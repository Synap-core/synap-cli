/**
 * `synap catalog validate|diff|publish [--kind k] [slug...] [--official] [--dry-run]`
 * ==========================================================================
 *
 * The team's ONE door to the official catalog (every installable kind). This
 * file is a THIN caller: loading, validation, the diff against the live
 * catalog, the `synap-official` preflight and the POSTs are ONE lib in the
 * monorepo checkout — `scripts/catalog-lib.mjs` of the catalog package
 * (`@synap-core/catalog`, or `@synap-core/workspace-templates` before the
 * rename). The surface this command relies on:
 *
 *   loadCatalog({ root?, kinds?, slugs? })            → { entries, problems }
 *   validateCatalog(entries, { siblingRepos? })       → Problem[]
 *   diffCatalog(entries, { cpUrl, token? })           → DiffRow[]
 *   publishCatalog({ entries, cpUrl, token, official, dryRun, confirm }) → results[]
 *   checkPublisher({ cpUrl, token })                  → { official, vendor?, reason? }   (optional)
 *
 * ONE READ PATH: every kind — capabilities included — is read from the catalog
 * package by `loadCatalog` (its default kind dirs). The CLI never reads the
 * control-plane repo; the CP's capability JSON is only a guarded mirror now.
 *
 * ONE ERROR TABLE: every code the lib throws (and every refusal of this
 * command) maps to ONE next step in `CATALOG_ERROR_HINTS`.
 *
 * `synap market publish --official` is an ALIAS of
 * `synap catalog publish --official --kind workspace` — `marketPublishOfficial`
 * calls `runCatalog` below; there is no second implementation.
 *
 * WHY THE CHECKOUT, NEVER THIS CLI'S BUNDLE: the CLI's npm copy of the
 * templates package is older than the repo. Publishing from it would stamp
 * stale content as official — so the lib is dynamic-imported from the checkout
 * (found by `--catalog-dir`, else by walking up from cwd, identified by the
 * package.json NAME).
 *
 * SHAPE CHECK: the lib lives in another repo and evolves on its own. A checkout
 * whose lib is missing or exports a different shape is a clear refusal that
 * names what is missing — never a `TypeError: x is not a function` crash.
 *
 * SAFETY (publish): validate → diff preview → confirm → publish. `--dry-run`
 * stops after the preview and NEVER calls `publishCatalog`. Non-interactive
 * without `--yes` refuses rather than guess.
 */

import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve as resolvePath } from "node:path";
import { pathToFileURL } from "node:url";
import { getCpUrl, getStoredToken, isTokenLocallyExpired, type StoredCredentials } from "../lib/auth.js";
import { log } from "../utils/logger.js";

/** Package names the catalog checkout may carry (new name first). */
export const CATALOG_PACKAGE_NAMES = ["@synap-core/catalog", "@synap-core/workspace-templates"] as const;
export const CATALOG_LIB_PATH = "scripts/catalog-lib.mjs";
export const CATALOG_KINDS = ["workspace", "capability", "skill", "pack", "automation"] as const;
export type CatalogKind = (typeof CATALOG_KINDS)[number];
export const CATALOG_VERBS = ["validate", "diff", "publish"] as const;
export type CatalogVerb = (typeof CATALOG_VERBS)[number];

// ── The lib's surface (it lives in another repo; typed here, not imported) ───

