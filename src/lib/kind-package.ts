/**
 * Standalone (non-workspace) package files — view / cell / skill / workflow.
 * ================================================================
 * `market-authoring.ts`'s scaffold/publish loop is WorkspaceYaml-shaped (a
 * `meta` + `workspace` envelope validated by `validateTemplate`). A lone view,
 * cell, or skill has no such envelope — it IS its content. This file is the
 * PURE half (no network, no `process.exit`) for that shape: parse a standalone
 * package file, run the minimal structural check the CP's own
 * `packageDefinitionSchema` needs (see synap-control-plane-api/src/routes/
 * packages.ts), and hand back a definition `publishPackage` can post.
 *
 * File shape (explicit — no `_meta`/`meta` ambiguity, unlike the workspace
 * envelope):
 *   {
 *     "category": "cell" | "view",
 *     "slug": "my-cell",
 *     "displayName": "My Cell",
 *     "description": "...",           // optional
 *     "tags": ["..."],                // optional
 *     "definition": { "cells": [...] } | { "views": [...] }
 *   }
 *
 * A `cells[]` entry may carry `codeFile` (a path to the cell's ESM entry
 * source, resolved relative to the package file) INSTEAD of an inline `code`
 * string — the indirection an author needs to publish from a real source file
 * rather than hand-pasting a minified bundle into JSON. `codeFile` is CLI-only:
 * the CP's `packageDefinitionSchema.cells[]` has no such slot (only `code`,
 * required), so `resolveCellCodeFiles` bundles it (via `cell.ts`'s
 * `buildCellFromSource` — the SAME esbuild path `cell build` uses) and inlines
 * the result into `code` before the definition ever reaches `publishPackage`.
 *
 * ✅ RESOLVED 2026-09-04 — this block used to claim that
 * `packageDefinitionSchema` requires `definition.profiles` to be non-empty
 * UNCONDITIONALLY, so a profile-less view/cell/skill package would 400 against
 * `POST /api/packages`. That is NO LONGER TRUE and had become a load-bearing
 * lie: the rule moved to a category-gated `superRefine` on the OUTER schema
 * (`synap-control-plane-api/src/routes/packages.ts:859-872` — only that schema
 * can see the sibling `category`), and it now fires for `category === "workspace"`
 * ONLY. Every other kind may publish with `profiles: []`.
 *
 * Left as a tombstone rather than deleted because the stale claim outlived its
 * fix and was still being cited as fact months later.
 *
 * ⚠️ "skill" ALSO HAS NO PAYLOAD SLOT: `packageDefinitionSchema` (and the
 * `PackageDefinition` TS type it validates) carry no top-level `skills[]`
 * array — a skill's `{ slug, name, code|instructions, … }` today only has a
 * home NESTED inside a `capability`'s `skills[]`. A truly standalone skill
 * package has nowhere to land until the CP schema grows a slot for it.
 * `validateStandalonePackage` reports this rather than inventing a shape.
 */

import { readFileSync, existsSync } from "node:fs";
import { dirname, resolve as resolvePath } from "node:path";
import { parse as parseYaml } from "yaml";
import { validateFlowDefinition } from "@synap-core/workspace-templates";
import type { PackageDefinitionLike } from "./template-file.js";
import {
  CONTENT_KINDS,
  parseContentKind,
  buildCellFromSource,
} from "../commands/cell.js";

