/**
 * synap import — "capture, but for files and URLs" (personal OS intake).
 *
 * Routing (INTAKE-CONSOLIDATION-PLAN Wave 1):
 *   - Superwhisper store-first     → lib/superwhisper-import (unchanged)
 *   - Single file OR single URL    → POST /capture/structure + /capture/execute
 *   - 2 text-like files
 *     (md / markdown / txt / csv)  → ONE batch via SYNCHRONOUS REST import:
 *         POST /import/analyze  → human review (or --yes / --dry-run)
 *         POST /import/apply    → materialize the EXACT previewed ops
 *   - ≥CORPUS_THRESHOLD (3) such
 *     files                        → ONE BACKGROUND job (the sync door times out):
 *         POST /import/enqueue-corpus  → { jobId }, returns immediately
 *         GET  /import/corpus-job/{id} → poll to "completed"
 *       On completion the result is ONE pending governed `import.graph`
 *       proposal — NOT stored entities. `--dry-run` never takes this door
 *       (enqueueing is itself a write).
 *   - Mixed binary/URL + text      → capture path for URLs/binaries;
 *                                    batch text via /import/* when N≥2
 *
 * Directory walks cap at DIR_FILE_CAP (sync analyze max); truncate is warned,
 * never silent. After expansion, batch-eligible text is also capped at
 * GLOBAL_BATCH_CAP (same ceiling) across all inputs — not only per-directory.
 * Workspace/project from --workspace / --project (or cfg);
 * session from --session (active session id).
 *
 * Optional --home-map rewrites batch item paths so the backend path heuristic
 * (workspace **name** as a path segment) pins multi-home destinations. Example:
 *   --home-map "Projects=Builder,Posts=Content OS"
 * rewrites `5. Projects/foo.md` → `Builder/5. Projects/foo.md`. No product
 * defaults — user-supplied pairs only. It applies to the corpus door too: the
 * background job forwards `items` verbatim into the SAME
 * `ImportOrchestrator.analyzeLarge` the sync door reaches, so the path
 * heuristic is identical on both.
 *
 * No Company OS coupling — pure personal intake doors.
 */

import chalk from "chalk";
import { readFileSync, statSync, readdirSync, existsSync, type Dirent } from "node:fs";
import { extname, basename, join, relative } from "node:path";
import * as readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { log } from "../utils/logger.js";
import {
  resolveHubConfig,
  resolveUserId,
  hubGet,
  hubPost,
  resolveActiveSessionId,
  type HubConfig,
  renderHubError,
} from "../lib/hub-client.js";
import { unwrapList } from "../lib/unwrapList.js";
import { pollForApproval } from "../lib/approval-poll.js";
import { FLOW, renderNextSteps } from "../lib/next-steps.js";
import { formatLaneLine, resolveWorkspaceName, type LaneReport } from "../lib/capture-lane.js";
import {
  isDegraded,
  degradedMessage,
  readCaptureExecute,
  type StructureResult,
  type ExecuteResult,
} from "../lib/capture-structure.js";

export interface ImportOpts {
  workspace?: string;
  project?: string;
  dryRun?: boolean;
  yes?: boolean;
  session?: boolean;
  json?: boolean;
  podUrl?: string;
  apiKey?: string;
  /**
   * Preferred-home map: comma-separated `pathSubstring=workspaceNameOrId`.
   * Matched paths (case-insensitive substring) are rewritten so the first
   * path segment is the resolved workspace **name** — backend deep structure
   * matches workspace names in path segments.
   */
  homeMap?: string;
  /** Adapter name: "superwhisper" enables paired store-first path. */
  source?: string;
  /** Skip AI structure; store corpus units (Superwhisper). */
  storeFirst?: boolean;
  withAudio?: boolean;
  /**
   * Preserve the ORIGINAL file alongside the entities the AI derived from it.
   *
   * Default (absent) is extract-and-discard: the bytes are read for structuring
   * and then dropped, so an imported PDF produced entities with no `documentId`
   * and no source document — dogfooding an import of a real PDF found exactly
   * that. `--with-audio` is NOT this: it is Superwhisper-adapter-specific and
   * only rides the store-first path. This flag threads `keepRaw` + the bytes
   * through the SAME `capture.execute` disposition the browser uses.
   */
  keepRaw?: boolean;
  limit?: number;
  concurrency?: number;
  resume?: boolean;
  /** `--job-status <uuid>`: re-poll a background corpus job instead of importing. */
  jobStatus?: string;
}

// ─── input classification ─────────────────────────────────────────────────────

const TEXT_LIKE = new Set([".md", ".markdown", ".txt", ".csv", ".json", ".html", ".htm"]);

/** Extensions eligible for the multi-file REST /import/analyze batch path. */
const BATCH_TEXT_EXTS = new Set([".md", ".markdown", ".txt", ".csv"]);

const MIME: Record<string, string> = {
  ".md": "text/markdown",
  ".markdown": "text/markdown",
  ".txt": "text/plain",
  ".csv": "text/csv",
  ".json": "application/json",
  ".html": "text/html",
  ".htm": "text/html",
  ".pdf": "application/pdf",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".doc": "application/msword",
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
};

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const URL_RE = /^https?:\/\//i;

/**
 * Cap on files pulled from a single directory — log + truncate, never silently drop.
 * Aligned with sync /import/analyze max items (2000).
 */
const DIR_FILE_CAP = 2000;

/**
 * Global cap on batch-eligible text items across ALL inputs (not only one dir).
 * Same ceiling as sync /import/analyze max items.
 */
const GLOBAL_BATCH_CAP = 2000;

/** Generous timeout: deep vault structure can take minutes on large corpora. */
const IMPORT_ANALYZE_TIMEOUT_MS = 300_000;
const IMPORT_APPLY_TIMEOUT_MS = 120_000;

/**
 * At or above this many batch-eligible text files, route to the BACKGROUND
 * corpus door (`POST /import/enqueue-corpus`) instead of the synchronous
 * `/import/analyze`.
 *
 * Why 3, measured rather than guessed: 3 markdown files complete in ~2m01s on
 * the background worker, and the SAME 3 files fail 0/5 through /import/analyze,
 * each dying at 45–48s against the pod's 45s request timeout. So 3 is the
 * smallest N at which the synchronous door is observed to be unusable.
 *
 * Below it (1–2 files) the synchronous path stays: it is proven to work at that
 * size and it is strictly more interactive — it renders the operation list, the
 * multi-home placement and the quality report, then applies on a y/N confirm.
 * The corpus door can offer none of that; it returns a job handle and files ONE
 * governed proposal for later review. Routing everything through it would trade
 * a working interactive preview for a background job on inputs that never
 * needed one.
 */
export const CORPUS_THRESHOLD = 3;

/** Gap between corpus-job polls. 12 req/min — well under the hub RPM budget. */
const CORPUS_POLL_INTERVAL_MS = 5_000;
/** Heartbeat cadence for the human progress line (poll ticks are quieter). */
const CORPUS_PROGRESS_EVERY_MS = 30_000;
/** Observed worker throughput: 3 files → ~2m01s ≈ 40s/file. Rounded up. */
const CORPUS_MS_PER_ITEM = 45_000;
/** Never wait less than this, even for a 3-file corpus. */
const CORPUS_MIN_WAIT_MS = 10 * 60_000;
/**
 * Never block a terminal longer than this. Hitting it is NOT a failure — the
 * job keeps running server-side and the CLI prints how to re-poll.
 */
const CORPUS_MAX_WAIT_MS = 2 * 60 * 60_000;

type ImportSource = "obsidian" | "markdown" | "csv";

type ImportItem =
  | { kind: "url"; label: string; url: string }
  | {
      kind: "file";
      label: string;
      /** Source-relative path for /import/analyze (vault structure). */
      path: string;
      file: { content: string; mimeType: string; filename: string; encoding: "base64" | "utf8" };
    };

type BatchTextItem = {
  path: string;
  content: string;
  label: string;
};

/** Wire shape from POST /import/analyze (Wave 1 REST → ImportOrchestrator). */
interface ImportAnalyzeResult {
  workspaceId?: string | null;
  source?: string;
  mode?: string;
  proposalId?: string | null;
  sessionId?: string | null;
  operations?: unknown[];
  summary?: string;
  stats?: Record<string, unknown>;
  droppedReferences?: number;
  aiTyped?: number;
  tablePlan?: unknown;
  /** Multi-home placement summary (create_entity destinations). */
  homes?: {
    byWorkspace?: Record<string, number>;
    podWide?: number;
    byProject?: Record<string, number>;
    multiHome?: boolean;
  };
  /** Continuous-improvement quality report (stored on proposal too). */
  quality?: {
    score?: number;
    summary?: string;
    counts?: Record<string, unknown>;
    hierarchy?: Record<string, unknown>;
    findings?: Array<{ id?: string; severity?: string; message?: string }>;
    nextUpgrades?: string[];
  };
  [key: string]: unknown;
}

/** Wire shape from POST /import/apply. */
interface ImportApplyResult {
  workspaceId?: string | null;
  source?: string;
  created?: number;
  linked?: number;
  [key: string]: unknown;
}

