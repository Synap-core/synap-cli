/**
 * `synap tools install|verify|remove <capability>` and `synap tools list`: the
 * person's door, at the keyboard, to a capability's tool on THIS computer
 * (plan b647769e §3; decision 168f34db; one installer, reconciliation
 * f75fbb48 §3.3).
 *
 * The pod holds what is installed where (an installation of kind `tool`), and
 * the host runner is the one thing that changes a computer. So this command
 * asks the pod (with the person's own key an install is approved at once; an
 * agent's ask waits for the person), then runs the job the pod queued, right
 * here, through the same runner `synap worker` uses: same steps, same check,
 * same report. With a person at the keyboard, admin steps and scripts are
 * asked. `--dry-run` only plans: it reads the manifest and prints this
 * computer's steps; it asks nothing and records nothing.
 */

import { resolveStatusLabel } from "@synap-core/types/vocabulary";
import type { ComputerManifest } from "../lib/host/tool.js";
import { loadComputerManifest, type ManifestSourceOpts } from "../lib/host/tool-manifest.js";
import { computerName, defaultContext, installTool, removeTool, verifyTool, type RunContext, type ToolResult } from "../lib/host/tool-run.js";
import { HostDoorClosedError, type FinishBody } from "../lib/host/wire.js";
import { log } from "../utils/logger.js";

// ── The pod's installations door ──────────────────────────────────────────────

/** Hub paths of the installations door (backend lane installer-backend). */
export const REQUEST_PATH = "/installations/request";
export const LIST_PATH = "/installations";

export type ToolAction = "install" | "verify" | "remove";

export interface RequestAnswer {
  /** approved: a job is queued for this computer. proposed: it waits for the person. */
  status: "approved" | "proposed" | string;
  installationId?: string;
  jobId?: string;
  reviewUrl?: string;
}

/** A row of `GET /installations?computer=me`. Health is derived by the pod, never stored. */
export interface InstallationRow {
  id?: string;
  capabilityKey: string;
  kind?: string;
  status: string;
  observedVersion?: string | null;
  desiredVersion?: string | null;
  verifiedAt?: string | null;
  /** The pod's derived verdict: ok | degraded | drifted | stale | unknown | failed. */
  health?: string | null;
}

export interface InstallationsDoor {
  /** With the person's key: their ask is approved; an agent's waits for them. */
  /** The pod derives the kind from the capability's manifest. */
  request(body: { capabilityKey: string; action: ToolAction; computer: "me"; sessionId?: string }): Promise<RequestAnswer>;
  /** With the computer's key: what the pod records on this computer. */
  list(): Promise<InstallationRow[]>;
}

/**
 * The pod has no installations door yet (an older pod): its router's 404,
 * which carries no code. A 404 the door itself answers names its code
 * (`NOT_INSTALLABLE`: the pod has no such capability to install), and a 403
 * is a refusal (`GRANT_DOOR_UNSUPPORTED`): both are said as the pod said them.
 */
export const isMissingDoor = (err: unknown): boolean => {
  const e = err as { status?: number; code?: string } | undefined;
  return e?.status === 404 && !e.code;
};

/** The line `synap tools list` says when the pod's read failed. */
export function listFailureLine(pod: string, computer: string, err: unknown): string {
  return isMissingDoor(err)
    ? `${pod} cannot list what is installed on its computers yet (no installations door): update the pod`
    : `could not read what is installed on ${computer} from ${pod}: ${(err as Error).message}`;
}

export async function installationsDoor(podUrl: string, personKey: string, computerKey: string): Promise<InstallationsDoor> {
  const { hubGet, hubPost } = await import("../lib/hub-client.js");
  return {
    async request(body) {
      return (await hubPost(REQUEST_PATH, body, { podUrl, apiKey: personKey, userId: "cli" })) as RequestAnswer;
    },
    async list() {
      const res = (await hubGet(LIST_PATH, { computer: "me" }, { podUrl, apiKey: computerKey })) as { items?: InstallationRow[] } | InstallationRow[];
      return Array.isArray(res) ? res : (res.items ?? []);
    },
  };
}

