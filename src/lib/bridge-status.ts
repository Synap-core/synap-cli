/**
 * The status line's 4th line from the pod, through the synap-bridge plugin's
 * per-conversation status file (bridge 0.10, plan P3.3).
 *
 * After each read of the bound session the bridge writes
 * `~/.synap/bridge/status/<Claude Code session id>.json`, whole (tmp + `mv -f`,
 * so a reader never sees half a file): `{ v: 1, writtenAt, sessionId, title,
 * live, nextMove, waitingOn, workUnits }`, each from the session's
 * continuation packet. A section the pod could not read is `null`, never
 * empty; `sessionId: null` = nothing is bound. The writer is the bridge's
 * `statusFile` (synap-bridge `hooks/lib.ts`).
 *
 * The file is the FIRST source of what the conversation waits on; the
 * transcript index (lib/now-line.ts) stays the fallback whenever the file is
 * absent, unbound, stale or unreadable. The turn state itself (working /
 * needs you / stopped) stays Claude Code's registry when it is readable: the
 * pod's `live` is the bridge's relay of that same registry, smoothed by the
 * pod's 5-minute rule, so it is used only when the registry is not there.
 *
 *   ▶ working · 4m · ⏳ 2 · other work (2) · synap-cli#52 open ✗
 *   ⏳ waiting on 3 · other work (2) · approval · synap-cli#52 open ✓
 *   ■ stopped · next: Produce "Wave 2 report" · pod 40m ago
 *
 * Local files only, no network. `readBridgeStatus` never throws;
 * `buildBridgeLine` is pure.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { WAITING_ON_REASON_LABELS, goalWord } from "./goal-words.js";
import { age, capped, clip, DEFAULT_WIDTH, type RegistryEntry } from "./now-line.js";

const G = "\x1b[32m"; // green
const R = "\x1b[31m"; // red
const C = "\x1b[36m"; // cyan
const A = "\x1b[33m"; // amber
const Y = "\x1b[01;33m"; // yellow bold
const D = "\x1b[2m"; // dim
const X = "\x1b[0m"; // reset

/** The pod's working window (`SESSION_WORKING_WINDOW_MS`), for a file whose `live` carries none. */
export const POD_WORKING_WINDOW_MS = 5 * 60_000;
/**
 * A file older than this is stale even when no registry says when this
 * Claude Code process started: beyond half a day nothing shows its writer
 * still runs. A quiet file younger than this is still true (the bridge
 * rewrites it on every change the pod's feed sends), and its age is shown.
 */
export const BRIDGE_STATUS_MAX_AGE_MS = 12 * 60 * 60_000;

export interface WaitingOnMark {
  reason: string;
  count: number;
  refs?: Array<{ kind?: string; id?: string; label?: string }>;
}

export interface BridgeWorkUnit {
  key: string | null;
  label: string;
  kind: string;
  url: string | null;
  state: string;
  /** `{ status: "ok", label, state, checks? }` or `{ status: "unavailable", reason }`; null = none recorded. */
  prState: { status?: string; label?: string; state?: string; checks?: string } | null;
}

/** Version 1 of the file, as the bridge writes it. */
export interface BridgeStatusFile {
  v: 1;
  writtenAt: string;
  sessionId: string | null;
  title: string | null;
  live: {
    state: "working" | "idle";
    turnInFlight: boolean;
    since: string | null;
    lastActivityAt: string | null;
    measuredAt: string;
    windowMs: number;
  } | null;
  nextMove: { kind: string; actor: string; label: string; reason: string } | null;
  waitingOn: WaitingOnMark[] | null;
  workUnits: BridgeWorkUnit[] | null;
}

/**
 * What reading the file found. Only `fresh` is drawn; every other answer falls
 * back to the transcript index. `absent` and `unbound` are normal (no bridge,
 * nothing bound) and say nothing; `failed` (unreadable or malformed) is a
 * failed read the line marks, never folded into "absent".
 */
