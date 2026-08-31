import chalk from "chalk";
import { log } from "../utils/logger.js";
import {
  resolveHubConfig,
  hubGet,
  hubPatch,
  hubPost,
  attachActiveSessionId,
  detachActiveSessionId,
  resolveActiveSessionId,
  renderHubError,
  HubError,
} from "../lib/hub-client.js";
import { type BaseOpts } from "./data.js";

/** Human phrasing for where an attach landed — so scope is never a mystery. */
function describeAttachTarget(target: "session-lens" | "directory-lens"): string {
  return target === "session-lens"
    ? "in this Claude Code session (~/.synap/lenses)"
    : "in this working tree (.synap/lens.json)";
}

// ─── startSession ─────────────────────────────────────────────────────────────

export async function startSession(
  opts: BaseOpts & { goal: string; workspace?: string; taskId?: string; template?: string }
): Promise<void> {
  try {
    const cfg = await resolveHubConfig(opts);

    const workspaceId = opts.workspace || cfg.workspaceId;
    if (!workspaceId) {
      console.error(chalk.red("Error: --workspace <id> is required (or set active workspace with 'synap use')"));
      process.exit(1);
    }

    // Resolve caller userId from the hub key
    const me = (await hubGet("/users/me", {}, cfg)) as { id?: string };
    const userId = me?.id;
    if (!userId) {
      console.error(chalk.red("Error: could not resolve userId from /users/me"));
      process.exit(1);
    }

    const body: Record<string, unknown> = {
      workspaceId,
      userId,
      goal: opts.goal,
    };
    if (opts.taskId) body.correlationId = `task:${opts.taskId}`;
    if (opts.template) body.templateId = opts.template;

    const session = (await hubPost("/focus-sessions", body, cfg)) as Record<string, unknown>;

    if (opts.json) {
      console.log(JSON.stringify(session, null, 2));
      return;
    }

    const id = String(session.id ?? "");
    // Auto-attach: make this session active so the statusline and every scoped
    // call reflect it. Lands on the Claude-session lens inside Claude Code,
    // otherwise on this working tree's directory lens.
    const target = attachActiveSessionId(id);
    log.success(`Session started and attached`);
    console.log(`  ID:      ${chalk.bold(id)}`);
    console.log(`  Goal:    ${chalk.white(opts.goal)}`);
    if (opts.taskId) console.log(`  Task:    ${chalk.dim(opts.taskId)}`);
    log.dim(`  Active ${describeAttachTarget(target)}`);
    console.log();
    // Print the ID alone on a final line so scripts can grab it easily
    console.log(id);
  } catch (e) {
    renderHubError(e);
    process.exit(1);
  }
}

// ─── listSessions ─────────────────────────────────────────────────────────────

export async function listSessions(
  opts: BaseOpts & { workspace?: string; status?: string; limit?: string }
): Promise<void> {
  try {
    const cfg = await resolveHubConfig(opts);
    const params: Record<string, string | number | undefined> = {};
    // Fall back to the active workspace (config/env) like `start` does — the
    // focus-sessions REST requires workspaceId, and an operator with an active
    // workspace shouldn't have to repeat --workspace on every session command.
    const wsId = opts.workspace || cfg.workspaceId;
    if (wsId) params.workspaceId = wsId;
    if (opts.status) params.status = opts.status;
    if (opts.limit) params.limit = parseInt(opts.limit, 10);

    // The Hub REST GET /focus-sessions returns a bare array of sessions.
    // (Tolerate a { sessions: [...] } envelope too, for forward-compat.)
    const res = await hubGet("/focus-sessions", params, cfg);
    const sessions: unknown[] = Array.isArray(res)
      ? res
      : ((res as { sessions?: unknown[] })?.sessions ?? []);

    if (opts.json) {
      console.log(JSON.stringify(sessions, null, 2));
      return;
    }

    if (!sessions.length) {
      log.dim("No sessions found");
      return;
    }

    for (const s of sessions as Array<Record<string, unknown>>) {
      const status = String(s.status ?? "");
      const statusColor =
        status === "active"
          ? chalk.green(status)
          : status === "paused"
            ? chalk.yellow(status)
            : chalk.dim(status);
      const progress =
        typeof s.progress === "number" ? ` ${chalk.dim(`[${s.progress}%]`)}` : "";
      // Full id — feeds straight into `synap session get/update/attach <id>`.
      console.log(
        `  ${chalk.bold(String(s.id ?? ""))}  ${statusColor}${progress}  ${chalk.white(String(s.goal ?? ""))}`
      );
    }
  } catch (e) {
    renderHubError(e);
    process.exit(1);
  }
}

// ─── getSession ───────────────────────────────────────────────────────────────

/**
 * Fetch a focus session by id.
 *
 * Prefer GET without workspaceId so project-scoped sessions (workspaceId null)
 * resolve. Older pods still require the query param — if the bare GET fails
 * with 400 and we have a workspace, retry with it.
 */
