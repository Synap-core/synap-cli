/**
 * Per-Claude-session lens registry.
 *
 * Claude Code assigns each session (each tab / instance) a stable
 * `CLAUDE_CODE_SESSION_ID` — present BOTH in the bash env of the agent's
 * commands AND in the JSON the statusline receives on stdin. That shared id
 * lets us bind a per-session "lens" (which workspace / project / focus session
 * this session is working through) without any backend change: the pod stays
 * agnostic, the CLI layers session-scoped state on top.
 *
 * This is what makes concurrent Claude Code sessions independent — tab A on
 * workspace Builder + session X, tab B on workspace Marketing + session Y —
 * instead of all sharing one global `~/.synap/config.json` workspace.
 *
 * Registry: ~/.synap/lenses/<session_id>.json
 * Resolution precedence (highest first): explicit flag > session lens >
 *   env SYNAP_WORKSPACE_ID > global config activeWorkspaceId.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const LENS_DIR = path.join(os.homedir(), ".synap", "lenses");

export interface SessionLens {
  workspaceId?: string;
  projectId?: string;
  focusSessionId?: string;
  updatedAt?: number;
}

/** The current Claude Code session id, if we're running inside one. */
export function getClaudeSessionId(): string | undefined {
  // Set in the bash env of the agent's commands. The statusline gets the same
  // id from stdin and forwards it via SYNAP_LENS_SESSION when it spawns the
  // detached refresh (which has no Claude env of its own).
  return process.env.SYNAP_LENS_SESSION || process.env.CLAUDE_CODE_SESSION_ID || undefined;
}

function lensPath(sessionId: string): string {
  // session ids are UUIDs — safe as filenames, but sanitize defensively.
  const safe = sessionId.replace(/[^a-zA-Z0-9_-]/g, "_");
  return path.join(LENS_DIR, `${safe}.json`);
}

export function readLens(sessionId: string): SessionLens | null {
  try {
    return JSON.parse(fs.readFileSync(lensPath(sessionId), "utf-8")) as SessionLens;
  } catch {
    return null;
  }
}

/** Merge-write the lens for a session (creates the registry dir on demand). */
export function writeLens(sessionId: string, patch: Partial<SessionLens>): SessionLens {
  const prev = readLens(sessionId) ?? {};
  const next: SessionLens = { ...prev, ...patch, updatedAt: Date.now() };
  try {
    fs.mkdirSync(LENS_DIR, { recursive: true, mode: 0o700 });
    fs.writeFileSync(lensPath(sessionId), JSON.stringify(next, null, 2), { mode: 0o600 });
  } catch {
    /* best-effort */
  }
  return next;
}

/** Clear one field (or the whole lens) for a session. */
export function clearLensField(sessionId: string, field?: keyof SessionLens): void {
  const prev = readLens(sessionId);
  if (!prev) return;
  if (!field) {
    try { fs.unlinkSync(lensPath(sessionId)); } catch {}
    return;
  }
  delete prev[field];
  writeLens(sessionId, prev);
}

/** The active session's lens, or null if not in a Claude session / none set. */
export function resolveActiveLens(): SessionLens | null {
  const id = getClaudeSessionId();
  return id ? readLens(id) : null;
}
