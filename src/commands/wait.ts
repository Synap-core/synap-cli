/**
 * `synap wait devbox|pr|run …` — block until a devbox job, a PR's checks or
 * merge, or a GitHub Actions run is finished, and leave a typed state file the
 * status line reads.
 *
 * An agent that runs this in the background (instead of a hand-written
 * `for i in $(seq 1 240); do ssh …; sleep 30; done`) gets two things: an output
 * file that reads as one line per state change plus a summary, and a status
 * line that says what it waits on ("devbox w7-regen running be-file · 2/4"),
 * whether it is stuck (no change for 30 min), dead (its process is gone) or
 * looping (the 3rd wait on the same target).
 *
 * The probes shell out to `ssh devbox` (the read-only status reader) and `gh`.
 * Nothing here prints a token or an environment value: a failed probe prints
 * the first line of its error, clipped.
 */

import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { parseDuration } from "./proposals-await.js";
import { age, ordinal } from "../lib/now-line.js";
import {
  attemptFor,
  pruneWaits,
  readWaits,
  stateAndDetail,
  waitName,
  writeWait,
  type WaitKind,
  type WaitRecord,
  type WaitState,
} from "../lib/wait-state.js";

import { WAIT_EXIT } from "../lib/wait-help.js";

export { WAIT_EXIT };


// ── Probe results ──────────────────────────────────────────────────────

export interface ProbeResult {
  state: WaitState;
  detail: string;
  exitCode?: number; // set = the wait is over
}

const OK_CONCLUSIONS = new Set(["success", "skipped", "neutral"]);

function isoMs(s: unknown): number | null {
  if (typeof s !== "string" || !s || s.startsWith("0001-")) return null;
  const t = Date.parse(s);
  return Number.isFinite(t) ? t : null;
}

