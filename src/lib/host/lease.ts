/**
 * The host runner's loop (`synap host serve`): one job at a time, no AI.
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
 * Kinds: install, update (keeps the previous compose and rolls back to it when
 * the new version is not healthy), remove (keeps the data folder unless the
 * job says `keepData: false`), provider_op (provider-ops.ts). `verb` jobs
 * (hosted verbs, plan U8) are answered `failed` with the reason.
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
import {
  HostLeaseLostError,
  type FinishBody,
  type FinishStep,
  type HealthReport,
  type HostHub,
  type HostLog,
  type LeasedHostJob,
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

  try {
    try {
      switch (job.kind) {
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

        case "verb":
        default:
          throw new StepFailure(
            job.kind === "verb" ? "this host runner does not run hosted verbs yet (plan 64072312 U8)" : `unknown job kind "${String(job.kind)}"`
          );
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
  const body: Omit<FinishBody, "leaseId"> = {
    status: verdict,
    durationMs: now() - startedAt,
    ...(infraReason ? { infraReason } : {}),
    steps,
    ...(log ? { log } : {}),
    ...(contractOutput ? { output: contractOutput } : {}),
    ...(cleanedUp.length ? { cleanedUp } : {}),
  };
  try {
    await deps.hub.finish(job, body);
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
  once?: boolean;
  signal?: AbortSignal;
  sleep?: (ms: number) => Promise<void>;
}

/** Lease and work jobs until the signal aborts (or one pass with `once`). */
export async function serveHost(deps: RunnerDeps, opts: ServeOptions): Promise<void> {
  const sleep = opts.sleep ?? realSleep;
  while (!opts.signal?.aborted) {
    try {
      const job = await deps.hub.lease();
      if (job) {
        deps.log(`leased job ${job.id} (${job.kind}, ${job.installation.capabilityKey})`);
        await runJob(job, { ...deps, signal: opts.signal });
      }
      if (opts.once) return;
      if (!job) await sleep(opts.idleMs);
    } catch (err) {
      deps.log(`error: ${(err as Error).message}`);
      if (opts.once) throw err;
      await sleep(opts.errorWaitMs);
    }
  }
}
