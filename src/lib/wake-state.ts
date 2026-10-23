/**
 * The wake hook's memory between runs — `~/.synap/wake/<key>.json`.
 *
 * Claude Code runs an `asyncRewake` Stop hook as a NEW background process on
 * every Stop, and never kills the previous one ("Each execution creates a
 * separate background process", code.claude.com/docs/en/hooks). So two waiters
 * for one terminal overlap whenever the person types again before the first
 * gives up. This file keeps them honest:
 *
 *   - `owner`: the newest waiter's token. An older waiter sees it change and
 *     exits quietly at its next read — the terminal has one doorbell, not two.
 *   - `since`: the feed cursor, so the next run resumes where the last one
 *     read (never a replay, never a gap) — the pod's `nextSince`.
 *   - `delivered`: event ids already handed to the agent, so an older waiter
 *     whose read was in flight and a newer one cannot both wake it for the
 *     same event.
 *   - `carried`: events read (and so marked read by the pod) that do not wake
 *     — an fyi, a done, a held wake — kept until the next wake shows them.
 *
 * Best-effort by design: a lost write costs at most one duplicate line, and a
 * file that cannot be read is a fresh start, never a crash in someone's hook.
 * The read-modify-writes are unlocked: two waiters racing inside the same
 * milliseconds can both wake the agent once.
 *
 * Stated limits, both from the pod's contract rather than this file:
 *   - the pod marks a message read when it HANDS it out (there is no ack), so
 *     a hook killed between that read and its stderr write (the session ended,
 *     the hook's timeout) loses that one wake — the message stays in the room;
 *   - after the first run the hook reads in CURSOR mode (`since`), which sees
 *     owner messages written while the agent worked its turn, but not a post
 *     whose row commits after a concurrent read already moved the cursor past
 *     its timestamp (unread mode would; it would also drop those owner messages).
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { writeFileAtomic } from "./atomic-file.js";
import type { SessionFeedEvent } from "./session-feed.js";

/** Ids remembered as delivered (the newest win). */
const DELIVERED_MAX = 200;
/** Events carried to the next wake (the newest win). */
const CARRIED_MAX = 20;

export interface WakeState {
  owner?: string;
  pid?: number;
  since?: string | null;
  delivered?: string[];
  carried?: SessionFeedEvent[];
  updatedAt?: string;
}

function wakeDir(): string {
  return path.join(os.homedir(), ".synap", "wake");
}

/** One file per (Claude Code conversation, focus session). */
export function wakeStatePath(conversationId: string | undefined, sessionId: string): string {
  const safe = (s: string) => s.replace(/[^a-zA-Z0-9_-]/g, "_");
  return path.join(wakeDir(), `${safe(conversationId ?? "terminal")}__${safe(sessionId)}.json`);
}

export function readWakeState(file: string): WakeState {
  try {
    const v = JSON.parse(fs.readFileSync(file, "utf8")) as unknown;
    return v && typeof v === "object" && !Array.isArray(v) ? (v as WakeState) : {};
  } catch {
    return {};
  }
}

function writeWakeState(file: string, state: WakeState): void {
  try {
    writeFileAtomic(file, JSON.stringify({ ...state, updatedAt: new Date().toISOString() }, null, 2) + "\n", {
      mode: 0o600,
    });
  } catch {
    /* best-effort — see the header */
  }
}

/** The later of two millisecond ISO cursors (they compare as strings). */
function laterCursor(a: string | null | undefined, b: string | null | undefined): string | null {
  if (!a) return b ?? null;
  if (!b) return a;
  return a > b ? a : b;
}

/** Claim the doorbell: this run becomes the owner. Returns its token. */
export function claimWake(file: string): string {
  const owner = randomBytes(8).toString("hex");
  writeWakeState(file, { ...readWakeState(file), owner, pid: process.pid });
  return owner;
}

export function isWakeOwner(file: string, owner: string): boolean {
  return readWakeState(file).owner === owner;
}

/** Advance the cursor (never backwards) and carry events that did not wake. */
export function recordRead(file: string, p: { since: string | null; carry?: SessionFeedEvent[] }): void {
  const s = readWakeState(file);
  const delivered = new Set(s.delivered ?? []);
  const carried = [...(s.carried ?? [])];
  for (const e of p.carry ?? []) {
    if (!delivered.has(e.id) && !carried.some((c) => c.id === e.id)) carried.push(e);
  }
  writeWakeState(file, {
    ...s,
    since: laterCursor(s.since, p.since),
    carried: carried.slice(-CARRIED_MAX),
  });
}

/**
 * Hand events to the agent: drop any already delivered (by another waiter),
 * mark the rest delivered, and release the carried ones with them. Returns
 * what to show; `events` empty = someone else already woke the agent for them.
 */
export function takeDelivery(
  file: string,
  p: { events: SessionFeedEvent[]; since: string | null }
): { events: SessionFeedEvent[]; carried: SessionFeedEvent[] } {
  const s = readWakeState(file);
  const delivered = new Set(s.delivered ?? []);
  const events = p.events;
  const carried = events.length > 0 ? (s.carried ?? []).filter((e) => !delivered.has(e.id)) : [];
  for (const e of [...events, ...carried]) delivered.add(e.id);
  writeWakeState(file, {
    ...s,
    since: laterCursor(s.since, p.since),
    delivered: [...delivered].slice(-DELIVERED_MAX),
    carried: events.length > 0 ? [] : s.carried,
  });
  return { events, carried: carried.filter((c) => !events.some((e) => e.id === c.id)) };
}