function mimeFor(path: string): string {
  return MIME[extname(path).toLowerCase()] ?? "application/octet-stream";
}

/** Read a single file into an ImportItem (utf8 for text-like, base64 otherwise). */
function fileToItem(path: string, displayPath?: string): ImportItem {
  const ext = extname(path).toLowerCase();
  const filename = basename(path);
  const mimeType = mimeFor(path);
  const rel = displayPath ?? path;
  if (TEXT_LIKE.has(ext)) {
    return {
      kind: "file",
      label: rel,
      path: rel,
      file: { content: readFileSync(path, "utf8"), mimeType, filename, encoding: "utf8" },
    };
  }
  return {
    kind: "file",
    label: rel,
    path: rel,
    file: { content: readFileSync(path).toString("base64"), mimeType, filename, encoding: "base64" },
  };
}

/** Recursively collect files under a directory, skipping node_modules/.git/dotfiles. */
function walkDir(dir: string, acc: string[]): void {
  if (acc.length >= DIR_FILE_CAP) return;
  let entries: Dirent[] = [];
  try {
    entries = readdirSync(dir, { withFileTypes: true }) as Dirent[];
  } catch {
    return;
  }
  for (const e of entries) {
    if (acc.length >= DIR_FILE_CAP) return;
    if (e.name.startsWith(".")) continue; // dotfiles + dot-dirs (.git, .env, …)
    if (e.name === "node_modules") continue;
    const full = join(dir, e.name);
    if (e.isDirectory()) {
      walkDir(full, acc);
    } else if (e.isFile()) {
      acc.push(full);
    }
  }
}

/**
 * Expand the raw CLI inputs into a flat list of import items. Returns the items
 * plus any per-input failures (missing paths) and a `truncated` flag if a
 * directory exceeded DIR_FILE_CAP.
 */
function expandInputs(inputs: string[]): {
  items: ImportItem[];
  failures: { label: string; error: string }[];
  truncated: boolean;
} {
  const items: ImportItem[] = [];
  const failures: { label: string; error: string }[] = [];
  let truncated = false;

  for (const raw of inputs) {
    if (URL_RE.test(raw)) {
      items.push({ kind: "url", label: raw, url: raw });
      continue;
    }
    if (!existsSync(raw)) {
      failures.push({ label: raw, error: "no such file, directory, or URL" });
      continue;
    }
    let st;
    try {
      st = statSync(raw);
    } catch (e) {
      failures.push({ label: raw, error: (e as Error).message });
      continue;
    }
    if (st.isDirectory()) {
      const files: string[] = [];
      walkDir(raw, files);
      if (files.length >= DIR_FILE_CAP) truncated = true;
      for (const f of files) {
        try {
          // Preserve vault-relative paths so wikilink/relation resolution works.
          const rel = relative(raw, f) || basename(f);
          items.push(fileToItem(f, rel));
        } catch (e) {
          failures.push({ label: f, error: (e as Error).message });
        }
      }
    } else {
      try {
        items.push(fileToItem(raw));
      } catch (e) {
        failures.push({ label: raw, error: (e as Error).message });
      }
    }
  }
  return { items, failures, truncated };
}

/** True when this item can join a multi-file /import/analyze batch. */
function isBatchTextItem(item: ImportItem): item is ImportItem & { kind: "file" } {
  if (item.kind !== "file") return false;
  if (item.file.encoding !== "utf8") return false;
  const ext = extname(item.path).toLowerCase() || extname(item.file.filename).toLowerCase();
  return BATCH_TEXT_EXTS.has(ext);
}

/**
 * Source heuristic for the batch door:
 *   - any .csv → "csv"
 *   - mostly .md/.markdown → "markdown"
 *   - default → "markdown"
 */
function sourceForBatchItems(items: BatchTextItem[]): ImportSource {
  if (items.some((i) => i.path.toLowerCase().endsWith(".csv"))) return "csv";
  const mdCount = items.filter((i) => /\.(md|markdown)$/i.test(i.path)).length;
  if (mdCount * 2 >= items.length) return "markdown";
  return "markdown";
}

function toBatchTextItem(item: ImportItem & { kind: "file" }): BatchTextItem {
  return {
    path: item.path,
    content: item.file.content,
    label: item.label,
  };
}

// Structure/execute wire shapes + the degraded/execute interpreters are shared
// with `synap capture` in lib/capture-structure.ts (ONE mirror, no drift).

// ─── --home-map (client prepass for multi-home path heuristic) ────────────────

type HomeMapPair = { pathSubstring: string; workspace: string };
/** Resolved map: path substring → workspace **name** (for path prefix rewrite). */
type ResolvedHomeMapEntry = { pathSubstring: string; workspaceName: string };

/**
 * Parse `--home-map "Projects=Builder,Posts=Content OS"` into pairs.
 * Values may be workspace names or UUIDs (resolved later).
 */
export function parseHomeMap(raw: string): HomeMapPair[] {
  const pairs: HomeMapPair[] = [];
  // Split on commas that separate pairs. Values may contain spaces but not commas.
  for (const part of raw.split(",")) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    const eq = trimmed.indexOf("=");
    if (eq <= 0 || eq === trimmed.length - 1) {
      throw new Error(
        `Invalid --home-map entry '${trimmed}'. Expected pathSubstring=workspaceNameOrId ` +
          `(e.g. Projects=Builder,Posts=Content OS).`
      );
    }
    const pathSubstring = trimmed.slice(0, eq).trim();
    const workspace = trimmed.slice(eq + 1).trim();
    if (!pathSubstring || !workspace) {
      throw new Error(
        `Invalid --home-map entry '${trimmed}'. Both pathSubstring and workspace are required.`
      );
    }
    pairs.push({ pathSubstring, workspace });
  }
  if (pairs.length === 0) {
    throw new Error(
      `Empty --home-map. Expected pathSubstring=workspaceNameOrId pairs ` +
        `(e.g. Projects=Builder,Posts=Content OS).`
    );
  }
  return pairs;
}

/**
 * Resolve home-map values to workspace **names** (id → name when UUID given).
 * Backend path heuristic matches segment equality against workspace names.
 */
async function resolveHomeMap(
  pairs: HomeMapPair[],
  cfg: HubConfig
): Promise<ResolvedHomeMapEntry[]> {
  const res = (await hubGet("/workspaces", {}, cfg)) as Record<string, unknown>;
  const list = unwrapList<Record<string, unknown>>(res, ["workspaces"]);
  const names = list.map((w) => String(w.name ?? w.id)).join(", ");

  return pairs.map(({ pathSubstring, workspace }) => {
    if (UUID_RE.test(workspace)) {
      const match = list.find((w) => String(w.id) === workspace);
      if (!match) {
        throw new Error(
          `Home-map workspace id '${workspace}' not found.${names ? ` Available: ${names}` : ""}`
        );
      }
      const workspaceName = String(match.name ?? "").trim();
      if (!workspaceName) {
        throw new Error(`Home-map workspace '${workspace}' has no name — cannot rewrite paths.`);
      }
      return { pathSubstring, workspaceName };
    }
    const match = list.find(
      (w) => String(w.name ?? "").toLowerCase() === workspace.toLowerCase()
    );
    if (!match) {
      throw new Error(
        `Home-map workspace '${workspace}' not found.${names ? ` Available: ${names}` : ""}`
      );
    }
    return { pathSubstring, workspaceName: String(match.name) };
  });
}

/**
 * If `path` contains any map pathSubstring (case-insensitive), prefix with the
 * resolved workspace name so deep-structure segment match pins that home.
 * First matching pair wins. Skips rewrite when the path already starts with the
 * workspace name segment.
 */
export function applyHomeMapToPath(
  path: string,
  map: ResolvedHomeMapEntry[]
): string {
  if (map.length === 0 || !path) return path;
  const lower = path.toLowerCase();
  for (const { pathSubstring, workspaceName } of map) {
    if (!pathSubstring) continue;
    if (!lower.includes(pathSubstring.toLowerCase())) continue;
    const prefix = workspaceName + "/";
    // Already rewritten or vault already uses workspace name as root.
    if (
      path === workspaceName ||
      path.startsWith(prefix) ||
      path.toLowerCase().startsWith(prefix.toLowerCase())
    ) {
      return path;
    }
    return `${workspaceName}/${path}`;
  }
  return path;
}

/** Apply home-map path rewrite to batch text items (labels stay original). */
function applyHomeMapToBatchItems(
  items: BatchTextItem[],
  map: ResolvedHomeMapEntry[]
): BatchTextItem[] {
  if (map.length === 0) return items;
  return items.map((i) => {
    const next = applyHomeMapToPath(i.path, map);
    if (next === i.path) return i;
    return { ...i, path: next };
  });
}

// ─── workspace / project name → id resolution ─────────────────────────────────

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

// ─── rendering ─────────────────────────────────────────────────────────────────

