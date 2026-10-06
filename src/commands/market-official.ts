/**
 * `synap market publish --official [slug...]` — the founder's ONE command for
 * publishing the official Synap template catalog.
 * ==========================================================================
 *
 * This file is a THIN caller. The publish itself — corpus validation, the dist
 * freshness refusal, the `synap-official` preflight, the diff against the live
 * catalog, the body (with `definition.sourcePackage`), the POSTs and the per-slug
 * verdict — is ONE implementation in the monorepo checkout:
 * `synap-app/packages/workspace-templates/scripts/publish-official-lib.mjs`.
 * The CI script (`scripts/publish-official.mjs`) is the other thin caller.
 *
 * WHY THE CHECKOUT, NEVER THIS CLI'S BUNDLE: the CLI depends on an npm
 * `@synap-core/workspace-templates` that is older than the repo. Publishing
 * from it would stamp stale content as official — so the lib is dynamic-imported
 * from the checkout (found by `--templates-dir`, else by walking up from cwd).
 *
 * FRESHNESS: the lib REFUSES when the checkout's `dist/` does not match its
 * `src/*.yaml` (it never rebuilds a shared `dist/`); the message names the build
 * command.
 *
 * AUTH: the `synap login` CP session — the same credential every other `market`
 * write uses. No token env, no pasting.
 *
 * SAFETY: preview first, always. Default = show the plan, then ask (node:readline;
 * @clack/prompts hangs on this machine). `--dry-run` = preview only. `--yes` =
 * skip the question. Non-interactive without `--yes` refuses rather than guess.
 */

import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve as resolvePath } from "node:path";
import { pathToFileURL } from "node:url";
import { getCpUrl, getStoredToken, isTokenLocallyExpired, type StoredCredentials } from "../lib/auth.js";
import { log } from "../utils/logger.js";

const PACKAGE_NAME = "@synap-core/workspace-templates";
const LIB_PATH = "scripts/publish-official-lib.mjs";

// ── The lib's surface (it lives in another repo; typed here, not imported) ───

interface PlanItem {
  slug: string;
  status: "new" | "updated" | "unchanged";
  warnings: string[];
  body: { vendorId: string; definition: { sourcePackage: { name: string; version: string } } };
}
interface Plan {
  cpUrl: string;
  vendor: { id: string; slug: string };
  sourcePackage: { name: string; version: string };
  items: PlanItem[];
}
interface PublishResult {
  slug: string;
  outcome: "created" | "updated" | "unchanged" | "failed";
  priorVersion: string | null;
  version: string | null;
  stampStored?: boolean;
  error?: string;
}
export interface OfficialLib {
  planOfficialPublish(opts: {
    cpUrl: string;
    token: string;
    slugs: string[];
    fetchImpl?: typeof fetch;
    callerUserId?: string;
  }): Promise<Plan>;
  executeOfficialPublish(
    plan: Plan,
    opts: { token: string; fetchImpl?: typeof fetch; log?: (line: string) => void },
  ): Promise<PublishResult[]>;
  formatPlan(plan: Plan): string;
  planToJson(plan: Plan): unknown;
  OfficialPublishError: new (...args: never[]) => Error & { code: string };
}

export interface OfficialPublishOpts {
  official?: boolean;
  templatesDir?: string;
  dryRun?: boolean;
  yes?: boolean;
  json?: boolean;
  public?: boolean;
  private?: boolean;
  price?: string;
  fromWorkspace?: string;
  fromProject?: string;
}

/** Seams for tests — every outside effect is injectable. */
export interface OfficialPublishDeps {
  cwd?: string;
  /** `undefined` = read `~/.synap/credentials.json`; `null` = not logged in. */
  credentials?: StoredCredentials | null;
  cpUrl?: string;
  fetchImpl?: typeof fetch;
  loadLib?: (templatesDir: string) => Promise<OfficialLib>;
  confirm?: (question: string) => Promise<boolean>;
  isInteractive?: boolean;
  out?: (line: string) => void;
}

