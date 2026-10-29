/**
 * The status line's 4th line: what this conversation is doing NOW, and what it
 * is waiting on. Built only from local files (Claude Code's process registry,
 * the transcript index, `synap wait` state files): no network, ever.
 *
 *   ✋ needs you · permission prompt          the registry says it waits for the person
 *   ▶ working · 4m · ⏳ 2 · …                 a turn is running (open waits follow)
 *   ⏳ waiting on 2 · devbox w7 running · …    idle, with background work still open
 *   ■ stopped · nothing running · 12m         idle with nothing open: the cue to prompt
 *
 * `buildNowLine` is pure (time, liveness and width come in as arguments) so
 * every state is testable from fixtures.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { OpenTask } from "./transcript-index.js";
import { isFinal, type WaitRecord } from "./wait-state.js";

const G = "\x1b[32m"; // green
const R = "\x1b[31m"; // red
const C = "\x1b[36m"; // cyan
const A = "\x1b[33m"; // amber
const Y = "\x1b[01;33m"; // yellow bold
const D = "\x1b[2m"; // dim
const X = "\x1b[0m"; // reset

/** A passed wait stays on the line this long, then goes. */
export const PASSED_VISIBLE_MS = 10 * 60_000;
/** A failed / infra / error / timeout / died wait stays this long. */
export const FAILED_VISIBLE_MS = 30 * 60_000;
/** A wait whose state has not changed for this long is shown as stale. */
export const STALE_AFTER_MS = 30 * 60_000;
export const DEFAULT_WIDTH = 120;

// ── Claude Code's process registry ─────────────────────────────────────

export interface RegistryEntry {
  pid?: number;
  sessionId: string;
  status?: string; // busy | idle | waiting | shell | …
  waitingFor?: string;
  statusUpdatedAt?: number; // ms
  startedAt?: number; // ms, the Claude Code process start
}

/**
 * The registry file (`~/.claude/sessions/<pid>.json`) whose `sessionId` is
 * this conversation; the most recently updated one when a resumed
 * conversation left several. Null when there is none (or no registry at all).
 */
export function readRegistry(sessionId: string, dir = path.join(os.homedir(), ".claude", "sessions")): RegistryEntry | null {
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return null;
  }
  let best: RegistryEntry | null = null;
  for (const n of names) {
    if (!n.endsWith(".json")) continue;
    try {
      const e = JSON.parse(fs.readFileSync(path.join(dir, n), "utf-8")) as RegistryEntry;
      if (e?.sessionId !== sessionId) continue;
      if (!best || (e.statusUpdatedAt ?? 0) > (best.statusUpdatedAt ?? 0)) best = e;
    } catch {
      /* a file mid-write */
    }
  }
  return best;
}

// ── Formatting helpers ─────────────────────────────────────────────────