function renderProposals(result: StructureResult): void {
  const proposals = result.proposals ?? [];
  if (proposals.length === 0) {
    log.dim("No entity proposals extracted.");
    return;
  }
  log.heading("Proposed entities");
  const typeW = Math.min(18, Math.max(6, ...proposals.map((p) => p.profileSlug.length)));
  const titleW = Math.min(48, Math.max(10, ...proposals.map((p) => p.title.length)));
  console.log(
    "  " +
      [chalk.bold("#".padEnd(3)), chalk.bold("Type".padEnd(typeW)), chalk.bold("Title".padEnd(titleW))].join("  ")
  );
  console.log("  " + chalk.dim("-".repeat(3 + 2 + typeW + 2 + titleW)));
  for (let i = 0; i < proposals.length; i++) {
    const p = proposals[i];
    console.log(
      "  " +
        [
          chalk.dim(String(i + 1).padEnd(3)),
          chalk.cyan(p.profileSlug.slice(0, typeW).padEnd(typeW)),
          p.title.slice(0, titleW).padEnd(titleW),
        ].join("  ")
    );
    if (p.description) log.dim(`     ${p.description.slice(0, 80)}`);
  }
  const rels = result.relations ?? [];
  if (rels.length > 0) {
    log.blank();
    log.dim(`  ${rels.length} relation${rels.length !== 1 ? "s" : ""} will be created.`);
  }
}

function pct(c?: number | null): string {
  return typeof c === "number" ? ` (${Math.round(c * 100)}%)` : "";
}

/** Print the AI's proposed workspace/project routing for this item. */
function renderRouting(result: StructureResult, wsOverride?: string, projOverride?: string): void {
  const ws = wsOverride ?? result.targetWorkspaceId ?? null;
  const proj = projOverride ?? result.targetProjectId ?? null;
  const wsSrc = wsOverride ? " (override)" : pct(result.targetWorkspaceConfidence);
  const projSrc = projOverride ? " (override)" : pct(result.targetProjectConfidence);
  log.dim(`  → workspace: ${ws ?? "pod-wide / unclear"}${wsSrc}`);
  if (result.targetWorkspaceReason && !wsOverride) log.dim(`      ${result.targetWorkspaceReason.slice(0, 90)}`);
  log.dim(`  → project:   ${proj ?? "none / unclear"}${projSrc}`);
  if (result.targetProjectReason && !projOverride) log.dim(`      ${result.targetProjectReason.slice(0, 90)}`);
}

function renderBatchAnalyze(result: ImportAnalyzeResult, fileCount: number, source: ImportSource): void {
  const ops = result.operations ?? [];
  log.heading(`▸ Batch import (${fileCount} file${fileCount !== 1 ? "s" : ""}, source=${source})`);
  if (result.summary) log.info(`  ${result.summary}`);
  log.dim(
    `  ${ops.length} operation${ops.length !== 1 ? "s" : ""}` +
      (result.mode ? ` · mode ${result.mode}` : "") +
      (result.proposalId ? ` · proposal ${result.proposalId}` : "") +
      (result.sessionId ? ` · session ${result.sessionId}` : "")
  );
  if (result.stats && typeof result.stats === "object") {
    const s = result.stats;
    const bits: string[] = [];
    if (s.entityCount != null) bits.push(`${s.entityCount} entities`);
    if (s.relationCount != null) bits.push(`${s.relationCount} relations`);
    if (s.itemCount != null) bits.push(`${s.itemCount} items`);
    if (s.typeCount != null) bits.push(`${s.typeCount} types`);
    if (s.itemsProcessed != null) bits.push(`${s.itemsProcessed} processed`);
    if (bits.length > 0) log.dim(`  stats: ${bits.join(" · ")}`);
  }
  // Multi-home: show where create_entity ops will land (per-op targetWorkspaceId).
  const homes = result.homes;
  if (homes && typeof homes === "object") {
    const parts: string[] = [];
    for (const [wid, n] of Object.entries(homes.byWorkspace ?? {})) {
      parts.push(`${wid.slice(0, 8)}…×${n}`);
    }
    if (homes.podWide && homes.podWide > 0) parts.push(`pod-wide×${homes.podWide}`);
    if (parts.length > 0) {
      log.info(
        `  homes${homes.multiHome ? " (multi)" : ""}: ${parts.join(" · ")}`
      );
    }
    const proj = homes.byProject ?? {};
    const projParts = Object.entries(proj).map(
      ([pid, n]) => `${pid.slice(0, 8)}…×${n}`
    );
    if (projParts.length > 0) log.dim(`  projects: ${projParts.join(" · ")}`);
  } else if (result.workspaceId) {
    log.dim(`  → workspace: ${result.workspaceId}`);
  }

  // Quality report — refuse / improve / apply loop
  const q = result.quality;
  if (q && typeof q.score === "number") {
    log.info(`  ${q.summary ?? `quality ${q.score}/100`}`);
    const findings = q.findings ?? [];
    for (const f of findings.slice(0, 8)) {
      const tag = (f.severity ?? "info").toUpperCase();
      log.dim(`    [${tag}] ${f.message ?? f.id}`);
    }
    const ups = q.nextUpgrades ?? [];
    if (ups.length > 0) {
      log.info("  next upgrades:");
      for (const u of ups.slice(0, 5)) log.dim(`    → ${u}`);
    }
    if (result.proposalId) {
      log.dim(
        `  proposal ${result.proposalId} stores quality+ops — refuse in UI, re-import with upgrades, apply when score looks good`
      );
    }
  }
}

// ─── per-item pipeline ─────────────────────────────────────────────────────────

export interface ItemOutcome {
  label: string;
  status:
    | "stored"
    | "proposed"
    | "degraded"
    | "dry-run"
    | "skipped"
    | "empty"
    | "failed"
    /**
     * Background corpus job accepted, but not observed to finish inside this
     * invocation's wait window. Nothing was lost — the job keeps running on the
     * pod. Exit code stays 0 (see importExitCode): a still-running job is not a
     * degraded one.
     */
    | "queued";
  entities?: number;
  relations?: number;
  workspaceId?: string | null;
  projectId?: string | null;
  error?: string;
  /**
   * Why the item degraded. Either a pod plumbing reason (`is_auth_error` |
   * `is_invalid_response` | `is_empty_result`) or an Intelligence Service
   * extraction reason (`vision_provider_not_configured`,
   * `pdf_scanned_needs_ocr`, `unsupported_type`, …) — the pod no longer
   * relabels the latter as the former. The human path prints this through
   * `degradedMessage()`; carrying the raw token here keeps `--json` machine
   * readable while the human line stays token-free.
   */
  degradedReason?: string;
  /**
   * What happened to the ORIGINAL file under `--keep-raw`. Absent when nothing
   * was kept. Never collapsed to a boolean: `denied` (policy said no) and
   * `failed` (storage broke) are different problems, and `proposed` means the
   * blob is still only a pending review.
   */
  sourceFile?: "stored" | "proposed" | "denied" | "failed";
  /** Present for the multi-file /import/* batch path. */
  batch?: {
    source: ImportSource;
    fileCount: number;
    proposalId?: string | null;
    sessionId?: string | null;
    analyze?: ImportAnalyzeResult;
    apply?: ImportApplyResult;
    /** Present for the background /import/enqueue-corpus path. */
    corpus?: {
      jobId: string | null;
      /** Last pg-boss state we observed, or "unknown" if we never got one. */
      state: string;
      /** True when the wait window elapsed with the job still running. */
      timedOut: boolean;
      waitedMs: number;
      itemCount: number;
      /**
       * File-level truth from the job's own output. `outcomeKnown: false` means
       * the pod did not report it (older pod, or job unfinished) — a script must
       * treat that as UNKNOWN, not as "0 failed".
       */
      outcomeKnown?: boolean;
      filesProcessed?: number | null;
      filesFailed?: number | null;
      findings?: Array<{ id?: string; severity?: string; message?: string }>;
      proposalId?: string | null;
    };
  };
}

/**
 * Build the outcome for an item the IS structurer could not structure.
 *
 * Carries `degradedReason` so `--json` reports the same cause the human path
 * already prints via `degradedMessage()`. Without it a scripted import saw
 * `{"status":"degraded"}` with no way to tell an auth error from an empty
 * result — the reason existed on the wire and was dropped at this one seam.
 */
export function degradedOutcome(
  label: string,
  res: StructureResult,
  workspaceId: string | null,
  projectId: string | null
): ItemOutcome {
  return {
    label,
    status: "degraded",
    workspaceId,
    projectId,
    ...(res.degradedReason ? { degradedReason: res.degradedReason } : {}),
  };
}

/**
 * The exit code for a finished import run.
 *
 * A degraded item produced ZERO entities — the IS structurer was down and the
 * CLI deliberately created nothing. Exiting 0 on that told a scripted backfill
 * "success" while most of its input was silently lost, so `degraded` is a
 * non-zero outcome exactly like `failed`.
 *
 * Everything else stays 0, including a clean `--dry-run` (nothing was meant to
 * be written), a `skipped` item (the user declined) and an `empty` one (the
 * structurer ran fine and honestly found nothing to create).
 *
 * Scoped to `import` on purpose: this is `import`'s own final line, not a
 * shared helper, so no other command's exit semantics change.
 */
export function importExitCode(outcomes: Array<{ status: ItemOutcome["status"] }>): number {
  return outcomes.some((o) => o.status === "failed" || o.status === "degraded") ? 1 : 0;
}

