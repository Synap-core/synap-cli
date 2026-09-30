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
 *   synap doc update <id> --content "new body"
 *   synap doc update <id> --file ./notes.md
 *   echo "updated" | synap doc update <id>
 *   synap doc update <id> --section risks --section-title "Risks" --file ./risks.md
 *
 * API:
 *   POST  /api/hub/documents            — { userId, workspaceId?, title, content?, type? }
 *   PATCH /api/hub/documents/:id        — { userId, content, baseRevision? } (full replace)
 *   POST  /api/hub/documents/:id/patch  — { userId, ops, baseRevision? } (--section: one upsert_section op)
 */

import { readFileSync } from "fs";
import { log } from "../utils/logger.js";
import {
  resolveHubConfig,
  resolveUserId,
  hubPost,
  hubPatch,
} from "../lib/hub-client.js";
import { writeGovernance } from "../lib/capture-lane.js";
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
  /** Write ONE section (by id) instead of replacing the whole body. */
  section?: string;
  /** The section's heading (required with --section). */
  sectionTitle?: string;
  /** The revision you read; the edit is refused if the document moved. */
  baseRevision?: string;
  open?: boolean;
  json?: boolean;
  podUrl?: string;
  apiKey?: string;
}

export interface DocReferenceOpts {
  title: string;
  workspace?: string;
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
      // A proposal is normal — the write is queued for review, not a failure.
      log.info(`Document: ${opts.title} — proposed (under review)`);
      const proposalId = String(res.proposalId ?? "");
      if (proposalId) log.dim(`  proposal: ${proposalId}`);
      if (res.reviewUrl) log.dim(`  review: ${String(res.reviewUrl)}`);
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

/**
 * synap doc reference <url> — create an external reference document (no bytes).
 * Reuses the same POST /api/hub/documents door as `doc create`, sending a `url`
 * field instead of `content`.
 */
export async function docReference(
  url: string,
  opts: DocReferenceOpts
): Promise<void> {
  try {
    const cfg = await resolveHubConfig(opts);
    const userId = await resolveUserId(cfg);
    const workspaceId = opts.workspace ?? cfg.workspaceId;

    const body: Record<string, unknown> = {
      userId,
      title: opts.title,
      url,
    };
    // A reference can be pod-wide; only scope it when a workspace is available.
    if (workspaceId) body.workspaceId = workspaceId;

    const res = (await hubPost("/documents", body, cfg)) as Record<
      string,
      unknown
    >;

    // `/documents` returns the row directly — no `{ document: … }` wrapper.
    const id = String(res.id ?? "");

    if (opts.json) {
      console.log(JSON.stringify(res, null, 2));
      return;
    }

    if (writeGovernance(res) === "proposed") {
      // A proposal is normal — the write is queued for review, not a failure.
      // Mirror `synap upload`'s neutral phrasing (info, not warn).
      log.info(`Reference: ${opts.title} — proposed (under review)`);
      const proposalId = String(res.proposalId ?? "");
      if (proposalId) log.dim(`  proposal: ${proposalId}`);
      if (res.reviewUrl) log.dim(`  review: ${String(res.reviewUrl)}`);
      return;
    }

    log.success(`Reference created: ${opts.title}`);
    log.dim(`  url: ${url}`);
    log.dim(`  id: ${id}`);

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

    if (content === undefined) {
      log.error(
        "Provide --content, --file, or pipe stdin to supply new content."
      );
      process.exit(1);
    }

    let baseRevision: number | undefined;
    if (opts.baseRevision !== undefined) {
      baseRevision = Number(opts.baseRevision);
      if (!Number.isInteger(baseRevision) || baseRevision < 0) {
        log.error("--base-revision must be a whole number (the `revision` a read returned).");
        process.exit(1);
      }
    }
    if (opts.section !== undefined && !opts.sectionTitle) {
      log.error("--section needs --section-title (the section's heading).");
      process.exit(1);
    }

    // --section writes ONE section through the patch door; otherwise the
    // content replaces the whole body (PATCH, an alias of the same door).
    const res = (
      opts.section !== undefined
        ? await hubPost(
            `/documents/${documentId}/patch`,
            {
              userId,
              ops: [
                {
                  op: "upsert_section",
                  id: opts.section,
                  title: opts.sectionTitle,
                  body: content,
                },
              ],
              ...(baseRevision !== undefined ? { baseRevision } : {}),
            },
            cfg
          )
        : await hubPatch(
            `/documents/${documentId}`,
            {
              userId,
              content,
              ...(baseRevision !== undefined ? { baseRevision } : {}),
            },
            cfg
          )
    ) as Record<string, unknown>;

    if (opts.json) {
      console.log(JSON.stringify(res, null, 2));
      return;
    }

    const isProposed = res.status === "proposed" || Boolean(res.proposalId);
    if (isProposed) {
      // A proposal is normal — the write is queued for review, not a failure.
      log.info(`Update: ${documentId.slice(0, 8)}… — proposed (under review)`);
      const proposalId = String(res.proposalId ?? "");
      if (proposalId) log.dim(`  proposal: ${proposalId}`);
      if (res.reviewUrl) log.dim(`  review: ${String(res.reviewUrl)}`);
      return;
    }

    log.success(`Document updated: ${documentId.slice(0, 8)}…`);

    if (opts.open) {
      await openInBrowser({ kind: "document", id: documentId });
    }
  } catch (e) {
    log.error("Error: " + (e as Error).message);
    process.exit(1);
  }
}