/**
 * The non-workspace package types this file knows how to shape. Mirrors the
 * live subset of the CP's `PACKAGE_TYPES` SSOT (db/schema/packages.ts) —
 * "workspace" has its own authoring loop (`template-file.ts`).
 *
 * `workflow` (the CP's rename of the old "automation" + "playbook") IS a lone
 * file: its payload is `definition.automations[]` — a triggered/sequenced run,
 * exactly the shape `POST /api/packages`' `packageDefinitionSchema.automations`
 * validates (`routes/packages.ts`). The `category` posted upstream must be a
 * live `PACKAGE_TYPES` value, so we use "workflow" verbatim (never the retired
 * "automation" alias, which the publish enum rejects).
 *
 * `capability` used to be excluded here with the comment "authored/seeded
 * elsewhere, not as a lone file here". That was a statement about how WE happen
 * to author them, not about what the CP accepts — and it left the most complex
 * kind we have with no CLI door at all. The server half already exists, all of
 * it, and NO CP migration is involved:
 *   • `capability` is a live `PACKAGE_TYPES` value (db/schema/packages.ts);
 *   • `packageDefinitionSchema` declares `capability: z.record(z.unknown())`
 *     (routes/packages.ts:824-832);
 *   • `publish-package-core.ts` stores a non-workspace definition AS-IS and
 *     hashes it into `definition.capability.contentHash`;
 *   • `GET /api/marketplace/capabilities` unwraps `definition.capability` into
 *     the card the pod's catalog sync caches (marketplace-apps.ts:398-410);
 *   • `market.install` resolves `kind: "capability"` BY KEY, cache row or not
 *     (marketplace-install.ts:263).
 * So the whole loop — scaffold → validate → publish → install — closes.
 *
 * `skill` stays here but is NOT scaffoldable and cannot really publish: it is
 * the one kind with no payload slot (see the file header). Adding one is a
 * CHECK-constraint migration (`drizzle/0049_package_vocabulary.sql`) mirrored
 * across ~24 files in 6 repos — a schema change, not an authoring change.
 */
export const STANDALONE_KINDS = [
  "view",
  "cell",
  "skill",
  "workflow",
  "capability",
] as const;
export type StandaloneKind = (typeof STANDALONE_KINDS)[number];

export interface StandalonePackageFile {
  category: StandaloneKind;
  slug: string;
  displayName: string;
  description?: string;
  tags?: string[];
  definition: PackageDefinitionLike;
}

/**
 * True when a parsed JSON/YAML top-level object declares a standalone
 * (non-workspace) `category`. A `WorkspaceYaml` file never carries a
 * top-level `category` key (it uses `meta`/`workspace`), so this is a safe,
 * non-overlapping discriminator `marketPublish` can branch on.
 */
export function isStandalonePackageFile(
  parsed: unknown,
): parsed is { category: string } {
  return (
    !!parsed &&
    typeof parsed === "object" &&
    typeof (parsed as { category?: unknown }).category === "string" &&
    (STANDALONE_KINDS as readonly string[]).includes(
      (parsed as { category: string }).category,
    )
  );
}

/**
 * Read + parse a standalone package file (JSON or YAML — the same
 * JSON-superset parser `parseTemplateFile` uses). Throws a friendly Error,
 * never `process.exit`.
 */
export function parseStandalonePackageFile(
  filePath: string,
): StandalonePackageFile {
  let raw: string;
  try {
    raw = readFileSync(filePath, "utf-8");
  } catch {
    throw new Error(`Cannot read package file: ${filePath}`);
  }
  let parsed: unknown;
  try {
    parsed = parseYaml(raw);
  } catch (e) {
    throw new Error(
      `Package file is not valid YAML/JSON: ${(e as Error).message}`,
    );
  }
  if (!isStandalonePackageFile(parsed)) {
    throw new Error(
      `Not a standalone package file (expected a top-level "category" of ${STANDALONE_KINDS.join("/")}).`,
    );
  }
  const p = parsed as Record<string, unknown>;
  if (!p.slug || typeof p.slug !== "string")
    throw new Error(`Package file has no "slug".`);
  if (!p.displayName || typeof p.displayName !== "string")
    throw new Error(`Package file has no "displayName".`);
  if (!p.definition || typeof p.definition !== "object")
    throw new Error(`Package file has no "definition" object.`);
  return {
    category: p.category as StandaloneKind,
    slug: p.slug,
    displayName: p.displayName,
    description: typeof p.description === "string" ? p.description : undefined,
    tags: Array.isArray(p.tags) ? (p.tags as string[]) : undefined,
    definition: p.definition as PackageDefinitionLike,
  };
}

/**
 * Minimal structural check BEFORE any network call — mirrors the fast
 * author-feedback `marketValidate` gives workspace templates, scaled to what
 * a standalone package actually needs: the `definition` must carry the array
 * the CP's `packageDefinitionSchema` reads for that category. Returns an
 * empty array when clean.
 */
