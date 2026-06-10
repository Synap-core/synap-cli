/**
 * synap doc create / synap doc update
 *
 * Manage markdown documents on the pod.
 *
 * Usage:
 *   synap doc create --title "My Doc" --content "# Hello" [--workspace <id>] [--open]
 *   synap doc create --title "My Doc" --file ./notes.md [--open]
 *   echo "# Hello" | synap doc create --title "My Doc"
 *
 *   synap doc update <id> --content "new body" [--title "New Title"]
 *   synap doc update <id> --file ./notes.md
 *   echo "updated" | synap doc update <id>
 *
 * API:
 *   POST  /api/hub/documents        — { userId, workspaceId?, title, content?, type? }
 *   PATCH /api/hub/documents/:id    — { userId, content } (full-replace, proposal-gated)
 */

import { readFileSync } from "fs";
import { log } from "../utils/logger.js";
import {
  resolveHubConfig,
  resolveUserId,
  hubPost,
  hubPatch,
} from "../lib/hub-client.js";
import { openInBrowser } from "./open.js";

export interface DocCreateOpts {
  title: string;
  content?: string;
  file?: string;
  workspace?: string;
  open?: boolean;
  json?: boolean;
  podUrl?: string;
  apiKey?: string;
}

export interface DocUpdateOpts {
  content?: string;
  file?: string;
  title?: string;
  open?: boolean;
  json?: boolean;
  podUrl?: string;
  apiKey?: string;
}

/** Read content from --content flag, --file flag, or stdin (in that priority order). */
async function resolveContent(
  content: string | undefined,
  file: string | undefined
): Promise<string | undefined> {
  if (content !== undefined) return content;
  if (file) {
    try {
      return readFileSync(file, "utf-8");
    } catch (e) {
      log.error(`Cannot read file: ${file} — ${(e as Error).message}`);
      process.exit(1);
    }
  }
  // stdin — only when it's a pipe (not a TTY)
  if (!process.stdin.isTTY) {
    return new Promise((resolve, reject) => {
      const chunks: Buffer[] = [];
      process.stdin.on("data", (chunk) => chunks.push(chunk as Buffer));
      process.stdin.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")));
      process.stdin.on("error", reject);
    });
  }
  return undefined;
}

export async function docCreate(opts: DocCreateOpts): Promise<void> {
  try {
    const cfg = await resolveHubConfig(opts);
    const userId = await resolveUserId(cfg);
    const workspaceId = opts.workspace ?? cfg.workspaceId;

    if (!workspaceId) {
      log.error(
        "Workspace ID required. Use --workspace <id> or set active workspace with: synap use <id>"
      );
      process.exit(1);
    }

    const content = await resolveContent(opts.content, opts.file);

    const body: Record<string, unknown> = {
      userId,
      workspaceId,
      title: opts.title,
      type: "markdown",
    };
    if (content !== undefined) body.content = content;

    const res = (await hubPost("/documents", body, cfg)) as Record<
      string,
      unknown
    >;

    const doc =
      (res.document as Record<string, unknown> | undefined) ?? res;
    const id = String(doc.id ?? res.id ?? "");

    if (opts.json) {
      console.log(JSON.stringify(res, null, 2));
      return;
    }

    const isProposed = res.status === "proposed" || Boolean(res.proposalId);
    if (isProposed) {
      log.warn(`Queued for approval (proposal: ${String(res.proposalId ?? "")})`);
      if (res.reviewUrl) log.dim(`  Review: ${String(res.reviewUrl)}`);
      return;
    }

    log.success(`Document created: ${opts.title}`);
    log.dim(`  id: ${id}`);
    log.dim(`  open in browser: synap open document ${id}`);

    if (opts.open && id) {
      await openInBrowser({ kind: "document", id });
    }
  } catch (e) {
    log.error("Error: " + (e as Error).message);
    process.exit(1);
  }
}

export async function docUpdate(
  documentId: string,
  opts: DocUpdateOpts
): Promise<void> {
  try {
    const cfg = await resolveHubConfig(opts);
    const userId = await resolveUserId(cfg);

    const content = await resolveContent(opts.content, opts.file);

    if (content === undefined && opts.title === undefined) {
      log.error(
        "Provide --content, --file, or pipe stdin to supply new content. " +
          "Title-only updates require --content as well (backend limitation)."
      );
      process.exit(1);
    }

    const body: Record<string, unknown> = { userId };
    if (content !== undefined) body.content = content;
    if (opts.title !== undefined) body.title = opts.title;

    const res = (await hubPatch(
      `/documents/${documentId}`,
      body,
      cfg
    )) as Record<string, unknown>;

    if (opts.json) {
      console.log(JSON.stringify(res, null, 2));
      return;
    }

    const isProposed = res.status === "proposed" || Boolean(res.proposalId);
    if (isProposed) {
      log.warn(`Queued for approval (proposal: ${String(res.proposalId ?? "")})`);
      if (res.reviewUrl) log.dim(`  Review: ${String(res.reviewUrl)}`);
      return;
    }

    log.success(`Document updated: ${documentId.slice(0, 8)}…`);
    if (opts.title) log.dim(`  title: ${opts.title}`);

    if (opts.open) {
      await openInBrowser({ kind: "document", id: documentId });
    }
  } catch (e) {
    log.error("Error: " + (e as Error).message);
    process.exit(1);
  }
}