// ── Run the queued job here ───────────────────────────────────────────────────

/** What one pass of the runner at the keyboard did with the job the pod queued. */
export type RanHere =
  | { ran: true; finish: FinishBody; message?: string }
  | { ran: false; reason: string };

export interface PassDeps {
  /** Lease and run host jobs for this computer until the one asked for has run. */
  leaseAndRun(match: (job: { id: string; installation: { capabilityKey: string } }) => boolean): Promise<RanHere>;
}

const MAX_JOBS_PER_PASS = 5;

/**
 * The runner, one pass, at the keyboard: lease this computer's jobs and run
 * them (each is work the person approved) until the one asked for has run.
 * Another process on this computer holding the runner (a worker in the middle
 * of a job) means that worker runs it: said, never raced.
 */
export async function runnerPass(podUrl: string, computerKey: string, ctx: () => RunContext): Promise<PassDeps> {
  const { createHostRunner, hostLockFile } = await import("../lib/host/runner.js");
  const { runJob, takeHostLock } = await import("../lib/host/lease.js");
  let last: string | undefined;
  /** A prerequisite's job runs inside the outer one: the runner is already this pass's. */
  let depth = 0;
  const deps = createHostRunner({
    podUrl,
    computerKey,
    log: (l) => {
      last = l.replace(/^job [^:]+: /, "");
      log.dim(l);
    },
    toolContext: ctx,
  });
  return {
    async leaseAndRun(match) {
      const release = depth > 0 ? () => {} : takeHostLock(hostLockFile());
      if (!release) return { ran: false, reason: "the worker on this computer is running a job; it runs this one next" };
      depth++;
      try {
        for (let i = 0; i < MAX_JOBS_PER_PASS; i++) {
          const job = await deps.hub.lease();
          if (!job) return { ran: false, reason: "no job for this computer was waiting: the worker on this computer may have taken it" };
          const finish = await runJob(job, deps);
          if (!match(job)) continue;
          if (!finish) return { ran: false, reason: "the pod took the job back before it finished (the lease was lost)" };
          return { ran: true, finish, message: last };
        }
        return { ran: false, reason: `${MAX_JOBS_PER_PASS} other jobs ran first; the worker on this computer runs the rest` };
      } finally {
        depth--;
        release();
      }
    },
  };
}

// ── Commands ──────────────────────────────────────────────────────────────────

export interface ToolsCommandOpts extends ManifestSourceOpts {
  dryRun?: boolean;
  computer?: string;
  skipModels?: boolean;
  session?: string;
  json?: boolean;
}

/** `--computer` names this computer only: installing on another one is that computer's runner. */
function computerRefusal(opts: ToolsCommandOpts): string | undefined {
  if (!opts.computer) return undefined;
  const here = computerName().toLowerCase();
  const asked = opts.computer.toLowerCase().replace(/\.local$/, "");
  if (asked === "this" || asked === here) return undefined;
  return `synap tools runs on the computer it is typed on (${computerName()}). To install on ${opts.computer}, run it there.`;
}

const PAST: Record<ToolAction, string> = { install: "Installed", verify: "Checked", remove: "Removed" };

/** The words for a finished job, from what it reported. */
function finishWords(action: ToolAction, slug: string, f: FinishBody, message: string | undefined): { ok: boolean; line: string } {
  if (f.status === "done") return { ok: true, line: message ?? `${PAST[action]} ${slug} on ${computerName()}` };
  const failed = f.steps?.find((s) => !s.ok);
  return { ok: false, line: message ?? failed?.detail ?? `${slug}: the job ended ${f.status}` };
}

export interface ToolsEnv {
  podUrl: string;
  pod: string;
  door: InstallationsDoor;
  pass: PassDeps;
  ctx: RunContext;
}

/**
 * Ask the pod for the action and run it here. Returns whether it is done and
 * the lines to say. Exported for tests (a fake door and pass).
 */