export function validateStandalonePackage(
  pkg: StandalonePackageFile,
  opts: { baseDir?: string } = {},
): string[] {
  const errors: string[] = [];
  if (pkg.category === "cell") {
    const cells = pkg.definition.cells;
    if (!Array.isArray(cells) || cells.length === 0) {
      errors.push(
        `category "cell" requires a non-empty definition.cells[] array.`,
      );
    } else {
      cells.forEach((raw, i) => {
        const c = (raw && typeof raw === "object" ? raw : {}) as Record<
          string,
          unknown
        >;
        const label =
          typeof c.key === "string" && c.key.trim()
            ? `cells[${i}] ("${c.key}")`
            : `cells[${i}]`;

        const hasCode = typeof c.code === "string" && c.code.trim().length > 0;
        const hasCodeFile =
          typeof c.codeFile === "string" && c.codeFile.trim().length > 0;
        if (!hasCode && !hasCodeFile) {
          errors.push(
            `${label}: needs "code" (inline ESM source) or "codeFile" (a path to a source/bundle file, resolved and inlined at publish time).`,
          );
        }
        if (hasCodeFile && opts.baseDir) {
          const abs = resolvePath(opts.baseDir, c.codeFile as string);
          if (!existsSync(abs)) {
            errors.push(
              `${label}: codeFile "${c.codeFile as string}" not found (resolved to ${abs}).`,
            );
          }
        }

        // Both of these are `.optional()` on the CP's `packageDefinitionSchema`
        // (routes/packages.ts), so an omitted or mistyped value is stripped
        // SILENTLY — not rejected — and the cell arrives at the pod as the
        // inert "widget" default with no view-renderer affinity: placeable,
        // permanently unpickable, and nothing downstream ever reports it (see
        // `cell.ts`'s SELECTABILITY note, and `kind-package-scaffold-usable
        // .test.ts`, which is exactly why the scaffold always sets both).
        if (typeof c.contentKind !== "string" || !parseContentKind(c.contentKind)) {
          errors.push(
            `${label}: "contentKind" must be one of: ${CONTENT_KINDS.join(", ")} (got ${JSON.stringify(c.contentKind)}).`,
          );
        }
        // `viewTypes` is OPTIONAL, and deliberately so: it is view-renderer
        // affinity, a DIFFERENT axis from `contentKind`'s renderer slot. An
        // `entity-detail` cell is a profile renderer and has no business
        // declaring view types — the scaffold says so in its own comment
        // ("remove if this cell is not a view renderer").
        //
        // ── VALIDATOR vs DOOR: a DELIBERATE asymmetry, do not "fix" it ──
        // This validator requires `contentKind` UNCONDITIONALLY. The install
        // door does NOT: `resolveCellContentKind` infers "collection" from a
        // non-empty `viewTypes` when `contentKind` is absent.
        //
        // That is strict-in / permissive-out, on purpose:
        //   • AUTHORING (here) is the last cheap moment to catch a mistake. An
        //     omitted `contentKind` silently defaults the stored column to
        //     "widget" — placeable, but never offered in the renderer slot the
        //     cell was built for. Failing at `market validate` costs the author
        //     seconds; discovering it after publish costs a republish.
        //   • INSTALL (the door) must keep already-published packages working,
        //     including ones authored before this rule existed. Rejecting them
        //     there would break installs for cells nobody can now re-publish.
        //
        // So a package can be door-valid and validator-invalid, and that is the
        // correct direction. Loosening this check to "match the door" would
        // reintroduce the silent-widget trap for every new cell.

        // Requiring it here would be worse than not checking: an author would
        // add a meaningless `["list"]` to get past the validator, and that
        // MANUFACTURES a false affinity — the cell then gets offered as a list
        // renderer it was never built to be. That is the unpickability bug
        // inverted, so we validate SHAPE when present and require presence only
        // where absence is genuinely fatal.
        if (c.viewTypes !== undefined) {
          if (
            !Array.isArray(c.viewTypes) ||
            c.viewTypes.length === 0 ||
            !c.viewTypes.every(
              (v) => typeof v === "string" && v.trim().length > 0,
            )
          ) {
            errors.push(
              `${label}: "viewTypes", when present, must be a non-empty array of view-type strings (e.g. ["list","table"]). Omit it entirely if this cell is not a view renderer.`,
            );
          } else if (
            typeof c.contentKind === "string" &&
            parseContentKind(c.contentKind) &&
            c.contentKind !== "collection"
          ) {
            // Match the door: `defineCell` rejects this same pair. `contentKind`
            // is the renderer SLOT, `viewTypes` is view-renderer AFFINITY — a
            // DIFFERENT axis, and a non-collection slot can never be selected by
            // view-type affinity, so declaring both is a contradiction the
            // author must resolve, not one this validator should coerce away
            // (silently forcing "collection" would hand them a cell they never
            // chose to be a view renderer). `contentKind` ABSENT is NOT this case
            // — that is inference from silence (the door's own
            // `resolveCellContentKind` infers "collection"), not a
            // contradiction, and is how older cell packages install correctly.
            errors.push(
              `${label}: "viewTypes" is set (${JSON.stringify(c.viewTypes)}) but "contentKind" is "${c.contentKind}", not "collection" — view-type affinity only applies to a collection renderer. Drop "viewTypes", or set "contentKind": "collection".`,
            );
          }
        } else if (c.contentKind === "collection") {
          // The one case where absence IS fatal: a `collection` cell exists to
          // render a view, so with no affinity the render chokepoint can never
          // select it — installed and permanently unpickable.
          errors.push(
            `${label}: a "collection" cell must declare "viewTypes" (e.g. ["list","table"]) — without an affinity it can never be selected as a view renderer.`,
          );
        }
      });
    }
  } else if (pkg.category === "view") {
    const views = pkg.definition.views;
    if (!Array.isArray(views) || views.length === 0) {
      errors.push(
        `category "view" requires a non-empty definition.views[] array.`,
      );
    }
  } else if (pkg.category === "workflow") {
    const automations = pkg.definition.automations;
    if (!Array.isArray(automations) || automations.length === 0) {
      errors.push(
        `category "workflow" requires a non-empty definition.automations[] array.`,
      );
    } else {
      errors.push(...validateWorkflowFlows(automations));
    }
  } else if (pkg.category === "capability") {
    // `packageDefinitionSchema.capability` is `z.record(z.unknown())` — the CP
    // catalogs a capability, it never validates or executes the inner skill
    // code. So say plainly what this check IS: presence and the two fields the
    // catalog's own reader dereferences, not correctness. Claiming more than
    // the check performs is the failure this file already carries a tombstone
    // for.
    const cap = (pkg.definition as { capability?: unknown }).capability;
    if (!cap || typeof cap !== "object" || Array.isArray(cap)) {
      errors.push(
        `category "capability" requires a definition.capability object (the CapabilityDefinition itself — key/name/tools/skills). The CP unwraps exactly this key at GET /api/marketplace/capabilities.`,
      );
    } else {
      const c = cap as Record<string, unknown>;
      // `tools` and `skills` are non-optional on `CapabilityDefinition`
      // (synap-backend/packages/playbooks/src/index.ts:839). An empty `tools`
      // is legitimate (research-methods.capability.json ships `tools: []`);
      // an empty `skills` is a capability that grants nothing — installed,
      // no error, and it does nothing. That is the shape this check exists
      // to catch, and it is the same "installed but inert" class as an
      // automation published with no `status`.
      if (typeof c.key !== "string" || !c.key.trim())
        errors.push(`definition.capability.key must be a non-empty string.`);
      if (typeof c.name !== "string" || !c.name.trim())
        errors.push(`definition.capability.name must be a non-empty string.`);
      if (!Array.isArray(c.tools))
        errors.push(
          `definition.capability.tools must be an array (use [] for a pure know-how capability).`,
        );
      if (!Array.isArray(c.skills) || c.skills.length === 0)
        errors.push(
          `definition.capability.skills must be a non-empty array — a capability with no skills installs successfully and grants nothing.`,
        );
    }
  } else if (pkg.category === "skill") {
    errors.push(
      `category "skill" has no standalone payload slot in the CP's package schema yet (a skill only exists today nested inside a capability's skills[]) — publish will likely be rejected. See kind-package.ts header.`,
    );
  }
  return errors;
}

