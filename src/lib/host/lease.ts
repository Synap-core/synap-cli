/**
 * The host runner's loop (`synap worker`, alone with `--host-only`): one job at
 * a time, no AI.
 *
 *   lease ─▶ heartbeat setup ─▶ check the manifest snapshot, write compose,
 *         ─▶ disk guard, images by digest ─▶ heartbeat RUNNING (200) ─▶ start
 *         ─▶ health within its clock ─▶ report ─▶ finish
 *   on any failure: remove everything this job started, then finish failed
 *   on a lost lease (404/409, or the lease ran out unrenewed): remove what this
 *   job started and say NOTHING more to the pod (no report, no finish)
 *
 * The lease protocol is the box runner's (`src/lib/box/provisioner.ts`):
 * containers start only after a `phase: "running"` heartbeat answered 200,
 * because from then on the pod never re-leases the job; a lost lease ends the
 * work without a finish, because the pod already gave the job up.
 *
 * An installation is a `service` or a `tool` (reconciliation f75fbb48 §3.1):
 * - service: install, update (keeps the previous compose and rolls back to it
 *   when the new version is not healthy), remove (keeps the data folder unless
 *   the job says `keepData: false`), verify (health again, reported),
 *   provider_op (provider-ops.ts);
 * - tool: install, update, remove and verify run the manifest's per-OS steps
 *   and check (tool-run.ts); the finish carries what the check found.
 * - verb (hosted verbs, plan U8): one recipe of a tool installed here, with its
 *   input files from the pod and its outputs uploaded back (recipe-run.ts).
 *
 * State on the computer: `<installRoot>/<installation id>/compose.yaml` and
 * its volume folders. It never holds a key: the runner's own key stays in the
 * CLI config it was started with.
 */

import fs from "node:fs";
import path from "node:path";
import {
  planInstallation,
  writeInstallation,
  type ContainerRuntime,
  type InstallationPlan,
} from "./compose.js";
import { HEALTH_SECONDS, PULL_SECONDS, START_SECONDS, unhealthySummary, waitHealthy, type HealthResult } from "./health.js";
import { LOG_TAIL_LINES, secretValues, toHostLog } from "./logs.js";
import {
  output,
  parseProviderOp,
  planProviderOp,
  probeBinding,
  writeProviderPlan,
  type ProviderEnv,
  type ProviderPlan,
} from "./provider-ops.js";
import { readComputerManifest } from "./tool.js";
import { defaultContext, installTool, removeTool, verifyTool, type RunContext } from "./tool-run.js";
import { runRecipe, type RecipeRunDeps } from "./recipe-run.js";
import {
  fitFinishBody,
  HostDoorClosedError,
  HostLeaseLostError,
  HostRequestRefusedError,
  installationKind,
  type FinishBody,
  type FinishStep,
  type HealthReport,
  type HostHub,
  type HostJobFile,
  type HostLog,
  type LeasedHostJob,
  type ToolCheck,
} from "./wire.js";

export interface RunnerConfig extends ProviderEnv {
  /** Wait unless the installation folder's disk keeps this much free after the job's declared disk. */
  minFreeDiskMb: number;
  maxLimits?: { cpus: number; memoryMb: number };
}

export interface Clocks {
  pullMs: number;
  startMs: number;
  healthMs: number;
}

export const DEFAULT_CLOCKS: Clocks = { pullMs: PULL_SECONDS * 1000, startMs: START_SECONDS * 1000, healthMs: HEALTH_SECONDS * 1000 };

export interface RunnerDeps {
  hub: HostHub;
  runtime: ContainerRuntime;
  config: RunnerConfig;
  log: (line: string) => void;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  fetchImpl?: (url: string, init: RequestInit) => Promise<Response>;
  /** Free MB on the disk holding a path (statfs). */
  freeDiskMb?: (p: string) => number;
  clocks?: Partial<Clocks>;
  healthIntervalMs?: number;
  /** The runner is stopping: end the current job (cleaned up, finished infra). */
  signal?: AbortSignal;
  /** Values that must never leave in a log (the computer's own key, …). */
  secrets?: string[];
  /** Heartbeat cadence override (tests); default the job's interval, at least 5 s. */
  heartbeatMs?: number;
  /** Where a hosted verb's job folders go (default `~/.synap/tools/work`). */
  workRoot?: string;
  /**
   * How a `tool` job runs here: the worker has no person to ask (the default);
   * `synap tools` at the keyboard does, so admin steps and scripts are asked.
   */
  toolContext?: () => RunContext;
}