/**
 * The `keepRaw` half of a `/capture/execute` body — `{}` unless `--keep-raw`
 * was passed for a FILE item.
 *
 * Three things it must get right, all of which the pod silently tolerates:
 *  • `content` MUST be base64. `fileToItem` reads text-like files as utf8, and
 *    the pod does `Buffer.from(content, "base64")` unconditionally — sending
 *    utf8 there stores a mangled blob with no error.
 *  • `extractedText` is echoed from the structure response so the stored
 *    document lands with a real v1 body. Skipping it leaves
 *    `document_versions.content` empty, which blinds the embedding worker, the
 *    retrieval body join and Typesense enrichment.
 *  • A URL item has no bytes to keep, so `keepRaw` is simply not sent — the pod
 *    would accept `keepRaw: true` with no file and do nothing.
 */
export function buildKeepRawPayload(
  opts: Pick<ImportOpts, "keepRaw">,
  item: ImportItem,
  structureRes: Pick<StructureResult, "extraction">
): Record<string, unknown> {
  if (!opts.keepRaw || item.kind !== "file") return {};
  const content =
    item.file.encoding === "base64"
      ? item.file.content
      : Buffer.from(item.file.content, "utf8").toString("base64");
  const extractedText = structureRes.extraction?.text;
  return {
    keepRaw: true,
    file: {
      content,
      mimeType: item.file.mimeType,
      filename: item.file.filename,
      ...(extractedText ? { extractedText } : {}),
      ...(structureRes.extraction?.textTruncated
        ? { extractedTextTruncated: true }
        : {}),
    },
  };
}

/**
 * One line describing what ACTUALLY happened to a kept original. The pod
 * reports four dispositions and they are not interchangeable: a
 * governance-parked attach is not a save, and a policy denial is not a storage
 * failure. Returns null when nothing was kept (so nothing is claimed).
 */
export function keepRawLine(res: ExecuteResult): string | null {
  const sf = res.sourceFile;
  if (!sf) return null;
  switch (sf.status) {
    case "stored":
      return "original kept and linked to the entity";
    case "proposed":
      return `original awaiting review${sf.reviewUrl ? ` — ${sf.reviewUrl}` : ""}`;
    case "denied":
      return `original NOT kept — policy declined it${sf.reason ? `: ${sf.reason}` : ""}`;
    case "failed":
      return "original NOT kept — the pod could not store it";
    default:
      return null;
  }
}

async function processItem(
  item: ImportItem,
  opts: ImportOpts,
  cfg: HubConfig,
  userId: string,
  wsOverride: string | undefined,
  projOverride: string | undefined,
  sessionId: string | undefined,
  rl: readline.Interface | undefined
): Promise<ItemOutcome> {
  // 1. Structure — workspace hint = override ?? active (the AI may still re-route).
  const structureBody: Record<string, unknown> = {
    userId,
    ...(wsOverride ?? cfg.workspaceId ? { workspaceId: wsOverride ?? cfg.workspaceId } : {}),
    ...(sessionId ? { sessionId } : {}),
  };
  if (item.kind === "url") structureBody.url = item.url;
  else structureBody.file = item.file;

  // File extraction (PDF/audio/image) runs through the IS extractor and is slow —
  // give structure a generous timeout (capture's free-text path is fast).
  const structureRes = (await hubPost("/capture/structure", structureBody, cfg, 120_000)) as StructureResult;

  const wsTarget = wsOverride ?? structureRes.targetWorkspaceId ?? cfg.workspaceId ?? null;
  const projTarget = projOverride ?? structureRes.targetProjectId ?? null;
  const proposals = structureRes.proposals ?? [];

  // Degraded: the IS structurer is down. Create nothing (same as `synap
  // capture` and the browser) — report it honestly instead of materializing the
  // raw stand-in and counting it as a successful import.
  if (isDegraded(structureRes)) {
    if (!opts.json) {
      log.heading(`▸ ${item.label}`);
      log.warn(`  ${degradedMessage(structureRes)}`);
    }
    return degradedOutcome(item.label, structureRes, wsTarget, projTarget);
  }

  if (!opts.json) {
    log.heading(`▸ ${item.label}`);
    renderProposals(structureRes);
    renderRouting(structureRes, wsOverride, projOverride);
  }

  if (proposals.length === 0) {
    return { label: item.label, status: "empty", workspaceId: wsTarget, projectId: projTarget };
  }

  if (opts.dryRun) {
    return {
      label: item.label,
      status: "dry-run",
      entities: proposals.length,
      relations: (structureRes.relations ?? []).length,
      workspaceId: wsTarget,
      projectId: projTarget,
    };
  }

  // 2. Confirm (skipped with --yes or in --json mode).
  let confirmed = Boolean(opts.yes);
  if (!confirmed && !opts.json && rl) {
    const answer = await rl.question(
      chalk.bold(`  Create ${proposals.length} entr${proposals.length !== 1 ? "ies" : "y"} from this item? [y/N] `)
    );
    confirmed = answer.trim().toLowerCase() === "y";
  }
  if (!confirmed) {
    if (!opts.json) log.dim("  Skipped.");
    return { label: item.label, status: "skipped", workspaceId: wsTarget, projectId: projTarget };
  }

  // 3. Execute — route to the resolved workspace/project.
  //    An explicit --workspace override is a deliberate pin: send it as-is, no
  //    AI routing hints. Otherwise stop pre-resolving the target client-side —
  //    forward the ambient workspace + the AI's routing signal and let the
  //    backend decide (auto = AI target wins over ambient when confidence is
  //    high enough AND the user is a member).
  //    NOTE: the hub REST /capture/execute door currently forwards only
  //    workspaceId (not projectId) to the tRPC caller; projectId is sent for
  //    forward-compatibility but is not yet applied server-side via this door.
  const executeBody: Record<string, unknown> = {
    userId,
    ...(wsOverride
      ? { workspaceId: wsOverride }
      : {
          ...(cfg.workspaceId ? { workspaceId: cfg.workspaceId } : {}),
          workspaceRouting: "auto",
          aiWorkspaceId: structureRes.targetWorkspaceId,
          aiWorkspaceConfidence: structureRes.targetWorkspaceConfidence,
          aiWorkspaceReason: structureRes.targetWorkspaceReason,
        }),
    ...(projTarget ? { projectId: projTarget } : {}),
    ...(sessionId ? { sessionId } : {}),
    entities: proposals,
    relations: structureRes.relations ?? [],
    // --keep-raw: preserve the ORIGINAL artifact, not just what the AI read out
    // of it. Without this the imported bytes are discarded, so the created
    // entity has no `documentId` and no source document at all.
    ...buildKeepRawPayload(opts, item, structureRes),
  };
  const executeRes = (await hubPost("/capture/execute", executeBody, cfg, 60_000)) as ExecuteResult;

  // Report what the pod ACTUALLY returned. A workspace policy can queue the
  // write as a proposal instead of applying it — surface that honestly (real
  // proposal/review handle) rather than hardcoding "auto"/"created".
  const outcome = readCaptureExecute(executeRes);

  if (outcome.proposed) {
    if (!opts.json) {
      log.heading(`▸ ${item.label}`);
      log.info(`  Proposed — under review, not yet stored.`);
      if (outcome.proposalId) log.dim(`    proposal: ${outcome.proposalId}`);
      if (outcome.reviewUrl) log.dim(`    review: ${outcome.reviewUrl}`);
    }
    return { label: item.label, status: "proposed", entities: 0, relations: 0, workspaceId: wsTarget, projectId: projTarget };
  }

  const entityCount = outcome.entitiesCreated;
  const relCount = outcome.relationsCreated;
  // Final resting workspace: the backend may have moved it (auto routing);
  // otherwise fall back to the pre-execute guess.
  const finalWorkspaceId = outcome.movedToWorkspace ?? wsTarget;

  if (!opts.json) {
    const report: LaneReport = {
      lane: "work",
      workspaceId: finalWorkspaceId ?? undefined,
      workspaceName: finalWorkspaceId ? await resolveWorkspaceName(finalWorkspaceId, cfg) : "pod-wide",
      governance: "auto",
    };
    log.success(`  ${entityCount} entit${entityCount !== 1 ? "ies" : "y"} created${relCount ? `, ${relCount} relation${relCount !== 1 ? "s" : ""}` : ""}`);
    if (outcome.entitiesLinked) {
      log.dim(`  ${outcome.entitiesLinked} linked to existing entit${outcome.entitiesLinked !== 1 ? "ies" : "y"}`);
    }
    console.log("  " + formatLaneLine(report) + (projTarget ? chalk.dim(` [project ${projTarget.slice(0, 8)}]`) : ""));
    if (outcome.movedToWorkspace) {
      log.dim(`  → filed into workspace ${outcome.movedToWorkspace}`);
    }
    const kept = keepRawLine(executeRes);
    if (kept) log.dim(`  ${kept}`);
  }

  const keptStatus = executeRes.sourceFile?.status;

  return {
    label: item.label,
    status: "stored",
    entities: entityCount,
    relations: relCount,
    workspaceId: finalWorkspaceId,
    projectId: projTarget,
    // --json parity with the human line above: a scripted import must be able
    // to tell a kept original from a denied or failed one.
    ...(keptStatus ? { sourceFile: keptStatus } : {}),
  };
}

