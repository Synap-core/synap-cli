/**
 * `synap market` — the template AUTHORING loop.
 * =============================================
 *
 * The other half of `market` (browse/install/update/installed lives in
 * `market.ts`): the create→publish path an author walks.
 *
 *   synap market scaffold <slug>        — write a minimal valid <slug>.template.yaml
 *   synap market validate  <file>       — run the ONE shared validator, fast feedback
 *   synap market publish   <file>       — validate, then upsert to the CP (private by default)
 *   synap market publish   --from-workspace <id>  — serialize a LIVE workspace, then publish
 *   synap market unpublish <slug>       — flip a published package back to private
 *
 * REUSE: validation is the shared `validateTemplate` (via `lib/template-file`);
 * CP transport is `lib/cp-packages` (`publishPackage`/`unpublishPackage`); the
 * pod `to-template` serializer is reached through the standard hub client. No
 * fetch is hand-rolled here.
 */

import { existsSync, writeFileSync } from "node:fs";
import { resolve as resolvePath } from "node:path";
import chalk from "chalk";
import type { ValidationError, WorkspaceYaml } from "@synap-core/workspace-templates";
import { log } from "../utils/logger.js";
import {
  parseTemplateFile,
  validateTemplateYaml,
  templateToPackageDefinition,
  packageDefinitionToYaml,
  scaffoldTemplateYaml,
  type PackageDefinitionLike,
} from "../lib/template-file.js";
import {
  publishPackage,
  unpublishPackage,
  CpWriteError,
} from "../lib/cp-packages.js";
import { resolveHubConfig, hubPost, renderHubError } from "../lib/hub-client.js";

/** Print a validator failure list human-readably: `rule` · `path` — `message`. */
function printValidationErrors(errors: ValidationError[]): void {
  for (const e of errors) {
    console.error(
      `  ${chalk.red("✗")} ${chalk.yellow(e.rule)} ${chalk.dim(e.path)}\n      ${e.message}`,
    );
  }
}

// ─── validate ────────────────────────────────────────────────────────────────

export async function marketValidate(
  file: string,
  opts: { json?: boolean },
): Promise<void> {
  let tpl: WorkspaceYaml;
  try {
    tpl = parseTemplateFile(file);
  } catch (e) {
    if (opts.json) {
      console.log(JSON.stringify({ ok: false, errors: [{ rule: "parse", path: file, message: (e as Error).message }] }, null, 2));
    } else {
      log.error((e as Error).message);
    }
    process.exit(1);
  }

  const result = validateTemplateYaml(tpl);
  if (opts.json) {
    console.log(JSON.stringify(result, null, 2));
    if (!result.ok) process.exit(1);
    return;
  }

  if (result.ok) {
    log.success(`${file} is valid.`);
    return;
  }
  log.error(`${file} has ${result.errors.length} validation error${result.errors.length === 1 ? "" : "s"}:`);
  printValidationErrors(result.errors);
  process.exit(1);
}

// ─── scaffold ──────────────────────────────────────────────────────────────

export async function marketScaffold(
  slug: string,
  opts: { json?: boolean },
): Promise<void> {
  const fileName = `${slug}.template.yaml`;
  const target = resolvePath(process.cwd(), fileName);

  // Create-then-configure: refuse to clobber, never overwrite an author's work.
  if (existsSync(target)) {
    if (opts.json) {
      console.log(JSON.stringify({ ok: false, error: "exists", path: target }, null, 2));
    } else {
      log.error(`${fileName} already exists — refusing to overwrite.`);
      log.hint("Edit it in place, or choose a different slug.");
    }
    process.exit(1);
  }

  writeFileSync(target, scaffoldTemplateYaml(slug), "utf-8");

  if (opts.json) {
    console.log(JSON.stringify({ ok: true, path: target, slug }, null, 2));
    return;
  }
  log.success(`Wrote ${fileName}`);
  log.dim("Edit it in place, then:");
  log.dim(`  synap market validate ${fileName}`);
  log.dim(`  synap market publish ${fileName}`);
}

// ─── publish ─────────────────────────────────────────────────────────────────

/**
 * POST `/api/hub/workspaces/:id/to-template` — the pod-native serializer that
 * turns a LIVE workspace into a full `PackageDefinition`. The one door for the
 * `--from-workspace` publish path; mirrors every other `/api/hub/*` call.
 */
export async function fetchWorkspaceAsTemplate(
  workspaceId: string,
  opts: { podUrl?: string; apiKey?: string },
): Promise<PackageDefinitionLike> {
  const cfg = await resolveHubConfig(opts);
  const res = (await hubPost(
    `/workspaces/${encodeURIComponent(workspaceId)}/to-template`,
    {},
    cfg,
    60_000,
  )) as { definition?: PackageDefinitionLike };
  if (!res?.definition) {
    throw new Error(`Workspace ${workspaceId} produced no template definition.`);
  }
  return res.definition;
}

