/**
 * synap view
 *
 * Manage views on the pod.
 *
 * Usage:
 *   synap view create --type kanban --profile task --name "My Board" --workspace <id>
 *   synap view create --type bento --profile note --json
 *   synap view list [--workspace <id>]
 *
 * API:
 *   POST /api/hub/views  — CreateViewRequest: { userId, workspaceId, name, type, profileId, config, metadata }
 *   GET  /api/hub/views  — ListViewsQuery:    { userId, workspaceId, type, profileId }
 *
 * Note: the backend accepts `profileId` (not `profileSlug`). The CLI accepts
 * `--profile <slug>` for convenience and passes it as `profileId` — the backend
 * resolves it at the entity level or stores it as-is. Pass a UUID if you need
 * exact profile routing.
 */

import { readFileSync } from "fs";
import chalk from "chalk";
import { log } from "../utils/logger.js";
import { resolveHubConfig, resolveUserId, hubGet, hubPost } from "../lib/hub-client.js";

export interface ViewCreateOpts {
  type: string;
  profile?: string;
  name?: string;
  workspace?: string;
  json?: boolean;
  podUrl?: string;
  apiKey?: string;
}

export interface ViewListOpts {
  workspace?: string;
  json?: boolean;
  podUrl?: string;
  apiKey?: string;
}

export async function viewCreate(opts: ViewCreateOpts): Promise<void> {
  try {
    const cfg = await resolveHubConfig(opts);
    const userId = await resolveUserId(cfg);

    const name = opts.name ?? `${opts.type} view`;
    const workspaceId = opts.workspace ?? cfg.workspaceId;

    // Resolve profile slug → UUID (backend requires UUID for profileId)
    let profileId: string | undefined;
    if (opts.profile) {
      const profilesRes = await hubGet("/profiles", { userId, workspaceId: workspaceId ?? "" }, cfg) as Record<string, unknown>;
      const profiles = (profilesRes.profiles ?? profilesRes.items ?? (Array.isArray(profilesRes) ? profilesRes : [])) as Record<string, unknown>[];
      const match = profiles.find((p) => p.slug === opts.profile || p.id === opts.profile);
      if (!match) {
        log.error(`Profile "${opts.profile}" not found. Run: synap list profiles`);
        process.exit(1);
      }
      profileId = String(match.id);
    }

    const body: Record<string, unknown> = {
      userId,
      name,
      type: opts.type,
    };
    if (workspaceId) body.workspaceId = workspaceId;
    if (profileId) body.profileId = profileId;

    const res = await hubPost("/views", body, cfg) as Record<string, unknown>;

    if (opts.json) {
      console.log(JSON.stringify(res, null, 2));
      return;
    }

    const isProposed = res.status === "proposed" || Boolean(res.proposalId);
    if (isProposed) {
      log.warn(`Queued for approval (proposal: ${String(res.proposalId ?? "")})`);
      if (res.reviewUrl) log.dim(`  Review: ${String(res.reviewUrl)}`);
    } else {
      log.success(`View created: ${String(res.name ?? name)}`);
      log.dim(`id: ${String(res.id ?? "")}`);
      if (res.type) log.dim(`type: ${String(res.type)}`);
    }
  } catch (e) {
    log.error("Error: " + (e as Error).message);
    process.exit(1);
  }
}

export async function viewList(opts: ViewListOpts): Promise<void> {
  try {
    const cfg = await resolveHubConfig(opts);
    const userId = await resolveUserId(cfg);
    const workspaceId = opts.workspace ?? cfg.workspaceId;

    const params: Record<string, string | number | undefined> = { userId };
    if (workspaceId) params.workspaceId = workspaceId;

    const res = await hubGet("/views", params, cfg) as Record<string, unknown>;
    const views = (res.views ?? res.items ?? (Array.isArray(res) ? res : [])) as Record<string, unknown>[];

    if (opts.json) {
      console.log(JSON.stringify(views, null, 2));
      return;
    }

    if (views.length === 0) {
      log.dim("No views found.");
      return;
    }

    log.heading(`Views${workspaceId ? ` in workspace ${workspaceId.slice(0, 8)}…` : ""}`);
    console.log("");
    for (const v of views) {
      const type = String(v.type ?? "").padEnd(14);
      const name = String(v.name ?? "–").slice(0, 40).padEnd(42);
      const id = chalk.dim(String(v.id ?? "").slice(0, 8));
      const profile = v.profileId ? chalk.dim(`  [${v.profileId}]`) : "";
      console.log(`  ${chalk.cyan(type)}  ${name}  ${id}${profile}`);
    }
    console.log("");
  } catch (e) {
    log.error("Error: " + (e as Error).message);
    process.exit(1);
  }
}

