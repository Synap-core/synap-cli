/**
 * A small incremental index of what a Claude Code conversation has running in
 * the background, built from its transcript JSONL.
 *
 * The transcript is append-only and can pass 50 MB, so it is never re-read:
 * the index keeps the byte offset it has read up to, and each update reads only
 * what was appended since. Most lines are skipped by a substring test before
 * any JSON.parse. A file smaller than the offset (truncated or replaced) is
 * read again from 0.
 *
 * What opens and closes a background task (Claude Code 2.1.x transcripts):
 *  - a `tool_use` (Bash, Agent, Monitor), then its `tool_result` line whose
 *    `toolUseResult` names the task: Bash `backgroundTaskId` (also a command
 *    moved to the background by its timeout), Agent `status: "async_launched"`
 *    + `agentId`, Agent `status: "teammate_spawned"` (a teammate, keyed by
 *    agent id and known by name), Monitor `taskId`;
 *  - a `<task-notification>` (`<task-id>`, `<status>`, `<summary>`), in a
 *    user message or, when it arrives while a turn runs, in a
 *    `queue-operation` `enqueue` line (every notice is enqueued first; on
 *    2026-10-30, 79 of 153 in one transcript were never written in another
 *    form). It can name several tasks and can fire more than once for one
 *    agent: the last event wins;
 *  - a `TaskStop` tool_use (`input.task_id`);
 *  - a teammate goes idle with an `idle_notification` teammate message, and is
 *    busy again after a SendMessage to it succeeds; a SendMessage result with
 *    `resumedAgentId` reopens that agent.
 *
 * Pure apart from `loadIndex` / `saveIndex` / `updateIndex`, which touch only
 * `~/.synap/statusline/` and the transcript. Never the network.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export type TaskKind = "bash" | "agent" | "monitor" | "teammate";

export interface OpenTask {
  kind: TaskKind;
  description: string;
  command?: string;
  toolUseId: string;
  startedAt: number; // ms
  name?: string; // a teammate's or a named agent's name
}

export interface ClosedTask extends OpenTask {
  taskId: string;
  status: string; // completed | stopped | failed | killed | idle | …
  closedAt: number;
}

interface PendingLaunch {
  name: string; // the tool: Bash | Agent | Monitor | SendMessage
  description: string;
  command?: string;
  to?: string; // SendMessage target
  at: number;
}

export interface TranscriptIndex {
  v: 1;
  path: string;
  offset: number; // bytes read (always at a line boundary)
  size: number; // transcript size at the last read
  open: Record<string, OpenTask>; // taskId → task
  recentlyClosed: ClosedTask[]; // newest last, capped
  /** tool_use ids still waiting for their tool_result (capped). */
  pending: Record<string, PendingLaunch>;
  /** teammate name → agent id, so a later SendMessage or idle notice finds it. */
  teammates: Record<string, string>;
  lastEventAt: number; // ms of the newest line read that carried a timestamp
}

const MAX_PENDING = 100;
const MAX_OPEN = 50;
const MAX_CLOSED = 20;
const CHUNK = 4 * 1024 * 1024;

export function emptyIndex(transcriptPath: string): TranscriptIndex {
  return { v: 1, path: transcriptPath, offset: 0, size: 0, open: {}, recentlyClosed: [], pending: {}, teammates: {}, lastEventAt: 0 };
}

export function indexDir(): string {
  return path.join(os.homedir(), ".synap", "statusline");
}

function safeId(sessionId: string): string {
  return sessionId.replace(/[^A-Za-z0-9_-]/g, "") || "_nosession";
}

export function indexPath(sessionId: string): string {
  return path.join(indexDir(), `${safeId(sessionId)}.json`);
}

export function indexLockPath(sessionId: string): string {
  return path.join(indexDir(), `${safeId(sessionId)}.lock`);
}