/** A step failed: the job ends failed (or timeout / stopped / infra), after cleanup. */
class StepFailure extends Error {
  constructor(
    message: string,
    readonly verdict: FinishBody["status"] = "failed"
  ) {
    super(message);
  }
}

/** The lease is gone: stop, clean up, say nothing. */
class LeaseGone extends Error {}

const realSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export function statfsFreeMb(p: string): number {
  let dir = p;
  while (!fs.existsSync(dir) && path.dirname(dir) !== dir) dir = path.dirname(dir);
  const s = fs.statfsSync(dir);
  return Math.floor((s.bavail * s.bsize) / (1024 * 1024));
}

function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  let t: NodeJS.Timeout | undefined;
  return Promise.race([
    p,
    new Promise<T>((_, reject) => {
      t = setTimeout(() => reject(new StepFailure(`${what} did not finish within ${Math.round(ms / 1000)} s`, "timeout")), ms);
    }),
  ]).finally(() => clearTimeout(t));
}

/**
 * Work one leased job to its end. Returns the finish body sent, or null when
 * the lease was lost (nothing more was said to the pod).
 */
export async function runJob(job: LeasedHostJob, deps: RunnerDeps): Promise<FinishBody | null> {
  const now = deps.now ?? Date.now;
  const clocks = { ...DEFAULT_CLOCKS, ...deps.clocks };
  const startedAt = now();
  const steps: FinishStep[] = [];
  const cleanedUp: string[] = [];
  const stop = new AbortController();
  let phase: "setup" | "running" = "setup";
  let lost = false;
  let stopped = false;
  let logsRequested = false;
  let leaseExpiresAt = Date.parse(job.leaseExpiresAt);
  /** Compose projects this job started, and folders it made: removed on every failure path. */
  const started: Array<{ project: string; file?: string }> = [];
  const madeDirs: string[] = [];
  /** The project whose logs a person may ask for. */
  let logProject: string | null = null;
  let logSecrets: string[] = [...(deps.secrets ?? [])];

  const held = () => !lost && now() < leaseExpiresAt;
  const assertHeld = () => {
    if (!held()) {
      if (!lost) deps.log(`job ${job.id}: the lease ran out at ${new Date(leaseExpiresAt).toISOString()} without a renewal`);
      lost = true;
      throw new LeaseGone();
    }
  };
  const assertGoing = () => {
    assertHeld();
    if (stopped) throw new StepFailure("a person asked to stop this job", "stopped");
    if (deps.signal?.aborted) throw new StepFailure("the host runner was stopped mid-job", "infra");
  };

  const beat = async (): Promise<void> => {
    if (lost) return;
    try {
      const a = await deps.hub.heartbeat(job, phase);
      const exp = Date.parse(a.leaseExpiresAt);
      if (Number.isFinite(exp)) leaseExpiresAt = exp;
      if (a.logsRequested) logsRequested = true;
      if (a.stopRequested && !stopped) {
        stopped = true;
        deps.log(`job ${job.id}: Stop requested`);
        stop.abort();
      }
    } catch (err) {
      if (err instanceof HostLeaseLostError) {
        lost = true;
        deps.log(`job ${job.id}: ${err.message}`);
        stop.abort();
        return;
      }
      // Transient: the next beat retries before the lease runs out; held() decides when it is too late.
      deps.log(`job ${job.id}: heartbeat failed: ${(err as Error).message}`);
    }
  };

  const step = async <T>(name: string, fn: () => Promise<T>): Promise<T> => {
    assertGoing();
    const t0 = now();
    try {
      const out = await fn();
      steps.push({ name, ok: true, durationMs: now() - t0 });
      return out;
    } catch (err) {
      if (err instanceof LeaseGone) throw err;
      if (lost) throw new LeaseGone();
      const detail = (err as Error).message.slice(0, 1000);
      steps.push({ name, ok: false, detail, durationMs: now() - t0 });
      // A refusal (ComposeRefusal, ProviderOpRefusal) and a failed command alike end the job failed.
      throw err instanceof StepFailure ? err : new StepFailure(detail);
    }
  };

  const goRunning = async () => {
    phase = "running";
    await beat();
    assertGoing();
  };

  const ensureImages = async (images: string[]) =>
    withTimeout(
      (async () => {
        for (const ref of images) {
          assertGoing();
          if (await deps.runtime.imagePresent(ref)) continue;
          deps.log(`job ${job.id}: pulling ${ref}`);
          await deps.runtime.pull(ref);
        }
      })(),
      clocks.pullMs,
      "pulling the images"
    );

  const healthDeps = {
    runtime: deps.runtime,
    fetchImpl: deps.fetchImpl,
    now,
    sleep: deps.sleep,
    intervalMs: deps.healthIntervalMs,
    signal: stop.signal,
  };

  const collectLog = async (): Promise<HostLog | undefined> => {
    if (!logsRequested || !logProject) return undefined;
    try {
      const text = await deps.runtime.logs(logProject, LOG_TAIL_LINES);
      logsRequested = false;
      return toHostLog(text, logSecrets);
    } catch (err) {
      deps.log(`job ${job.id}: could not read the logs: ${(err as Error).message}`);
      return undefined;
    }
  };

  const healthReport = (plan: InstallationPlan, h: HealthResult): HealthReport => {
    let freeMb: number | undefined;
    try {
      freeMb = (deps.freeDiskMb ?? statfsFreeMb)(plan.dir);
    } catch {
      freeMb = undefined;
    }
    return {
      services: h.services,
      versions: Object.fromEntries(plan.services.map((s) => [s.id, { digest: s.digest }])),
      ports: plan.services.flatMap((s) => s.ports.filter((p) => p.protocol === "tcp").map((p) => ({ service: s.id, port: p.host, host: "127.0.0.1" as const }))),
      ...(freeMb !== undefined ? { disk: { freeMb } } : {}),
    };
  };

  const diskGuard = (dir: string, needMb: number) => {
    const free = (deps.freeDiskMb ?? statfsFreeMb)(dir);
    if (free - needMb < deps.config.minFreeDiskMb) {
      throw new StepFailure(
        `not enough disk: ${free} MB free, the installation declares ${needMb} MB and the computer keeps ${deps.config.minFreeDiskMb} MB free`
      );
    }
  };

  const cleanup = async () => {
    for (const s of [...started].reverse()) {
      try {
        await deps.runtime.down(s.project, s.file);
        cleanedUp.push(`containers and network of ${s.project}`);
      } catch (err) {
        deps.log(`job ${job.id}: cleanup of ${s.project} failed: ${(err as Error).message}`);
        cleanedUp.push(`FAILED to remove ${s.project}: ${(err as Error).message}`.slice(0, 300));
      }
    }
    for (const d of [...madeDirs].reverse()) {
      try {
        fs.rmSync(d, { recursive: true, force: true });
        cleanedUp.push(d);
      } catch (err) {
        cleanedUp.push(`FAILED to remove ${d}: ${(err as Error).message}`.slice(0, 300));
      }
    }
  };

  /** The health report. Never sent once the lease is gone; a failed send is logged, not the job's failure. */
  const sendReport = async (plan: InstallationPlan, h: HealthResult) => {
    assertHeld();
    const log = await collectLog();
    try {
      await deps.hub.report(job, { health: healthReport(plan, h), ...(log ? { log } : {}) });
    } catch (err) {
      if (err instanceof HostLeaseLostError) {
        lost = true;
        throw new LeaseGone();
      }
      deps.log(`job ${job.id}: report failed: ${(err as Error).message}`);
    }
  };

  const onAbort = () => stop.abort();
  deps.signal?.addEventListener("abort", onAbort);

  await beat();
  if (lost) {
    deps.signal?.removeEventListener("abort", onAbort);
    return null;
  }
  const timer = setInterval(() => void beat(), deps.heartbeatMs ?? Math.max(5, job.heartbeatIntervalSeconds) * 1000);

  let verdict: FinishBody["status"] = "done";
  let infraReason: string | undefined;
  let contractOutput: Record<string, unknown> | undefined;
  const ctx = {
    installationId: job.installation.id,
    installRoot: deps.config.installRoot,
    digests: job.installation.digests,
    user: deps.config.user,
    allowDeclaredEgress: deps.config.allowDeclaredEgress,
    maxLimits: deps.config.maxLimits,
  };

  let toolCheck: ToolCheck | undefined;
  /** A hosted verb's outputs, uploaded (or why not): the finish carries them. */
  let verbFiles: HostJobFile[] | undefined;
  const kind = installationKind(job);

  try {
    try {
      if (job.kind !== "provider_op" && job.kind !== "verb" && kind === null) {
        throw new StepFailure("the approved manifest declares both services and install steps, or neither: refused");
      }
      if (kind === "tool" && (job.kind === "install" || job.kind === "update" || job.kind === "remove" || job.kind === "verify")) {
        const read = await step("check the approved manifest", async () => {
          const m = readComputerManifest(job.installation.manifest, job.installation.capabilityKey);
          if ("error" in m) throw new StepFailure(m.error);
          return { ...m, version: job.installation.capabilityVersion ?? m.version };
        });
        const tctx: RunContext = deps.toolContext?.() ?? defaultContext({ interactive: false, say: (l) => deps.log(`job ${job.id}: ${l}`) });
        await goRunning();
        const r =
          job.kind === "remove" ? await removeTool(read, tctx) : job.kind === "verify" ? await verifyTool(read, tctx) : await installTool(read, tctx);
        assertHeld();
        steps.push(...r.steps);
        toolCheck = r.check;
        deps.log(`job ${job.id}: ${r.message}`);
        // Drift (a working tool outside the manifest's range) is the pod's to derive from the version reported.
        if (r.status !== "installed" && r.status !== "drifted" && r.status !== "removed") {
          // The finish says why in the step that failed (a check that "failed" has no detail of its own).
          const failed = steps.find((x) => !x.ok);
          if (failed && !failed.detail) failed.detail = r.message.slice(0, 1000);
          throw new StepFailure(r.message);
        }
      } else
      switch (job.kind) {
        case "verify": {
          const plan = await step("check the approved manifest", async () => planInstallation(job.installation.manifest, ctx));
          logProject = plan.project;
          if (!fs.existsSync(plan.composeFile)) throw new StepFailure("this installation is not on this computer: nothing to check");
          await goRunning();
          const health = await step("health", async () => {
            const h = await waitHealthy(plan, healthDeps, clocks.healthMs);
            assertGoing();
            return h;
          });
          await sendReport(plan, health);
          if (!health.healthy) throw new StepFailure(`not healthy: ${unhealthySummary(health)}`);
          break;
        }

        case "install": {
          const plan = await step("check the approved manifest", async () => planInstallation(job.installation.manifest, ctx));
          logProject = plan.project;
          logSecrets = [...logSecrets, ...plan.services.flatMap((s) => secretValues(s.env))];
          if (fs.existsSync(plan.composeFile)) throw new StepFailure(`${plan.composeFile} exists: this installation is already on this computer`);
          await step("disk", async () => diskGuard(plan.dir, plan.services.reduce((n, s) => n + s.limits.diskMb, 0)));
          await step("write compose", async () => {
            const made = writeInstallation(plan, ctx);
            // A fresh folder goes whole on a failure; a folder kept from an earlier removal keeps its data.
            if (made.includes(plan.dir)) madeDirs.push(plan.dir);
            else madeDirs.push(...made, plan.composeFile);
          });
          await step("images by digest", () => ensureImages([...new Set(plan.services.map((s) => s.image))]));
          await goRunning();
          started.push({ project: plan.project, file: plan.composeFile });
          await step("start", () => withTimeout(deps.runtime.up(plan), clocks.startMs, "starting the containers"));
          const health = await step("health", async () => {
            const h = await waitHealthy(plan, healthDeps, clocks.healthMs);
            assertGoing();
            if (!h.healthy) throw new StepFailure(`not healthy within ${Math.round(clocks.healthMs / 1000)} s: ${unhealthySummary(h)}`, "timeout");
            return h;
          });
          await sendReport(plan, health);
          break;
        }

        case "update": {
          const plan = await step("check the approved manifest", async () => planInstallation(job.installation.manifest, ctx));
          logProject = plan.project;
          logSecrets = [...logSecrets, ...plan.services.flatMap((s) => secretValues(s.env))];
          const previous = fs.existsSync(plan.composeFile) ? fs.readFileSync(plan.composeFile, "utf8") : null;
          if (previous === null) throw new StepFailure("this installation is not on this computer: nothing to update");
          await step("images by digest", () => ensureImages([...new Set(plan.services.map((s) => s.image))]));
          await goRunning();
          await step("write compose", async () => {
            writeInstallation(plan, ctx);
          });
          try {
            await step("start the new version", () => withTimeout(deps.runtime.up(plan), clocks.startMs, "starting the containers"));
            const health = await step("health", async () => {
              const h = await waitHealthy(plan, healthDeps, clocks.healthMs);
              assertGoing();
              if (!h.healthy) throw new StepFailure(`the new version is not healthy: ${unhealthySummary(h)}`);
              return h;
            });
            await sendReport(plan, health);
          } catch (err) {
            if (err instanceof LeaseGone) throw err;
            // Roll back: the previous compose file, started again. The update failed; the old version runs.
            fs.writeFileSync(plan.composeFile, previous, { mode: 0o640 });
            // empty-ok: a failed rollback is recorded as its own failed step; the job ends with the update's own error.
            await step("roll back to the previous version", () => withTimeout(deps.runtime.up(plan), clocks.startMs, "the rollback")).catch(() => {});
            throw err;
          }
          break;
        }

        case "remove": {
          const dir = path.join(deps.config.installRoot, job.installation.id);
          const composeFile = path.join(dir, "compose.yaml");
          const project = `synap-${job.installation.id.replace(/-/g, "").slice(0, 12)}`;
          logProject = project;
          await goRunning();
          await step("stop and remove the containers", () => deps.runtime.down(project, composeFile));
          cleanedUp.push(`containers and network of ${project}`);
          const keepData = job.spec?.keepData !== false;
          await step(keepData ? "remove the compose file and scratch (data kept)" : "remove the installation folder", async () => {
            if (keepData) {
              fs.rmSync(composeFile, { force: true });
              fs.rmSync(path.join(dir, "scratch"), { recursive: true, force: true });
              cleanedUp.push(composeFile, path.join(dir, "scratch"));
            } else {
              fs.rmSync(dir, { recursive: true, force: true });
              cleanedUp.push(dir);
            }
          });
          break;
        }

        case "provider_op": {
          let plan: ProviderPlan | null = null;
          try {
            const spec = await step("check the op", async () => parseProviderOp(job));
            plan = await step(`plan ${spec.provider} ${spec.op}`, async () => planProviderOp(job, spec, deps.config));
            const p = plan;
            logProject = p.project;
            if (spec.op === "create") {
              const fresh = !fs.existsSync(p.composeFile);
              await step("write compose", async () => {
                const made = writeProviderPlan(p);
                if (fresh) madeDirs.push(p.dir);
                return made;
              });
              await step("images by digest", () => ensureImages(p.images));
              await goRunning();
              started.push({ project: p.project, file: p.composeFile });
              await step("start", () => withTimeout(deps.runtime.up(p.asInstallation), clocks.startMs, "starting the provider"));
              const live = await step("live", async () => {
                const deadline = now() + clocks.healthMs;
                let r = await probeBinding(p, deps.runtime, deps.fetchImpl);
                while (!r.live && now() < deadline && !stop.signal.aborted) {
                  await (deps.sleep ?? realSleep)(deps.healthIntervalMs ?? 2_000);
                  r = await probeBinding(p, deps.runtime, deps.fetchImpl);
                }
                assertGoing();
                if (!r.live) throw new StepFailure(`not live within ${Math.round(clocks.healthMs / 1000)} s: ${r.detail}`, "timeout");
                return r;
              });
              contractOutput = output("live", p, live.detail, new Date(now()));
            } else if (spec.op === "status") {
              await goRunning();
              const r = await step("probe", () => probeBinding(p, deps.runtime, deps.fetchImpl));
              contractOutput = output(r.live ? "live" : "degraded", p, r.detail, new Date(now()));
            } else {
              await goRunning();
              await step("stop and remove the provider", () => deps.runtime.down(p.project, p.composeFile));
              fs.rmSync(p.dir, { recursive: true, force: true });
              cleanedUp.push(`containers of ${p.project}`, p.dir);
              contractOutput = output("revoked", p, "revoked", new Date(now()));
            }
          } catch (err) {
            if (!(err instanceof LeaseGone)) contractOutput = output("failed", plan, (err as Error).message.slice(0, 500), new Date(now()));
            throw err;
          }
          break;
        }

        case "verb": {
          // A recipe of a tool installed here (recipe-run.ts): the RUNNING
          // heartbeat comes once the inputs are down and before the first step.
          const tctx: RunContext = deps.toolContext?.() ?? defaultContext({ interactive: false });
          try {
            const r = await runRecipe(job, {
              hub: deps.hub,
              os: tctx.os,
              values: tctx.values,
              env: tctx.env,
              ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl as RecipeRunDeps["fetchImpl"] } : {}),
              ...(tctx.run ? { run: tctx.run } : {}),
              signal: stop.signal,
              beforeSteps: goRunning,
              assertGoing,
              ...(deps.workRoot ? { workRoot: deps.workRoot } : {}),
              secrets: deps.secrets,
              log: (l) => deps.log(`job ${job.id}: ${l}`),
            });
            steps.push(...r.steps);
            verbFiles = r.files;
            deps.log(`job ${job.id}: ${r.message}`);
          } catch (err) {
            const partial = err as Error & { steps?: FinishStep[]; files?: HostJobFile[] };
            if (partial.steps) steps.push(...partial.steps);
            if (partial.files) verbFiles = partial.files;
            if (err instanceof LeaseGone || err instanceof StepFailure) throw err;
            if (err instanceof HostLeaseLostError) {
              lost = true;
              throw new LeaseGone();
            }
            if (lost) throw new LeaseGone();
            if (stopped) throw new StepFailure("a person asked to stop this job", "stopped");
            if (deps.signal?.aborted) throw new StepFailure("the host runner was stopped mid-job", "infra");
            throw new StepFailure((err as Error).message.slice(0, 1000));
          }
          break;
        }

        default:
          throw new StepFailure(`unknown job kind "${String(job.kind)}"`);
      }
    } catch (err) {
      if (err instanceof LeaseGone || lost) throw new LeaseGone();
      verdict = err instanceof StepFailure ? err.verdict : "failed";
      if (verdict === "infra") infraReason = (err as Error).message;
      if (!steps.some((s) => !s.ok)) steps.push({ name: "job", ok: false, detail: (err as Error).message.slice(0, 1000) });
      deps.log(`job ${job.id}: ${verdict}: ${(err as Error).message}`);
      await cleanup();
    }
  } catch (err) {
    // The lease is gone: remove what this job started, and say nothing more to the pod.
    clearInterval(timer);
    deps.signal?.removeEventListener("abort", onAbort);
    await cleanup();
    if (err instanceof LeaseGone) {
      deps.log(`job ${job.id}: lease lost; cleaned up (${cleanedUp.length} item(s)), not reported`);
      return null;
    }
    throw err;
  }

  clearInterval(timer);
  deps.signal?.removeEventListener("abort", onAbort);
  if (!held()) {
    deps.log(`job ${job.id}: the lease ran out before the finish; cleaning up, not reported`);
    if (verdict === "done") await cleanup();
    return null;
  }
  const log = await collectLog();
  // Inside the pod's limits: a finish it refuses is an outcome it never learns
  // (a tool installed and checked, then installed again by the self-heal).
  let body: Omit<FinishBody, "leaseId"> = fitFinishBody({
    status: verdict,
    durationMs: now() - startedAt,
    ...(infraReason ? { infraReason } : {}),
    steps,
    ...(log ? { log } : {}),
    ...(contractOutput ? { output: contractOutput } : {}),
    ...(cleanedUp.length ? { cleanedUp } : {}),
    ...(toolCheck ?? {}),
    ...(verbFiles?.length ? { files: verbFiles } : {}),
  });
  try {
    try {
      await deps.hub.finish(job, body);
    } catch (err) {
      if (!(err instanceof HostRequestRefusedError)) throw err;
      // Refused as malformed: send the outcome alone (verdict, check, a verb's files), once.
      deps.log(`job ${job.id}: ${err.message}; finishing again with the outcome only (steps and log are in this computer's log)`);
      const { steps: _s, log: _l, output: _o, cleanedUp: _c, ...outcome } = body;
      body = outcome;
      await deps.hub.finish(job, body);
    }
    deps.log(`job ${job.id}: finished ${verdict}`);
  } catch (err) {
    if (err instanceof HostLeaseLostError) {
      deps.log(`job ${job.id}: ${err.message} at the finish`);
      return null;
    }
    throw err;
  }
  return { leaseId: job.leaseId, ...body };
}

