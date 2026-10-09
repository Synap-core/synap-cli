/**
 * `synap market publish --official [slug...]` — the founder's command for
 * publishing the official Synap template catalog.
 * ==========================================================================
 *
 * An ALIAS, not an implementation: it is exactly
 * `synap catalog publish --official --kind workspace [slug...]` — the ONE code
 * path in `catalog.ts` (`runCatalog`), which dynamic-imports the ONE catalog lib
 * (`scripts/catalog-lib.mjs`) from the monorepo checkout. All the safety lives
 * there: validate → diff preview → confirm (`--dry-run` previews only, `--yes`
 * skips the question, non-interactive without `--yes` refuses), founder-only
 * `synap-official` preflight in the lib, `synap login` CP session as the
 * credential.
 *
 * What stays here is only what is specific to the `market publish` spelling:
 * the flags `market publish` carries for its NON-official mode (a file,
 * `--from-workspace`, visibility, price) are usage errors next to `--official`.
 */

import { log } from "../utils/logger.js";
import { findCatalogDir, looksLikeFile, runCatalog, type CatalogDeps } from "./catalog.js";

export { looksLikeFile };

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

/** Seams for tests — the catalog command's own seams (one implementation). */
export type OfficialPublishDeps = CatalogDeps;

/** Kept for callers of the old name: the catalog package dir of the checkout. */
export const findTemplatesDir = findCatalogDir;

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

/**
 * Returns the process exit code (0 ok · 1 refused/failed · 2 usage). The alias:
 * `market`-only usage checks, then `runCatalog("publish", …, kind workspace)`.
 */
export async function marketPublishOfficial(
  slugs: string[],
  opts: OfficialPublishOpts,
  deps: OfficialPublishDeps = {},
): Promise<number> {
  const usage = officialUsageError(slugs.find(looksLikeFile), opts);
  if (usage) {
    return runCatalogUsage(usage, opts, deps);
  }
  return runCatalog(
    "publish",
    slugs,
    {
      kind: "workspace",
      official: true,
      dryRun: opts.dryRun,
      yes: opts.yes,
      json: opts.json,
      catalogDir: opts.templatesDir,
    },
    deps,
  );
}

function runCatalogUsage(message: string, opts: OfficialPublishOpts, deps: OfficialPublishDeps): number {
  const out = deps.out ?? ((l: string) => console.log(l));
  if (opts.json) out(JSON.stringify({ ok: false, error: "usage", message }, null, 2));
  else log.error(message);
  return 2;
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