export interface CatalogEntry {
  kind: string;
  slug: string;
  path: string;
  meta: Record<string, unknown>;
  spec: unknown;
  dependencies: unknown[];
  publishBody: unknown;
}
export interface CatalogProblem {
  kind?: string;
  slug?: string;
  path?: string;
  severity?: "error" | "warning" | string;
  code?: string;
  message: string;
}
export interface CatalogDiffRow {
  kind: string;
  slug: string;
  status: "new" | "changed" | "unchanged";
  hashBefore?: string;
  hashAfter?: string;
  /** Optional lib-provided detail lines (e.g. a profile-removal warning). */
  warnings?: string[];
}
export interface CatalogPublishResult {
  kind?: string;
  slug?: string;
  outcome?: string;
  status?: string;
  error?: string;
  [k: string]: unknown;
}
export interface CatalogLoadResult {
  entries: CatalogEntry[];
  /** Every loaded entry — `entries` is validated AGAINST it (cross-kind refs, duplicates). */
  corpus?: CatalogEntry[];
  problems: CatalogProblem[];
}
export interface CatalogLoadOptions {
  root?: string;
  dirs?: Record<string, string[]>;
  kinds?: string[];
  slugs?: string[];
}
export interface CatalogLib {
  loadCatalog(opts: CatalogLoadOptions): Promise<CatalogLoadResult> | CatalogLoadResult;
  validateCatalog(
    entries: CatalogEntry[],
    opts?: { corpus?: CatalogEntry[]; siblingRepos?: unknown },
  ): Promise<CatalogProblem[]> | CatalogProblem[];
  diffCatalog(
    entries: CatalogEntry[],
    opts: { cpUrl: string; token?: string; fetchImpl?: typeof fetch },
  ): Promise<CatalogDiffRow[]> | CatalogDiffRow[];
  publishCatalog(opts: {
    entries: CatalogEntry[];
    corpus?: CatalogEntry[];
    cpUrl: string;
    token: string;
    official: boolean;
    dryRun: boolean;
    confirm: (plan: unknown) => Promise<boolean>;
    fetchImpl?: typeof fetch;
    callerUserId?: string;
    log?: (line: string) => void;
  }): Promise<CatalogPublishResult[]> | CatalogPublishResult[];
  // ── Optional (used when present; NOT part of the shape check) ──
  /**
   * READ-ONLY official preflight. A failed read THROWS (`cp-unreachable`) — it
   * is never returned as `official:false`. Absent in an older checkout: the
   * lib's own preflight inside `publishCatalog` still refuses, only later.
   */
  checkPublisher?: (opts: { cpUrl: string; token: string | undefined; fetchImpl?: typeof fetch }) => Promise<CatalogPublisherCheck>;
}

export type CatalogPublisherCheck =
  | { official: true; vendor: { id: string; slug: string } }
  | { official: false; reason: "not-logged-in" | "not-official-publisher" | string; message: string; vendor?: { slug: string } };

// ── One error table ─────────────────────────────────────────────────────────

/**
 * Every code the catalog lib throws (`CatalogErrorCode` in the checkout's
 * `scripts/catalog-lib.d.mts` — a tripwire keeps this list a superset) plus this
 * command's own refusals, each mapped to ONE next step. The lib's message says
 * WHAT happened (it carries the detail: stale slugs, the vendor found…); the
 * hint says what to DO. Nowhere else in this command writes a remedy string.
 */
export const CATALOG_ERROR_HINTS = {
  // The lib's codes.
  "stale-build": "Rebuild the catalog package, then re-run: pnpm --filter @synap-core/workspace-templates build",
  "invalid-template": "Fix the listed problems in the catalog files, then re-run: synap catalog validate",
  "unknown-slug": "Check the slug — run: synap catalog validate --json to list every entry",
  "not-logged-in": "Sign in to the control plane — run: synap login",
  "not-official-publisher": "Sign in (synap login) with the account that owns the synap-official vendor",
  "cp-unreachable": "The control plane did not answer — check your network / SYNAP_CP_URL and retry; nothing was published",
  "live-read-failed": "A live catalog row could not be read — retry; nothing was published blind",
  "not-confirmed": "The write was not confirmed — re-run and answer yes, or pass --yes",
  "unsupported-runtime": "Use Node ≥ 22.18 (the catalog schema is TypeScript loaded by native type stripping)",
  // This command's own refusals.
  usage: "Run: synap catalog --help",
  "checkout-not-found": "Run from inside the Synap monorepo, or pass --catalog-dir (market publish: --templates-dir) <path to the catalog package>",
  "lib-load-failed": "Pull synap-app (the checkout's catalog lib is missing, older or newer than this CLI)",
  "lib-shape": "Pull synap-app (the checkout's catalog lib returned an unexpected shape)",
  "confirmation-required": "Re-run with --dry-run to preview, or --yes to publish non-interactively",
} as const satisfies Record<string, string>;
export type CatalogErrorCode = keyof typeof CATALOG_ERROR_HINTS;