/**
 * Where Claude Code keeps a conversation's transcript when stdin does not say:
 * `~/.claude/projects/<cwd with / and . replaced by ->/<session_id>.jsonl`.
 */
export function defaultTranscriptPath(cwd: string, sessionId: string): string {
  return path.join(os.homedir(), ".claude", "projects", cwd.replace(/[/.]/g, "-"), `${sessionId}.jsonl`);
}

export function loadIndex(sessionId: string): TranscriptIndex | null {
  try {
    const idx = JSON.parse(fs.readFileSync(indexPath(sessionId), "utf-8")) as TranscriptIndex;
    return idx && idx.v === 1 && typeof idx.offset === "number" ? idx : null;
  } catch {
    return null;
  }
}

export function saveIndex(sessionId: string, idx: TranscriptIndex): void {
  fs.mkdirSync(indexDir(), { recursive: true });
  const target = indexPath(sessionId);
  const tmp = `${target}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(idx));
  fs.renameSync(tmp, target);
}

// ── Line parsing ───────────────────────────────────────────────────────

function tsOf(o: Record<string, unknown>, fallback: number): number {
  const t = typeof o.timestamp === "string" ? Date.parse(o.timestamp) : NaN;
  return Number.isFinite(t) ? t : fallback;
}

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((c) => (c && typeof c === "object" && typeof (c as { text?: unknown }).text === "string" ? (c as { text: string }).text : ""))
      .join("\n");
  }
  return "";
}

function oneLine(s: string, max: number): string {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

function close(idx: TranscriptIndex, taskId: string, status: string, at: number): void {
  const task = idx.open[taskId] ?? idx.recentlyClosed.find((c) => c.taskId === taskId);
  delete idx.open[taskId];
  if (!task) return;
  idx.recentlyClosed = idx.recentlyClosed.filter((c) => c.taskId !== taskId);
  const { kind, description, command, toolUseId, startedAt, name } = task;
  idx.recentlyClosed.push({ kind, description, command, toolUseId, startedAt, name, taskId, status, closedAt: at });
  if (idx.recentlyClosed.length > MAX_CLOSED) idx.recentlyClosed.splice(0, idx.recentlyClosed.length - MAX_CLOSED);
}

function open(idx: TranscriptIndex, taskId: string, task: OpenTask): void {
  idx.recentlyClosed = idx.recentlyClosed.filter((c) => c.taskId !== taskId);
  idx.open[taskId] = task;
  const ids = Object.keys(idx.open);
  if (ids.length > MAX_OPEN) {
    ids.sort((a, b) => idx.open[a].startedAt - idx.open[b].startedAt);
    for (const id of ids.slice(0, ids.length - MAX_OPEN)) delete idx.open[id];
  }
}

/** Reopen a closed task (a resumed agent, a teammate given work), keeping what it was. */
function reopen(idx: TranscriptIndex, taskId: string, at: number): void {
  if (idx.open[taskId]) return;
  const prev = idx.recentlyClosed.find((c) => c.taskId === taskId);
  if (!prev) return;
  const { kind, description, command, toolUseId, name } = prev;
  open(idx, taskId, { kind, description, command, toolUseId, name, startedAt: at });
}

function addPending(idx: TranscriptIndex, id: string, p: PendingLaunch): void {
  idx.pending[id] = p;
  const ids = Object.keys(idx.pending);
  if (ids.length > MAX_PENDING) {
    ids.sort((a, b) => idx.pending[a].at - idx.pending[b].at);
    for (const x of ids.slice(0, ids.length - MAX_PENDING)) delete idx.pending[x];
  }
}

const NOTIFICATION = /<task-notification>([\s\S]*?)<\/task-notification>/g;
const TEAMMATE_MSG = /<teammate-message\b[^>]*>([\s\S]*?)<\/teammate-message>/g;

function applyNotifications(idx: TranscriptIndex, text: string, at: number): void {
  for (const m of text.matchAll(NOTIFICATION)) {
    const body = m[1];
    const status = /<status>([\s\S]*?)<\/status>/.exec(body)?.[1]?.trim() || "completed";
    for (const t of body.matchAll(/<task-id>([\s\S]*?)<\/task-id>/g)) {
      const id = t[1].trim();
      if (id && !id.startsWith("__")) close(idx, id, status, at); // "__orphan_summary…" is a scan marker
    }
  }
  for (const m of text.matchAll(TEAMMATE_MSG)) {
    const first = m[1].trim().split("\n")[0];
    if (!first.startsWith("{")) continue;
    try {
      const msg = JSON.parse(first) as { type?: string; from?: string };
      const agentId = msg.from ? idx.teammates[msg.from] : undefined;
      if (agentId && msg.type === "idle_notification") close(idx, agentId, "idle", at);
    } catch {
      /* a teammate message that only looks like JSON */
    }
  }
}

/** Apply one transcript line to the index. Cheap for the lines that matter to nothing. */
export function applyLine(idx: TranscriptIndex, line: string, now = Date.now()): void {
  const isAssistantToolUse = line.includes('"type":"assistant"') && line.includes('"type":"tool_use"');
  const isNotification = line.includes("<task-notification>") || line.includes("idle_notification");
  let isResult = false;
  if (!isAssistantToolUse && !isNotification && line.includes('"tool_result"')) {
    for (const id in idx.pending) {
      if (line.includes(id)) {
        isResult = true;
        break;
      }
    }
  }
  if (!isAssistantToolUse && !isNotification && !isResult) return;

  let o: Record<string, unknown>;
  try {
    o = JSON.parse(line) as Record<string, unknown>;
  } catch {
    return; // a torn or foreign line
  }
  const at = tsOf(o, now);
  if (at > idx.lastEventAt) idx.lastEventAt = at;
  const message = (o.message ?? {}) as { content?: unknown };

  if (o.type === "assistant" && Array.isArray(message.content)) {
    for (const c of message.content as Array<Record<string, unknown>>) {
      if (!c || c.type !== "tool_use" || typeof c.id !== "string") continue;
      const input = (c.input ?? {}) as Record<string, unknown>;
      const str = (k: string) => (typeof input[k] === "string" ? (input[k] as string) : "");
      switch (c.name) {
        case "Bash":
          addPending(idx, c.id, { name: "Bash", description: oneLine(str("description") || str("command"), 80), command: str("command").slice(0, 2000), at });
          break;
        case "Agent":
          addPending(idx, c.id, { name: "Agent", description: oneLine(str("description") || str("name") || "agent", 80), to: str("name") || undefined, at });
          break;
        case "Monitor":
          addPending(idx, c.id, { name: "Monitor", description: oneLine(str("description") || str("command") || "monitor", 80), command: str("command").slice(0, 2000), at });
          break;
        case "SendMessage":
          if (str("to")) addPending(idx, c.id, { name: "SendMessage", description: "", to: str("to"), at });
          break;
        case "TaskStop": {
          const id = str("task_id") || str("shell_id");
          if (id) close(idx, idx.teammates[id] ?? id, "stopped", at);
          break;
        }
      }
    }
    return;
  }

  // A notice that arrives while a turn runs is queued: its `enqueue` line is
  // the first (and often the only) record of it, before any user message.
  if (o.type === "queue-operation") {
    if (isNotification && o.operation === "enqueue" && typeof o.content === "string") applyNotifications(idx, o.content, at);
    return;
  }

  if (o.type !== "user") return;

  if (Array.isArray(message.content)) {
    const tr = (o.toolUseResult ?? {}) as Record<string, unknown>;
    for (const c of message.content as Array<Record<string, unknown>>) {
      if (!c || c.type !== "tool_result" || typeof c.tool_use_id !== "string") continue;
      const p = idx.pending[c.tool_use_id];
      if (!p) continue;
      delete idx.pending[c.tool_use_id];
      const base = { description: p.description, command: p.command, toolUseId: c.tool_use_id, startedAt: p.at };
      if (p.name === "Bash" && typeof tr.backgroundTaskId === "string") {
        open(idx, tr.backgroundTaskId, { kind: "bash", ...base });
      } else if (p.name === "Monitor" && typeof tr.taskId === "string") {
        open(idx, tr.taskId, { kind: "monitor", ...base });
      } else if (p.name === "Agent" && tr.status === "async_launched" && typeof tr.agentId === "string") {
        open(idx, tr.agentId, { kind: "agent", ...base, name: p.to });
      } else if (p.name === "Agent" && tr.status === "teammate_spawned" && typeof tr.agentId === "string") {
        const name = typeof tr.name === "string" ? tr.name : p.to;
        if (name) idx.teammates[name] = tr.agentId;
        open(idx, tr.agentId, { kind: "teammate", ...base, description: name ? `@${name}` : p.description, name });
      } else if (p.name === "SendMessage" && tr.success === true) {
        if (typeof tr.resumedAgentId === "string") reopen(idx, tr.resumedAgentId, at);
        const target = p.to ? idx.teammates[p.to.replace(/^@/, "")] ?? p.to : undefined;
        if (target) reopen(idx, target, at);
      }
    }
  }

  if (isNotification) applyNotifications(idx, textOf(message.content), at);
}

// ── Incremental read ───────────────────────────────────────────────────

export interface UpdateResult {
  index: TranscriptIndex;
  changed: boolean;
  /** Bytes still unread: more than `maxBytes` were pending, so nothing was read. */
  behind: number;
}

/**
 * Bring `prev` up to date with the transcript at `transcriptPath`, reading at
 * most `maxBytes` new bytes (render) or everything (the detached refresh,
 * `maxBytes: Infinity`, in 4 MB chunks). Complete lines only: a half-written
 * last line is left for the next update.
 */
export function updateIndex(
  prev: TranscriptIndex | null,
  transcriptPath: string,
  opts: { maxBytes: number; now?: number }
): UpdateResult {
  const now = opts.now ?? Date.now();
  let size: number;
  try {
    size = fs.statSync(transcriptPath).size;
  } catch {
    return { index: prev ?? emptyIndex(transcriptPath), changed: false, behind: 0 };
  }
  let idx = prev && prev.path === transcriptPath && size >= prev.offset ? prev : emptyIndex(transcriptPath);
  const rescanned = idx !== prev;
  const pending = size - idx.offset;
  if (pending <= 0) return { index: idx, changed: rescanned, behind: 0 };
  if (pending > opts.maxBytes) return { index: idx, changed: rescanned, behind: pending };

  idx = structuredClone(idx);
  let fd: number;
  try {
    fd = fs.openSync(transcriptPath, "r");
  } catch {
    return { index: idx, changed: rescanned, behind: pending };
  }
  try {
    let pos = idx.offset;
    let carry = Buffer.alloc(0);
    while (pos < size) {
      const buf = Buffer.alloc(Math.min(CHUNK, size - pos));
      const n = fs.readSync(fd, buf, 0, buf.length, pos);
      if (n <= 0) break;
      pos += n;
      const data = carry.length ? Buffer.concat([carry, buf.subarray(0, n)]) : buf.subarray(0, n);
      let start = 0;
      for (let nl = data.indexOf(0x0a, start); nl !== -1; nl = data.indexOf(0x0a, start)) {
        const line = data.toString("utf-8", start, nl);
        if (line) applyLine(idx, line, now);
        start = nl + 1;
      }
      idx.offset += start; // up to the last complete line of this chunk
      carry = Buffer.from(data.subarray(start));
    }
  } finally {
    fs.closeSync(fd);
  }
  idx.size = size;
  return { index: idx, changed: true, behind: 0 };
}