async function fetchSessionById(
  id: string,
  cfg: Awaited<ReturnType<typeof resolveHubConfig>>,
  workspaceHint?: string
): Promise<Record<string, unknown>> {
  try {
    return (await hubGet(`/focus-sessions/${id}`, {}, cfg)) as Record<
      string,
      unknown
    >;
  } catch (e) {
    const wsId = workspaceHint || cfg.workspaceId;
    if (e instanceof HubError && e.status === 400 && wsId) {
      return (await hubGet(
        `/focus-sessions/${id}`,
        { workspaceId: wsId },
        cfg
      )) as Record<string, unknown>;
    }
    throw e;
  }
}

export async function getSession(
  id: string,
  opts: BaseOpts & { workspace?: string }
): Promise<void> {
  try {
    const cfg = await resolveHubConfig(opts);
    const res = await fetchSessionById(id, cfg, opts.workspace);

    if (opts.json) {
      console.log(JSON.stringify(res, null, 2));
      return;
    }

    const s = res;
    log.info(`Session  ${chalk.bold(String(s.id ?? ""))}`);
    console.log(`  Goal:       ${chalk.white(String(s.goal ?? ""))}`);
    console.log(`  Status:     ${chalk.cyan(String(s.status ?? ""))}`);
    // Project-scoped sessions have workspaceId null — show scope honestly.
    if (s.workspaceId != null && s.workspaceId !== "") {
      console.log(`  Workspace:  ${chalk.dim(String(s.workspaceId))}`);
    } else if (s.projectId) {
      console.log(`  Project:    ${chalk.dim(String(s.projectId))}  ${chalk.dim("(no workspace)")}`);
    } else {
      console.log(`  Scope:      ${chalk.dim("project/unscoped (workspace null)")}`);
    }
    if (s.projectId && s.workspaceId)
      console.log(`  Project:    ${chalk.dim(String(s.projectId))}`);
    if (typeof s.progress === "number") console.log(`  Progress:   ${s.progress}%`);
    if (s.templateId) console.log(`  Template:   ${chalk.dim(String(s.templateId))}`);
    if (Array.isArray(s.agentIds) && s.agentIds.length)
      console.log(`  Agents:     ${(s.agentIds as string[]).join(", ")}`);
    if (Array.isArray(s.expectedOutputs) && s.expectedOutputs.length)
      console.log(
        `  Outputs:    ${(s.expectedOutputs as Array<{ label: string }>).map((o) => o.label).join(", ")}`
      );
    if (s.correlationId)
      console.log(`  CorrelationId: ${chalk.dim(String(s.correlationId))}`);
  } catch (e) {
    renderHubError(e);
    process.exit(1);
  }
}

// ─── updateSession ────────────────────────────────────────────────────────────

export async function updateSession(
  id: string,
  opts: BaseOpts & { workspace?: string; progress?: string; status?: string; stage?: string; goal?: string }
): Promise<void> {
  try {
    const cfg = await resolveHubConfig(opts);

    const wsId = opts.workspace || cfg.workspaceId;
    if (!wsId) {
      console.error(chalk.red("Error: no active workspace — pass --workspace <id> or set one with `synap use`"));
      process.exit(1);
    }

    const body: Record<string, string | number | undefined> = { workspaceId: wsId };
    if (opts.progress !== undefined) body.progress = parseInt(opts.progress, 10);
    if (opts.status) body.status = opts.status;
    if (opts.stage) body.currentStage = opts.stage;
    if (opts.goal) body.goal = opts.goal;

    const res = await hubPatch(`/focus-sessions/${id}`, body, cfg);

    if (opts.json) {
      console.log(JSON.stringify(res, null, 2));
      return;
    }

    log.success(`Session updated  ${chalk.dim(id.slice(0, 8))}`);
    if (opts.progress !== undefined) log.dim(`  progress → ${opts.progress}%`);
    if (opts.status) log.dim(`  status → ${opts.status}`);
    if (opts.stage) log.dim(`  stage → ${opts.stage}`);
  } catch (e) {
    renderHubError(e);
    process.exit(1);
  }
}

// ─── attachSession ────────────────────────────────────────────────────────────

export async function attachSession(
  id: string,
  opts: BaseOpts
): Promise<void> {
  // Validate the session exists before attaching (project-scoped OK — no workspace required)
  try {
    const cfg = await resolveHubConfig(opts);
    await fetchSessionById(id, cfg, opts.workspace);
  } catch (e) {
    console.error(chalk.red("Error: session not found — " + (e as Error).message));
    process.exit(1);
  }
  const target = attachActiveSessionId(id);
  if (opts.json) {
    console.log(JSON.stringify({ ok: true, sessionId: id, scope: target }));
    return;
  }
  log.success(`Session attached  ${chalk.dim(id.slice(0, 8))}`);
  log.dim(`  Active ${describeAttachTarget(target)}`);
  log.dim(`  All hub calls in this terminal will tag X-Session-Id: ${id.slice(0, 8)}…`);
}