// ─── background corpus door (/import/enqueue-corpus + poll) ───────────────────

/** Wire shape from POST /import/enqueue-corpus (HTTP 202). */
interface EnqueueCorpusResult {
  queued?: boolean;
  jobId?: string | null;
  itemCount?: number;
  workspaceId?: string | null;
}

/**
 * The finished run's FILE-LEVEL outcome, as the pod stores it on the pg-boss job
 * (`output`) and returns it from GET /import/corpus-job/{jobId}.
 *
 * This is the only place a partially failed corpus import is visible. The pod
 * records `filesFailed` on the resulting import.graph proposal; before the pod
 * returned this object the CLI could not see it and printed `0 failed` for a run
 * that had dropped 2 of 3 files.
 */
export interface CorpusJobOutput {
  proposalId?: string | null;
  workspaceId?: string | null;
  filesProcessed?: number;
  filesFailed?: number;
  qualityScore?: number;
  findings?: Array<{ id?: string; severity?: string; message?: string }>;
}

/** Wire shape from GET /import/corpus-job/{jobId}. */
interface CorpusJobStatus {
  jobId?: string;
  state?: string;
  createdOn?: string | null;
  completedOn?: string | null;
  /**
   * Absent on a pod older than the worker that returns its result, and on any
   * unfinished job. Absence is UNKNOWN — never read it as "nothing failed".
   */
  output?: CorpusJobOutput | null;
}

/** What a completed corpus job actually did, once the wire value is judged. */
export type CorpusFileOutcome =
  | { known: false }
  | { known: true; filesProcessed: number | null; filesFailed: number };

/**
 * Judge a completed job's `output`.
 *
 * The ONE place absence is turned into `known: false`. A pod that predates the
 * result-carrying worker returns no output; so does a job whose handler reported
 * nothing. Neither is evidence that every file landed, so neither may collapse
 * into `filesFailed: 0`.
 */
export function readCorpusFileOutcome(
  output: CorpusJobOutput | null | undefined
): CorpusFileOutcome {
  if (!output || typeof output.filesFailed !== "number") return { known: false };
  return {
    known: true,
    filesProcessed:
      typeof output.filesProcessed === "number" ? output.filesProcessed : null,
    filesFailed: output.filesFailed,
  };
}

/**
 * The outcome status a COMPLETED corpus job earns.
 *
 * The ONE decision point: files were dropped → `degraded`, which `importExitCode`
 * already treats as non-zero (no second exit-code path). An unknown outcome stays
 * `proposed` — the proposal genuinely exists — but the caller must print
 * CORPUS_OUTCOME_UNAVAILABLE so the unknown is never read as "0 failed".
 */
export function corpusCompletionOutcome(
  output: CorpusJobOutput | null | undefined
): { status: "proposed" | "degraded"; degradedReason?: string } {
  const outcome = readCorpusFileOutcome(output);
  if (outcome.known && outcome.filesFailed > 0) {
    return {
      status: "degraded",
      degradedReason: `corpus_files_failed:${outcome.filesFailed}`,
    };
  }
  return { status: "proposed" };
}

/** The message shown when the pod cannot tell us what happened per file. */
export const CORPUS_OUTCOME_UNAVAILABLE =
  "file-level outcome unavailable from this pod — it did not report how many files were structured or dropped. " +
  "This is NOT a confirmation that every file landed: open the import.graph proposal and read quality.counts.";

/**
 * Human lines for a completed corpus run's file-level outcome.
 *
 * Exported so the run summary, the `--job-status` re-poll and the tests all read
 * the SAME judgement — a second copy is how "0 failed" survived on one path.
 */
export function corpusOutcomeLines(
  output: CorpusJobOutput | null | undefined,
  itemCount?: number
): string[] {
  const outcome = readCorpusFileOutcome(output);
  if (!outcome.known) return [CORPUS_OUTCOME_UNAVAILABLE];

  const processed = outcome.filesProcessed ?? "?";
  const total = typeof itemCount === "number" ? ` of ${itemCount}` : "";
  const lines = [
    `files: ${processed}${total} structured · ${outcome.filesFailed} failed`,
  ];
  if (outcome.filesFailed > 0) {
    lines.push(
      `${outcome.filesFailed} file(s) produced NOTHING and are absent from the proposal — re-import them alone once the cause below is addressed.`
    );
  }
  for (const f of (output?.findings ?? []).slice(0, 8)) {
    if (!f?.message) continue;
    lines.push(`[${(f.severity ?? "info").toUpperCase()}] ${f.message}`);
  }
  return lines;
}

/** pg-boss states that mean "this job is over and it did not succeed". */
const CORPUS_DEAD_STATES = new Set(["failed", "cancelled", "expired"]);

/**
 * Which batch door to use. The ONE place the threshold is applied — the human
 * message, the --json payload and the actual POST all read this.
 *
 * `--dry-run` always stays on `/import/analyze`: the corpus door has no preview
 * mode (`previewOnly` is an /import/analyze field), and enqueueing is itself a
 * durable write. A dry run that queued a background job would be a dry run that
 * writes — the exact thing the flag promises not to do.
 */
export function chooseBatchDoor(args: {
  fileCount: number;
  dryRun?: boolean;
}): "analyze" | "enqueue-corpus" {
  if (args.dryRun) return "analyze";
  return args.fileCount >= CORPUS_THRESHOLD ? "enqueue-corpus" : "analyze";
}

/**
 * How long to wait for a corpus job before handing the terminal back.
 *
 * Scaled from measured throughput (~45s/file) so a small corpus is not waited on
 * for an hour and a 257-file backfill is not abandoned after five minutes, then
 * clamped: never under 10 minutes, never over 2 hours. The ceiling is safe
 * precisely because expiry is not failure — see corpusTimeoutLines().
 */
export function corpusPollTimeoutMs(itemCount: number): number {
  const scaled = itemCount * CORPUS_MS_PER_ITEM;
  return Math.min(Math.max(scaled, CORPUS_MIN_WAIT_MS), CORPUS_MAX_WAIT_MS);
}

function humanDuration(ms: number): string {
  const totalMin = Math.round(ms / 60_000);
  if (totalMin < 60) return `${Math.max(totalMin, 1)}m`;
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  return m ? `${h}h${m}m` : `${h}h`;
}

/**
 * What we print when the wait window elapses.
 *
 * The job is STILL RUNNING — pg-boss holds it, the worker keeps chunking, and
 * the governed `import.graph` proposal will still be written. Saying "failed"
 * (or exiting non-zero) here would send a user to re-run a 257-file import that
 * is already half-done. So: state plainly that nothing was lost, and give the
 * exact command to re-poll.
 */
export function corpusTimeoutLines(jobId: string, waitedMs: number): string[] {
  return [
    `Still running after ${humanDuration(waitedMs)} — this is not a failure.`,
    `The job is queued on the pod and keeps going after this command exits; nothing was lost and nothing was imported twice.`,
    `Re-check it with:  synap import --job-status ${jobId}`,
    `Or watch the review inbox — the finished import lands there as ONE import.graph proposal:  synap proposals list`,
  ];
}

/** Poll a corpus job to completion. Returns the last observed status. */
async function pollCorpusJob(
  jobId: string,
  cfg: HubConfig,
  userId: string,
  itemCount: number,
  quiet: boolean
): Promise<{ status: CorpusJobStatus | null; timedOut: boolean; waitedMs: number }> {
  const timeoutMs = corpusPollTimeoutMs(itemCount);
  const url = new URL(`${cfg.podUrl}/api/hub/import/corpus-job/${jobId}`);
  url.searchParams.set("userId", userId);

  let lastState = "created";
  let lastProgressAt = 0;
  const startedAt = Date.now();

  try {
    // REUSE the shared approval poll — same create→poll shape as CP login and
    // agent-key approval. No second loop, no second backoff policy.
    const status = await pollForApproval<CorpusJobStatus>({
      url: url.toString(),
      headers: { Authorization: `Bearer ${cfg.apiKey}` },
      intervalMs: CORPUS_POLL_INTERVAL_MS,
      timeoutMs,
      isApproved: (d) => (d as CorpusJobStatus)?.state === "completed",
      isRejected: (d) => {
        const state = String((d as CorpusJobStatus)?.state ?? "");
        // Record the terminal state here too, not only in onTick: the rejected
        // path throws, and the catch below reports `lastState`. Reading it only
        // from onTick would make a failed job report the state BEFORE it failed.
        if (state) lastState = state;
        return CORPUS_DEAD_STATES.has(state);
      },
      onApproved: (d) => d as CorpusJobStatus,
      rejectedError: "corpus import job did not complete",
      timeoutError: "__corpus_timeout__",
      onTick: ({ data, elapsedMs }) => {
        const state = (data as CorpusJobStatus | null)?.state;
        if (state) lastState = state;
        if (quiet) return;
        if (elapsedMs - lastProgressAt < CORPUS_PROGRESS_EVERY_MS) return;
        lastProgressAt = elapsedMs;
        log.dim(
          `  … ${lastState} · ${humanDuration(elapsedMs)} elapsed (waiting up to ${humanDuration(timeoutMs)})`
        );
      },
    });
    return { status, timedOut: false, waitedMs: Date.now() - startedAt };
  } catch (e) {
    const waitedMs = Date.now() - startedAt;
    if ((e as Error).message === "__corpus_timeout__") {
      return { status: { jobId, state: lastState }, timedOut: true, waitedMs };
    }
    // Rejected: the job reached a terminal non-success state. Report the state
    // we actually saw rather than a generic "failed".
    return { status: { jobId, state: lastState }, timedOut: false, waitedMs };
  }
}

