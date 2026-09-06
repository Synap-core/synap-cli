/**
 * `synap market` — the template AUTHORING loop.
 * =============================================
 *
 * The other half of `market` (browse/install/update/installed lives in
 * `market.ts`): the create→publish path an author walks.
 *
 *   synap market scaffold <slug>        — write a minimal valid <slug>.template.yaml
 *   synap market scaffold <slug> --kind cell|view|workflow|capability — a standalone package file
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
import { exporterDropWarnings } from "../lib/exporter-coverage.js";
import {
  isStandalonePackageFile,
  parseStandalonePackageFile,
  validateStandalonePackage,
  scaffoldStandalonePackageJson,
  SCAFFOLDABLE_KINDS,
  type ScaffoldableKind,
} from "../lib/kind-package.js";

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
  // A standalone view/cell/skill/workflow file branches off IMMEDIATELY — the
  // SAME discriminator `marketPublish` uses. Without this, `validate` ran the
  // WORKSPACE validator over a standalone file and rejected it with three
  // envelope errors (missing `meta`, `workspace`, `profiles`) — including files
  // `market scaffold --kind cell` had JUST WRITTEN. Step 02 of the documented
  // four-command loop rejected step 01's own output, for every non-workspace
  // kind. Found by walking the loop on 2026-09-05.
  let peeked: unknown;
  try {
    peeked = parseTemplateFile(file);
  } catch {
    peeked = undefined;
  }
  if (isStandalonePackageFile(peeked)) {
    const parsed = parseStandalonePackageFile(file);
    // `validateStandalonePackage` returns plain message strings, not the
    // `ValidationError` records the workspace validator emits — so it prints
    // directly rather than through `printValidationErrors`.
    const errors = validateStandalonePackage(parsed);
    if (opts.json) {
      console.log(JSON.stringify({ ok: errors.length === 0, errors }, null, 2));
      if (errors.length > 0) process.exit(1);
      return;
    }
    if (errors.length === 0) {
      log.success(`${file} is valid.`);
      return;
    }
    log.error(
      `${file} has ${errors.length} validation error${errors.length === 1 ? "" : "s"}:`,
    );
    for (const message of errors) log.hint(`✗ ${message}`);
    process.exit(1);
  }

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
  opts: { json?: boolean; kind?: string },
): Promise<void> {
  // `--kind cell|view|workflow` scaffolds a STANDALONE package file instead of
  // a workspace template — see `lib/kind-package.ts`. `skill` is refused: there
  // is no known-good standalone shape yet (the CP schema has no slot for one),
  // so a scaffold would just produce a file that can't publish.
  //
  // The accepted list is `SCAFFOLDABLE_KINDS` — the same constant `src/index.ts`
  // builds the `--kind` help string from, so the help can never again advertise
  // a kind this branch refuses (it advertised `skill`) or hide one it accepts
  // (it hid `workflow`, which `validateStandalonePackage` has always handled).
  if (opts.kind && opts.kind !== "workspace") {
    if (opts.kind === "skill") {
      if (opts.json) {
        console.log(
          JSON.stringify(
            { ok: false, error: "unsupported-kind", kind: "skill" },
            null,
            2,
          ),
        );
      } else {
        log.error(`--kind skill isn't scaffoldable yet.`);
        log.hint(
          "The CP's package schema has no standalone slot for a skill (skills only exist nested inside a capability's skills[]) — see lib/kind-package.ts.",
        );
      }
      process.exit(1);
    }
    if (!(SCAFFOLDABLE_KINDS as readonly string[]).includes(opts.kind)) {
      log.error(
        `Unknown --kind "${opts.kind}" — expected one of: ${SCAFFOLDABLE_KINDS.join(", ")}.`,
      );
      process.exit(1);
    }
    const kind = opts.kind as ScaffoldableKind;
    const fileName = `${slug}.${kind}.json`;
    const target = resolvePath(process.cwd(), fileName);
    if (existsSync(target)) {
      if (opts.json) {
        console.log(JSON.stringify({ ok: false, error: "exists", path: target }, null, 2));
      } else {
        log.error(`${fileName} already exists — refusing to overwrite.`);
        log.hint("Edit it in place, or choose a different slug.");
      }
      process.exit(1);
    }
    writeFileSync(target, scaffoldStandalonePackageJson(kind, slug), "utf-8");
    if (opts.json) {
      console.log(JSON.stringify({ ok: true, path: target, slug, kind }, null, 2));
      return;
    }
    log.success(`Wrote ${fileName}`);
    log.dim("Edit it in place, then:");
    log.dim(`  synap market validate ${fileName}`);
    log.dim(`  synap market publish ${fileName}`);
    return;
  }

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
  // Attribution is WRITE-TIME ONLY at the CP: `if (body.vendorId) {…}` with no
  // else, and no back-fill. Silence here is how every CLI-published package
  // ended up orphaned from its author — the publish looked like a full success
  // because, apart from the author page, it was.
  if (!r.vendorAttached) {
    log.warn("Published without a publisher profile — attributed to nobody.");
    log.hint(`Create one (synap vendor create <slug>), then publish again.`);
  }
}

/** Turn a CP write failure into a clear, honest message — never swallow the server `detail`; special-case the reserved-slug 403. */
function reportCpWriteError(err: CpWriteError, slug: string | undefined): void {
  if (err.status === 403 && /reserved/i.test(err.serverMessage) && slug) {
    log.error(`"${slug}" is a reserved Synap bedrock template — publish under a different slug.`);
    log.hint("Reserved: foundation, crm, operations, content-os, enterprise-os, research-base.");
    return;
  }
  // A 401 here is almost always "no CP session", not a broken package — publish
  // authenticates as the HUMAN account (the pod agent key does not carry CP
  // credentials, by design). Naming the door beats restating the wall: a bare
  // "Unauthorized" sends the author back to re-check a file that was fine.
  if (err.status === 401) {
    log.error("Publish failed (HTTP 401): not signed in to the Synap account.");
    log.hint("Run `synap login`, then publish again. Your package file is unchanged.");
    log.hint(
      "Publishing authenticates as YOU, not as the pod's agent key — that separation is deliberate: approval and publication stay human.",
    );
    return;
  }
  log.error(`Publish failed${err.status ? ` (HTTP ${err.status})` : ""}: ${err.serverMessage}`);
}