export async function toolViaPod(
  action: ToolAction,
  slug: string,
  env: ToolsEnv,
  opts: Pick<ToolsCommandOpts, "session" | "manifest">
): Promise<{ ok: boolean; lines: Array<{ level: "success" | "error" | "warn" | "info"; text: string }> }> {
  let answer: RequestAnswer;
  try {
    answer = await env.door.request({ capabilityKey: slug, action, computer: "me", ...(opts.session ? { sessionId: opts.session } : {}) });
  } catch (err) {
    if (!isMissingDoor(err)) return { ok: false, lines: [{ level: "error", text: `${env.pod} did not take the request: ${(err as Error).message}` }] };
    if (action !== "verify") {
      return { ok: false, lines: [{ level: "error", text: `${env.pod} cannot record what is installed on its computers yet (no installations door): update the pod, then run this again` }] };
    }
    // A check changes nothing on the computer: it runs here, and says it is not recorded.
    const loaded = await loadComputerManifest(slug, opts);
    if ("error" in loaded) return { ok: false, lines: [{ level: "error", text: loaded.error }] };
    const r = await verifyTool(loaded.manifest, env.ctx);
    return {
      ok: false,
      lines: [
        { level: r.status === "installed" ? "success" : "error", text: r.message },
        { level: "warn", text: `not recorded: ${env.pod} has no installations door yet (manifest: ${loaded.source})` },
      ],
    };
  }
  if (answer.status === "proposed") {
    return {
      ok: true,
      lines: [
        { level: "info", text: `Asked: ${action} ${slug} on ${computerName()} waits for your approval${answer.reviewUrl ? `: ${answer.reviewUrl}` : " on the pod"}` },
        { level: "info", text: "Once approved, the worker on this computer runs it." },
      ],
    };
  }
  let ran: RanHere;
  try {
    ran = await env.pass.leaseAndRun((job) => (answer.jobId ? job.id === answer.jobId : job.installation.capabilityKey === slug));
  } catch (err) {
    if (err instanceof HostDoorClosedError) return { ok: false, lines: [{ level: "error", text: err.message }] };
    throw err;
  }
  if (!ran.ran) return { ok: true, lines: [{ level: "info", text: `${env.pod} queued it: ${ran.reason}. \`synap tools list\` shows the result.` }] };
  const w = finishWords(action, slug, ran.finish, ran.message);
  return { ok: w.ok, lines: [{ level: w.ok ? "success" : "error", text: `${w.line} (recorded on ${env.pod})` }] };
}

function say(lines: Array<{ level: "success" | "error" | "warn" | "info"; text: string }>): void {
  for (const l of lines) log[l.level](l.text);
}

