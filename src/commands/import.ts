/**
 * synap import — "capture, but for files and URLs".
 *
 * Routes EVERY input (local file, folder, or http(s) URL) through the SAME AI
 * capture centerpiece as free-text `capture`:
 *   POST /capture/structure  (AI entity extraction + workspace/project routing)
 *   POST /capture/execute    (materialize the chosen proposals + relations)
 *
 * One item per file/url. This inherits AI entity extraction, the relation graph,
 * workspace routing AND project routing for free — no separate /import/* path.
 *
 * Inputs:
 *   - http(s) URL              → sent as `url`
 *   - directory                → recursively globbed (skips node_modules/.git/dotfiles)
 *   - file                     → text-like → utf8, everything else → base64
 *
 * Routing: --workspace / --project override the AI's suggestion; otherwise the
 * AI-proposed targetWorkspaceId / targetProjectId from /capture/structure win.
 */

import chalk from "chalk";
import { readFileSync, statSync, readdirSync, existsSync, type Dirent } from "node:fs";
import { extname, basename, join } from "node:path";
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
} from "../lib/hub-client.js";
import { unwrapList } from "../lib/unwrapList.js";
import { formatLaneLine, resolveWorkspaceName, type LaneReport } from "../lib/capture-lane.js";

export interface ImportOpts {
  workspace?: string;
  project?: string;
  dryRun?: boolean;
  yes?: boolean;
  session?: boolean;
  json?: boolean;
  podUrl?: string;
  apiKey?: string;
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

/** Cap on files pulled from a single directory — log + truncate, never silently drop. */
const DIR_FILE_CAP = 200;

type ImportItem =
  | { kind: "url"; label: string; url: string }
  | {
      kind: "file";
      label: string;
      file: { content: string; mimeType: string; filename: string; encoding: "base64" | "utf8" };
    };

function mimeFor(path: string): string {
  return MIME[extname(path).toLowerCase()] ?? "application/octet-stream";
}

/** Read a single file into an ImportItem (utf8 for text-like, base64 otherwise). */
function fileToItem(path: string): ImportItem {
  const ext = extname(path).toLowerCase();
  const filename = basename(path);
  const mimeType = mimeFor(path);
  if (TEXT_LIKE.has(ext)) {
    return {
      kind: "file",
      label: path,
      file: { content: readFileSync(path, "utf8"), mimeType, filename, encoding: "utf8" },
    };
  }
  return {
    kind: "file",
    label: path,
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
          items.push(fileToItem(f));
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

// ─── structure / execute response shapes ──────────────────────────────────────

interface StructureProposal {
  tempId: string;
  profileSlug: string;
  title: string;
  description?: string;
  properties?: Record<string, unknown>;
  content?: string;
  existingEntityId?: string;
}
interface StructureRelation {
  sourceTempId: string;
  targetTempId: string;
  relationType: string;
}
interface StructureResult {
  proposals?: StructureProposal[];
  relations?: StructureRelation[];
  degraded?: boolean;
  targetWorkspaceId?: string | null;
  targetWorkspaceReason?: string | null;
  targetWorkspaceConfidence?: number | null;
  targetProjectId?: string | null;
  targetProjectReason?: string | null;
  targetProjectConfidence?: number | null;
  // followUp is `string | { question, suggestions: chip[] } | null` (chips are
  // objects, not strings). Typed honestly even though import doesn't render it.
  followUp?:
    | string
    | { question?: string; suggestions?: Array<{ label: string; value: string }> }
    | null;
}
interface ExecuteResult {
  created?: Array<{ id?: string; entityId?: string; profileSlug?: string; linked?: boolean }>;
  relations?: unknown[];
  movedToWorkspace?: string | null;
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
  if (result.degraded) {
    log.warn("AI structuring degraded — this source may not be fully extractable server-side.");
  }
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

// ─── per-item pipeline ─────────────────────────────────────────────────────────

interface ItemOutcome {
  label: string;
  status: "stored" | "dry-run" | "skipped" | "empty" | "failed";
  entities?: number;
  relations?: number;
  workspaceId?: string | null;
  projectId?: string | null;
  error?: string;
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
  const created = Array.isArray(executeRes.created) ? executeRes.created : [];
  const entityCount = created.filter((c) => !c.linked).length || created.length;
  const relCount = Array.isArray(executeRes.relations) ? executeRes.relations.length : 0;
  // Final resting workspace: the backend may have moved it (auto routing);
  // otherwise fall back to the pre-execute guess.
  const finalWorkspaceId = executeRes.movedToWorkspace ?? wsTarget;

  if (!opts.json) {
    const report: LaneReport = {
      lane: "work",
      workspaceId: finalWorkspaceId ?? undefined,
      workspaceName: finalWorkspaceId ? await resolveWorkspaceName(finalWorkspaceId, cfg) : "pod-wide",
      governance: "auto",
    };
    log.success(`  ${entityCount} entit${entityCount !== 1 ? "ies" : "y"} created${relCount ? `, ${relCount} relation${relCount !== 1 ? "s" : ""}` : ""}`);
    console.log("  " + formatLaneLine(report) + (projTarget ? chalk.dim(` [project ${projTarget.slice(0, 8)}]`) : ""));
    if (executeRes.movedToWorkspace) {
      log.dim(`  → filed into workspace ${executeRes.movedToWorkspace}`);
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

    const { items, failures, truncated } = expandInputs(inputs);

    if (truncated && !opts.json) {
      log.warn(`A directory exceeded ${DIR_FILE_CAP} files — only the first ${DIR_FILE_CAP} were taken. Narrow the path or split the import.`);
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

    if (!opts.json) {
      log.info(`Importing ${items.length} item${items.length !== 1 ? "s" : ""}${opts.dryRun ? " (dry run)" : ""}…`);
    }

    const outcomes: ItemOutcome[] = [];
    // One shared readline for all interactive confirmations (human, non-json).
    const interactive = !opts.json && !opts.dryRun && !opts.yes;
    const rl = interactive ? readline.createInterface({ input, output }) : undefined;
    try {
      for (const item of items) {
        try {
          outcomes.push(await processItem(item, opts, cfg, userId, wsOverride, projOverride, sessionId, rl));
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
      console.log(JSON.stringify({ imported: outcomes, truncated }, null, 2));
    } else {
      const stored = outcomes.filter((o) => o.status === "stored");
      const totalEntities = stored.reduce((n, o) => n + (o.entities ?? 0), 0);
      const failed = outcomes.filter((o) => o.status === "failed");
      log.blank();
      log.heading("Import summary");
      log.info(
        `${outcomes.length} item${outcomes.length !== 1 ? "s" : ""} · ` +
          `${stored.length} stored (${totalEntities} entit${totalEntities !== 1 ? "ies" : "y"}) · ` +
          `${outcomes.filter((o) => o.status === "dry-run").length} dry-run · ` +
          `${outcomes.filter((o) => o.status === "skipped").length} skipped · ` +
          `${outcomes.filter((o) => o.status === "empty").length} empty · ` +
          `${failed.length} failed`
      );
      for (const f of failed) log.dim(`  ✗ ${f.label}: ${f.error ?? "unknown error"}`);
    }

    const anyFailed = outcomes.some((o) => o.status === "failed");
    if (anyFailed) process.exit(1);
  } catch (e) {
    console.error(chalk.red("Error: " + (e as Error).message));
    process.exit(1);
  }
}
