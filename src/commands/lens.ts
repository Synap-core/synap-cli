/**
 * Per-Claude-session lens commands: `synap project use/clear` and `synap lens`.
 *
 * These bind the cross-cutting "project" dimension and let you inspect the
 * full lens (workspace + project + focus session) for the current Claude Code
 * session. All state lives in ~/.synap/lenses/<session_id>.json — no backend
 * change; the pod stays agnostic.
 */

import chalk from "chalk";
import { resolveHubConfig, hubGet } from "../lib/hub-client.js";
import { getClaudeSessionId, writeLens, clearLensField, resolveActiveLens } from "../lib/session-lens.js";
import { describeLens } from "../lib/describe-lens.js";
import { setActiveProjectId, clearActiveProjectId } from "../lib/pod.js";
import { log } from "../utils/logger.js";
import { type BaseOpts } from "./data.js";

function requireClaudeSession(): string {
  const id = getClaudeSessionId();
  if (!id) {
    console.error(chalk.red("Not in a Claude Code session (CLAUDE_CODE_SESSION_ID unset)."));
    log.dim("--session scoping is per-Claude-session. Drop --session to persist the project globally instead.");
    process.exit(1);
  }
  return id;
}

/**
 * Pin the active project — a peer lens to `synap use <workspace>`.
 * Default: DURABLE — persists to ~/.synap/config.json (activeProjectId), same
 * tier as `synap use`. Composes with a Claude session: when one is active, the
 * session lens is ALSO updated so `resolveActiveLens()` reflects it immediately
 * without waiting for the durable value to be re-read.
 * `--session`: ephemeral — scopes only this Claude Code session, like the old
 * behavior. Requires an active Claude Code session.
 */
export async function useProject(projectId: string, opts: BaseOpts & { session?: boolean }): Promise<void> {
  let name = projectId;
  try {
    const cfg = await resolveHubConfig(opts);
    const res = (await hubGet(`/projects?ids=${encodeURIComponent(projectId)}`, {}, cfg)) as {
      projects?: Array<{ id: string; name: string }>;
    };
    const match = res?.projects?.find((p) => p.id === projectId);
    if (match) name = match.name;
  } catch {
    /* validation is best-effort — accept the id regardless */
  }

  if (opts.session) {
    const session = requireClaudeSession();
    writeLens(session, { projectId });
    if (opts.json) {
      console.log(JSON.stringify({ projectId, name, scope: "session" }, null, 2));
      return;
    }
    log.success(`Project focus: ${chalk.bold(name)} ${chalk.dim("(this session)")}`);
    return;
  }

  // Default: mirror `synap use <workspace>` EXACTLY — inside a Claude Code
  // session, scope to THIS session's lens (concurrent sessions stay independent);
  // otherwise set the durable global default. `--session` (above) forces
  // session-scope and errors when there's no session. This keeps project and
  // workspace symmetric so a pin doesn't unexpectedly leak pod-wide from a session.
  const session = getClaudeSessionId();
  if (session) {
    writeLens(session, { projectId });
  } else {
    setActiveProjectId(projectId);
  }
  if (opts.json) {
    console.log(JSON.stringify({ projectId, name, scope: session ? "session" : "global" }, null, 2));
    return;
  }
  log.success(`Project focus: ${chalk.bold(name)} ${chalk.dim(session ? "(this session)" : "(persisted)")}`);
}

export async function clearProject(opts: BaseOpts & { session?: boolean }): Promise<void> {
  if (opts.session) {
    const session = requireClaudeSession();
    clearLensField(session, "projectId");
    if (opts.json) {
      console.log(JSON.stringify({ cleared: "projectId", scope: "session" }));
      return;
    }
    log.success("Project focus cleared (this session)");
    return;
  }

  clearActiveProjectId();
  const session = getClaudeSessionId();
  if (session) clearLensField(session, "projectId");
  if (opts.json) {
    console.log(JSON.stringify({ cleared: "projectId", scope: "global" }));
    return;
  }
  log.success("Project focus cleared");
}

export async function showLens(opts: BaseOpts): Promise<void> {
  const session = getClaudeSessionId();
  const lens = resolveActiveLens();
  if (opts.json) {
    console.log(JSON.stringify({ session, lens }, null, 2));
    return;
  }
  if (!session) {
    log.dim("Not in a Claude Code session.");
    return;
  }
  const described = describeLens({
    workspace: lens?.workspaceId ? { id: lens.workspaceId } : undefined,
    project: lens?.projectId ? { id: lens.projectId } : undefined,
    session: lens?.focusSessionId ? { id: lens.focusSessionId } : undefined,
  });
  console.log(chalk.bold("Session lens"), chalk.dim(session.slice(0, 8)));
  for (const { label, value, bound } of described.lines) {
    console.log(`  ${label}:${" ".repeat(Math.max(1, 10 - label.length))}${bound ? chalk.white(value) : chalk.dim(value)}`);
  }
}