export interface ViewArrangeOpts {
  file?: string;
  workspace?: string;
  json?: boolean;
  podUrl?: string;
  apiKey?: string;
}

/**
 * POST /api/hub/views/:viewId/arrange
 *
 * Replaces the widget arrangement for a bento-type view.
 * Payload: { userId, workspaceId?, widgets: BentoWidget[] }
 *
 * BentoWidget shape: { id, kind, x?, y?, w?, h?, config?, ...passthrough }
 *
 * Layout JSON can be provided via --file <path> or piped from stdin.
 * Expected format: an array of BentoWidget objects, OR
 *   { widgets: BentoWidget[] } wrapper — both are accepted.
 */
export async function viewArrange(
  viewId: string,
  opts: ViewArrangeOpts
): Promise<void> {
  try {
    // Read layout JSON from --file or stdin
    let raw: string;
    if (opts.file) {
      try {
        raw = readFileSync(opts.file, "utf-8");
      } catch (e) {
        log.error(`Cannot read file: ${opts.file} — ${(e as Error).message}`);
        process.exit(1);
      }
    } else if (!process.stdin.isTTY) {
      raw = await new Promise<string>((resolve, reject) => {
        const chunks: Buffer[] = [];
        process.stdin.on("data", (chunk) => chunks.push(chunk as Buffer));
        process.stdin.on("end", () =>
          resolve(Buffer.concat(chunks).toString("utf-8"))
        );
        process.stdin.on("error", reject);
      });
    } else {
      log.error(
        "Provide layout JSON via --file <path> or pipe stdin.\n" +
          "  Format: array of { id, kind, x?, y?, w?, h?, config? } objects, or { widgets: [...] }."
      );
      process.exit(1);
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      log.error("Layout JSON is not valid JSON.");
      process.exit(1);
    }

    // Accept both bare array and { widgets: [...] } wrapper
    const widgets: unknown[] = Array.isArray(parsed)
      ? parsed
      : Array.isArray((parsed as Record<string, unknown>).widgets)
        ? ((parsed as Record<string, unknown>).widgets as unknown[])
        : [];

    if (widgets.length === 0) {
      log.error(
        "No widgets found in layout. Expected an array or { widgets: [...] }."
      );
      process.exit(1);
    }

    const cfg = await resolveHubConfig(opts);
    const userId = await resolveUserId(cfg);
    const workspaceId = opts.workspace ?? cfg.workspaceId;

    const body: Record<string, unknown> = { userId, widgets };
    if (workspaceId) body.workspaceId = workspaceId;

    const res = (await hubPost(
      `/views/${viewId}/arrange`,
      body,
      cfg
    )) as Record<string, unknown>;

    if (opts.json) {
      console.log(JSON.stringify(res, null, 2));
      return;
    }

    const isProposed = res.status === "proposed" || Boolean(res.proposalId);
    if (isProposed) {
      log.warn(
        `Queued for approval (proposal: ${String(res.proposalId ?? "")})`
      );
      if (res.reviewUrl) log.dim(`  Review: ${String(res.reviewUrl)}`);
      return;
    }

    log.success(`View arranged: ${viewId.slice(0, 8)}…`);
    log.dim(`  ${widgets.length} widget(s) set`);
  } catch (e) {
    log.error("Error: " + (e as Error).message);
    process.exit(1);
  }
}