function hhmm(ms: number): string {
  const d = new Date(ms);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

function firstLine(s: string, max = 160): string {
  const l = (s.split("\n").find((x) => x.trim()) ?? "").trim();
  return l.length > max ? `${l.slice(0, max - 1)}…` : l;
}

// ── devbox ─────────────────────────────────────────────────────────────

interface DevboxGate {
  id: string;
  status: string;
  exit?: number | null;
  tests_failed?: number | null;
  files_failed?: number | null;
  ts_errors?: number | null;
  flag_text?: string | null;
}

export interface DevboxDetail {
  name?: string;
  status?: string;
  started?: string | null;
  done?: string | null;
  mtime?: string | null;
  infra?: string | null;
  refused?: string | null;
  gates?: DevboxGate[];
  job?: {
    state?: string;
    position?: number | null;
    queue?: string | null;
    gates?: string[];
    activity?: string | null;
    waiting_for?: string | null;
    disk_wait?: unknown;
    blocked_on?: string | null;
  } | null;
}

/** The gate names a job asked for (`*-file` gates are followed by paths, which are not gates). */
function requestedGates(gates: string[] | undefined): string[] {
  return (gates ?? []).filter((g) => !g.includes("/") && !/\.\w+$/.test(g));
}

function redGate(g: DevboxGate): string {
  const bits: string[] = [];
  if (g.tests_failed) bits.push(`${g.tests_failed} tests`);
  else if (g.files_failed) bits.push(`${g.files_failed} files`);
  if (g.ts_errors) bits.push(`${g.ts_errors} ts errors`);
  return bits.length ? `${g.id} (${bits.join(", ")})` : g.id;
}

/**
 * Map the devbox status reader's `--name` detail to a wait state. A finished
 * run counts only when it ended at or after `startedAt - graceMs`: an older
 * summary under the same name is the PREVIOUS run, not the one waited for.
 */
export function mapDevbox(d: DevboxDetail, startedAt: number, graceMs: number): ProbeResult {
  const job = d.job;
  const done = (d.gates ?? []).filter((g) => g.status !== "skipped");
  if (job && ["queued", "joined", "waiting"].includes(job.state ?? "")) {
    if (job.disk_wait || job.waiting_for === "disk") return { state: "queued", detail: "waiting for disk" };
    if (job.state === "joined") return { state: "queued", detail: "joined another job" };
    if (job.state === "waiting") return { state: "queued", detail: job.blocked_on ? `waiting for ${job.blocked_on}` : "waiting for a slot" };
    const pos = job.position ? `${ordinal(job.position)} ` : "";
    return { state: "queued", detail: `queued ${pos}(${job.queue ?? "?"})`.replace(" ()", "") };
  }
  if (job && (job.state === "running" || job.state === "checking")) {
    const asked = requestedGates(job.gates);
    const current = asked.find((g) => !done.some((x) => x.id === g || x.id.startsWith(`${g}-`) || x.id.startsWith(`${g}:`)));
    const progress = asked.length && done.length <= asked.length ? `${done.length}/${asked.length} done` : `${done.length} done`;
    const what = current ?? firstLine(job.activity ?? "", 40);
    const reds = done.filter((g) => g.status === "red").map(redGate);
    return {
      state: "running",
      detail: [what, progress, reds.length ? `red so far: ${reds.slice(0, 2).join(", ")}` : ""].filter(Boolean).join(" · "),
    };
  }

  const runAt = isoMs(d.done) ?? isoMs(d.mtime) ?? isoMs(d.started);
  const fresh = runAt !== null && runAt >= startedAt - graceMs;
  const status = d.status ?? "unknown";
  if (status === "running") return { state: "running", detail: `${done.length} done` };
  if (status === "queued") return { state: "queued", detail: "queued" };
  if (!fresh || status === "unknown") {
    const last = runAt !== null && status !== "unknown" ? ` (last run ${status} at ${hhmm(runAt)})` : "";
    return { state: "pending", detail: `not on the devbox yet${last}` };
  }
  switch (status) {
    case "green":
      return { state: "passed", detail: `${done.length} gate${done.length === 1 ? "" : "s"} green`, exitCode: WAIT_EXIT.PASSED };
    case "done":
      return { state: "passed", detail: "finished (this kind of job records no verdict)", exitCode: WAIT_EXIT.PASSED };
    case "red":
    case "red-uncounted": {
      const reds = done.filter((g) => g.status === "red" || g.status === "red-uncounted").map(redGate);
      return { state: "failed", detail: reds.length ? `red: ${reds.slice(0, 3).join(", ")}${reds.length > 3 ? ` +${reds.length - 3}` : ""}` : status, exitCode: WAIT_EXIT.FAILED };
    }
    case "refused":
      return { state: "infra", detail: `refused: ${firstLine(d.refused ?? "", 100)}`, exitCode: WAIT_EXIT.INFRA };
    case "infra": {
      const g = done.find((x) => x.status === "infra");
      return { state: "infra", detail: firstLine(d.infra ?? (g ? `${g.id}: ${g.flag_text ?? "infra"}` : "infra"), 100), exitCode: WAIT_EXIT.INFRA };
    }
    case "died":
    case "cancelled":
      return { state: "infra", detail: `${status} before DONE`, exitCode: WAIT_EXIT.INFRA };
    default:
      return { state: "pending", detail: `devbox status "${status}"` };
  }
}

// ── GitHub PR ──────────────────────────────────────────────────────────

interface RollupEntry {
  __typename?: string;
  name?: string;
  context?: string;
  status?: string;
  conclusion?: string;
  state?: string;
  startedAt?: string;
}

export interface GhPr {
  state?: string; // OPEN | MERGED | CLOSED
  isDraft?: boolean;
  statusCheckRollup?: RollupEntry[];
}

interface Check {
  name: string;
  status: "queued" | "in_progress" | "completed";
  conclusion: string; // lower case, "" until completed
  startedAt: number;
}

function normaliseChecks(rollup: RollupEntry[] | undefined): Map<string, Check> {
  const byName = new Map<string, Check>();
  for (const e of rollup ?? []) {
    let c: Check;
    if (e.__typename === "StatusContext" || (e.context && !e.name)) {
      const st = (e.state ?? "").toUpperCase();
      const completed = st === "SUCCESS" || st === "FAILURE" || st === "ERROR";
      c = { name: e.context ?? "?", status: completed ? "completed" : "queued", conclusion: completed ? (st === "SUCCESS" ? "success" : "failure") : "", startedAt: isoMs(e.startedAt) ?? 0 };
    } else {
      const st = (e.status ?? "").toUpperCase();
      c = {
        name: e.name ?? "?",
        status: st === "COMPLETED" ? "completed" : st === "IN_PROGRESS" ? "in_progress" : "queued",
        conclusion: (e.conclusion ?? "").toLowerCase(),
        startedAt: isoMs(e.startedAt) ?? 0,
      };
    }
    const prev = byName.get(c.name);
    if (!prev || c.startedAt >= prev.startedAt) byName.set(c.name, c); // a re-run replaces the older one
  }
  return byName;
}

export function mapPrChecks(pr: GhPr, wanted: string[] | null): ProbeResult {
  const all = normaliseChecks(pr.statusCheckRollup);
  const checks: Check[] = wanted
    ? wanted.map((n) => all.get(n) ?? { name: n, status: "queued", conclusion: "", startedAt: 0 })
    : [...all.values()];
  if (!checks.length) return { state: "pending", detail: "no checks reported yet" };
  const completed = checks.filter((c) => c.status === "completed");
  const failed = completed.filter((c) => !OK_CONCLUSIONS.has(c.conclusion));
  if (completed.length === checks.length) {
    return failed.length
      ? { state: "failed", detail: `failed: ${failed.slice(0, 3).map((c) => `${c.name} (${c.conclusion || "?"})`).join(", ")}`, exitCode: WAIT_EXIT.FAILED }
      : { state: "passed", detail: `${checks.length} check${checks.length === 1 ? "" : "s"} green`, exitCode: WAIT_EXIT.PASSED };
  }
  const running = checks.filter((c) => c.status === "in_progress");
  const progress = `${completed.length}/${checks.length} done`;
  const red = failed.length ? ` · ✗ ${failed[0].name}` : "";
  if (running.length) {
    const more = running.length > 1 ? ` +${running.length - 1}` : "";
    return { state: "running", detail: `${running[0].name} running${more} · ${progress}${red}` };
  }
  return { state: "queued", detail: `${checks.length - completed.length} queued · ${progress}${red}` };
}

export function mapPrMerged(pr: GhPr): ProbeResult {
  const st = (pr.state ?? "").toUpperCase();
  if (st === "MERGED") return { state: "passed", detail: "merged", exitCode: WAIT_EXIT.PASSED };
  if (st === "CLOSED") return { state: "failed", detail: "closed unmerged", exitCode: WAIT_EXIT.FAILED };
  return { state: "queued", detail: pr.isDraft ? "open (draft)" : "open" };
}

// ── GitHub Actions run ─────────────────────────────────────────────────

export interface GhRun {
  status?: string;
  conclusion?: string;
  name?: string;
  jobs?: Array<{ name?: string; status?: string; conclusion?: string }>;
}

export function mapRun(run: GhRun): ProbeResult {
  const status = (run.status ?? "").toLowerCase();
  const jobs = run.jobs ?? [];
  const done = jobs.filter((j) => (j.status ?? "").toLowerCase() === "completed");
  if (status === "completed") {
    const conclusion = (run.conclusion ?? "").toLowerCase();
    if (OK_CONCLUSIONS.has(conclusion)) return { state: "passed", detail: `${run.name ?? "run"} ${conclusion}`, exitCode: WAIT_EXIT.PASSED };
    const bad = done.filter((j) => !OK_CONCLUSIONS.has((j.conclusion ?? "").toLowerCase())).map((j) => j.name ?? "?");
    return { state: "failed", detail: `${conclusion || "failed"}${bad.length ? `: ${bad.slice(0, 3).join(", ")}` : ""}`, exitCode: WAIT_EXIT.FAILED };
  }
  if (status === "in_progress") {
    const cur = jobs.find((j) => (j.status ?? "").toLowerCase() === "in_progress");
    return { state: "running", detail: [cur?.name ? `${cur.name} running` : "", jobs.length ? `${done.length}/${jobs.length} jobs done` : ""].filter(Boolean).join(" · ") };
  }
  return { state: "queued", detail: status || "queued" };
}

// ── Targets ────────────────────────────────────────────────────────────

const JOB_NAME = /^[\w.@:-]+$/; // what devbox-status.py itself accepts
const REPO = /^[\w.-]+\/[\w.-]+$/;

export function parsePrRef(raw: string): { repo: string; number: number } | null {
  const m = /^(?:https:\/\/github\.com\/)?([\w.-]+(?:\/[\w.-]+)?)(?:#|\/pull\/)(\d+)\/?$/.exec(raw.trim());
  if (!m) return null;
  const repo = m[1].includes("/") ? m[1] : `Synap-core/${m[1]}`;
  return { repo, number: Number(m[2]) };
}

export function parseRunRef(raw: string, repoOpt?: string): { repo?: string; id: string } | null {
  const m = /^https:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/actions\/runs\/(\d+)/.exec(raw.trim());
  if (m) return { repo: m[1], id: m[2] };
  if (!/^\d+$/.test(raw.trim())) return null;
  const repo = repoOpt ? (repoOpt.includes("/") ? repoOpt : `Synap-core/${repoOpt}`) : undefined;
  if (repo && !REPO.test(repo)) return null;
  return { repo, id: raw.trim() };
}

// ── Probes (shell out; nothing printed) ────────────────────────────────

function run(cmd: string, args: string[], timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout: timeoutMs, maxBuffer: 32 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) reject(new Error(firstLine(String(stderr || "")) || firstLine(err.message)));
      else resolve(String(stdout));
    });
  });
}