// ── Usage ───────────────────────────────────────────────────────────────────

/**
 * `--official` publishes the checkout's corpus, so every flag that names some
 * OTHER source or overrides what the template itself declares is a usage error —
 * silently ignoring it would publish something other than what was typed.
 * Returns the message, or null when the combination is valid.
 */
export function officialUsageError(file: string | undefined, opts: OfficialPublishOpts): string | null {
  if (file) {
    return `--official publishes the official corpus from the monorepo checkout; it takes template SLUGS, not a file ("${file}" looks like a path). Drop --official to publish a file.`;
  }
  if (opts.fromWorkspace) return "--official cannot be combined with --from-workspace.";
  if (opts.fromProject) return "--official cannot be combined with --from-project.";
  if (opts.public || opts.private) {
    return "--official takes visibility from each template's meta.isPublic — drop --public/--private.";
  }
  if (opts.price !== undefined) return "--official templates are not priced — drop --price.";
  return null;
}

/** A positional that is a path, not a slug (slugs are `[a-z][a-z0-9-]*`). */
export function looksLikeFile(arg: string): boolean {
  return /[./\\]/.test(arg);
}

// ── Locating the checkout ───────────────────────────────────────────────────

function isTemplatesPackage(dir: string): boolean {
  const pj = join(dir, "package.json");
  if (!existsSync(pj)) return false;
  try {
    return (JSON.parse(readFileSync(pj, "utf8")) as { name?: string }).name === PACKAGE_NAME;
  } catch {
    return false;
  }
}

/**
 * The `@synap-core/workspace-templates` package dir of the monorepo checkout.
 * `explicit` (`--templates-dir`) must BE that package; otherwise walk up from
 * `cwd`, at each level trying the dir itself, `packages/workspace-templates`
 * (inside synap-app) and `synap-app/packages/workspace-templates` (monorepo
 * root). Identity is the package.json `name`, never the path alone.
 */
