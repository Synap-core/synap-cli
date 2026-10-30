/**
 * The state files `synap wait` writes, and the status line reads.
 *
 * One file per wait: `~/.synap/waits/<conversation>/<id>.json`, where the
 * conversation is the Claude Code session id the wait ran under
 * (`CLAUDE_CODE_SESSION_ID`, set in every Bash command an agent runs) or
 * `_nosession`. The wait rewrites its file after every probe (tmp + rename,
 * so a reader never sees half a file); the status line only ever reads.
 *
 * Local files only, no network: the status line renders from these.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export type WaitKind = "devbox" | "pr" | "run";

/** A wait is over once it carries `exitCode` (and `finishedAt`); `error` can be either. */
export type WaitState =
  | "pending" // asked for, not on the devbox / GitHub yet
  | "queued"
  | "running"
  | "passed"
  | "failed"
  | "infra"
  | "error" // 3 probes in a row failed; the wait keeps polling, and ends on it (exit 3) at its timeout
  | "timeout";

export function isFinal(w: Pick<WaitRecord, "exitCode">): boolean {
  return typeof w.exitCode === "number";
}

export interface WaitRecord {
  id: string;
  kind: WaitKind;
  /** Normalised target: the devbox job name, `owner/repo#n`, `owner/repo run <id>`. */
  ref: string;
  label: string;
  pid: number;
  startedAt: number; // ms
  probedAt: number; // ms, last probe (successful or not)
  changedAt: number; // ms, last change of `state` or `detail`
  state: WaitState;
  detail: string;
  /** 1 + the earlier waits in this conversation for the same kind+ref: the "looping" signal. */
  attempt: number;
  probeErrors: number; // consecutive failed probes
  exitCode?: number;
  finishedAt?: number; // ms
}

const PRUNE_AFTER_MS = 24 * 60 * 60_000;

export function waitsRoot(): string {
  return path.join(os.homedir(), ".synap", "waits");
}

/** A session id as a directory name: anything outside [A-Za-z0-9_-] is dropped. */
export function safeSessionDir(sessionId: string | undefined): string {
  const clean = (sessionId ?? "").replace(/[^A-Za-z0-9_-]/g, "");
  return clean || "_nosession";
}

export function waitsDir(sessionId: string | undefined): string {
  return path.join(waitsRoot(), safeSessionDir(sessionId));
}

/** Every readable wait file of one conversation. A file that does not parse is skipped. */
export function readWaits(sessionId: string | undefined): WaitRecord[] {
  const dir = waitsDir(sessionId);
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return [];
  }
  const out: WaitRecord[] = [];
  for (const n of names) {
    if (!n.endsWith(".json")) continue;
    try {
      const rec = JSON.parse(fs.readFileSync(path.join(dir, n), "utf-8")) as WaitRecord;
      if (rec && typeof rec.id === "string" && typeof rec.state === "string") out.push(rec);
    } catch {
      /* a file mid-write by an older writer, or not ours */
    }
  }
  return out;
}

/** Atomic: write a sibling tmp file, then rename it over the target. */
export function writeWait(sessionId: string | undefined, rec: WaitRecord): void {
  const dir = waitsDir(sessionId);
  fs.mkdirSync(dir, { recursive: true });
  const target = path.join(dir, `${rec.id}.json`);
  const tmp = `${target}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(rec));
  fs.renameSync(tmp, target);
}

/** 1 + the earlier waits (any state) in this conversation for the same kind+ref. */
export function attemptFor(existing: WaitRecord[], kind: WaitKind, ref: string): number {
  return 1 + existing.filter((w) => w.kind === kind && w.ref === ref).length;
}

/**
 * Remove waits that finished more than 24 h ago, and non-final ones whose
 * process is gone and whose last probe is that old. Best-effort.
 */
export function pruneWaits(sessionId: string | undefined, now = Date.now()): void {
  const dir = waitsDir(sessionId);
  for (const w of readWaits(sessionId)) {
    const old = isFinal(w)
      ? now - (w.finishedAt ?? w.probedAt) > PRUNE_AFTER_MS
      : now - w.probedAt > PRUNE_AFTER_MS && !pidAlive(w.pid);
    if (!old) continue;
    try {
      fs.unlinkSync(path.join(dir, `${w.id}.json`));
    } catch {
      /* already gone */
    }
  }
}

export function pidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    // EPERM: the process exists, it is just not ours to signal.
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** How a wait is named on screen: its label, else kind + target without the Synap-core owner. */
export function waitName(w: Pick<WaitRecord, "kind" | "ref" | "label">): string {
  return w.label || `${w.kind} ${w.ref.replace(/^Synap-core\//, "")}`;
}

/**
 * A state and its detail in one phrase, never saying the state twice:
 * "running (be-file · 1/2 done)", but "queued 2nd (light)" and
 * "Release gate running · 2/4 done" as they are.
 */
export function stateAndDetail(state: string, detail: string): string {
  if (!detail) return state;
  return new RegExp(`\\b${state}\\b`).test(detail) ? detail : `${state} (${detail})`;
}