export interface ResolveCellCodeFilesResult {
  definition: PackageDefinitionLike;
  errors: string[];
}

/**
 * Inline every cell's `codeFile` into `code` — the field the CP schema
 * actually validates (`cells[].code: z.string().min(1)`, no `codeFile` slot).
 * A no-op for anything but a `cell` package, and for a cell entry that has no
 * `codeFile` (plain inline `code` is untouched).
 *
 * `codeFile` is bundled through the SAME esbuild path `cell build` uses
 * (`buildCellFromSource`), so publishing from source needs no separate manual
 * build step. `bundleDeps` defaults to `true` here — see `market-authoring.ts`
 * `marketPublishStandalone` for why the DEFAULT flips only on this door.
 * Author-declared `deps` on the cell entry win over the derived map, mirroring
 * `cell build --deps`'s own override semantics.
 */
export async function resolveCellCodeFiles(
  pkg: StandalonePackageFile,
  baseDir: string,
  opts: { bundleDeps?: boolean } = {},
): Promise<ResolveCellCodeFilesResult> {
  if (pkg.category !== "cell" || !Array.isArray(pkg.definition.cells)) {
    return { definition: pkg.definition, errors: [] };
  }
  const bundleDeps = opts.bundleDeps ?? true;
  const errors: string[] = [];
  const resolved: unknown[] = [];

  for (let i = 0; i < pkg.definition.cells.length; i++) {
    const raw = pkg.definition.cells[i];
    const c = (raw && typeof raw === "object" ? raw : {}) as Record<
      string,
      unknown
    >;
    if (typeof c.codeFile !== "string" || !c.codeFile.trim()) {
      resolved.push(raw);
      continue;
    }
    const label =
      typeof c.key === "string" && c.key.trim()
        ? `cells[${i}] ("${c.key}")`
        : `cells[${i}]`;
    const entry = resolvePath(baseDir, c.codeFile);
    if (!existsSync(entry)) {
      errors.push(
        `${label}: codeFile "${c.codeFile}" not found (resolved to ${entry}).`,
      );
      resolved.push(raw);
      continue;
    }
    try {
      const built = await buildCellFromSource(entry, { bundleDeps });
      const { codeFile: _codeFile, ...rest } = c;
      resolved.push({
        ...rest,
        code: built.code,
        deps: { ...built.deps, ...((c.deps as Record<string, string>) ?? {}) },
      });
    } catch (e) {
      errors.push(
        `${label}: failed to bundle codeFile "${c.codeFile}" — ${(e as Error).message}`,
      );
      resolved.push(raw);
    }
  }

  return { definition: { ...pkg.definition, cells: resolved }, errors };
}