export function age(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h${String(m % 60).padStart(2, "0")}`;
  return `${Math.floor(h / 24)}d`;
}

export function ordinal(n: number): string {
  const t = n % 100;
  if (t >= 11 && t <= 13) return `${n}th`;
  return `${n}${({ 1: "st", 2: "nd", 3: "rd" } as Record<number, string>)[n % 10] ?? "th"}`;
}

// eslint-disable-next-line no-control-regex
const ANSI = /\x1b\[[0-9;]*m/g;
export function visibleLength(s: string): number {
  return [...s.replace(ANSI, "")].length;
}

function clip(s: string, max: number): string {
  const chars = [...s];
  return chars.length > max ? `${chars.slice(0, max - 1).join("")}…` : s;
}

// ── Items ──────────────────────────────────────────────────────────────

/** How one typed wait shows, or null when it is no longer worth a place. */
export function waitItem(w: WaitRecord, now: number, alive: (pid: number) => boolean): string | null {
  const name = clip(w.label || `${w.kind} ${w.ref.replace(/^Synap-core\//, "")}`, 40);
  const try3 = w.attempt >= 3 ? ` ${A}· ${ordinal(w.attempt)} try${X}` : "";
  const detail = w.detail ? ` ${clip(w.detail, 48)}` : "";
  if (isFinal(w)) {
    const since = now - (w.finishedAt ?? w.probedAt);
    if (w.state === "passed") {
      return since <= PASSED_VISIBLE_MS ? `${G}✓ ${name} passed${X} ${D}${age(since)} ago${X}${try3}` : null;
    }
    if (since > FAILED_VISIBLE_MS) return null;
    return `${R}✗ ${name} ${w.state}${detail}${X}${try3}`;
  }
  if (!alive(w.pid)) {
    if (now - w.probedAt > FAILED_VISIBLE_MS) return null;
    return `${R}✗ ${name} died${X} ${D}(the wait stopped at ${w.state})${X}${try3}`;
  }
  const waited = ` ${D}${age(now - w.startedAt)}${X}`;
  if (now - w.changedAt > STALE_AFTER_MS) {
    return `${A}${name} ${w.state}${detail} · no change ${age(now - w.changedAt)}${X}${try3}`;
  }
  if (w.state === "error" || w.state === "timeout" || w.state === "infra" || w.state === "failed") {
    return `${R}${name} ${w.state}${detail}${X}${waited}${try3}`;
  }
  if (w.state === "running") return `${C}${name} running${detail}${X}${waited}${try3}`;
  return `${D}${name} ${w.state}${detail}${X}${waited}${try3}`; // queued, pending
}

/** A background task is the typed wait it runs when its command is `synap wait …` for that wait's target. */
function runsWait(t: OpenTask, w: WaitRecord): boolean {
  const cmd = t.command ?? "";
  if (!/\bsynap\b[^|;&]*\bwait\s+(devbox|pr|run)\b/.test(cmd)) return false;
  if (!cmd.includes(`wait ${w.kind}`)) return false;
  const target = w.kind === "devbox" ? w.ref : /(?:#| run )(\d+)/.exec(w.ref)?.[1] ?? w.ref; // job name, PR number, run id
  return cmd.includes(target) && w.startedAt >= t.startedAt - 5_000;
}

export interface NowInput {
  now: number;
  registry: RegistryEntry | null;
  open: OpenTask[];
  waits: WaitRecord[];
  width?: number;
  /** When the registry has no status time: the transcript's last event. */
  lastActivityAt?: number;
  alive: (pid: number) => boolean;
}

/** Every item worth showing, typed waits first, as display strings. */
export function nowItems(input: NowInput): string[] {
  const { now, registry, open, waits, alive } = input;
  const items: string[] = [];
  const shownWaits: WaitRecord[] = [];
  for (const w of [...waits].sort((a, b) => a.startedAt - b.startedAt)) {
    const s = waitItem(w, now, alive);
    if (s) {
      items.push(s);
      shownWaits.push(w);
    }
  }
  // A task launched by an earlier Claude Code process died with it (Claude
  // Code marks it stopped on resume): only this process's tasks are open.
  const since = registry?.startedAt ?? 0;
  // A shell killed by hand (`kill`, a Monitor timeout) leaves no transcript
  // marker, so the index keeps it open. Claude Code itself knows: an ended
  // turn reads `shell` while a background shell is live and `idle` once none
  // is (seen 2026-10-29: every `idle` session's task outputs were held open by
  // no process; `shell` ones had live holders). So `idle` closes the shells.
  const shellsGone = registry?.status === "idle";
  for (const t of [...open].sort((a, b) => a.startedAt - b.startedAt)) {
    if (t.startedAt < since) continue;
    if (shellsGone && (t.kind === "bash" || t.kind === "monitor")) continue;
    if (waits.some((w) => runsWait(t, w))) continue; // shown once, as its typed wait
    items.push(`${clip(t.description || t.kind, 40)} ${D}${age(now - t.startedAt)}${X}`);
  }
  return items;
}

function capped(head: string, items: string[], width: number): string {
  let line = head;
  for (let i = 0; i < items.length; i++) {
    const rest = items.length - i - 1;
    const more = rest > 0 ? ` ${D}· +${rest} more${X}` : "";
    const next = `${line} ${D}·${X} ${items[i]}`;
    if (visibleLength(next) + visibleLength(more) > width && i > 0) {
      return `${line} ${D}· +${items.length - i} more${X}`;
    }
    line = next;
  }
  return line;
}

/** The 4th line. */
export function buildNowLine(input: NowInput): string {
  const { now, registry } = input;
  const width = input.width && input.width > 20 ? input.width : DEFAULT_WIDTH;
  const items = nowItems(input);
  const status = registry?.status;
  const since = registry?.statusUpdatedAt ?? input.lastActivityAt;

  if (status === "waiting") {
    return `${Y}✋ needs you${X} ${D}·${X} ${clip(registry?.waitingFor || "your answer", width - 16)}`;
  }
  if (status === "busy") {
    const head = `${C}▶ working${X}${since ? ` ${D}· ${age(now - since)}${X}` : ""}`;
    return items.length ? capped(`${head} ${D}·${X} ⏳ ${items.length}`, items, width) : head;
  }
  if (items.length) return capped(`${Y}⏳ waiting on ${items.length}${X}`, items, width);
  if (!registry) return `${D}○ no session status${X}`;
  // idle, shell (a turn ended) and any status this CLI does not know yet
  return `${A}■ stopped${X} ${D}· nothing running${since ? ` · ${age(now - since)}` : ""}${X}`;
}