/** The one next step for a code (an unknown code from a newer lib gets the pull hint). */
export function catalogErrorHint(code: string): string {
  return (CATALOG_ERROR_HINTS as Record<string, string>)[code] ?? CATALOG_ERROR_HINTS["lib-load-failed"];
}

const REQUIRED_EXPORTS = ["loadCatalog", "validateCatalog", "diffCatalog", "publishCatalog"] as const;

/**
 * The shape check. Returns the error message, or null when `mod` carries every
 * function of the fixed interface.
 */
export function catalogLibShapeError(mod: unknown, libFile: string): string | null {
  const m = (mod ?? {}) as Record<string, unknown>;
  const missing = REQUIRED_EXPORTS.filter((name) => typeof m[name] !== "function");
  if (missing.length === 0) return null;
  return (
    `${libFile} does not export the catalog interface — missing or not a function: ${missing.join(", ")}. ` +
    `Expected ${REQUIRED_EXPORTS.join(", ")}.`
  );
}

// ── Options, seams ──────────────────────────────────────────────────────────

export interface CatalogOpts {
  kind?: string;
  official?: boolean;
  dryRun?: boolean;
  yes?: boolean;
  json?: boolean;
  /** Path to the catalog package dir (`--catalog-dir`; `market`'s `--templates-dir`). */
  catalogDir?: string;
}

/** Seams for tests — every outside effect is injectable. */
export interface CatalogDeps {
  cwd?: string;
  /** `undefined` = read `~/.synap/credentials.json`; `null` = not logged in. */
  credentials?: StoredCredentials | null;
  cpUrl?: string;
  fetchImpl?: typeof fetch;
  /** Replaces the dynamic import; its result still goes through the shape check. */
  importLib?: (libFile: string) => Promise<unknown>;
  confirm?: (question: string) => Promise<boolean>;
  isInteractive?: boolean;
  out?: (line: string) => void;
}

// ── Usage ───────────────────────────────────────────────────────────────────

/** A positional that is a path, not a slug (slugs are `[a-z][a-z0-9-]*`). */
export function looksLikeFile(arg: string): boolean {
  return /[./\\]/.test(arg);
}

/**
 * Every combination that would otherwise be silently ignored is a usage error
 * (exit 2). Returns the message, or null when valid.
 *
 * Default (named so it can be overridden): `publish` REQUIRES `--official` —
 * the catalog is the official corpus; there is no other vendor that publishes
 * it, so a non-official publish of it has no meaning yet.
 */
export function catalogUsageError(verb: string, slugs: string[], opts: CatalogOpts): string | null {
  if (!(CATALOG_VERBS as readonly string[]).includes(verb)) {
    return `Unknown catalog command "${verb}" — use one of: ${CATALOG_VERBS.join(", ")}.`;
  }
  if (opts.kind !== undefined && !(CATALOG_KINDS as readonly string[]).includes(opts.kind)) {
    return `Unknown --kind "${opts.kind}" — use one of: ${CATALOG_KINDS.join(", ")}.`;
  }
  const file = slugs.find(looksLikeFile);
  if (file) {
    return `The catalog takes SLUGS, not a file ("${file}" looks like a path). To publish a file, use: synap market publish <file>.`;
  }
  if (verb !== "publish") {
    const stray = [opts.official && "--official", opts.dryRun && "--dry-run", opts.yes && "--yes"].filter(Boolean);
    if (stray.length > 0) return `${stray.join(", ")} only apply to "synap catalog publish".`;
    return null;
  }
  if (!opts.official) {
    return "catalog publish writes the OFFICIAL catalog — pass --official (founder: a `synap login` session that owns the synap-official vendor).";
  }
  return null;
}

// ── Locating the checkout ───────────────────────────────────────────────────

function catalogPackageName(dir: string): string | null {
  const pj = join(dir, "package.json");
  if (!existsSync(pj)) return null;
  try {
    const name = (JSON.parse(readFileSync(pj, "utf8")) as { name?: string }).name;
    return name && (CATALOG_PACKAGE_NAMES as readonly string[]).includes(name) ? name : null;
  } catch {
    return null;
  }
}