/** Surface a publish outcome (created/updated/no-op) uniformly. */
function reportPublish(
  r: Awaited<ReturnType<typeof publishPackage>>,
): void {
  const vis = r.isPublic ? chalk.green("public") : chalk.dim("private");
  switch (r.outcome) {
    case "created":
      log.success(`Published ${chalk.bold(r.slug)} ${chalk.dim(r.version)} (${vis})`);
      break;
    case "updated":
      log.success(`Updated ${chalk.bold(r.slug)} → ${chalk.dim(r.version)} (${vis})`);
      break;
    case "no-op":
      log.info(`${chalk.bold(r.slug)} is already up to date at ${chalk.dim(r.version)} (${vis}) — nothing to publish.`);
      break;
  }
}

/** Turn a CP write failure into a clear, honest message — never swallow the server `detail`; special-case the reserved-slug 403. */
function reportCpWriteError(err: CpWriteError, slug: string | undefined): void {
  if (err.status === 403 && /reserved/i.test(err.serverMessage) && slug) {
    log.error(`"${slug}" is a reserved Synap bedrock template — publish under a different slug.`);
    log.hint("Reserved: foundation, crm, operations, content-os, enterprise-os, research-base.");
    return;
  }
  log.error(`Publish failed${err.status ? ` (HTTP ${err.status})` : ""}: ${err.serverMessage}`);
}

export async function marketPublish(
  file: string | undefined,
  opts: {
    public?: boolean;
    private?: boolean;
    fromWorkspace?: string;
    json?: boolean;
    podUrl?: string;
    apiKey?: string;
  },
): Promise<void> {
  // Default PRIVATE; `--public` flips it. `--private` is accepted as the explicit
  // default so a script can state intent.
  const isPublic = opts.public === true;

  // 1. Obtain the definition + a WorkspaceYaml view to validate.
  let def: PackageDefinitionLike;
  let yamlForValidate: WorkspaceYaml;
  let sourceLabel: string;

  if (opts.fromWorkspace) {
    try {
      def = await fetchWorkspaceAsTemplate(opts.fromWorkspace, opts);
    } catch (e) {
      renderHubError(e);
      process.exit(1);
    }
    yamlForValidate = packageDefinitionToYaml(def);
    sourceLabel = `workspace ${opts.fromWorkspace}`;
  } else {
    if (!file) {
      log.error("Provide a template file, or --from-workspace <id>.");
      process.exit(1);
    }
    try {
      const tpl = parseTemplateFile(file);
      yamlForValidate = tpl;
      def = templateToPackageDefinition(tpl) as unknown as PackageDefinitionLike;
    } catch (e) {
      log.error((e as Error).message);
      process.exit(1);
    }
    sourceLabel = file;
  }

  // 2. Validate BEFORE any publish network call (the fast author-feedback gate).
  const result = validateTemplateYaml(yamlForValidate);
  if (!result.ok) {
    if (opts.json) {
      console.log(JSON.stringify({ ok: false, stage: "validate", errors: result.errors }, null, 2));
    } else {
      log.error(`${sourceLabel} failed validation — not published:`);
      printValidationErrors(result.errors);
    }
    process.exit(1);
  }

  // 3. Publish.
  const slug = def._meta?.slug;
  try {
    const r = await publishPackage(def, { isPublic });
    if (opts.json) {
      console.log(JSON.stringify({ ok: true, ...r }, null, 2));
      return;
    }
    reportPublish(r);
  } catch (e) {
    if (e instanceof CpWriteError) {
      if (opts.json) {
        console.log(JSON.stringify({ ok: false, stage: "publish", status: e.status, error: e.serverMessage, slug }, null, 2));
      } else {
        reportCpWriteError(e, slug);
      }
      process.exit(1);
    }
    log.error(`Publish failed: ${(e as Error).message}`);
    process.exit(1);
  }
}

// ─── unpublish ───────────────────────────────────────────────────────────────

export async function marketUnpublish(
  slug: string,
  opts: { json?: boolean },
): Promise<void> {
  try {
    const r = await unpublishPackage(slug);
    if (opts.json) {
      console.log(JSON.stringify({ ok: true, ...r }, null, 2));
      return;
    }
    log.success(`${chalk.bold(slug)} is now ${r.isPublic ? "public" : "private"}.`);
  } catch (e) {
    if (e instanceof CpWriteError) {
      if (opts.json) {
        console.log(JSON.stringify({ ok: false, status: e.status, error: e.serverMessage, slug }, null, 2));
      } else {
        log.error(`Unpublish failed${e.status ? ` (HTTP ${e.status})` : ""}: ${e.serverMessage}`);
        // The CP PATCH door does not yet accept `isPublic` (only `podId`) — say so
        // rather than leaving a bare validation error.
        if (e.status === 400) {
          log.hint("The control-plane PATCH door needs `isPublic` added to its allow-list (TODO cp).");
        }
      }
      process.exit(1);
    }
    log.error(`Unpublish failed: ${(e as Error).message}`);
    process.exit(1);
  }
}
