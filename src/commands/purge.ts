/**
 * `synap workspace purge <id|name>` / `synap project purge <id|name>` —
 * HARD teardown for the pod owner. Irreversible.
 *
 * Calls the backend purge endpoints (owner-only):
 *   workspace: POST /api/hub/workspaces/:id/purge  body { confirm: "<exact name>" }
 *              → { purged, workspaceId, entitiesDeleted, blobsDeleted }
 *   project:   POST /api/hub/projects/:id/purge     body { confirm: "<exact name>" }
 *              → { purged, projectId, podWideEntitiesDeleted, relationsDeleted }
 *
 * SAFETY: resolves the target's exact name, then requires the operator to TYPE
 * that name (interactive) — or pass it via --confirm <name> / --yes — before any
 * server call is made. A local name mismatch aborts before the network.
 */

import chalk from "chalk";
import * as readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { log } from "../utils/logger.js";
import { resolveHubConfig, hubGet, hubPost, type HubConfig } from "../lib/hub-client.js";
import { unwrapList } from "../lib/unwrapList.js";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface PurgeOpts {
  confirm?: string;
  yes?: boolean;
  json?: boolean;
  podUrl?: string;
  apiKey?: string;
}

interface Resolved {
  id: string;
  name: string;
}

/** Resolve a workspace <id|name> to its { id, name }. Throws if unknown. */
async function resolveWorkspace(value: string, cfg: HubConfig): Promise<Resolved> {
  // GET /workspaces returns a { workspaces: [...] } envelope.
  const res = (await hubGet("/workspaces", {}, cfg)) as Record<string, unknown>;
  const list = unwrapList<Record<string, unknown>>(res, ["workspaces"]);
  const match = UUID_RE.test(value)
    ? list.find((w) => String(w.id) === value)
    : list.find((w) => String(w.name ?? "").toLowerCase() === value.toLowerCase());
  if (!match) {
    const names = list.map((w) => String(w.name ?? w.id)).join(", ");
    throw new Error(`Workspace '${value}' not found.${names ? ` Available: ${names}` : ""}`);
  }
  return { id: String(match.id), name: String(match.name ?? match.id) };
}

/** Resolve a project <id|name> to its { id, name }. Throws if unknown. */
async function resolveProject(value: string, cfg: HubConfig): Promise<Resolved> {
  // GET /projects returns a RAW array (no envelope).
  const res = (await hubGet("/projects", {}, cfg)) as unknown;
  const list = unwrapList<Record<string, unknown>>(res, ["projects"]);
  const match = UUID_RE.test(value)
    ? list.find((p) => String(p.id) === value)
    : list.find((p) => String(p.name ?? "").toLowerCase() === value.toLowerCase());
  if (!match) {
    const names = list.map((p) => String(p.name ?? p.id)).join(", ");
    throw new Error(`Project '${value}' not found.${names ? ` Available: ${names}` : ""}`);
  }
  return { id: String(match.id), name: String(match.name ?? match.id) };
}

/**
 * Obtain the confirmation string and check it matches `name` locally — BEFORE
 * any destructive server call. Returns the validated confirm value, or null if
 * the operator aborted / mismatched.
 */
async function getConfirmation(name: string, opts: PurgeOpts): Promise<string | null> {
  // Non-interactive: --confirm <name> (must match) or --yes (use resolved name).
  if (opts.confirm !== undefined) {
    if (opts.confirm !== name) {
      log.error(`--confirm '${opts.confirm}' does not match the exact name '${name}'. Aborting.`);
      return null;
    }
    return opts.confirm;
  }
  if (opts.yes) return name;

  // Interactive: operator must TYPE the exact name.
  const rl = readline.createInterface({ input, output });
  try {
    const answer = await rl.question(
      chalk.bold(`  Type the exact name to confirm purge (${chalk.red(name)}): `)
    );
    if (answer.trim() !== name) {
      log.error("Name does not match. Aborting — nothing was purged.");
      return null;
    }
    return answer.trim();
  } finally {
    rl.close();
  }
}

/** Surface a thrown hub error: 4xx body + a friendly hint for known statuses. */
function reportError(e: unknown): void {
  const msg = (e as Error).message ?? String(e);
  log.error(msg);
  if (/HTTP 403/.test(msg)) {
    log.dim("403 — owner-only operation, or this is a protected/system workspace.");
  } else if (/HTTP 404/.test(msg)) {
    log.dim("404 — target no longer exists.");
  } else if (/HTTP 400/.test(msg)) {
    log.dim("400 — confirmation name mismatch or malformed request.");
  }
}

interface WorkspacePurgeResult {
  purged: boolean;
  workspaceId: string;
  entitiesDeleted: number;
  blobsDeleted: number;
}

interface ProjectPurgeResult {
  purged: boolean;
  projectId: string;
  podWideEntitiesDeleted: number;
  relationsDeleted: number;
}

export async function workspacePurge(target: string, opts: PurgeOpts): Promise<void> {
  try {
    const cfg = await resolveHubConfig(opts);
    const ws = await resolveWorkspace(target, cfg);

    if (!opts.json) {
      log.heading(`Purge workspace — ${ws.name}`);
      log.warn("This is a HARD, IRREVERSIBLE teardown.");
      log.dim(`Deletes the workspace ${chalk.dim(ws.id.slice(0, 8))}, all its entities, and their blobs.`);
    }

    const confirm = await getConfirmation(ws.name, opts);
    if (confirm === null) process.exit(1);

    const res = (await hubPost(`/workspaces/${ws.id}/purge`, { confirm }, cfg, 120_000)) as WorkspacePurgeResult;

    if (opts.json) {
      console.log(JSON.stringify(res, null, 2));
      return;
    }
    log.success(`Purged workspace '${ws.name}'.`);
    log.dim(`Entities deleted: ${chalk.bold(String(res.entitiesDeleted ?? 0))}`);
    log.dim(`Blobs deleted:    ${chalk.bold(String(res.blobsDeleted ?? 0))}`);
  } catch (e) {
    reportError(e);
    process.exit(1);
  }
}

export async function projectPurge(target: string, opts: PurgeOpts): Promise<void> {
  try {
    const cfg = await resolveHubConfig(opts);
    const proj = await resolveProject(target, cfg);

    if (!opts.json) {
      log.heading(`Purge project — ${proj.name}`);
      log.warn("This is a HARD, IRREVERSIBLE teardown.");
      log.dim(`Deletes the project ${chalk.dim(proj.id.slice(0, 8))}, its pod-wide-exclusive entities, and belongs_to_project links.`);
      log.dim("Note: workspace-scoped entities are NOT removed here — use `synap workspace purge` for those.");
    }

    const confirm = await getConfirmation(proj.name, opts);
    if (confirm === null) process.exit(1);

    const res = (await hubPost(`/projects/${proj.id}/purge`, { confirm }, cfg, 120_000)) as ProjectPurgeResult;

    if (opts.json) {
      console.log(JSON.stringify(res, null, 2));
      return;
    }
    log.success(`Purged project '${proj.name}'.`);
    log.dim(`Pod-wide entities deleted: ${chalk.bold(String(res.podWideEntitiesDeleted ?? 0))}`);
    log.dim(`Relations deleted:         ${chalk.bold(String(res.relationsDeleted ?? 0))}`);
    log.dim("Reminder: workspace-scoped entities are removed by `synap workspace purge`.");
  } catch (e) {
    reportError(e);
    process.exit(1);
  }
}