// ─── detachSession ────────────────────────────────────────────────────────────

export function detachSession(opts: { json?: boolean }): void {
  const current = detachActiveSessionId();
  if (opts.json) {
    console.log(JSON.stringify({ ok: true }));
    return;
  }
  if (current) {
    log.success(`Session detached  ${chalk.dim(current.slice(0, 8))}`);
  } else {
    log.dim("No active session to detach");
  }
}

// ─── sessionStatus ────────────────────────────────────────────────────────────

export function sessionStatus(opts: { json?: boolean }): void {
  const id = resolveActiveSessionId();
  if (opts.json) {
    console.log(JSON.stringify({ sessionId: id ?? null }));
    return;
  }
  if (id) {
    log.info(`Active session: ${chalk.bold(id.slice(0, 8))}…  ${chalk.dim("(SYNAP_SESSION_ID, session lens, or .synap/lens.json)")}`);
  } else {
    log.dim("No active session — run `synap session start` or `synap session attach <id>`");
  }
}

// ─── closeSession ─────────────────────────────────────────────────────────────

/** Pack shape returned by POST /focus-sessions/:id/complete (Gate 2). */
type CompletePackResult = {
  session?: Record<string, unknown>;
  pendingProposals?: Array<Record<string, unknown>>;
  counts?: { pending?: number; unfinishedOutputs?: number };
  warnings?: string[];
  status?: string;
  note?: string;
};

/**
 * Close a focus session via Hub complete (proposal pack).
 *
 * Prefer POST /focus-sessions/:id/complete with `{ summary }` from `--recap`.
 * On 404 (older pods without the route) fall back to PATCH status=closed and
 * write verificationReport.summary — graceful degrade, pack unavailable.
 *
 * --workspace is optional: complete loads the row by id; PATCH also scopes
 * from the row (workspaceId body is back-compat only).
 */
export async function closeSession(
  id: string,
  opts: BaseOpts & { workspace?: string; recap?: string }
): Promise<void> {
  try {
    const cfg = await resolveHubConfig(opts);
    const wsId = opts.workspace || cfg.workspaceId;

    let pack: CompletePackResult | null = null;
    let usedPack = false;

    try {
      // Canonical close: completeFocusSession — returns proposal pack.
      // Map CLI --recap → body.summary (server field; there is no `recap` key).
      const body: Record<string, unknown> = {};
      if (opts.recap) body.summary = opts.recap;
      pack = (await hubPost(
        `/focus-sessions/${id}/complete`,
        body,
        cfg
      )) as CompletePackResult;
      usedPack = true;
    } catch (e) {
      if (!(e instanceof HubError) || e.status !== 404) throw e;

      // Older pod: no complete route — close via PATCH and warn that pack is
      // unavailable. verificationReport.summary is the field the complete path
      // writes (complete-session.ts); UpdateBodySchema accepts it as z.unknown().
      log.dim(
        "Pack unavailable on this pod (POST …/complete → 404); falling back to status close."
      );
      const patchBody: Record<string, unknown> = { status: "closed" };
      if (wsId) patchBody.workspaceId = wsId;
      if (opts.recap) patchBody.verificationReport = { summary: opts.recap };
      await hubPatch(`/focus-sessions/${id}`, patchBody, cfg);
    }

    // Detach if this was the active terminal session
    if (resolveActiveSessionId(cfg.podUrl) === id) detachActiveSessionId(cfg.podUrl);

    if (opts.json) {
      if (usedPack && pack) {
        console.log(JSON.stringify(pack, null, 2));
      } else {
        console.log(
          JSON.stringify(
            {
              ok: true,
              status: "closed",
              pack: false,
              summary: opts.recap ?? null,
            },
            null,
            2
          )
        );
      }
      return;
    }

    const sessionStatus =
      (pack?.session && String(pack.session.status ?? "")) ||
      pack?.status ||
      "closed";
    log.success(
      `Session closed  ${chalk.dim(id.slice(0, 8))}  ${chalk.cyan(sessionStatus)}`
    );
    if (opts.recap) log.dim(`  recap: ${opts.recap}`);

    if (usedPack && pack) {
      const pending =
        pack.counts?.pending ??
        (Array.isArray(pack.pendingProposals) ? pack.pendingProposals.length : 0);
      const unfinished = pack.counts?.unfinishedOutputs ?? 0;
      console.log(
        `  Pack:       ${chalk.white(String(pending))} pending proposal(s)` +
          (unfinished > 0
            ? `  ${chalk.yellow(`${unfinished} unfinished output(s)`)}`
            : "")
      );
      if (Array.isArray(pack.warnings)) {
        for (const w of pack.warnings) {
          log.warn(String(w));
        }
      }
      if (pack.note) log.dim(`  ${pack.note}`);
      if (pending > 0) {
        log.dim(
          `  Review: synap proposals list --session ${id}`
        );
      }
    }
  } catch (e) {
    renderHubError(e);
    process.exit(1);
  }
}
