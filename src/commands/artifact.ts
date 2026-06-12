/**
 * synap artifact
 *
 * Define AI-generated cells from local HTML/JS source.
 *
 * Usage:
 *   synap artifact create --html <file> [--name <name>] [--workspace <id>] [--open]
 *
 * API:
 *   POST /api/hub/cells/define — { name, rendererSource, workspaceId, typeKey?, description? }
 *
 * The cell is registered with rendererType:'frame' and trustLevel:'generated'.
 * useRegisterFrameCells picks it up and makes it available in cellRegistry.
 * Open it in the desktop app with:
 *   synap open cell <typeKey>
 */

import { readFileSync } from "fs";
import { log } from "../utils/logger.js";
import { resolveHubConfig, resolveUserId, hubPost } from "../lib/hub-client.js";
import { openInBrowser } from "./open.js";

export interface ArtifactCreateOpts {
  html?: string;
  name?: string;
  workspace?: string;
  open?: boolean;
  json?: boolean;
  podUrl?: string;
  apiKey?: string;
}

export async function artifactCreate(opts: ArtifactCreateOpts): Promise<void> {
  try {
    if (!opts.html) {
      log.error("Provide an HTML file path: --html <file>");
      process.exit(1);
    }

    let rendererSource: string;
    try {
      rendererSource = readFileSync(opts.html, "utf-8");
    } catch (e) {
      log.error(`Cannot read file: ${opts.html} — ${(e as Error).message}`);
      process.exit(1);
    }

    const cfg = await resolveHubConfig(opts);
    const userId = await resolveUserId(cfg);
    const workspaceId = opts.workspace ?? cfg.workspaceId;

    if (!workspaceId) {
      log.error("Workspace ID required. Use --workspace <id> or set active workspace with: synap use <id>");
      process.exit(1);
    }

    const name = opts.name ?? opts.html.split("/").pop()?.replace(/\.html?$/i, "") ?? "artifact";

    const body = { userId, name, rendererSource, workspaceId };
    const res = await hubPost("/cells/define", body, cfg) as Record<string, unknown>;

    const isProposed = res.status === "proposed" || Boolean(res.proposalId);
    if (isProposed) {
      log.warn(`Queued for approval (proposal: ${String(res.proposalId ?? "")})`);
      if (res.reviewUrl) log.dim(`  Review: ${String(res.reviewUrl)}`);
      return;
    }

    const typeKey = String(res.typeKey ?? "");
    if (!typeKey) {
      log.error("Cell defined but no typeKey returned");
      if (opts.json) console.log(JSON.stringify(res, null, 2));
      return;
    }

    if (opts.json) {
      console.log(JSON.stringify({ typeKey, name }, null, 2));
      return;
    }

    log.success(`Cell defined: ${name}`);
    log.dim(`  typeKey: ${typeKey}`);
    log.dim(`  bento block: { kind: "${typeKey}", config: {} }`);
    log.dim(`  open in browser: synap open cell ${typeKey}`);

    if (opts.open) {
      await openInBrowser({ kind: "cell", id: typeKey });
    }
  } catch (e) {
    log.error("Error: " + (e as Error).message);
    process.exit(1);
  }
}
