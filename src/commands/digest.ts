/**
 * `synap digest` — a quick read of what lives in a workspace or project.
 *
 * Calls the backend digest endpoints (LOCKED CONTRACT):
 *   workspace: GET /api/hub/workspaces/:id/digest
 *   project:   GET /api/hub/projects/:id/digest
 *
 * Default (no flag) = the active workspace lens. Pass --workspace / --project
 * (id or name) to target a specific lens. --json prints the raw payload.
 */

import chalk from "chalk";
import { log } from "../utils/logger.js";
import { resolveHubConfig, hubGet, type HubConfig } from "../lib/hub-client.js";
import { unwrapList } from "../lib/unwrapList.js";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Resolve a --workspace value (id or name) to a workspace id. Throws if unknown. */
async function resolveWorkspaceArg(value: string, cfg: HubConfig): Promise<string> {
  if (UUID_RE.test(value)) return value;
  const res = (await hubGet("/workspaces", {}, cfg)) as Record<string, unknown>;
  const list = unwrapList<Record<string, unknown>>(res, ["workspaces"]);
  const match = list.find((w) => String(w.name ?? "").toLowerCase() === value.toLowerCase());
  if (!match) {
    const names = list.map((w) => String(w.name ?? w.id)).join(", ");
    throw new Error(`Workspace '${value}' not found.${names ? ` Available: ${names}` : ""}`);
  }
  return String(match.id);
}

/** Resolve a --project value (id or name) to a project id. Throws if unknown. */
async function resolveProjectArg(value: string, cfg: HubConfig): Promise<string> {
  if (UUID_RE.test(value)) return value;
  // GET /projects returns a raw array (no envelope).
  const res = (await hubGet("/projects", {}, cfg)) as unknown;
  const list = unwrapList<Record<string, unknown>>(res, ["projects"]);
  const match = list.find((p) => String(p.name ?? "").toLowerCase() === value.toLowerCase());
  if (!match) {
    const names = list.map((p) => String(p.name ?? p.id)).join(", ");
    throw new Error(`Project '${value}' not found.${names ? ` Available: ${names}` : ""}`);
  }
  return String(match.id);
}

interface KeyEntity {
  id: string;
  title: string;
  profileSlug: string;
  workspaceId?: string;
  updatedAt?: string;
}

interface DigestBase {
  name: string;
  total: number;
  counts: Record<string, number>;
  keyEntities: KeyEntity[];
  summary?: string;
}

interface WorkspaceDigest extends DigestBase {
  workspaceId: string;
}

interface ProjectDigest extends DigestBase {
  projectId: string;
  byWorkspace: Array<{ workspaceId: string; name: string; total: number }>;
}

/** Render a `slug  count` counts table, most populous first. */
function renderCounts(counts: Record<string, number>): void {
  const rows = Object.entries(counts ?? {}).sort((a, b) => b[1] - a[1]);
  if (rows.length === 0) {
    log.dim("(no entities yet)");
    return;
  }
  const width = Math.max(...rows.map(([slug]) => slug.length));
  for (const [slug, n] of rows) {
    console.log(`    ${chalk.cyan(slug.padEnd(width))}  ${chalk.bold(String(n))}`);
  }
}

function renderKeyEntities(entities: KeyEntity[]): void {
  if (!entities || entities.length === 0) {
    log.dim("(no key entities)");
    return;
  }
  for (const e of entities) {
    const when = e.updatedAt ? chalk.dim(`  ${e.updatedAt.slice(0, 10)}`) : "";
    // Full id — feeds straight into `synap get entity <id>`.
    console.log(
      `    ${chalk.bold(e.title || "(untitled)")} ${chalk.dim(`[${e.profileSlug}]`)} ${chalk.dim(
        e.id
      )}${when}`
    );
  }
}

export async function digest(opts: {
  workspace?: string;
  project?: string;
  json?: boolean;
  podUrl?: string;
  apiKey?: string;
}): Promise<void> {
  const cfg = await resolveHubConfig(opts);

  // ── Project digest ──────────────────────────────────────────────────────
  if (opts.project) {
    const projectId = await resolveProjectArg(opts.project, cfg);
    const d = (await hubGet(`/projects/${projectId}/digest`, {}, cfg)) as ProjectDigest;

    if (opts.json) {
      console.log(JSON.stringify(d, null, 2));
      return;
    }

    log.heading(`Project digest — ${d.name}`);
    if (d.summary) log.info(d.summary);
    log.dim(`${d.total} entities across ${d.byWorkspace?.length ?? 0} workspace(s)`);

    log.heading("By workspace");
    if (d.byWorkspace && d.byWorkspace.length > 0) {
      const width = Math.max(...d.byWorkspace.map((w) => w.name.length));
      for (const w of d.byWorkspace) {
        console.log(`    ${chalk.cyan(w.name.padEnd(width))}  ${chalk.bold(String(w.total))}`);
      }
    } else {
      log.dim("(no workspaces)");
    }

    log.heading("By type");
    renderCounts(d.counts);

    log.heading("Key entities");
    renderKeyEntities(d.keyEntities);
    return;
  }

  // ── Workspace digest (explicit --workspace or the active lens) ───────────
  let workspaceId: string | undefined;
  if (opts.workspace) {
    workspaceId = await resolveWorkspaceArg(opts.workspace, cfg);
  } else {
    workspaceId = cfg.workspaceId;
  }
  if (!workspaceId) {
    log.error(
      "No workspace in scope. Pass --workspace <id|name> or --project <id|name>, or set one with 'synap use'."
    );
    process.exit(1);
  }

  const d = (await hubGet(`/workspaces/${workspaceId}/digest`, {}, cfg)) as WorkspaceDigest;

  if (opts.json) {
    console.log(JSON.stringify(d, null, 2));
    return;
  }

  log.heading(`Workspace digest — ${d.name}`);
  if (d.summary) log.info(d.summary);
  log.dim(`${d.total} entities`);

  log.heading("By type");
  renderCounts(d.counts);

  log.heading("Key entities");
  renderKeyEntities(d.keyEntities);
}
