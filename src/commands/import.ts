/**
 * synap import — "capture, but for files and URLs" (personal OS intake).
 *
 * Routing (INTAKE-CONSOLIDATION-PLAN Wave 1):
 *   - Superwhisper store-first     → lib/superwhisper-import (unchanged)
 *   - Single file OR single URL    → POST /capture/structure + /capture/execute
 *   - N≥2 text-like files
 *     (md / markdown / txt / csv)  → ONE batch via REST import:
 *         POST /import/analyze  → human review (or --yes / --dry-run)
 *         POST /import/apply    → materialize the EXACT previewed ops
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
 * defaults — user-supplied pairs only.
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
  readActiveSessionId,
  type HubConfig,
  renderHubError,
} from "../lib/hub-client.js";
import { unwrapList } from "../lib/unwrapList.js";
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
  limit?: number;
  concurrency?: number;
  resume?: boolean;
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
  status: "stored" | "proposed" | "degraded" | "dry-run" | "skipped" | "empty" | "failed";
  entities?: number;
  relations?: number;
  workspaceId?: string | null;
  projectId?: string | null;
  error?: string;
  /**
   * Why the item degraded (`is_auth_error` | `is_invalid_response` |
   * `is_empty_result`). The human path already prints this via
   * `degradedMessage()`; carrying it here keeps `--json` from reporting a
   * causeless "degraded" — a scripted import has no other way to see WHY it
   * got zero entities.
   */
  degradedReason?: string;
  /** Present for the multi-file /import/* batch path. */
  batch?: {
    source: ImportSource;
    fileCount: number;
    proposalId?: string | null;
    sessionId?: string | null;
    analyze?: ImportAnalyzeResult;
    apply?: ImportApplyResult;
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
  }

  return {
    label: item.label,
    status: "stored",
    entities: entityCount,
    relations: relCount,
    workspaceId: finalWorkspaceId,
    projectId: projTarget,
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
    const sessionId = opts.session ? readActiveSessionId() : undefined;

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
    for (const item of items) {
      if (isBatchTextItem(item)) {
        batchFileItems.push(item);
      } else {
        captureItems.push(item);
      }
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
      log.info(
        `${outcomes.length} item${outcomes.length !== 1 ? "s" : ""} · ` +
          `${stored.length} stored (${totalEntities} entit${totalEntities !== 1 ? "ies" : "y"}) · ` +
          (proposed ? `${proposed} proposed · ` : "") +
          `${outcomes.filter((o) => o.status === "dry-run").length} dry-run · ` +
          `${outcomes.filter((o) => o.status === "skipped").length} skipped · ` +
          `${outcomes.filter((o) => o.status === "empty").length} empty · ` +
          (degraded ? `${degraded} degraded · ` : "") +
          `${failed.length} failed`
      );
      for (const f of failed) log.dim(`  ✗ ${f.label}: ${f.error ?? "unknown error"}`);
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
