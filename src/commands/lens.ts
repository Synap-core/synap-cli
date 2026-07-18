/**
 * Per-Claude-session lens commands: `synap project use/clear` and `synap lens`.
 *
 * These bind the cross-cutting "project" dimension and let you inspect the
 * full lens (workspace + project + focus session) for the current Claude Code
 * session. All state lives in ~/.synap/lenses/<session_id>.json — no backend
 * change; the pod stays agnostic.
 */

import chalk from "chalk";
import { resolveHubConfig, hubGet, renderHubError } from "../lib/hub-client.js";
import { getClaudeSessionId, writeLens, clearLensField, resolveActiveLens } from "../lib/session-lens.js";
import { describeLens } from "../lib/describe-lens.js";
import { setActiveProjectId, clearActiveProjectId, getActiveProjectId } from "../lib/pod.js";
import { fetchProjects, createProject } from "../lib/project.js";
import { renderNextSteps, FLOW } from "../lib/next-steps.js";
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

  const steps = FLOW.afterProjectUse(name);

  if (opts.session) {
    const session = requireClaudeSession();
    writeLens(session, { projectId });
    if (opts.json) {
      console.log(JSON.stringify({ projectId, name, scope: "session", nextSteps: steps }, null, 2));
      return;
    }
    log.success(`Project focus: ${chalk.bold(name)} ${chalk.dim("(this session)")}`);
    renderNextSteps(steps);
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
    console.log(JSON.stringify({ projectId, name, scope: session ? "session" : "global", nextSteps: steps }, null, 2));
    return;
  }
  log.success(`Project focus: ${chalk.bold(name)} ${chalk.dim(session ? "(this session)" : "(persisted)")}`);
  renderNextSteps(steps);
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

/** The active project — session lens first, then the durable global default. */
function activeProjectId(): string | undefined {
  return resolveActiveLens()?.projectId || getActiveProjectId();
}

/**
 * List the projects on the active pod (mirrors `synap pods`) with an ACTIVE
 * marker on the currently-pinned one. Full ids are shown so they paste straight
 * into `synap project use <id>`. Degrades to an empty list offline.
 */
export async function projectList(opts: BaseOpts): Promise<void> {
  let projects: Awaited<ReturnType<typeof fetchProjects>> = [];
  try {
    const cfg = await resolveHubConfig(opts);
    projects = await fetchProjects(cfg);
  } catch (e) {
    if (opts.json) {
      console.log(JSON.stringify({ projects: [], activeProjectId: activeProjectId() ?? null, nextSteps: FLOW.afterProjectList() }, null, 2));
      return;
    }
    renderHubError(e);
    return;
  }

  const active = activeProjectId();
  const steps = FLOW.afterProjectList();

  if (opts.json) {
    console.log(
      JSON.stringify(
        {
          projects: projects.map((p) => ({ id: p.id, name: p.name, active: p.id === active })),
          activeProjectId: active ?? null,
          nextSteps: steps,
        },
        null,
        2
      )
    );
    return;
  }

  log.heading("Projects");
  if (projects.length === 0) {
    log.dim("No projects yet — a project is a company/initiative that ties workspaces together.");
    log.dim("Create one: synap project new <name>");
    return;
  }
  for (const p of projects) {
    const marker = p.id === active ? chalk.green("▶ ") : "  ";
    console.log(`  ${marker}${chalk.bold(p.name)}  ${chalk.dim(p.id)}`);
  }
  renderNextSteps(steps);
}

/**
 * Create a project on the active pod. Governance may queue it as a proposal
 * instead of creating it live — we distinguish and message accordingly. On a
 * live create, guides the user to pin it + add to it.
 */
export async function projectNew(
  name: string,
  opts: BaseOpts & { description?: string }
): Promise<void> {
  let created: Awaited<ReturnType<typeof createProject>>;
  try {
    const cfg = await resolveHubConfig(opts);
    created = await createProject(cfg, { name, description: opts.description });
  } catch (e) {
    renderHubError(e);
    process.exit(1);
  }

  const proposed = !created.id && Boolean(created.proposalId);
  const steps = created.id
    ? FLOW.afterProjectNew(name, created.id)
    : [{ command: "synap proposals list", why: `approve the queued creation of ${name}` }];

  if (opts.json) {
    console.log(
      JSON.stringify(
        { id: created.id ?? null, proposalId: created.proposalId ?? null, name, status: created.status ?? null, nextSteps: steps },
        null,
        2
      )
    );
    return;
  }

  if (proposed) {
    log.warn(`Project "${name}" isn't live yet — governance queued it for your approval.`);
    if (created.proposalId) log.hint(`Approve proposal ${created.proposalId.slice(0, 8)}, then retry pinning it.`);
    renderNextSteps(steps);
    return;
  }

  log.success(`Project created: ${chalk.bold(name)}${created.id ? chalk.dim(`  ${created.id}`) : ""}`);
  renderNextSteps(steps);
}