/**
 * The catalog package dir of the monorepo checkout. `explicit` must BE that
 * package; otherwise walk up from `cwd`, at each level trying the dir itself,
 * `packages/catalog`, `packages/workspace-templates` (inside synap-app) and the
 * same under `synap-app/` (monorepo root). Identity is the package.json `name`,
 * never the path alone. `@synap-core/catalog` wins over the re-export shim.
 */
export function findCatalogDir(cwd: string, explicit?: string): string | null {
  if (explicit) {
    const dir = resolvePath(cwd, explicit);
    return catalogPackageName(dir) ? dir : null;
  }
  let dir = resolvePath(cwd);
  for (;;) {
    const candidates = [
      dir,
      join(dir, "packages/catalog"),
      join(dir, "packages/workspace-templates"),
      join(dir, "synap-app/packages/catalog"),
      join(dir, "synap-app/packages/workspace-templates"),
    ];
    const named = candidates.filter((c) => catalogPackageName(c));
    const preferred = named.find((c) => catalogPackageName(c) === CATALOG_PACKAGE_NAMES[0]) ?? named[0];
    if (preferred) return preferred;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

class CatalogLoadError extends Error {
  code = "lib-load-failed";
}

/** Import the checkout's lib and shape-check it. Throws `CatalogLoadError`. */
export async function loadCatalogLib(
  catalogDir: string,
  importLib: (libFile: string) => Promise<unknown> = (f) => import(pathToFileURL(f).href),
): Promise<CatalogLib> {
  const libFile = join(catalogDir, CATALOG_LIB_PATH);
  if (!existsSync(libFile)) {
    throw new CatalogLoadError(
      `${libFile} not found — this checkout predates the one catalog lib.`,
    );
  }
  let mod: unknown;
  try {
    mod = await importLib(libFile);
  } catch (e) {
    throw new CatalogLoadError(`Could not load ${libFile}: ${(e as Error).message}`);
  }
  const shape = catalogLibShapeError(mod, libFile);
  if (shape) throw new CatalogLoadError(shape);
  return mod as CatalogLib;
}

async function readlineConfirm(question: string): Promise<boolean> {
  const readline = await import("node:readline/promises");
  const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
  try {
    const answer = await rl.question(question);
    return /^y(es)?$/i.test(answer.trim());
  } finally {
    rl.close();
  }
}

// ── Rendering ───────────────────────────────────────────────────────────────

function isError(p: CatalogProblem): boolean {
  return p.severity !== "warning";
}

function formatProblem(p: CatalogProblem): string {
  const where = [p.kind, p.slug].filter(Boolean).join("/") || p.path || "catalog";
  return `  ${isError(p) ? "✗" : "!"} ${where}: ${p.message}`;
}

const STATUS_LABEL: Record<CatalogDiffRow["status"], string> = {
  new: "NEW      ",
  changed: "CHANGED  ",
  unchanged: "unchanged",
};

function formatDiff(rows: CatalogDiffRow[]): string {
  const lines = rows.map((r) => {
    const hashes = r.status === "changed" ? `  ${r.hashBefore ?? "?"} → ${r.hashAfter ?? "?"}` : "";
    const head = `  ${STATUS_LABEL[r.status] ?? r.status} ${r.kind}/${r.slug}${hashes}`;
    const warn = Array.isArray(r.warnings) ? r.warnings.map((w) => `      ! ${w}`) : [];
    return [head, ...warn].join("\n");
  });
  const count = (s: CatalogDiffRow["status"]) => rows.filter((r) => r.status === s).length;
  lines.push(`\n  ${count("new")} new · ${count("changed")} changed · ${count("unchanged")} unchanged`);
  return lines.join("\n");
}

function resultFailed(r: CatalogPublishResult): boolean {
  return r.outcome === "failed" || r.outcome === "declined" || r.status === "failed" || typeof r.error === "string";
}

// ── The command ─────────────────────────────────────────────────────────────

/**
 * Returns the process exit code (0 ok · 1 refused/failed · 2 usage). The
 * index.ts action sets `process.exitCode` from it.
 */
export async function runCatalog(
  verb: string,
  slugs: string[],
  opts: CatalogOpts,
  deps: CatalogDeps = {},
): Promise<number> {
  const out = deps.out ?? ((l: string) => console.log(l));
  const fail = (code: string, message: string, exit = 1): number => {
    const hint = catalogErrorHint(code);
    if (opts.json) out(JSON.stringify({ ok: false, error: code, message, hint }, null, 2));
    else {
      log.error(message);
      out(`  → ${hint}`);
    }
    return exit;
  };

  const usage = catalogUsageError(verb, slugs, opts);
  if (usage) return fail("usage", usage, 2);

  const cwd = deps.cwd ?? process.cwd();
  const catalogDir = findCatalogDir(cwd, opts.catalogDir);
  if (!catalogDir) {
    return fail(
      "checkout-not-found",
      opts.catalogDir
        ? `${opts.catalogDir} is not the catalog package (no package.json named ${CATALOG_PACKAGE_NAMES.join(" or ")}).`
        : `Could not find the catalog checkout from ${cwd}.`,
    );
  }

  // Credentials: required to publish; used (if valid) to diff; unused to validate.
  const creds = verb === "validate" ? null : deps.credentials === undefined ? getStoredToken() : deps.credentials;
  const sessionOk = !!creds?.token && !isTokenLocallyExpired(creds);
  if (verb === "publish" && !sessionOk) {
    return fail(
      "not-logged-in",
      creds?.token ? "Your control-plane session has expired." : "Not signed in to the Synap control plane.",
    );
  }

  const interactive = deps.isInteractive ?? (!!process.stdin.isTTY && !opts.json);
  if (verb === "publish" && !opts.dryRun && !opts.yes && !interactive) {
    return fail(
      "confirmation-required",
      "Refusing to publish the official catalog without a confirmation.",
    );
  }

  let lib: CatalogLib;
  try {
    lib = await loadCatalogLib(catalogDir, deps.importLib);
  } catch (e) {
    return fail((e as { code?: string }).code ?? "lib-load-failed", (e as Error).message);
  }

  const libCall = async <T>(name: string, fn: () => T | Promise<T>): Promise<T> => {
    try {
      return await fn();
    } catch (e) {
      const err = e as Error & { code?: string };
      throw Object.assign(new Error(err.message), { code: err.code ?? `${name}-failed` });
    }
  };

  try {
    // 1. Load + validate (every verb).
    // ONE read path: the catalog package's own kind dirs (capabilities included).
    const loaded = await libCall("load", () => lib.loadCatalog({ root: catalogDir, kinds: opts.kind ? [opts.kind] : undefined }));
    if (!loaded || !Array.isArray(loaded.entries) || !Array.isArray(loaded.problems)) {
      return fail("lib-shape", `loadCatalog in ${join(catalogDir, CATALOG_LIB_PATH)} did not return { entries[], problems[] }.`);
    }
    // Validate the selection AGAINST the whole loaded corpus: a workspace's
    // compose/require deps are other entries, which a slug filter would drop.
    const corpus = Array.isArray(loaded.corpus) ? loaded.corpus : loaded.entries;
    const entries = slugs.length ? corpus.filter((e) => slugs.includes(e.slug)) : loaded.entries;
    const missing = slugs.filter((s) => !entries.some((e) => e.slug === s));
    const validated = await libCall("validate", () => lib.validateCatalog(entries, { corpus }));
    if (!Array.isArray(validated)) {
      return fail("lib-shape", `validateCatalog in ${join(catalogDir, CATALOG_LIB_PATH)} did not return Problem[].`);
    }
    const problems = [
      ...loaded.problems,
      ...validated,
      ...missing.map((slug): CatalogProblem => ({
        slug,
        kind: opts.kind,
        code: "unknown-slug",
        message: `no ${opts.kind ?? "catalog"} entry with this slug`,
      })),
    ];
    const errors = problems.filter(isError);
    const scope = `${opts.kind ?? "all kinds"}${slugs.length ? ` · ${slugs.join(", ")}` : ""}`;

    if (!opts.json) {
      log.heading(`Catalog ${verb} — ${scope} — from ${catalogDir}`);
      for (const p of problems) out(formatProblem(p));
    }
    if (errors.length > 0) {
      if (opts.json) out(JSON.stringify({ ok: false, error: "invalid-template", hint: catalogErrorHint("invalid-template"), entries: entries.length, problems }, null, 2));
      else log.error(`${errors.length} problem(s) in ${entries.length} entr${entries.length === 1 ? "y" : "ies"}${verb === "validate" ? "" : ` — nothing to ${verb} until they are fixed`}.`);
      return 1;
    }
    if (verb === "validate") {
      if (opts.json) out(JSON.stringify({ ok: true, entries: entries.length, problems }, null, 2));
      else log.success(`${entries.length} entr${entries.length === 1 ? "y" : "ies"} valid.`);
      return 0;
    }

    const cpUrl = deps.cpUrl ?? getCpUrl();
    const token = sessionOk ? creds!.token : undefined;

    // 2. Official preflight, BEFORE the preview (read-only, the lib's one rule):
    //    publish → refuse here, so a non-official account never sees a preview
    //    it could not act on; diff → warn and still show the diff.
    let publisherWarning: { code: string; message: string } | undefined;
    if (lib.checkPublisher) {
      const check = await libCall("preflight", () => lib.checkPublisher!({ cpUrl, token, fetchImpl: deps.fetchImpl }));
      if (!check.official) {
        if (verb === "publish") return fail(check.reason, check.message);
        publisherWarning = { code: check.reason, message: check.message };
        if (!opts.json) {
          log.warn(`Publishing would be refused: ${check.message}`);
          out(`  → ${catalogErrorHint(check.reason)}`);
        }
      }
    }

    // 3. Diff against the live catalog (diff + publish).
    const rows = await libCall("diff", () =>
      lib.diffCatalog(entries, { cpUrl, token, fetchImpl: deps.fetchImpl }),
    );
    if (!Array.isArray(rows)) {
      return fail("lib-shape", `diffCatalog in ${join(catalogDir, CATALOG_LIB_PATH)} did not return a row array.`);
    }
    if (!opts.json) out(formatDiff(rows));
    if (verb === "diff" || opts.dryRun) {
      if (opts.json) {
        const publishable = publisherWarning
          ? { publishable: false, publishRefusal: { ...publisherWarning, hint: catalogErrorHint(publisherWarning.code) } }
          : {};
        out(JSON.stringify({ ok: true, dryRun: verb === "publish" ? true : undefined, cpUrl, diff: rows, ...publishable }, null, 2));
      }
      else if (opts.dryRun) log.info("Dry run — nothing was published.");
      return 0;
    }

    // 4. Confirm, then the ONE write door.
    if (!opts.yes) {
      const ok = await (deps.confirm ?? readlineConfirm)(
        `\n  Publish ${entries.length} catalog entr${entries.length === 1 ? "y" : "ies"} (${scope}) to ${cpUrl} as synap-official? [y/N] `,
      );
      if (!ok) {
        log.info("Cancelled — nothing was published.");
        return 1;
      }
    }
    const results = await libCall("publish", () =>
      lib.publishCatalog({
        entries,
        corpus,
        cpUrl,
        token: creds!.token,
        official: true,
        dryRun: false,
        // The human already said yes above; the lib may call this as its own gate.
        confirm: async () => true,
        fetchImpl: deps.fetchImpl,
        callerUserId: creds!.userId,
        log: opts.json ? () => {} : out,
      }),
    );
    if (!Array.isArray(results)) {
      return fail("lib-shape", `publishCatalog in ${join(catalogDir, CATALOG_LIB_PATH)} did not return a result array — check the live catalog before re-running.`);
    }
    const failed = results.filter(resultFailed);
    if (opts.json) {
      out(JSON.stringify({ ok: failed.length === 0, cpUrl, diff: rows, results }, null, 2));
    } else {
      for (const r of failed) out(`  ✗ ${[r.kind, r.slug].filter(Boolean).join("/")}: ${r.error ?? "failed"}`);
      if (failed.length > 0) log.error(`${failed.length}/${results.length} catalog entr${results.length === 1 ? "y" : "ies"} failed to publish.`);
      else log.success(`Published ${results.length} official catalog entr${results.length === 1 ? "y" : "ies"}.`);
    }
    return failed.length > 0 ? 1 : 0;
  } catch (e) {
    const err = e as Error & { code?: string };
    return fail(err.code ?? `${verb}-failed`, err.message);
  }
}