export type BridgeStatusRead =
  | { status: "fresh"; file: BridgeStatusFile; writtenAt: number }
  | { status: "absent" }
  | { status: "unbound" }
  | { status: "stale"; why: string }
  | { status: "failed"; why: string };

export function bridgeStatusPath(claudeSessionId: string, home = os.homedir()): string {
  return path.join(home, ".synap", "bridge", "status", `${claudeSessionId}.json`);
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const isTime = (v: unknown): v is string => typeof v === "string" && Number.isFinite(Date.parse(v));
const isStrOrNull = (v: unknown) => v === null || typeof v === "string";

/** The parsed JSON as a version-1 file, or why it is not one. */
export function parseBridgeStatus(json: unknown): BridgeStatusFile | string {
  if (!isObj(json)) return "not an object";
  if (json.v !== 1) return `version ${JSON.stringify(json.v)} is not 1`;
  if (!isTime(json.writtenAt)) return "no writtenAt time";
  if (!isStrOrNull(json.sessionId)) return "sessionId is not a string";
  if (!isStrOrNull(json.title ?? null)) return "title is not a string";
  const live = json.live ?? null;
  if (live !== null && (!isObj(live) || !isTime(live.measuredAt) || typeof live.windowMs !== "number")) return "live is malformed";
  const next = json.nextMove ?? null;
  if (next !== null && (!isObj(next) || typeof next.label !== "string")) return "nextMove is malformed";
  const waits = json.waitingOn ?? null;
  if (waits !== null && (!Array.isArray(waits) || !waits.every((m) => isObj(m) && typeof m.reason === "string" && typeof m.count === "number")))
    return "waitingOn is malformed";
  const units = json.workUnits ?? null;
  if (units !== null && (!Array.isArray(units) || !units.every((u) => isObj(u) && typeof u.label === "string" && typeof u.state === "string")))
    return "workUnits is malformed";
  return {
    v: 1,
    writtenAt: json.writtenAt,
    sessionId: json.sessionId as string | null,
    title: (json.title as string | null | undefined) ?? null,
    live,
    nextMove: next,
    waitingOn: waits,
    workUnits: units,
  } as BridgeStatusFile;
}

/**
 * This conversation's status file, judged. Stale when it was written before
 * this Claude Code process started (`startedAt`, from the registry: the
 * bridge of an earlier process wrote it, and this one has not confirmed the
 * binding yet), or is older than BRIDGE_STATUS_MAX_AGE_MS. Never throws.
 */
export function readBridgeStatus(
  claudeSessionId: string,
  opts: { now: number; startedAt?: number; home?: string },
): BridgeStatusRead {
  // A session id becomes a file name: anything that could leave the directory is no file.
  if (!/^[A-Za-z0-9_-]+$/.test(claudeSessionId)) return { status: "absent" };
  let raw: string;
  try {
    raw = fs.readFileSync(bridgeStatusPath(claudeSessionId, opts.home), "utf-8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return { status: "absent" };
    return { status: "failed", why: `unreadable (${(e as NodeJS.ErrnoException).code ?? "error"})` };
  }
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return { status: "failed", why: "not JSON" };
  }
  const file = parseBridgeStatus(json);
  if (typeof file === "string") return { status: "failed", why: file };
  const writtenAt = Date.parse(file.writtenAt);
  if (opts.startedAt && writtenAt < opts.startedAt) return { status: "stale", why: "written before this Claude Code process started" };
  if (opts.now - writtenAt > BRIDGE_STATUS_MAX_AGE_MS) return { status: "stale", why: `written ${age(opts.now - writtenAt)} ago` };
  if (file.sessionId === null) return { status: "unbound" };
  return { status: "fresh", file, writtenAt };
}

// ── The line ───────────────────────────────────────────────────────────

/** One mark: `other work (2)`, words through the vocabulary's table (goal-words.ts). */
function markText(m: WaitingOnMark): string {
  const reason = goalWord(WAITING_ON_REASON_LABELS, m.reason).toLowerCase();
  return m.count > 1 ? `${reason} (${m.count})` : reason;
}

function osc8(url: string | null, text: string): string {
  return url ? `\x1b]8;;${url}\x1b\\${text}\x1b]8;;\x1b\\` : text;
}

/** A pull request still under way: `synap-cli#52 open ✗`, its name a link to it. */
function unitText(u: BridgeWorkUnit): string | null {
  const isPr = u.kind === "pull_request" || /\/pull\/\d+/.test(u.url ?? "");
  if (!isPr || (u.state !== "open" && u.state !== "claimed")) return null;
  const name = osc8(u.url, /^\S+#\d+/.exec(u.label)?.[0] ?? clip(u.label, 30));
  const p = u.prState;
  if (!p) return name; // the pod recorded nothing about it: draw nothing, never a guess
  if (p.status !== "ok") return `${name} ${D}⚑ not read${X}`;
  const word = (p.label ?? p.state ?? "").toLowerCase();
  const checks = p.checks === "passed" ? ` ${G}✓${X}` : p.checks === "failed" ? ` ${R}✗${X}` : "";
  return `${name}${word ? ` ${D}${word}${X}` : ""}${checks}`;
}

/** The pod's rule (`isSessionWorkingNow`) on the file's `live`, judged now. */
export function podWorking(live: NonNullable<BridgeStatusFile["live"]>, now: number): boolean {
  if (live.turnInFlight) return true;
  const last = live.lastActivityAt ? Date.parse(live.lastActivityAt) : NaN;
  return Number.isFinite(last) && now - last <= (live.windowMs || POD_WORKING_WINDOW_MS);
}

export interface BridgeLineInput {
  now: number;
  file: BridgeStatusFile;
  writtenAt: number;
  registry: RegistryEntry | null;
  width?: number;
}

/** The 4th line from a fresh status file. */
export function buildBridgeLine(input: BridgeLineInput): string {
  const { now, file, registry } = input;
  const width = input.width && input.width > 20 ? input.width : DEFAULT_WIDTH;

  if (registry?.status === "waiting") {
    return `${Y}✋ needs you${X} ${D}·${X} ${clip(registry.waitingFor || "your answer", width - 16)}`;
  }

  const marks = (file.waitingOn ?? []).filter((m) => m.count > 0);
  const waited = marks.reduce((n, m) => n + m.count, 0);
  const units = (file.workUnits ?? []).map(unitText).filter((t): t is string => t !== null);
  const unread = [file.waitingOn === null && "waits", file.workUnits === null && "PRs"].filter(Boolean);

  // The registry's turn state when there is one; the pod's relay of it otherwise.
  let working = false;
  let since: number | undefined;
  if (registry) {
    working = registry.status === "busy";
    since = registry.statusUpdatedAt;
  } else if (file.live) {
    working = podWorking(file.live, now);
    const at = Date.parse((working ? file.live.since : file.live.lastActivityAt) ?? "");
    since = Number.isFinite(at) ? at : undefined;
  }

  const items: string[] = [...marks.map(markText), ...units];
  if (!working && file.nextMove?.label) items.push(`${D}next:${X} ${clip(file.nextMove.label, 60)}`);
  if (unread.length) items.push(`${D}⚑ not read: ${unread.join(", ")}${X}`);
  // A quiet file is still true, but say how old the pod's word is.
  if (now - input.writtenAt > POD_WORKING_WINDOW_MS) items.push(`${D}pod ${age(now - input.writtenAt)} ago${X}`);

  let head: string;
  if (working) {
    head = `${C}▶ working${X}${since ? ` ${D}· ${age(now - since)}${X}` : ""}${waited ? ` ${D}·${X} ⏳ ${waited}` : ""}`;
  } else if (waited) {
    head = `${Y}⏳ waiting on ${waited}${X}`;
  } else if (!registry && !file.live) {
    head = `${D}○ no session status${X}`;
  } else {
    head = `${A}■ stopped${X}${since ? ` ${D}· ${age(now - since)}${X}` : ""}`;
  }
  return capped(head, items, width);
}