export function findTemplatesDir(cwd: string, explicit?: string): string | null {
  if (explicit) {
    const dir = resolvePath(cwd, explicit);
    return isTemplatesPackage(dir) ? dir : null;
  }
  let dir = resolvePath(cwd);
  for (;;) {
    for (const c of [dir, join(dir, "packages/workspace-templates"), join(dir, "synap-app/packages/workspace-templates")]) {
      if (isTemplatesPackage(c)) return c;
    }
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

async function defaultLoadLib(templatesDir: string): Promise<OfficialLib> {
  const libFile = join(templatesDir, LIB_PATH);
  if (!existsSync(libFile)) {
    throw new Error(
      `${libFile} not found — this checkout predates the shared official-publish lib. Pull synap-app.`,
    );
  }
  return (await import(pathToFileURL(libFile).href)) as OfficialLib;
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

// ── The command ─────────────────────────────────────────────────────────────

/**
 * Returns the process exit code (0 ok · 1 refused/failed · 2 usage). The
 * index.ts action sets `process.exitCode` from it, so tests never need to stub
 * `process.exit`.
 */
export async function marketPublishOfficial(
  slugs: string[],
  opts: OfficialPublishOpts,
  deps: OfficialPublishDeps = {},
): Promise<number> {
  const out = deps.out ?? ((l: string) => console.log(l));
  const fail = (code: string, message: string, exit = 1): number => {
    if (opts.json) out(JSON.stringify({ ok: false, error: code, message }, null, 2));
    else log.error(message);
    return exit;
  };

  const usage = officialUsageError(slugs.find(looksLikeFile), opts);
  if (usage) return fail("usage", usage, 2);

  const templatesDir = findTemplatesDir(deps.cwd ?? process.cwd(), opts.templatesDir);
  if (!templatesDir) {
    return fail(
      "checkout-not-found",
      opts.templatesDir
        ? `--templates-dir ${opts.templatesDir} is not the ${PACKAGE_NAME} package (no package.json with that name).`
        : `Could not find the ${PACKAGE_NAME} checkout from ${deps.cwd ?? process.cwd()}. Run from inside the Synap monorepo, or pass --templates-dir <path to synap-app/packages/workspace-templates>.`,
    );
  }

  const creds = deps.credentials === undefined ? getStoredToken() : deps.credentials;
  if (!creds?.token) return fail("not-logged-in", "Not signed in to the Synap control plane — run: synap login");
  if (isTokenLocallyExpired(creds)) {
    return fail("not-logged-in", "Your control-plane session has expired — run: synap login");
  }

  const interactive = deps.isInteractive ?? (!!process.stdin.isTTY && !opts.json);
  if (!opts.dryRun && !opts.yes && !interactive) {
    return fail(
      "confirmation-required",
      "Refusing to publish the official catalog without a confirmation. Re-run with --dry-run to preview, or --yes to publish non-interactively.",
    );
  }

  let lib: OfficialLib;
  try {
    lib = await (deps.loadLib ?? defaultLoadLib)(templatesDir);
  } catch (e) {
    return fail("lib-load-failed", (e as Error).message);
  }

  const cpUrl = deps.cpUrl ?? getCpUrl();
  let plan: Plan;
  try {
    plan = await lib.planOfficialPublish({
      cpUrl,
      token: creds.token,
      slugs,
      fetchImpl: deps.fetchImpl,
      callerUserId: creds.userId,
    });
  } catch (e) {
    const err = e as Error & { code?: string };
    return fail(err.code ?? "plan-failed", err.message);
  }

  if (!opts.json) {
    log.heading(`Official template publish — from ${templatesDir}`);
    out(lib.formatPlan(plan));
  }

  if (opts.dryRun) {
    if (opts.json) out(JSON.stringify({ ok: true, dryRun: true, plan: lib.planToJson(plan) }, null, 2));
    else log.info("Dry run — nothing was published.");
    return 0;
  }

  if (!opts.yes) {
    const ok = await (deps.confirm ?? readlineConfirm)(
      `\n  Publish ${plan.items.length} template(s) to ${plan.cpUrl} as ${plan.vendor.slug}? [y/N] `,
    );
    if (!ok) {
      log.info("Cancelled — nothing was published.");
      return 1;
    }
  }

  const results = await lib.executeOfficialPublish(plan, {
    token: creds.token,
    fetchImpl: deps.fetchImpl,
    log: opts.json ? () => {} : out,
  });
  const failed = results.filter((r) => r.outcome === "failed");
  const unstamped = results.filter((r) => r.outcome !== "failed" && r.stampStored === false);

  if (opts.json) {
    out(JSON.stringify({ ok: failed.length === 0, plan: lib.planToJson(plan), results }, null, 2));
  } else {
    if (unstamped.length > 0) {
      log.warn(
        `${unstamped.length} row(s) kept no sourcePackage (${unstamped.map((r) => r.slug).join(", ")}) — the control plane needs the skip-unchanged provenance fix deployed; re-run after it is.`,
      );
    }
    if (failed.length > 0) log.error(`${failed.length}/${results.length} template(s) failed to publish.`);
    else log.success(`Published ${results.length} official template(s).`);
  }
  return failed.length > 0 ? 1 : 0;
}

/**
 * The flags that only mean something WITH `--official`, and the one-file rule
 * of a regular publish. Without this a stray `--dry-run` on a regular publish
 * would be silently ignored and the package published for real.
 */
export function nonOfficialUsageError(
  targets: string[],
  opts: { dryRun?: boolean; yes?: boolean; templatesDir?: string },
): string | null {
  if (opts.dryRun || opts.yes || opts.templatesDir) {
    return "--dry-run, --yes and --templates-dir only apply with --official.";
  }
  if (targets.length > 1) return `Publish one file at a time (got ${targets.length}: ${targets.join(", ")}).`;
  return null;
}