export function devboxProbe(job: string, host: string, startedAt: number, graceMs: number): () => Promise<ProbeResult> {
  return async () => {
    const out = await run(
      "ssh",
      ["-n", "-o", "BatchMode=yes", "-o", "ConnectTimeout=10", host, `python3 ~/wt/devbox-status.py --json --name ${job}`],
      90_000
    );
    const d = JSON.parse(out) as DevboxDetail & { error?: string };
    if (d.error) throw new Error(`devbox: ${d.error}`);
    return mapDevbox(d, startedAt, graceMs);
  };
}

export function prProbe(repo: string, n: number, mode: "checks" | "merged", wanted: string[] | null): () => Promise<ProbeResult> {
  return async () => {
    const out = await run("gh", ["pr", "view", String(n), "-R", repo, "--json", "state,isDraft,statusCheckRollup"], 60_000);
    const pr = JSON.parse(out) as GhPr;
    return mode === "merged" ? mapPrMerged(pr) : mapPrChecks(pr, wanted);
  };
}

export function runProbe(id: string, repo?: string): () => Promise<ProbeResult> {
  return async () => {
    const args = ["run", "view", id, "--json", "status,conclusion,name,jobs"];
    if (repo) args.push("-R", repo);
    return mapRun(JSON.parse(await run("gh", args, 60_000)) as GhRun);
  };
}

