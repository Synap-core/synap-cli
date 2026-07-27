/**
 * synap upload
 *
 * Store a real file (arbitrary bytes) on the pod. Closes the "an AI/CLI cannot
 * store a real file" gap: the CLI reads the file from disk and POSTs it as
 * multipart/form-data to the standalone file door, which mints a `file`
 * entity for the bytes.
 *
 * Usage:
 *   synap upload ./report.pdf
 *   synap upload ./logo.png --title "Brand logo" --workspace <id>
 *   synap upload ./spec.pdf --attach <entityId>   # also link doc → entity
 *
 * API:
 *   POST /api/hub/files  (multipart)  — field `file` (≤10MB) + REQUIRED
 *                                       workspaceId (membership-gated) +
 *                                       optional title → { fileEntityId, documentId }
 *   POST /api/hub/relations           — with --attach: `references` relation
 *                                       from the target entity to the new doc.
 */

import { readFileSync } from "fs";
import { basename, extname } from "path";
import { log } from "../utils/logger.js";
import {
  resolveHubConfig,
  resolveUserId,
  hubPostMultipart,
  renderHubError,
} from "../lib/hub-client.js";
import { writeGovernance } from "../lib/capture-lane.js";
import { createRelation } from "./data.js";
import { openInBrowser } from "./open.js";

/** Mirror of the pinned /api/hub/files contract: reject >10MB before the round-trip. */
const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;

/** Best-effort extension → mime. Backend accepts arbitrary mime; octet-stream is the safe default. */
const MIME: Record<string, string> = {
  ".md": "text/markdown",
  ".markdown": "text/markdown",
  ".txt": "text/plain",
  ".csv": "text/csv",
  ".json": "application/json",
  ".html": "text/html",
  ".htm": "text/html",
  ".pdf": "application/pdf",
  ".doc": "application/msword",
  ".docx":
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".svg": "image/svg+xml",
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
  ".m4a": "audio/mp4",
  ".ogg": "audio/ogg",
  ".mp4": "video/mp4",
  ".mov": "video/quicktime",
  ".zip": "application/zip",
};

function mimeFor(path: string): string {
  return MIME[extname(path).toLowerCase()] ?? "application/octet-stream";
}

export interface UploadOpts {
  workspace?: string;
  attach?: string;
  title?: string;
  open?: boolean;
  json?: boolean;
  podUrl?: string;
  apiKey?: string;
}

export async function uploadFile(path: string, opts: UploadOpts): Promise<void> {
  try {
    const cfg = await resolveHubConfig(opts);
    // Fail-fast identity check: assert the caller has a resolvable identity before
    // uploading. The /files door derives the owner from the API key, not a body
    // field, so the resolved id is intentionally not forwarded (unlike doc create).
    await resolveUserId(cfg);
    const workspaceId = opts.workspace ?? cfg.workspaceId;

    // Buffer<ArrayBuffer> (not the widened Buffer<ArrayBufferLike>) — required for
    // File([buf]) to typecheck, matching readFileSync's inferred NonSharedBuffer.
    let buf: Buffer<ArrayBuffer>;
    try {
      buf = readFileSync(path);
    } catch (e) {
      log.error(`Cannot read file: ${path} — ${(e as Error).message}`);
      process.exit(1);
    }

    if (buf.byteLength === 0) {
      log.error(`File is empty: ${path}`);
      process.exit(1);
    }
    if (buf.byteLength > MAX_UPLOAD_BYTES) {
      log.error(
        `File too large: ${(buf.byteLength / 1024 / 1024).toFixed(1)}MB — the pod accepts up to 10MB.`
      );
      process.exit(1);
    }

    const filename = basename(path);
    const form = new FormData();
    // Field name + optional fields per the pinned /api/hub/files contract.
    form.append("file", new File([buf], filename, { type: mimeFor(path) }));
    if (workspaceId) form.append("workspaceId", workspaceId);
    if (opts.title) form.append("title", opts.title);

    const res = (await hubPostMultipart("/files", form, cfg)) as Record<
      string,
      unknown
    >;

    const governance = writeGovernance(res);
    const fileEntityId = String(res.fileEntityId ?? "");
    const documentId = String(res.documentId ?? "");

    // Single --attach implementation for both output modes: a `references` relation
    // links ENTITIES — target the new file entity (fileEntityId), never the
    // documents-row id (documentId). Callers guard on opts.attach + fileEntityId first.
    const doAttach = (json: boolean): Promise<void> =>
      createRelation({
        source: opts.attach!,
        target: fileEntityId,
        type: "references",
        workspace: workspaceId,
        json,
        podUrl: opts.podUrl,
        apiKey: opts.apiKey,
      });

    if (opts.json) {
      console.log(
        JSON.stringify(
          { ...res, outcome: governance === "proposed" ? "proposed" : "stored" },
          null,
          2
        )
      );
      // In JSON mode we still run the attach so its response is emitted too.
      if (governance !== "proposed" && opts.attach && fileEntityId) {
        await doAttach(true);
      }
      return;
    }

    if (governance === "proposed") {
      // A proposal is normal — the write is queued for the user's review, not a failure.
      log.info(`Upload: ${filename} — proposed (under review)`);
      const proposalId = String(res.proposalId ?? "");
      if (proposalId) log.dim(`  proposal: ${proposalId}`);
      if (res.reviewUrl) log.dim(`  review: ${String(res.reviewUrl)}`);
      if (opts.attach) {
        log.dim(
          "  --attach skipped: the file entity is created on approval; re-run attach after the proposal lands."
        );
      }
      return;
    }

    log.success(`Uploaded: ${filename}`);
    if (fileEntityId) log.dim(`  fileEntityId: ${fileEntityId}`);
    if (documentId) log.dim(`  documentId:   ${documentId}`);

    if (opts.attach) {
      if (!fileEntityId) {
        log.error(
          "Uploaded, but the door returned no fileEntityId — cannot create the --attach relation."
        );
        process.exit(1);
      }
      await doAttach(Boolean(opts.json));
    }

    // Open the new file ENTITY (fileEntityId), not the documents-row id.
    // `kind: "document"` is a different, content-layer deep link (it opens the
    // html-doc cell keyed by a `documents`-table row id) — fileEntityId lives in
    // `entities`, so this must dispatch as `kind: "entity"`, not `"document"`.
    if (opts.open && fileEntityId) {
      await openInBrowser({ kind: "entity", id: fileEntityId });
    }
  } catch (e) {
    renderHubError(e);
    process.exit(1);
  }
}
