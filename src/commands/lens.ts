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
import { log } from "../utils/logger.js";
import { type BaseOpts } from "./data.js";

function requireClaudeSession(): string {
  const id = getClaudeSessionId();
  if (!id) {
    console.error(chalk.red("Not in a Claude Code session (CLAUDE_CODE_SESSION_ID unset)."));
    log.dim("Project/session lenses are per-Claude-session. Use `synap use` for the global workspace.");
    process.exit(1);
  }
  return id;
}

export async function useProject(projectId: string, opts: BaseOpts): Promise<void> {
  const session = requireClaudeSession();
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
  writeLens(session, { projectId });
  if (opts.json) {
    console.log(JSON.stringify({ projectId, name, scope: "session" }, null, 2));
    return;
  }
  log.success(`Project focus: ${chalk.bold(name)} ${chalk.dim("(this session)")}`);
}

export async function clearProject(opts: BaseOpts): Promise<void> {
  const session = requireClaudeSession();
  clearLensField(session, "projectId");
  if (opts.json) {
    console.log(JSON.stringify({ cleared: "projectId" }));
    return;
  }
  log.success("Project focus cleared (this session)");
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
  console.log(chalk.bold("Session lens"), chalk.dim(session.slice(0, 8)));
  console.log(`  Workspace: ${lens?.workspaceId ? chalk.white(lens.workspaceId) : chalk.dim("— (global default)")}`);
  console.log(`  Project:   ${lens?.projectId ? chalk.white(lens.projectId) : chalk.dim("— none")}`);
  console.log(`  Session:   ${lens?.focusSessionId ? chalk.white(lens.focusSessionId) : chalk.dim("— none")}`);
}