/**
 * Run the SAME node-contract validator the workspace lane runs, on a standalone
 * workflow package's flows.
 *
 * `validateStandalonePackage` used to check only that `automations[]` was
 * non-empty. A semantically broken flow — an unknown `node.type`, an edge to a
 * nonexistent node, a cycle, a `capability` node with no `verbId`, a typo'd
 * `channelType` — therefore validated GREEN and died at runtime, silently: the
 * automation installs and simply never fires. `validateTemplate` has closed
 * exactly this gap for WORKSPACE templates since
 * `@synap-core/workspace-templates` validate.ts:655-669; the standalone lane
 * never got the same treatment, and `market scaffold --kind workflow` has now
 * made standalone workflows a first-class authoring path. This is that wiring —
 * the validator already exists, it is pure and synchronous, and it is exported
 * from the package the CLI already depends on.
 *
 * `flow ?? flowDefinition` mirrors validate.ts's own read: the WorkspaceYaml
 * lane names it `flow`, the CP publish schema and the scaffold name it
 * `flowDefinition`. Catalog-existence checks are resolver-gated and skipped —
 * there is no catalog at author time — so only the structural and per-node
 * contract checks run, which is exactly what the workspace lane does.
 *
 * An automation with NO flow at all is left alone here: `validateFlowDefinition`
 * would reject `undefined` as "not an object", but a flowless automation is a
 * different (and legitimate) shape, not a broken flow.
 */
