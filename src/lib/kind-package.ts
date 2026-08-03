/**
 * Standalone (non-workspace) package files — view / cell / skill.
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
 * ⚠️ KNOWN CP-SIDE GAP (do not paper over — this is a write-door fix, not a
 * CLI one). `POST /api/packages`'s zod `packageDefinitionSchema` requires
 * `definition.profiles` to be a NON-EMPTY array UNCONDITIONALLY
 * (`z.array(profileDefinitionSchema).min(1)`), even for category
 * "view"/"cell"/"skill". A profile-less standalone package therefore 400s
 * against that door today; the seed scripts (`seed-capability-templates.ts`)
 * sidestep it entirely by writing `profiles: []` straight to the DB, bypassing
 * this HTTP validator. Flagged for whoever owns `routes/packages.ts` — out of
 * scope here.
 *
 * ⚠️ "skill" ALSO HAS NO PAYLOAD SLOT: `packageDefinitionSchema` (and the
 * `PackageDefinition` TS type it validates) carry no top-level `skills[]`
 * array — a skill's `{ slug, name, code|instructions, … }` today only has a
 * home NESTED inside a `capability`'s `skills[]`. A truly standalone skill
 * package has nowhere to land until the CP schema grows a slot for it.
 * `validateStandalonePackage` reports this rather than inventing a shape.
 */

import { readFileSync } from "node:fs";
import { parse as parseYaml } from "yaml";
import type { PackageDefinitionLike } from "./template-file.js";

/**
 * The non-workspace package types this file knows how to shape. Mirrors the
 * live subset of the CP's `PACKAGE_TYPES` SSOT (db/schema/packages.ts) —
 * "workspace" has its own authoring loop (`template-file.ts`); "capability"
 * and "workflow" are authored/seeded elsewhere, not as a lone file here.
 */
export const STANDALONE_KINDS = ["view", "cell", "skill"] as const;
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
): string[] {
  const errors: string[] = [];
  if (pkg.category === "cell") {
    const cells = pkg.definition.cells;
    if (!Array.isArray(cells) || cells.length === 0) {
      errors.push(
        `category "cell" requires a non-empty definition.cells[] array.`,
      );
    }
  } else if (pkg.category === "view") {
    const views = pkg.definition.views;
    if (!Array.isArray(views) || views.length === 0) {
      errors.push(
        `category "view" requires a non-empty definition.views[] array.`,
      );
    }
  } else if (pkg.category === "skill") {
    errors.push(
      `category "skill" has no standalone payload slot in the CP's package schema yet (a skill only exists today nested inside a capability's skills[]) — publish will likely be rejected. See kind-package.ts header.`,
    );
  }
  return errors;
}

// ─── scaffold ────────────────────────────────────────────────────────────────

/**
 * Build the minimal standalone-package JSON `market scaffold --kind cell|view`
 * writes — the smallest file that passes {@link validateStandalonePackage},
 * for the author to edit in place. No `skill` scaffold: there is no known-good
 * shape yet (see the file header) — `marketScaffold` refuses `--kind skill`
 * with that same explanation rather than writing a file that can't publish.
 */
export function scaffoldStandalonePackageJson(
  kind: "cell" | "view",
  slug: string,
): string {
  const displayName = slug
    .split(/[-_]/)
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ") || slug;

  const definition =
    kind === "cell"
      ? {
          cells: [
            {
              key: slug,
              name: displayName,
              code: "export default function Cell() { return null; }",
            },
          ],
        }
      : {
          views: [
            {
              slug,
              displayName,
              type: "list",
            },
          ],
        };

  return JSON.stringify(
    {
      category: kind,
      slug,
      displayName,
      description: `A ${displayName} ${kind}.`,
      definition,
    },
    null,
    2,
  ) + "\n";
}
