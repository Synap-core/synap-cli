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
 *   synap upload ./logo.svg --profile brand-asset --prop variant=dark
 *   synap upload ./launch.mp4 --workspace <id>      # >10MB → presigned lane
 *   synap upload ./spec.pdf --attach <entityId>   # also link doc → entity
 *
 * API:
 *   POST /api/hub/files  (multipart)  — ≤10MB (fonts ≤5MB): field `file` +
 *                                       workspaceId (membership-gated) + optional
 *                                       title / profileSlug / properties /
 *                                       targetWorkspaceId → { fileEntityId, documentId }
 *   POST /api/hub/files/uploads       — >10MB: presigned PUT URL (caps per mime:
 *        PUT <uploadUrl>                video 500MB · audio 100MB · zip 200MB);
 *   POST /api/hub/files/uploads/finalize  the bytes go straight to storage, then
 *                                       finalize mints the entity (same shape).
 *   POST /api/hub/relations           — with --attach: `references` relation
 *                                       from the target entity to the new doc.
 *
 * `--workspace` is an EXPLICIT placement pin (sent as `targetWorkspaceId`).
 * Without it the configured workspace is only context, and a pod-scope kind
 * such as `file` lands pod-wide — which is why `--workspace` used to look
 * ignored (the entity came back with workspaceId null).
 */

import { readFileSync } from "fs";
import { basename, extname } from "path";
import { log } from "../utils/logger.js";
import {
  resolveHubConfig,
  resolveUserId,
  hubPost,
  hubPostMultipart,
  renderHubError,
  type HubConfig,
} from "../lib/hub-client.js";
import { writeGovernance } from "../lib/capture-lane.js";
import { createRelation } from "./data.js";
import { openInBrowser } from "./open.js";

const MB = 1024 * 1024;
/** The buffered multipart door's ceiling (the pod holds that body in memory). */
const MAX_BUFFERED_BYTES = 10 * MB;

/** Mirror of the pod's per-mime caps (C4) — refuse before any round-trip. */
export function maxUploadBytesForMime(mime: string): number {
  if (mime.startsWith("video/")) return 500 * MB;
  if (mime.startsWith("audio/")) return 100 * MB;
  if (mime === "application/zip") return 200 * MB;
  if (mime.startsWith("font/")) return 5 * MB;
  return MAX_BUFFERED_BYTES;
}

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
  ".webm": "video/webm",
  ".zip": "application/zip",
  ".woff2": "font/woff2",
  ".woff": "font/woff",
  ".ttf": "font/ttf",
  ".otf": "font/otf",
};

export function mimeFor(path: string): string {
  return MIME[extname(path).toLowerCase()] ?? "application/octet-stream";
}

/** `--prop key=value` (repeatable) → the entity `properties` object. */
export function parseProps(pairs: string[] | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const pair of pairs ?? []) {
    const i = pair.indexOf("=");
    if (i <= 0) throw new Error(`--prop expects key=value, got "${pair}"`);
    out[pair.slice(0, i)] = pair.slice(i + 1);
  }
  return out;
}

export interface UploadOpts {
  workspace?: string;
  /** Entity kind to create (default `file`), e.g. `brand-asset`. */
  profile?: string;
  /** Repeatable `key=value` entity properties. */
  prop?: string[];
  attach?: string;
  title?: string;
  open?: boolean;
  json?: boolean;
  podUrl?: string;
  apiKey?: string;
}

export interface UploadRequest {
  buf: Buffer<ArrayBuffer>;
  filename: string;
  mimeType: string;
  workspaceId?: string;
  targetWorkspaceId?: string;
  title?: string;
  profileSlug?: string;
  properties: Record<string, string>;
}

/**
 * Pick the lane by size: the buffered multipart door up to 10MB, the presigned
 * lane above it (request → PUT straight to storage → finalize). Both answer
 * `{ fileEntityId, documentId }` or a governed `proposed` handle.
 */
export async function sendUpload(
  req: UploadRequest,
  cfg: HubConfig
): Promise<Record<string, unknown>> {
  const hasProps = Object.keys(req.properties).length > 0;
  if (req.buf.byteLength <= MAX_BUFFERED_BYTES) {
    const form = new FormData();
    form.append("file", new File([req.buf], req.filename, { type: req.mimeType }));
    if (req.workspaceId) form.append("workspaceId", req.workspaceId);
    if (req.targetWorkspaceId) form.append("targetWorkspaceId", req.targetWorkspaceId);
    if (req.title) form.append("title", req.title);
    if (req.profileSlug) form.append("profileSlug", req.profileSlug);
    if (hasProps) form.append("properties", JSON.stringify(req.properties));
    return (await hubPostMultipart("/files", form, cfg)) as Record<string, unknown>;
  }

  const ticket = (await hubPost(
    "/files/uploads",
    {
      workspaceId: req.workspaceId,
      ...(req.targetWorkspaceId ? { targetWorkspaceId: req.targetWorkspaceId } : {}),
      filename: req.filename,
      mimeType: req.mimeType,
      size: req.buf.byteLength,
    },
    cfg
  )) as { uploadUrl: string; uploadToken: string; headers?: Record<string, string> };

  // Straight to object storage — signed for exactly this type and length.
  const put = await fetch(ticket.uploadUrl, {
    method: "PUT",
    headers: { ...(ticket.headers ?? {}), "Content-Type": req.mimeType },
    body: req.buf,
    signal: AbortSignal.timeout(30 * 60_000),
  });
  if (!put.ok) {
    const detail = await put.text().catch(() => "");
    throw new Error(
      `Upload to storage failed (HTTP ${put.status})${detail ? `: ${detail.slice(0, 300)}` : ""}`
    );
  }

  return (await hubPost(
    "/files/uploads/finalize",
    {
      uploadToken: ticket.uploadToken,
      ...(req.title ? { title: req.title } : {}),
      ...(req.profileSlug ? { profileSlug: req.profileSlug } : {}),
      ...(hasProps ? { properties: req.properties } : {}),
      ...(req.targetWorkspaceId ? { targetWorkspaceId: req.targetWorkspaceId } : {}),
    },
    cfg,
    60_000
  )) as Record<string, unknown>;
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
    const filename = basename(path);
    const mimeType = mimeFor(path);
    const cap = maxUploadBytesForMime(mimeType);
    if (buf.byteLength > cap) {
      log.error(
        `File too large: ${(buf.byteLength / MB).toFixed(1)}MB — the pod accepts up to ${cap / MB}MB for ${mimeType}.`
      );
      process.exit(1);
    }
    let properties: Record<string, string>;
    try {
      properties = parseProps(opts.prop);
    } catch (e) {
      log.error((e as Error).message);
      process.exit(1);
    }

    const res = await sendUpload(
      {
        buf,
        filename,
        mimeType,
        workspaceId,
        // Only an explicit --workspace pins; the configured default stays context.
        targetWorkspaceId: opts.workspace,
        title: opts.title,
        profileSlug: opts.profile,
        properties,
      },
      cfg
    );

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