function validateWorkflowFlows(automations: unknown[]): string[] {
  const errors: string[] = [];
  automations.forEach((raw, i) => {
    const a = (raw ?? {}) as Record<string, unknown>;
    const label =
      typeof a.name === "string" && a.name.trim()
        ? `automation "${a.name}"`
        : `automations[${i}]`;
    const flow = a.flow ?? a.flowDefinition;
    if (flow == null) return;
    for (const e of validateFlowDefinition(flow).errors) {
      const where = e.nodeId
        ? `${label}.flow.node "${e.nodeId}"`
        : e.edgeId
          ? `${label}.flow.edge "${e.edgeId}"`
          : `${label}.flow`;
      errors.push(`${where}: ${e.message}`);
    }
  });
  return errors;
}

// ─── scaffold ────────────────────────────────────────────────────────────────

/**
 * The kinds `market scaffold --kind <k>` can write. This is the SSOT for that
 * flag's accepted values AND for its help string (`src/index.ts`) — the two had
 * drifted: the help advertised `skill` (which scaffold refuses) and hid
 * `workflow` (which `validateStandalonePackage` has always accepted), so the
 * documented loop offered a dead option and concealed a working one.
 *
 * `skill` is deliberately absent: `STANDALONE_KINDS` carries it because a
 * hand-written skill file must still be *recognised* and told the truth, but
 * there is no known-good publishable shape (see the file header), so scaffold
 * refuses it rather than writing a file that cannot publish.
 */
export const SCAFFOLDABLE_KINDS = [
  "cell",
  "view",
  "workflow",
  "capability",
] as const;
export type ScaffoldableKind = (typeof SCAFFOLDABLE_KINDS)[number];

/**
 * Build the minimal standalone-package JSON `market scaffold --kind
 * cell|view|workflow|capability` writes — the smallest file that passes
 * {@link validateStandalonePackage}, for the author to edit in place.
 *
 * The bar is USABLE, not merely valid. Every arm below has at least one field
 * whose OMISSION is not neutral — the cell's `contentKind`/`viewTypes`, the
 * workflow's `status`/`triggerType`/two-node flow — because the appliers
 * default a missing value to something inert and report success. A scaffold
 * that writes a file which installs and then does nothing is the same defect
 * as a validator that passes a flow which never fires.
 */
export function scaffoldStandalonePackageJson(
  kind: ScaffoldableKind,
  slug: string,
): string {
  const displayName = slug
    .split(/[-_]/)
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ") || slug;

  const definition = scaffoldDefinition(kind, slug, displayName);

  return JSON.stringify(
    {
      category: kind,
      slug,
      displayName,
      // No kind noun here on purpose. `cell` and `workflow` are MACHINE tokens
      // the product's vocabulary renders as "card" and "automation"
      // (`KIND_HEADINGS`, commands/market.ts, pinned by
      // test/kind-heading-vocabulary-parity.test.ts) — echoing the raw token
      // into an author-visible, publishable description would fork that table.
      description: `What ${displayName} does — replace this before publishing.`,
      definition,
    },
    null,
    2,
  ) + "\n";
}

/**
 * The payload for one scaffolded kind.
 *
 * A `switch` rather than the nested ternary chain this used to be: at four
 * arms and ~130 lines the chain had already drifted — its last arm was
 * indented as if it belonged to the arm above it — and no reader could tell
 * which comment documented which kind. The switch also makes exhaustiveness
 * over {@link ScaffoldableKind} checkable, which a ternary chain cannot give:
 * adding a kind to `SCAFFOLDABLE_KINDS` without adding an arm here is now a
 * typecheck failure at the `never` assignment below, not a silent fallthrough
 * into the workflow shape.
 */