// ── The loop ───────────────────────────────────────────────────────────

export interface WaitLoopOptions {
  kind: WaitKind;
  ref: string;
  label?: string;
  intervalMs: number;
  timeoutMs: number;
  sessionId: string | undefined;
  probe: () => Promise<ProbeResult>;
  /** Injected for tests. */
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  print?: (line: string) => void;
  pid?: number;
}

const MAX_PROBE_ERRORS = 3;


/** Poll until the probe says the target is finished, or the timeout. Returns the exit code. */
export async function waitLoop(o: WaitLoopOptions): Promise<number> {
  const now = o.now ?? Date.now;
  const sleep = o.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const print = o.print ?? ((l: string) => console.log(l));
  pruneWaits(o.sessionId, now());
  const startedAt = now();
  const head = waitName({ kind: o.kind, ref: o.ref, label: o.label ?? "" });
  const rec: WaitRecord = {
    id: `${startedAt.toString(36)}-${randomBytes(3).toString("hex")}`,
    kind: o.kind,
    ref: o.ref,
    label: o.label ?? "",
    pid: o.pid ?? process.pid,
    startedAt,
    probedAt: startedAt,
    changedAt: startedAt,
    state: "pending",
    detail: "",
    attempt: attemptFor(readWaits(o.sessionId), o.kind, o.ref),
    probeErrors: 0,
  };
  const save = () => {
    try {
      writeWait(o.sessionId, rec);
    } catch {
      /* the state file is for the status line; the wait itself goes on */
    }
  };
  save();
  if (rec.attempt >= 3) print(`${hhmm(startedAt)} ${head}: ${ordinal(rec.attempt)} wait on this target in this conversation`);

  let first = true;
  for (;;) {
    let next: ProbeResult | null = null;
    try {
      next = await o.probe();
      rec.probeErrors = 0;
    } catch (e) {
      rec.probeErrors++;
      if (rec.probeErrors >= MAX_PROBE_ERRORS && rec.state !== "error") {
        next = { state: "error", detail: `probe failed ${rec.probeErrors}× in a row: ${firstLine((e as Error).message, 100)}` };
      }
    }
    const t = now();
    rec.probedAt = t;
    if (next && (first || next.state !== rec.state || next.detail !== rec.detail)) {
      const was = stateAndDetail(rec.state, rec.detail);
      rec.state = next.state;
      rec.detail = next.detail;
      rec.changedAt = t;
      print(first ? `${hhmm(t)} ${head}: ${stateAndDetail(rec.state, rec.detail)}` : `${hhmm(t)} ${head}: ${was} → ${stateAndDetail(rec.state, rec.detail)}`);
      first = false;
    }
    if (next?.exitCode !== undefined) {
      rec.exitCode = next.exitCode;
      rec.finishedAt = t;
      save();
      print(`${hhmm(t)} ${head}: ${rec.state} after ${age(t - startedAt)}${rec.detail ? ` · ${rec.detail}` : ""} · exit ${rec.exitCode}`);
      return rec.exitCode;
    }
    if (t - startedAt >= o.timeoutMs) {
      const endedOnError = rec.state === "error";
      if (!endedOnError) {
        rec.detail = `gave up after ${age(t - startedAt)} at ${stateAndDetail(rec.state, rec.detail)}`;
        rec.state = "timeout";
      }
      rec.exitCode = endedOnError ? WAIT_EXIT.INFRA : WAIT_EXIT.TIMEOUT;
      rec.finishedAt = t;
      rec.changedAt = t;
      save();
      print(`${hhmm(t)} ${head}: ${stateAndDetail(rec.state, rec.detail)} · exit ${rec.exitCode}`);
      return rec.exitCode;
    }
    save();
    await sleep(Math.min(o.intervalMs, Math.max(1000, o.timeoutMs - (t - startedAt))));
  }
}