export interface ServeOptions {
  idleMs: number;
  errorWaitMs: number;
  /** How long to wait after the pod said this computer may not lease (default 10 min). */
  closedWaitMs?: number;
  once?: boolean;
  signal?: AbortSignal;
  sleep?: (ms: number) => Promise<void>;
  /**
   * One host runner per computer: several workers (one per agent) share it.
   * Answers a release, or undefined when another process on this computer
   * holds it (this pass then leases nothing).
   */
  lock?: () => (() => void) | undefined;
}

/** Lease and work jobs until the signal aborts (or one pass with `once`). */
export async function serveHost(deps: RunnerDeps, opts: ServeOptions): Promise<void> {
  const sleep = opts.sleep ?? realSleep;
  let closedSaid: string | undefined;
  while (!opts.signal?.aborted) {
    const release = opts.lock ? opts.lock() : () => {};
    if (!release) {
      if (opts.once) return;
      await sleep(opts.idleMs);
      continue;
    }
    let job: LeasedHostJob | null = null;
    try {
      job = await deps.hub.lease();
      closedSaid = undefined;
      if (job) {
        deps.log(`leased job ${job.id} (${job.kind}, ${job.installation.capabilityKey})`);
        await runJob(job, { ...deps, signal: opts.signal });
      }
    } catch (err) {
      if (err instanceof HostDoorClosedError) {
        // Said once, not every pass: the person changes this on the pod, not a retry.
        if (closedSaid !== err.message) deps.log(err.message);
        closedSaid = err.message;
        if (opts.once) throw err;
        release();
        await sleep(opts.closedWaitMs ?? 10 * 60_000);
        continue;
      }
      deps.log(`error: ${(err as Error).message}`);
      if (opts.once) throw err;
      release();
      await sleep(opts.errorWaitMs);
      continue;
    } finally {
      release();
    }
    if (opts.once) return;
    if (!job) await sleep(opts.idleMs);
  }
}

/** The host runner's lock file on this computer (`serveHost`'s `lock`). A dead holder's lock is taken over. */
export function takeHostLock(file: string): (() => void) | undefined {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  try {
    const fd = fs.openSync(file, "wx");
    fs.writeSync(fd, String(process.pid));
    fs.closeSync(fd);
  } catch {
    const pid = Number(fs.readFileSync(file, "utf8").trim());
    let alive = false;
    try {
      if (pid && pid !== process.pid) process.kill(pid, 0);
      alive = !!pid && pid !== process.pid;
    } catch {
      alive = false;
    }
    if (alive) return undefined;
    fs.writeFileSync(file, String(process.pid));
  }
  let released = false;
  return () => {
    if (released) return;
    released = true;
    try {
      if (fs.readFileSync(file, "utf8").trim() === String(process.pid)) fs.unlinkSync(file);
    } catch {
      /* already gone */
    }
  };
}