/**
 * Enqueue a text corpus on the background door and wait for the worker.
 *
 * The door is ADDITIVE onto the same `ImportOrchestrator.analyzeLarge` that
 * `/import/analyze` reaches — chunking, cross-chunk dedup and the single
 * governed `import.graph` proposal all live server-side. This function only
 * posts, polls, and reports.
 */
async function processCorpusImport(
  mappedItems: BatchTextItem[],
  source: ImportSource,
  opts: ImportOpts,
  cfg: HubConfig,
  userId: string,
  workspaceId: string | undefined,
  projOverride: string | undefined,
  sessionId: string | undefined
): Promise<ItemOutcome> {
  const label = `corpus:${source} (${mappedItems.length} files)`;
  const itemCount = mappedItems.length;

  // The enqueue payload the pod builds is {userId, workspaceId, source, items}
  // (hub-protocol/rest/capture.ts) — projectId and sessionId are accepted by the
  // schema and then DROPPED before the job. Warn rather than let a passed flag
  // vanish: on this path they genuinely do not apply.
  if (!opts.json && (projOverride || sessionId)) {
    const dropped = [projOverride ? "--project" : null, sessionId ? "--session" : null]
      .filter(Boolean)
      .join(" and ");
    log.warn(
      `  ${dropped} ${projOverride && sessionId ? "do" : "does"} not apply to the background corpus import — ` +
        `the pod's enqueue payload carries only userId, workspaceId, source and items. ` +
        `Set the project/session on the resulting proposal when you review it.`
    );
  }

  if (!opts.json) {
    log.info(
      `Enqueuing ${itemCount} text file${itemCount !== 1 ? "s" : ""} on the background corpus door ` +
        `(source=${source}) — the synchronous /import/analyze door times out at this size.`
    );
  }

  const enqueueRes = (await hubPost(
    "/import/enqueue-corpus",
    {
      userId,
      source,
      items: mappedItems.map((i) => ({ path: i.path, content: i.content })),
      ...(workspaceId ? { workspaceId } : {}),
    },
    cfg,
    60_000
  )) as EnqueueCorpusResult;

  const jobId = enqueueRes.jobId ?? null;
  const finalWs = enqueueRes.workspaceId ?? workspaceId ?? null;
  const corpusBase = { jobId, itemCount, waitedMs: 0 };

  // pg-boss can accept a send and still return no id (dedup/throttle). We were
  // told "queued", so nothing failed — but we cannot poll a job we cannot name.
  if (!jobId) {
    if (!opts.json) {
      log.warn(
        "  The pod accepted the corpus but returned no job id — it is running, but this command cannot follow it."
      );
      log.dim("  Watch for the import.graph proposal with:  synap proposals list");
    }
    return {
      label,
      status: "queued",
      workspaceId: finalWs,
      projectId: null,
      batch: {
        source,
        fileCount: itemCount,
        proposalId: null,
        sessionId: null,
        corpus: { ...corpusBase, state: "unknown", timedOut: false },
      },
    };
  }

  if (!opts.json) {
    log.dim(`  job ${jobId} · polling every ${CORPUS_POLL_INTERVAL_MS / 1000}s`);
  }

  const { status, timedOut, waitedMs } = await pollCorpusJob(
    jobId,
    cfg,
    userId,
    itemCount,
    Boolean(opts.json)
  );
  const state = status?.state ?? "unknown";
  const corpus = { jobId, itemCount, state, timedOut, waitedMs };
  const batchMeta = {
    source,
    fileCount: itemCount,
    proposalId: null,
    sessionId: null,
    corpus,
  };

  if (timedOut) {
    if (!opts.json) {
      log.blank();
      for (const line of corpusTimeoutLines(jobId, waitedMs)) log.info(`  ${line}`);
    }
    return { label, status: "queued", workspaceId: finalWs, projectId: null, batch: batchMeta };
  }

  if (state !== "completed") {
    if (!opts.json) {
      log.error(`  corpus job ${jobId} ended in state "${state}" — nothing was imported.`);
      log.hint("Check the pod's job logs, then re-run the import.");
    }
    return {
      label,
      status: "failed",
      error: `corpus job ended in state "${state}"`,
      workspaceId: finalWs,
      projectId: null,
      batch: batchMeta,
    };
  }

  // Completed. The result is a PENDING governed proposal — not stored entities.
  // Say exactly that; "created N entities" here would be a lie.
  //
  // And "completed" is NOT "every file landed": the pod structures each file
  // separately and records `filesFailed` on the proposal. Read that number here
  // or the run reports success over an unknown amount of loss.
  const output = status?.output ?? null;
  const fileOutcome = readCorpusFileOutcome(output);
  const lostFiles = fileOutcome.known && fileOutcome.filesFailed > 0;
  const corpusFull = {
    ...corpus,
    outcomeKnown: fileOutcome.known,
    filesProcessed: fileOutcome.known ? fileOutcome.filesProcessed : null,
    filesFailed: fileOutcome.known ? fileOutcome.filesFailed : null,
    ...(output?.findings ? { findings: output.findings } : {}),
    proposalId: output?.proposalId ?? null,
  };
  const fullBatchMeta = {
    ...batchMeta,
    proposalId: output?.proposalId ?? null,
    corpus: corpusFull,
  };

  if (!opts.json) {
    const headline = `  Corpus import finished in ${humanDuration(waitedMs)}${
      lostFiles ? " with FILES MISSING" : ""
    } — ONE import.graph proposal is waiting for review.`;
    if (lostFiles) log.warn(headline);
    else log.success(headline);
    for (const line of corpusOutcomeLines(output, itemCount)) {
      if (fileOutcome.known && !lostFiles) log.dim(`  ${line}`);
      else log.warn(`  ${line}`);
    }
    log.dim("  Nothing is in the graph yet: approving the proposal is what materializes it.");
    renderNextSteps(FLOW.afterCorpusImport());
  }

  // Files dropped → `degraded`, the existing non-zero outcome (importExitCode);
  // otherwise `proposed`, the same meaning the capture path already carries.
  // The judgement lives in corpusCompletionOutcome so the tests exercise the
  // real decision rather than a copy of it.
  const completion = corpusCompletionOutcome(output);

  return {
    label,
    status: completion.status,
    ...(completion.degradedReason
      ? { degradedReason: completion.degradedReason }
      : {}),
    entities: 0,
    relations: 0,
    workspaceId: finalWs,
    projectId: null,
    batch: fullBatchMeta,
  };
}

// ─── multi-file batch via /import/analyze + /import/apply ─────────────────────