async function toolsAction(action: ToolAction, slug: string, opts: ToolsCommandOpts): Promise<void> {
  const refused = computerRefusal(opts);
  if (refused) {
    log.error(refused);
    process.exitCode = 1;
    return;
  }
  const ctx = defaultContext({ skipModels: opts.skipModels, say: (l) => log.info(l) });

  if (opts.dryRun) {
    // Plan only: this computer's steps for the manifest the catalog serves. Nothing is asked or recorded.
    const loaded = await loadComputerManifest(slug, opts);
    if ("error" in loaded) {
      log.error(loaded.error);
      process.exitCode = 1;
      return;
    }
    log.dim(`manifest: ${loaded.source}`);
    const dry = { ...ctx, dryRun: true };
    const r: ToolResult =
      action === "install" ? await installTool(loaded.manifest, dry) : action === "remove" ? await removeTool(loaded.manifest, dry) : await verifyTool(loaded.manifest, dry);
    if (opts.json) console.log(JSON.stringify({ slug, status: r.status, message: r.message }, null, 2));
    else if (r.status === "dry-run") log.success(r.message);
    else log.error(r.message);
    if (r.status !== "dry-run") process.exitCode = 1;
    return;
  }

  const { resolveHubConfig } = await import("../lib/hub-client.js");
  const { ensureComputerEnrolled } = await import("../lib/device-connect.js");
  const cfg = await resolveHubConfig();
  const enrol = await ensureComputerEnrolled(cfg.podUrl, `run \`synap tools ${action} ${slug}\` again`);
  if (!enrol.enrolled) {
    log.error(enrol.message);
    process.exitCode = 1;
    return;
  }
  const pod = new URL(cfg.podUrl).host;
  const door = await installationsDoor(cfg.podUrl, cfg.apiKey, enrol.computerKey);
  const env: ToolsEnv = { podUrl: cfg.podUrl, pod, door, ctx, pass: undefined as unknown as PassDeps };
  // A prerequisite (requires.capabilities) is its own yes and its own installation on the pod.
  const jobCtx = (): RunContext => ({
    ...ctx,
    ...(ctx.interactive
      ? {
          prerequisite: async (dep: ComputerManifest) => {
            if (!(await ctx.confirm?.(`This needs ${dep.name} first. Install it?`))) return { ok: false as const, message: "you said no: nothing was installed" };
            const asked = await door.request({ capabilityKey: dep.slug, action: "install", computer: "me" });
            if (asked.status === "proposed") return { ok: false as const, message: `approve ${dep.slug} first${asked.reviewUrl ? `: ${asked.reviewUrl}` : " on the pod"}` };
            // The outer job holds this computer's runner: the prerequisite's job runs inside it.
            const inner = await env.pass.leaseAndRun((j) => (asked.jobId ? j.id === asked.jobId : j.installation.capabilityKey === dep.slug));
            if (!inner.ran) return { ok: false as const, message: inner.reason };
            return inner.finish.status === "done" ? { ok: true as const } : { ok: false as const, message: `the install of ${dep.slug} ended ${inner.finish.status}` };
          },
        }
      : {}),
  });
  env.pass = await runnerPass(cfg.podUrl, enrol.computerKey, jobCtx);
  const r = await toolViaPod(action, slug, env, opts);
  if (opts.json) console.log(JSON.stringify({ slug, action, ok: r.ok, lines: r.lines.map((l) => l.text) }, null, 2));
  else say(r.lines);
  if (!r.ok) process.exitCode = 1;
}

export const toolsInstallCommand = (slug: string, opts: ToolsCommandOpts) => toolsAction("install", slug, opts);
export const toolsVerifyCommand = (slug: string, opts: ToolsCommandOpts) => toolsAction("verify", slug, opts);
export const toolsRemoveCommand = (slug: string, opts: ToolsCommandOpts) => toolsAction("remove", slug, opts);

/** `synap tools list`: what the pod records on this computer. A failed read is said, never shown as empty. */
export async function toolsListCommand(opts: { json?: boolean }): Promise<void> {
  const { resolveHubConfig } = await import("../lib/hub-client.js");
  const { ensureComputerEnrolled } = await import("../lib/device-connect.js");
  const cfg = await resolveHubConfig();
  const enrol = await ensureComputerEnrolled(cfg.podUrl, "run `synap tools list` again");
  if (!enrol.enrolled) {
    log.error(enrol.message);
    process.exitCode = 1;
    return;
  }
  const pod = new URL(cfg.podUrl).host;
  let rows: InstallationRow[];
  try {
    rows = await (await installationsDoor(cfg.podUrl, cfg.apiKey, enrol.computerKey)).list();
  } catch (err) {
    log.error(listFailureLine(pod, computerName(), err));
    process.exitCode = 1;
    return;
  }
  if (opts.json) {
    console.log(JSON.stringify(rows, null, 2));
    return;
  }
  log.heading(`Installed on ${computerName()}`);
  if (!rows.length) {
    log.info("Nothing yet. Install a tool with `synap tools install <capability>`.");
    return;
  }
  for (const r of rows) {
    const health = r.health;
    const version = r.observedVersion ? `  ${r.observedVersion}` : "";
    const checked = r.verifiedAt ? `, checked ${r.verifiedAt.slice(0, 10)}` : "";
    log.info(`${r.capabilityKey}  ${resolveStatusLabel(r.status)}${health ? ` (${resolveStatusLabel(health)})` : ""}${version}${checked}`);
  }
}