/**
 * Publish a STANDALONE (non-workspace) package file — a view/cell/skill,
 * discriminated by a top-level `category` key the workspace-template envelope
 * never carries (see `lib/kind-package.ts`). Reuses the SAME `publishPackage`
 * CP transport as the workspace path — no second fetch, just a different
 * identity (`opts.slug`/`opts.displayName`/`opts.category` instead of
 * `_meta.slug`/`workspaceName`).
 */
async function marketPublishStandalone(
  file: string,
  opts: { public?: boolean; json?: boolean },
): Promise<void> {
  const isPublic = opts.public === true;

  let pkg;
  try {
    pkg = parseStandalonePackageFile(file);
  } catch (e) {
    log.error((e as Error).message);
    process.exit(1);
  }

  const structuralErrors = validateStandalonePackage(pkg);
  if (structuralErrors.length) {
    if (opts.json) {
      console.log(
        JSON.stringify({ ok: false, stage: "validate", errors: structuralErrors }, null, 2),
      );
    } else {
      log.error(`${file} failed validation — not published:`);
      for (const e of structuralErrors) log.hint(e);
    }
    process.exit(1);
  }

  try {
    const r = await publishPackage(
      { ...pkg.definition, description: pkg.description },
      {
        isPublic,
        category: pkg.category,
        slug: pkg.slug,
        displayName: pkg.displayName,
      },
    );
    if (opts.json) {
      console.log(JSON.stringify({ ok: true, ...r }, null, 2));
      return;
    }
    reportPublish(r);
  } catch (e) {
    if (e instanceof CpWriteError) {
      if (opts.json) {
        console.log(
          JSON.stringify(
            { ok: false, stage: "publish", status: e.status, error: e.serverMessage, slug: pkg.slug },
            null,
            2,
          ),
        );
      } else {
        reportCpWriteError(e, pkg.slug);
      }
      process.exit(1);
    }
    log.error(`Publish failed: ${(e as Error).message}`);
    process.exit(1);
  }
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
  // A standalone view/cell/skill file branches off IMMEDIATELY — it has no
  // `meta`/`workspace` envelope, so the WorkspaceYaml parser below would
  // reject it. `--from-workspace` never produces this shape, so only the
  // `file` path is checked. `isStandalonePackageFile` peeks the SAME parse
  // `parseStandalonePackageFile` will redo — cheap, and keeps the discriminator
  // logic in ONE place (`kind-package.ts`).
  if (file && !opts.fromWorkspace) {
    let peeked: unknown;
    try {
      peeked = parseTemplateFile(file);
    } catch {
      peeked = undefined;
    }
    if (isStandalonePackageFile(peeked)) {
      await marketPublishStandalone(file, opts);
      return;
    }
  }

  // Default PRIVATE; `--public` flips it. `--private` is accepted as the explicit
  // default so a script can state intent.
  const isPublic = opts.public === true;

  // 1. Obtain the definition + a WorkspaceYaml view to validate.
  let def: PackageDefinitionLike;
  let yamlForValidate: WorkspaceYaml;
  let sourceLabel: string;

  // Keys the pod's workspace serialiser has NO projection for. Unconditional
  // for `--from-workspace` and EMPTY for a hand-written file, because the file
  // path is not a projection — what the author wrote is what gets published.
  // See `lib/exporter-coverage.ts` for why this warns about the door rather
  // than counting a payload it cannot see.
  let dropWarnings: string[] = [];

  if (opts.fromWorkspace) {
    try {
      def = await fetchWorkspaceAsTemplate(opts.fromWorkspace, opts);
    } catch (e) {
      renderHubError(e);
      process.exit(1);
    }
    dropWarnings = exporterDropWarnings();
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

  // 2b. Say what this door does NOT carry — BEFORE the publish, not after, so
  // the author can still stop. Printed as a warning, never as an error: the
  // export is not wrong, it is incomplete, and the package still installs.
  if (dropWarnings.length > 0 && !opts.json) {
    log.warn(
      `Serialising a live workspace is a LOSSY projection — these are NOT in the package:`,
    );
    for (const w of dropWarnings) log.hint(`• ${w}`);
    log.hint(
      "See TEMPLATE-DEV-GUIDE.md — `template ≡ installed` holds publish→install, not workspace→publish.",
    );
  }

  // 3. Publish.
  const slug = def._meta?.slug;
  try {
    const r = await publishPackage(def, { isPublic });
    if (opts.json) {
      console.log(JSON.stringify({ ok: true, warnings: dropWarnings, ...r }, null, 2));
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