// ── CLI entry ──────────────────────────────────────────────────────────

export interface WaitCliOptions {
  interval?: string;
  timeout?: string;
  label?: string;
  host?: string;
  since?: string;
  for?: string;
  checks?: string;
  repo?: string;
}

function fail(msg: string): never {
  console.error(msg);
  process.exit(WAIT_EXIT.INFRA);
}

function durationOpt(v: string | undefined, fallback: number, flag: string): number {
  if (v !== undefined && /^0+(ms|s|m|h)?$/.test(v.trim())) return 0;
  const ms = parseDuration(v, fallback);
  if (ms === null) fail(`synap wait: ${flag} "${v}" is not a duration (e.g. 30s, 5m, 4h)`);
  return ms;
}

export async function waitCommand(kind: string, target: string, opts: WaitCliOptions): Promise<void> {
  const timeoutMs = durationOpt(opts.timeout, 4 * 3_600_000, "--timeout");
  const sessionId = process.env.CLAUDE_CODE_SESSION_ID || undefined;
  let probe: () => Promise<ProbeResult>;
  let ref: string;
  let k: WaitKind;
  let intervalMs: number;

  if (kind === "devbox") {
    if (!JOB_NAME.test(target)) fail(`synap wait devbox: "${target}" is not a devbox job name ([A-Za-z0-9_.@:-])`);
    const host = opts.host ?? "devbox";
    if (!/^[\w.@-]+$/.test(host)) fail(`synap wait devbox: --host "${host}" is not a host name`);
    intervalMs = durationOpt(opts.interval, 30_000, "--interval");
    const graceMs = durationOpt(opts.since, 120_000, "--since");
    k = "devbox";
    ref = target;
    probe = devboxProbe(target, host, Date.now(), graceMs);
  } else if (kind === "pr") {
    const pr = parsePrRef(target);
    if (!pr || !REPO.test(pr.repo)) fail(`synap wait pr: "${target}" is not <owner/repo|repo>#<number>`);
    const mode = opts.for ?? "checks";
    if (mode !== "checks" && mode !== "merged") fail(`synap wait pr: --for must be checks or merged, not "${mode}"`);
    const wanted = opts.checks ? opts.checks.split(",").map((s) => s.trim()).filter(Boolean) : null;
    intervalMs = durationOpt(opts.interval, 60_000, "--interval");
    k = "pr";
    ref = `${pr.repo}#${pr.number}${mode === "merged" ? " merged" : ""}`;
    probe = prProbe(pr.repo, pr.number, mode, wanted);
  } else if (kind === "run") {
    const r = parseRunRef(target, opts.repo);
    if (!r) fail(`synap wait run: "${target}" is not a run URL or a run id (with -R owner/repo)`);
    intervalMs = durationOpt(opts.interval, 60_000, "--interval");
    k = "run";
    ref = `${r.repo ?? "."} run ${r.id}`;
    probe = runProbe(r.id, r.repo);
  } else {
    fail(`synap wait: unknown kind "${kind}" (devbox, pr or run)`);
  }

  const code = await waitLoop({ kind: k, ref, label: opts.label, intervalMs: Math.max(intervalMs, 1000), timeoutMs, sessionId, probe });
  process.exit(code);
}
