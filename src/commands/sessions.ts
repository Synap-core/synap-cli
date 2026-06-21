import chalk from "chalk";
import { log } from "../utils/logger.js";
import {
  resolveHubConfig,
  hubGet,
  hubPatch,
  hubPost,
  writeActiveSessionId,
  clearActiveSessionId,
  readActiveSessionId,
} from "../lib/hub-client.js";
import { type BaseOpts } from "./data.js";

// ─── startSession ─────────────────────────────────────────────────────────────

export async function startSession(
  opts: BaseOpts & { goal: string; workspace?: string; taskId?: string }
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

    const session = (await hubPost("/focus-sessions", body, cfg)) as Record<string, unknown>;

    if (opts.json) {
      console.log(JSON.stringify(session, null, 2));
      return;
    }

    const id = String(session.id ?? "");
    // Auto-attach: make this session active for the current terminal
    writeActiveSessionId(id);
    log.success(`Session started and attached`);
    console.log(`  ID:      ${chalk.bold(id)}`);
    console.log(`  Goal:    ${chalk.white(opts.goal)}`);
    if (opts.taskId) console.log(`  Task:    ${chalk.dim(opts.taskId)}`);
    log.dim(`  Active in this terminal (.synap-session)`);
    console.log();
    // Print the ID alone on a final line so scripts can grab it easily
    console.log(id);
  } catch (e) {
    console.error(chalk.red("Error: " + (e as Error).message));
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

    const res = (await hubGet("/focus-sessions", params, cfg)) as {
      sessions?: unknown[];
    };
    const sessions = res?.sessions ?? [];

    if (opts.json) {
      console.log(JSON.stringify(res, null, 2));
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
      console.log(
        `  ${chalk.bold(String(s.id ?? "").slice(0, 8))}  ${statusColor}${progress}  ${chalk.white(String(s.goal ?? ""))}`
      );
    }
  } catch (e) {
    console.error(chalk.red("Error: " + (e as Error).message));
    process.exit(1);
  }
}

// ─── getSession ───────────────────────────────────────────────────────────────

export async function getSession(
  id: string,
  opts: BaseOpts & { workspace?: string }
): Promise<void> {
  try {
    const cfg = await resolveHubConfig(opts);
    const params: Record<string, string | number | undefined> = {};
    const wsId = opts.workspace || cfg.workspaceId;
    if (wsId) params.workspaceId = wsId;

    const res = await hubGet(`/focus-sessions/${id}`, params, cfg);

    if (opts.json) {
      console.log(JSON.stringify(res, null, 2));
      return;
    }

    const s = res as Record<string, unknown>;
    log.info(`Session  ${chalk.bold(String(s.id ?? ""))}`);
    console.log(`  Goal:       ${chalk.white(String(s.goal ?? ""))}`);
    console.log(`  Status:     ${chalk.cyan(String(s.status ?? ""))}`);
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
    console.error(chalk.red("Error: " + (e as Error).message));
    process.exit(1);
  }
}

// ─── updateSession ────────────────────────────────────────────────────────────

export async function updateSession(
  id: string,
  opts: BaseOpts & { workspace?: string; progress?: string; status?: string; goal?: string }
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
    if (opts.goal) body.goal = opts.goal;

    const res = await hubPatch(`/focus-sessions/${id}`, body, cfg);

    if (opts.json) {
      console.log(JSON.stringify(res, null, 2));
      return;
    }

    log.success(`Session updated  ${chalk.dim(id.slice(0, 8))}`);
    if (opts.progress !== undefined) log.dim(`  progress → ${opts.progress}%`);
    if (opts.status) log.dim(`  status → ${opts.status}`);
  } catch (e) {
    console.error(chalk.red("Error: " + (e as Error).message));
    process.exit(1);
  }
}

// ─── attachSession ────────────────────────────────────────────────────────────

export async function attachSession(
  id: string,
  opts: BaseOpts
): Promise<void> {
  // Validate the session exists before attaching
  try {
    const cfg = await resolveHubConfig(opts);
    const params: Record<string, string | number | undefined> = {};
    if (cfg.workspaceId) params.workspaceId = cfg.workspaceId;
    await hubGet(`/focus-sessions/${id}`, params, cfg);
  } catch (e) {
    console.error(chalk.red("Error: session not found — " + (e as Error).message));
    process.exit(1);
  }
  writeActiveSessionId(id);
  if (opts.json) {
    console.log(JSON.stringify({ ok: true, sessionId: id }));
    return;
  }
  log.success(`Session attached  ${chalk.dim(id.slice(0, 8))}`);
  log.dim(`  All hub calls in this terminal will tag X-Session-Id: ${id.slice(0, 8)}…`);
}

// ─── detachSession ────────────────────────────────────────────────────────────

export function detachSession(opts: { json?: boolean }): void {
  const current = readActiveSessionId();
  clearActiveSessionId();
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
  const id = readActiveSessionId();
  if (opts.json) {
    console.log(JSON.stringify({ sessionId: id ?? null }));
    return;
  }
  if (id) {
    log.info(`Active session: ${chalk.bold(id.slice(0, 8))}…  ${chalk.dim("(from .synap-session or SYNAP_SESSION_ID)")}`);
  } else {
    log.dim("No active session — run `synap session start` or `synap session attach <id>`");
  }
}

// ─── closeSession ─────────────────────────────────────────────────────────────

export async function closeSession(
  id: string,
  opts: BaseOpts & { workspace?: string; recap?: string }
): Promise<void> {
  try {
    const cfg = await resolveHubConfig(opts);

    const wsId = opts.workspace || cfg.workspaceId;
    if (!wsId) {
      console.error(chalk.red("Error: no active workspace — pass --workspace <id> or set one with `synap use`"));
      process.exit(1);
    }

    // Close via PATCH — the /focus-sessions/:id endpoint sets closedAt automatically
    // when status transitions to "closed"
    const body: Record<string, string | number | undefined> = { workspaceId: wsId, status: "closed" };

    await hubPatch(`/focus-sessions/${id}`, body, cfg);

    // Detach if this was the active terminal session
    if (readActiveSessionId() === id) clearActiveSessionId();

    if (opts.json) {
      console.log(JSON.stringify({ ok: true }));
      return;
    }

    log.success(`Session closed  ${chalk.dim(id.slice(0, 8))}`);
  } catch (e) {
    console.error(chalk.red("Error: " + (e as Error).message));
    process.exit(1);
  }
}