async function processBatchImport(
  batchItems: BatchTextItem[],
  opts: ImportOpts,
  cfg: HubConfig,
  userId: string,
  wsOverride: string | undefined,
  projOverride: string | undefined,
  sessionId: string | undefined,
  rl: readline.Interface | undefined,
  homeMap: ResolvedHomeMapEntry[] = []
): Promise<ItemOutcome> {
  // Path rewrite for multi-home: backend matches workspace **names** in path
  // segments. --home-map prefixes matched paths with the resolved name.
  const mappedItems = applyHomeMapToBatchItems(batchItems, homeMap);
  const homeMapRewrites =
    homeMap.length > 0
      ? mappedItems.filter((m, i) => m.path !== batchItems[i]?.path).length
      : 0;

  const source = sourceForBatchItems(mappedItems);
  const label = `batch:${source} (${mappedItems.length} files)`;
  const workspaceId = wsOverride ?? cfg.workspaceId;

  // Above CORPUS_THRESHOLD the synchronous door cannot finish inside the pod's
  // request timeout — hand the SAME mapped items (home-map already applied, caps
  // already enforced, source already resolved) to the background door instead.
  if (chooseBatchDoor({ fileCount: mappedItems.length, dryRun: opts.dryRun }) === "enqueue-corpus") {
    if (!opts.json && homeMapRewrites > 0) {
      log.dim(
        `  home-map: rewrote ${homeMapRewrites} path${homeMapRewrites !== 1 ? "s" : ""} ` +
          `(workspace name as first segment for multi-home placement)`
      );
    }
    return processCorpusImport(
      mappedItems,
      source,
      opts,
      cfg,
      userId,
      workspaceId,
      projOverride,
      sessionId
    );
  }

  const analyzeBody: Record<string, unknown> = {
    userId,
    source,
    items: mappedItems.map((i) => ({ path: i.path, content: i.content })),
    aiStructure: true,
    // --dry-run must not file a durable import.graph proposal (inbox spam).
    // Interactive / --yes still create a real proposal for HITL apply.
    ...(opts.dryRun ? { previewOnly: true } : {}),
    ...(workspaceId ? { workspaceId } : {}),
    ...(projOverride ? { projectId: projOverride } : {}),
    ...(sessionId ? { sessionId } : {}),
  };

  if (!opts.json) {
    log.info(
      `Analyzing ${mappedItems.length} text file${mappedItems.length !== 1 ? "s" : ""} via /import/analyze (source=${source})…`
    );
    if (homeMapRewrites > 0) {
      log.dim(
        `  home-map: rewrote ${homeMapRewrites} path${homeMapRewrites !== 1 ? "s" : ""} ` +
          `(workspace name as first segment for multi-home placement)`
      );
    }
  }

  const analyzeRes = (await hubPost(
    "/import/analyze",
    analyzeBody,
    cfg,
    IMPORT_ANALYZE_TIMEOUT_MS
  )) as ImportAnalyzeResult;

  const ops = analyzeRes.operations ?? [];
  const batchMeta = {
    source,
    fileCount: mappedItems.length,
    proposalId: analyzeRes.proposalId ?? null,
    sessionId: analyzeRes.sessionId ?? sessionId ?? null,
    analyze: analyzeRes,
  };

  if (!opts.json) {
    renderBatchAnalyze(analyzeRes, mappedItems.length, source);
  }

  if (ops.length === 0) {
    return {
      label,
      status: "empty",
      workspaceId: analyzeRes.workspaceId ?? workspaceId ?? null,
      projectId: projOverride ?? null,
      batch: batchMeta,
    };
  }

  // Dry-run (or --json without --yes): analyze only — no apply.
  if (opts.dryRun) {
    return {
      label,
      status: "dry-run",
      entities: ops.filter((o) => (o as { op?: string }).op === "create_entity").length || ops.length,
      relations: ops.filter((o) => (o as { op?: string }).op === "create_relation").length,
      workspaceId: analyzeRes.workspaceId ?? workspaceId ?? null,
      projectId: projOverride ?? null,
      batch: batchMeta,
    };
  }

  // Human apply default: confirm y/N unless --yes.
  // --json without --yes skips apply (same as per-item capture path).
  let confirmed = Boolean(opts.yes);
  if (!confirmed && !opts.json && rl) {
    const answer = await rl.question(
      chalk.bold(
        `  Apply this import (${ops.length} operation${ops.length !== 1 ? "s" : ""})? [y/N] `
      )
    );
    confirmed = answer.trim().toLowerCase() === "y";
  }
  if (!confirmed) {
    if (!opts.json) log.dim("  Skipped.");
    return {
      label,
      status: "skipped",
      workspaceId: analyzeRes.workspaceId ?? workspaceId ?? null,
      projectId: projOverride ?? null,
      batch: batchMeta,
    };
  }

  const applySessionId = analyzeRes.sessionId ?? sessionId;
  // Prefer analyze-resolved placement so apply lands where the proposal was filed.
  const applyWorkspaceId =
    analyzeRes.workspaceId ?? workspaceId ?? undefined;
  const applyBody: Record<string, unknown> = {
    userId,
    source,
    operations: ops,
    ...(applyWorkspaceId ? { workspaceId: applyWorkspaceId } : {}),
    ...(projOverride ? { projectId: projOverride } : {}),
    ...(applySessionId ? { sessionId: applySessionId } : {}),
    // Client-stable idempotency namespace (U1): analyze proposalId.
    ...(analyzeRes.proposalId
      ? {
          idempotencyKey: analyzeRes.proposalId,
          proposalId: analyzeRes.proposalId,
        }
      : {}),
  };

  const applyRes = (await hubPost(
    "/import/apply",
    applyBody,
    cfg,
    IMPORT_APPLY_TIMEOUT_MS
  )) as ImportApplyResult;

  const created = applyRes.created ?? 0;
  const linked = applyRes.linked ?? 0;
  const finalWs = applyRes.workspaceId ?? analyzeRes.workspaceId ?? workspaceId ?? null;

  if (!opts.json) {
    log.success(
      `  ${created} entit${created !== 1 ? "ies" : "y"} created` +
        (linked ? `, ${linked} linked` : "")
    );
    if (finalWs) {
      const report: LaneReport = {
        lane: "work",
        workspaceId: finalWs,
        workspaceName: await resolveWorkspaceName(finalWs, cfg),
        governance: "auto",
      };
      console.log(
        "  " +
          formatLaneLine(report) +
          (projOverride ? chalk.dim(` [project ${projOverride.slice(0, 8)}]`) : "")
      );
    }
    if (applySessionId) log.dim(`  session: ${applySessionId}`);
  }

  return {
    label,
    status: "stored",
    entities: created,
    relations: linked,
    workspaceId: finalWs,
    projectId: projOverride ?? null,
    batch: { ...batchMeta, apply: applyRes },
  };
}

// ─── `synap import --job-status <jobId>` ──────────────────────────────────────

/**
 * Re-poll a corpus job started by an earlier `synap import`.
 *
 * This is the command `corpusTimeoutLines()` tells the user to run, so it has to
 * exist: a timeout message naming a command that does not resolve is worse than
 * no message. One GET, no waiting — it reports the current state and exits.
 */
export async function importJobStatus(
  jobId: string,
  opts: ImportOpts
): Promise<void> {
  try {
    if (!UUID_RE.test(jobId)) {
      console.error(chalk.red(`'${jobId}' is not a job id — pass the UUID printed when the import was enqueued.`));
      process.exit(1);
    }
    const cfg = await resolveHubConfig(opts);
    const userId = await resolveUserId(cfg);
    const res = (await hubGet(
      `/import/corpus-job/${jobId}`,
      { userId },
      cfg
    )) as CorpusJobStatus;
    const state = res.state ?? "unknown";

    const output = res.output ?? null;
    const fileOutcome = readCorpusFileOutcome(output);
    const lostFiles = fileOutcome.known && fileOutcome.filesFailed > 0;

    if (opts.json) {
      console.log(
        JSON.stringify(
          {
            jobId,
            state,
            createdOn: res.createdOn ?? null,
            completedOn: res.completedOn ?? null,
            // Same UNKNOWN-vs-zero distinction the run path makes.
            outcomeKnown: state === "completed" ? fileOutcome.known : false,
            filesProcessed: fileOutcome.known ? fileOutcome.filesProcessed : null,
            filesFailed: fileOutcome.known ? fileOutcome.filesFailed : null,
            ...(output?.findings ? { findings: output.findings } : {}),
            proposalId: output?.proposalId ?? null,
          },
          null,
          2
        )
      );
      if (state === "completed" && lostFiles) process.exit(1);
      return;
    }

    log.heading(`Corpus import job ${jobId}`);
    log.info(`  state: ${state}`);
    if (res.createdOn) log.dim(`  created:   ${res.createdOn}`);
    if (res.completedOn) log.dim(`  completed: ${res.completedOn}`);

    if (state === "completed") {
      if (lostFiles) {
        log.warn("  Finished with FILES MISSING — ONE import.graph proposal is waiting for review.");
      } else {
        log.success("  Finished — ONE import.graph proposal is waiting for review.");
      }
      for (const line of corpusOutcomeLines(output)) {
        if (fileOutcome.known && !lostFiles) log.dim(`  ${line}`);
        else log.warn(`  ${line}`);
      }
      renderNextSteps(FLOW.afterCorpusImport());
      // A run that lost files is not a success on the re-poll path either.
      if (lostFiles) process.exit(1);
      return;
    }
    if (CORPUS_DEAD_STATES.has(state)) {
      log.error(`  The job ended in state "${state}" — nothing was imported.`);
      process.exit(1);
    }
    log.info("  Still running — nothing was lost. Re-run this command later.");
  } catch (e) {
    renderHubError(e);
    process.exit(1);
  }
}

// ─── command entrypoint ─────────────────────────────────────────────────────────