function scaffoldDefinition(
  kind: ScaffoldableKind,
  slug: string,
  displayName: string,
): PackageDefinitionLike {
  switch (kind) {
    case "cell":
      return {
        cells: [
          {
            key: slug,
            name: displayName,
            code: "export default function Cell() { return null; }",
            // WHAT this cell renders + which profile assignment it fills.
            // SSOT: `CONTENT_KINDS` in
            // synap-backend/packages/database/src/schema/widget-definitions.ts
            // — the five legal values are "entity-detail", "entity-card",
            // "entity-profile", "collection", "widget". Omitting this field
            // is NOT neutral: the CP schema strips an undeclared
            // `contentKind`, so the cell installs silently as the
            // content-agnostic "widget" default and can never be picked as
            // a renderer for the kind it was actually built for.
            contentKind: "widget",
            // View-type affinity when this cell acts as a view renderer
            // (e.g. ["list", "table"]). Without this slot the cell has no
            // affinity and the render chokepoint can never select it —
            // installed but permanently unpickable. Edit to match the view
            // type(s) this cell renders, or remove if this cell is not a
            // view renderer.
            viewTypes: ["list"],
          },
        ],
      };
    case "view":
      return {
        views: [
          {
            slug,
            displayName,
            type: "list",
          },
        ],
      };
    case "capability":
      return {
        capability: {
          key: slug,
          name: displayName,
          description: `What ${displayName} does — replace this before publishing.`,
          // No params and no vault: the smallest capability that is
          // immediately usable is pure know-how, needing no credential
          // and no connection step. Add `params`/`vault` when a tool
          // actually needs a secret — the applier stores it
          // server-encrypted and remaps the ref at install.
          params: [],
          vault: [],
          // `tools` and `skills` are REQUIRED on `CapabilityDefinition`
          // (synap-backend/packages/playbooks/src/index.ts:845-846).
          // `tools: []` is legitimate and shipped in production —
          // research-methods.capability.json is exactly this shape.
          tools: [],
          skills: [
            {
              name: `${slug.replace(/-/g, "_")}_method`,
              // `instruction` = a prompt/doc skill injected into the
              // agent's turn. No sandboxed code, no connector call, so
              // it works on a fresh pod with no credentials — unlike
              // `code`, which needs a tool to call.
              kind: "instruction",
              scope: "pod",
              description: `When and how an agent should use ${displayName}.`,
              // A real instruction, not a placeholder: an empty `code`
              // installs a skill that teaches the agent nothing, which
              // is this scaffold's version of an inert automation.
              code: `# ${displayName}\n\nDescribe HOW the agent should do this — the judgement, not the mechanics.\n\n## When to use\n- Replace with the situations that should trigger this skill.\n\n## How to do it\n1. Replace with the actual method.\n\n## Hard rules\n- Replace with what the agent must never do here.\n`,
            },
          ],
        },
      };
    case "workflow":
      return {
        automations: [
          {
            // `slug` (not `key`): both are accepted by the CP's publish
            // schema, which resolves `slug ?? key` — but three flagship
            // templates once 400'd on `automations.0.slug: Required`, so
            // the scaffold writes the field the schema names first.
            slug,
            name: displayName,
            // A `manual` trigger is the only one that is inert until the
            // author asks for it: a scaffolded `cron`/`event` automation
            // would start firing the moment it is installed.
            triggerType: "manual",
            triggerConfig: {},
            // NOT neutral, and the same trap as the cell's `contentKind`:
            // the CP's `automations[]` transform defaults a missing status
            // to "draft", so an automation that omits it installs INERT —
            // no error, no signal, never runs.
            status: "active",
            // A real two-node flow, not `{nodes: [], edges: []}`: an empty
            // flow is structurally valid and does nothing, which is the
            // "installed but does nothing" shape this scaffold exists to
            // avoid. Node types come from `FLOW_NODE_TYPES` and the output
            // type from `FLOW_OUTPUT_TYPES`
            // (@synap-core/workspace-templates `validate-flow.ts`).
            flowDefinition: {
              nodes: [
                {
                  id: "trigger",
                  type: "trigger",
                  position: { x: 0, y: 0 },
                  data: {
                    label: displayName,
                    triggerType: "manual",
                    config: {},
                  },
                },
                {
                  id: "notify",
                  type: "output",
                  position: { x: 260, y: 0 },
                  data: {
                    label: "Notify",
                    outputType: "notification",
                    // `body` is required by the executor — a notification
                    // output with no body is SKIPPED at runtime.
                    config: {
                      title: displayName,
                      body: `${displayName} ran.`,
                    },
                  },
                },
              ],
              edges: [
                { id: "trigger-notify", source: "trigger", target: "notify" },
              ],
            },
          },
        ],
      };
    default: {
      const unhandled: never = kind;
      throw new Error(
        `scaffoldStandalonePackageJson: no scaffold for kind ${String(unhandled)}`,
      );
    }
  }
}
