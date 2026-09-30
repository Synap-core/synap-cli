/**
 * Governed workspace operations (R8a):
 *
 *   synap workspace archive <id|name>      POST  /api/hub/workspaces/:id/archive
 *   synap workspace restore <id>           POST  /api/hub/workspaces/:id/restore
 *   synap workspace rename <id|name> <new> PATCH /api/hub/workspaces/:id
 *   synap entity move <ids...> --to <ws>   POST  /api/hub/entities/move
 *
 * Every one of these is GOVERNED on the pod: with an agent key the answer is a
 * proposal (`proposed` is success — approve it with `synap open proposal <id>`);
 * with an owner key it applies. This file only resolves names and prints.
 */

import chalk from "chalk";
import { log } from "../utils/logger.js";
import {
  resolveHubConfig,
  hubGet,
  hubPost,
  hubPatch,
  type HubConfig,
} from "../lib/hub-client.js";
import { unwrapList } from "../lib/unwrapList.js";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface WorkspaceOpsOpts {
  reason?: string;
  json?: boolean;
  podUrl?: string;
  apiKey?: string;
}

interface Resolved {
  id: string;
  name: string;
}

/**
 * Resolve <id|name> to { id, name }. An id is taken as-is (an ARCHIVED
 * workspace is hidden from the list, so restore must be able to name it by id).
 */
export async function resolveWorkspaceRef(value: string, cfg: HubConfig): Promise<Resolved> {
  if (UUID_RE.test(value)) return { id: value, name: value };
  const res = (await hubGet("/workspaces", {}, cfg)) as Record<string, unknown>;
  const list = unwrapList<Record<string, unknown>>(res, ["workspaces"]);
  const match = list.find((w) => String(w.name ?? "").toLowerCase() === value.toLowerCase());
  if (!match) {
    const names = list.map((w) => String(w.name ?? w.id)).join(", ");
    throw new Error(
      `Workspace '${value}' not found.${names ? ` Available: ${names}` : ""} ` +
        "(Archived workspaces are hidden — pass the workspace id.)"
    );
  }
  return { id: String(match.id), name: String(match.name ?? match.id) };
}

/** True when the pod answered with a proposal instead of applying. */
function isProposed(res: unknown): res is { status: "proposed"; proposalId?: string; reviewUrl?: string } {
  return !!res && typeof res === "object" && (res as { status?: unknown }).status === "proposed";
}

function printProposed(res: { proposalId?: string; reviewUrl?: string }, what: string): void {
  log.success(`${what} filed for review.`);
  if (res.proposalId) log.dim(`Approve it: synap open proposal ${res.proposalId}`);
  if (res.reviewUrl) log.dim(res.reviewUrl);
}

type AutomationRef = { id: string; name: string };

function fail(e: unknown): never {
  const msg = (e as Error).message ?? String(e);
  log.error(msg);
  if (/HTTP 403/.test(msg)) {
    log.hint("403 — owner or pod admin only, or a protected/system workspace.");
  } else if (/HTTP 404/.test(msg)) {
    log.hint("404 — that workspace or entity does not exist.");
  }
  process.exit(1);
}

async function archiveOrRestore(target: string, restore: boolean, opts: WorkspaceOpsOpts): Promise<void> {
  try {
    const cfg = await resolveHubConfig(opts);
    const ws = await resolveWorkspaceRef(target, cfg);
    const res = await hubPost(
      `/workspaces/${ws.id}/${restore ? "restore" : "archive"}`,
      opts.reason ? { reasoning: opts.reason } : {},
      cfg
    );
    if (opts.json) {
      console.log(JSON.stringify(res, null, 2));
      return;
    }
    if (isProposed(res)) {
      printProposed(res, restore ? `Restore of '${ws.name}'` : `Archive of '${ws.name}'`);
      return;
    }
    const body = res as { name?: string; pausedAutomations?: AutomationRef[]; pausedByArchive?: AutomationRef[] };
    const name = body.name ?? ws.name;
    if (restore) {
      log.success(`Restored workspace '${name}'.`);
      const paused = body.pausedByArchive ?? [];
      if (paused.length > 0) {
        log.dim(`${paused.length} automation(s) are still paused from the archive — re-enable the ones you want:`);
        for (const a of paused) log.dim(`  ${a.name}  ${chalk.dim(`synap automation enable ${a.id}`)}`);
      }
    } else {
      log.success(`Archived workspace '${name}'.`);
      const paused = body.pausedAutomations ?? [];
      if (paused.length > 0) {
        log.dim(`Paused ${paused.length} automation(s): ${paused.map((a) => a.name).join(", ")}`);
        log.dim("Restoring the workspace will NOT re-enable them.");
      }
    }
  } catch (e) {
    fail(e);
  }
}

export function workspaceArchive(target: string, opts: WorkspaceOpsOpts): Promise<void> {
  return archiveOrRestore(target, false, opts);
}

export function workspaceRestore(target: string, opts: WorkspaceOpsOpts): Promise<void> {
  return archiveOrRestore(target, true, opts);
}

export async function workspaceRename(target: string, newName: string, opts: WorkspaceOpsOpts): Promise<void> {
  try {
    const trimmed = newName.trim();
    if (!trimmed) throw new Error("New name must not be empty.");
    const cfg = await resolveHubConfig(opts);
    const ws = await resolveWorkspaceRef(target, cfg);
    const res = await hubPatch(`/workspaces/${ws.id}`, { name: trimmed }, cfg);
    if (opts.json) {
      console.log(JSON.stringify(res, null, 2));
      return;
    }
    if (isProposed(res)) {
      printProposed(res, `Rename of '${ws.name}' to '${trimmed}'`);
      return;
    }
    log.success(`Renamed '${ws.name}' to '${trimmed}'.`);
  } catch (e) {
    fail(e);
  }
}

export async function entityMove(
  entityIds: string[],
  opts: WorkspaceOpsOpts & { to: string }
): Promise<void> {
  try {
    const bad = entityIds.filter((id) => !UUID_RE.test(id));
    if (bad.length > 0) throw new Error(`Not entity ids: ${bad.join(", ")}`);
    const cfg = await resolveHubConfig(opts);
    const ws = await resolveWorkspaceRef(opts.to, cfg);
    const res = (await hubPost(
      "/entities/move",
      { entityIds, workspaceId: ws.id, ...(opts.reason ? { reason: opts.reason } : {}) },
      cfg
    )) as {
      moved?: string[];
      proposed?: Array<{ entityId: string; proposalId: string }>;
      errors?: Array<{ entityId: string; error: string }>;
    };
    if (opts.json) {
      console.log(JSON.stringify(res, null, 2));
      return;
    }
    const moved = res.moved ?? [];
    const proposed = res.proposed ?? [];
    const errors = res.errors ?? [];
    if (moved.length) log.success(`Moved ${moved.length} entit${moved.length === 1 ? "y" : "ies"} to '${ws.name}'.`);
    if (proposed.length) {
      log.success(`${proposed.length} move(s) filed for review.`);
      for (const p of proposed) log.dim(`  ${p.entityId.slice(0, 8)}  synap open proposal ${p.proposalId}`);
    }
    for (const e of errors) log.error(`${e.entityId.slice(0, 8)}: ${e.error}`);
    if (errors.length && !moved.length && !proposed.length) process.exit(1);
  } catch (e) {
    fail(e);
  }
}