export async function importData(inputs: string[], opts: ImportOpts): Promise<void> {
  try {
    if (!inputs || inputs.length === 0) {
      console.error(chalk.red("Nothing to import. Pass one or more files, folders, or URLs."));
      console.error(chalk.dim("  e.g. synap import ./notes.md ./docs/ https://example.com/article"));
      console.error(
        chalk.dim(
          "  e.g. synap import ~/Documents/superwhisper/recordings --source superwhisper --store-first --yes --limit 10"
        )
      );
      process.exit(1);
    }

    // Superwhisper store-first: pair meta+wav → pod-wide notes (no AI structure on audio).
    if (
      opts.source === "superwhisper" ||
      (opts.storeFirst && opts.source === "superwhisper")
    ) {
      const { importSuperwhisperStoreFirst } = await import(
        "../lib/superwhisper-import.js"
      );
      await importSuperwhisperStoreFirst(inputs, {
        dryRun: opts.dryRun,
        yes: opts.yes,
        json: opts.json,
        withAudio: opts.withAudio,
        limit: opts.limit,
        concurrency: opts.concurrency,
        resume: opts.resume,
        podUrl: opts.podUrl,
        apiKey: opts.apiKey,
      });
      return;
    }
    if (opts.storeFirst && opts.source && opts.source !== "superwhisper") {
      console.error(
        chalk.red(
          `--store-first is only implemented for --source superwhisper (got ${opts.source})`
        )
      );
      process.exit(1);
    }

    const cfg = await resolveHubConfig(opts);
    const userId = await resolveUserId(cfg);

    // Resolve routing overrides (id or name) up front so a bad value fails fast.
    const wsOverride = opts.workspace ? await resolveWorkspaceArg(opts.workspace, cfg) : undefined;
    const projOverride = opts.project ? await resolveProjectArg(opts.project, cfg) : undefined;
    const sessionId = opts.session ? resolveActiveSessionId(cfg.podUrl) : undefined;

    // Optional multi-home path map (no product defaults — user pairs only).
    let homeMap: ResolvedHomeMapEntry[] = [];
    if (opts.homeMap) {
      homeMap = await resolveHomeMap(parseHomeMap(opts.homeMap), cfg);
    }

    const { items, failures, truncated: dirTruncated } = expandInputs(inputs);
    let truncated = dirTruncated;

    if (dirTruncated && !opts.json) {
      log.warn(
        `A directory exceeded ${DIR_FILE_CAP} files — only the first ${DIR_FILE_CAP} were taken ` +
          `(sync /import/analyze max). Narrow the path, split the import, or use a smaller folder.`
      );
    }

    if (items.length === 0) {
      if (opts.json) {
        console.log(JSON.stringify({ imported: [], failures, truncated }, null, 2));
      } else {
        log.warn("No importable items found.");
        for (const f of failures) log.dim(`  ✗ ${f.label}: ${f.error}`);
      }
      process.exit(failures.length > 0 ? 1 : 0);
    }

    // Partition: N≥2 batch-eligible text → /import/*; rest → per-item capture.
    // Single text file stays on capture structure/execute (same as a lone URL).
    const batchFileItems: Array<ImportItem & { kind: "file" }> = [];
    const captureItems: ImportItem[] = [];
    // `--keep-raw` is a PER-FILE disposition and the batch door
    // (/import/analyze → /import/apply) has no `keepRaw` half at all. Routing a
    // kept-raw text file through it would accept the flag and silently discard
    // every original — an inert flag rendered as a live one. Send those items
    // down the per-item capture path instead, which is where `keepRaw` exists.
    for (const item of items) {
      if (isBatchTextItem(item) && !opts.keepRaw) {
        batchFileItems.push(item);
      } else {
        captureItems.push(item);
      }
    }
    if (opts.keepRaw && !opts.json && captureItems.length > 1) {
      log.dim(
        `--keep-raw: importing ${captureItems.length} items one by one (the batch door cannot keep originals).`
      );
    }

    // Global batch cap: multi-dir / multi-file inputs can exceed the sync max
    // even when no single directory hit DIR_FILE_CAP.
    if (batchFileItems.length > GLOBAL_BATCH_CAP) {
      truncated = true;
      if (!opts.json) {
        log.warn(
          `Batch has ${batchFileItems.length} text files — truncating to ${GLOBAL_BATCH_CAP} ` +
            `(sync /import/analyze max). Split the import or narrow the paths.`
        );
      }
      batchFileItems.length = GLOBAL_BATCH_CAP;
    }

    const useBatch = batchFileItems.length >= 2;
    const batchCandidates: BatchTextItem[] = useBatch
      ? batchFileItems.map(toBatchTextItem)
      : [];
    if (!useBatch) {
      captureItems.push(...batchFileItems);
    }

    if (!opts.json) {
      const parts: string[] = [];
      if (useBatch) parts.push(`${batchCandidates.length} text files (batch import)`);
      if (captureItems.length > 0) {
        parts.push(
          `${captureItems.length} item${captureItems.length !== 1 ? "s" : ""} (capture pipeline)`
        );
      }
      log.info(
        `Importing ${parts.join(" + ") || `${items.length} item${items.length !== 1 ? "s" : ""}`}` +
          `${opts.dryRun ? " (dry run)" : ""}…`
      );
    }

    const outcomes: ItemOutcome[] = [];
    // One shared readline for all interactive confirmations (human, non-json).
    const interactive = !opts.json && !opts.dryRun && !opts.yes;
    const rl = interactive ? readline.createInterface({ input, output }) : undefined;
    try {
      if (useBatch) {
        try {
          outcomes.push(
            await processBatchImport(
              batchCandidates,
              opts,
              cfg,
              userId,
              wsOverride,
              projOverride,
              sessionId,
              rl,
              homeMap
            )
          );
        } catch (e) {
          const error = (e as Error).message;
          if (!opts.json) log.error(`  batch import: ${error}`);
          outcomes.push({
            label: `batch (${batchCandidates.length} files)`,
            status: "failed",
            error,
          });
        }
      }

      for (const item of captureItems) {
        try {
          outcomes.push(
            await processItem(item, opts, cfg, userId, wsOverride, projOverride, sessionId, rl)
          );
        } catch (e) {
          // Never abort the whole run on one bad item — collect + continue.
          const error = (e as Error).message;
          if (!opts.json) log.error(`  ${item.label}: ${error}`);
          outcomes.push({ label: item.label, status: "failed", error });
        }
      }
    } finally {
      rl?.close();
    }

    // Fold read-time failures (missing paths) into the outcome list.
    for (const f of failures) outcomes.push({ label: f.label, status: "failed", error: f.error });

    if (opts.json) {
      // Surface analyze/apply payloads for the batch path (agents need ops + receipt).
      const batchOutcome = outcomes.find((o) => o.batch);
      console.log(
        JSON.stringify(
          {
            imported: outcomes,
            truncated,
            ...(batchOutcome?.batch?.analyze ? { analyze: batchOutcome.batch.analyze } : {}),
            ...(batchOutcome?.batch?.apply ? { apply: batchOutcome.batch.apply } : {}),
            // Background corpus path: a script needs the jobId + final state to
            // decide whether to re-poll, and nextSteps to chain the review.
            ...(batchOutcome?.batch?.corpus
              ? { corpus: batchOutcome.batch.corpus, nextSteps: FLOW.afterCorpusImport() }
              : {}),
          },
          null,
          2
        )
      );
    } else {
      const stored = outcomes.filter((o) => o.status === "stored");
      const totalEntities = stored.reduce((n, o) => n + (o.entities ?? 0), 0);
      const failed = outcomes.filter((o) => o.status === "failed");
      log.blank();
      log.heading("Import summary");
      const proposed = outcomes.filter((o) => o.status === "proposed").length;
      const degraded = outcomes.filter((o) => o.status === "degraded").length;
      const queued = outcomes.filter((o) => o.status === "queued").length;

      // Background corpus path: ONE outcome represents ONE JOB covering N files.
      // So this line's counters are denominated in JOBS, and the file-level truth
      // is a separate line below.
      const corpusMeta = outcomes.find((o) => o.batch?.corpus)?.batch?.corpus;
      const corpusLost = (corpusMeta?.filesFailed ?? 0) > 0;
      const noun = corpusMeta ? "job" : "item";
      log.info(
        `${outcomes.length} ${noun}${outcomes.length !== 1 ? "s" : ""} · ` +
          `${stored.length} stored (${totalEntities} entit${totalEntities !== 1 ? "ies" : "y"}) · ` +
          (proposed ? `${proposed} proposed · ` : "") +
          (queued ? `${queued} still running · ` : "") +
          `${outcomes.filter((o) => o.status === "dry-run").length} dry-run · ` +
          `${outcomes.filter((o) => o.status === "skipped").length} skipped · ` +
          `${outcomes.filter((o) => o.status === "empty").length} empty · ` +
          (degraded ? `${degraded} degraded · ` : "") +
          // A corpus run that LOST files expresses that loss one line below, in
          // files. Printing "0 failed" here too — same word, different
          // denominator, three lines apart — restates the exact sentence this
          // whole wave existed to delete. Job-level failure is already carried
          // by `degraded`, so the counter is dropped rather than qualified.
          (corpusLost ? "" : `${failed.length} failed`)
      );
      for (const f of failed) log.dim(`  ✗ ${f.label}: ${f.error ?? "unknown error"}`);

      if (corpusMeta && !corpusMeta.timedOut) {
        if (corpusMeta.outcomeKnown) {
          const line = `files: ${corpusMeta.filesProcessed ?? "?"} of ${corpusMeta.itemCount} structured · ${corpusMeta.filesFailed ?? 0} failed`;
          if (corpusLost) log.warn(`  ${line}`);
          else log.info(`  ${line}`);
        } else if (corpusMeta.state === "completed") {
          log.warn(`  ${CORPUS_OUTCOME_UNAVAILABLE}`);
        }
      }
    }

    // Only hard-exit on a non-zero code: a plain `return` lets Node flush the
    // (possibly large) --json payload it just wrote to stdout.
    const code = importExitCode(outcomes);
    if (code !== 0) process.exit(code);
  } catch (e) {
    renderHubError(e);
    process.exit(1);
  }
}
