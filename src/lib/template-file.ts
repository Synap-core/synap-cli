/**
 * Local template-file authoring helpers — the PURE half of the authoring loop
 * (scaffold → validate → publish). No network, no `process.exit`:
 *
 *   • parse a `.yaml`/`.yml`/`.json` template off disk into a `WorkspaceYaml`,
 *   • run the ONE shared validator (`validateTemplate` from
 *     `@synap-core/workspace-templates`) against the bundled corpus,
 *   • convert a parsed template into the `PackageDefinition` the CP wants, and
 *   • adapt a backend `to-template` `PackageDefinition` back into the
 *     `WorkspaceYaml` shape the validator reads (so the `--from-workspace`
 *     publish path runs the SAME validator as a hand-authored file).
 *
 * Kept out of the command layer so it is unit-testable in isolation (the
 * validator is pure — a bad and a good template are trivial to assert).
 */

import { readFileSync } from "node:fs";
import { parse as parseYaml } from "yaml";
import {
  validateTemplate,
  toPackageDefinition,
  WORKSPACE_TEMPLATES,
  type WorkspaceYaml,
  type ValidateResult,
  type PackageDefinitionOutput,
} from "@synap-core/workspace-templates";

/**
 * The bundled corpus as the array `validateTemplate`'s `corpus` option wants —
 * it keys by `meta.slug` internally to resolve a template's compose/require
 * dependency vocabulary. Reuses the same bundle every other CLI surface reads.
 */
function bundledCorpus(): WorkspaceYaml[] {
  return Object.values(WORKSPACE_TEMPLATES);
}

/**
 * Read + parse a local template file into a `WorkspaceYaml`. YAML's parser is a
 * JSON superset, so one path covers both `.yaml`/`.yml` and `.json`. Throws a
 * friendly Error (never `process.exit`) on unreadable / unparseable input.
 */
export function parseTemplateFile(filePath: string): WorkspaceYaml {
  let raw: string;
  try {
    raw = readFileSync(filePath, "utf-8");
  } catch {
    throw new Error(`Cannot read template file: ${filePath}`);
  }
  let parsed: unknown;
  try {
    parsed = parseYaml(raw);
  } catch (e) {
    throw new Error(`Template is not valid YAML/JSON: ${(e as Error).message}`);
  }
  if (!parsed || typeof parsed !== "object") {
    throw new Error("Template file is empty or not a mapping/object");
  }
  return parsed as WorkspaceYaml;
}

/**
 * Validate ONE parsed template against the bundled corpus. Pure passthrough to
 * the shared validator — the ONE door, never a re-implementation.
 */
export function validateTemplateYaml(tpl: WorkspaceYaml): ValidateResult {
  return validateTemplate(tpl, { corpus: bundledCorpus() });
}

/**
 * Convert a parsed local template into the `PackageDefinition` the CP publish
 * route accepts. Thin wrapper over the shared converter (same one `market
 * install` uses for the pod apply path).
 */
export function templateToPackageDefinition(
  tpl: WorkspaceYaml,
): PackageDefinitionOutput {
  return toPackageDefinition(tpl);
}

/**
 * The subset of a backend `PackageDefinition` the publish/validate paths read.
 * Structurally matches `PackageDefinitionOutput` AND the backend `to-template`
 * output (both carry `_meta` + `workspaceName`), so either can flow through.
 */
export interface PackageDefinitionLike {
  _meta?: {
    slug?: string;
    icon?: string;
    color?: string;
    domain?: string;
    tags?: string[];
    isPublic?: boolean;
    version?: string;
  };
  workspaceName?: string;
  description?: string;
  profiles?: unknown[];
  views?: unknown[];
  /** Cell definitions — only meaningful for a standalone `category: "cell"` package (see `lib/kind-package.ts`). */
  cells?: unknown[];
  entityLinks?: unknown[];
  onboarding?: unknown;
  dependencies?: unknown[];
  icon?: string;
  color?: string;
  domain?: string;
  [k: string]: unknown;
}

// `meta.icon`/`meta.color` are author-set-at-publish-time and have NO slot on a
// live workspace's settings (the backend `to-template` service says so), so the
// adapter fills neutral placeholders. The validator's real value is the
// profile/view/link referential closure — not cosmetic-field presence.
const PLACEHOLDER_ICON = "📦";
const PLACEHOLDER_COLOR = "#6B7280";

/**
 * Adapt a `PackageDefinition` (from the backend `to-template` door) into the
 * `WorkspaceYaml` shape `validateTemplate` reads, so the `--from-workspace`
 * publish path runs the SAME referential-integrity validator as a hand-authored
 * file rather than a second, drifting copy.
 */
export function packageDefinitionToYaml(def: PackageDefinitionLike): WorkspaceYaml {
  const name = def.workspaceName ?? def._meta?.slug ?? "workspace";
  const description = def.description ?? name;
  return {
    meta: {
      slug: def._meta?.slug ?? "",
      name,
      description,
      icon: def._meta?.icon ?? def.icon ?? PLACEHOLDER_ICON,
      color: def._meta?.color ?? def.color ?? PLACEHOLDER_COLOR,
      tags: def._meta?.tags,
      isPublic: def._meta?.isPublic,
      domain: def._meta?.domain ?? def.domain,
    },
    workspace: { name, description },
    profiles: (def.profiles ?? []) as WorkspaceYaml["profiles"],
    views: def.views as WorkspaceYaml["views"],
    entityLinks: def.entityLinks as WorkspaceYaml["entityLinks"],
    onboarding: def.onboarding as WorkspaceYaml["onboarding"],
    dependencies: def.dependencies as WorkspaceYaml["dependencies"],
  } as WorkspaceYaml;
}

/** Title-case a slug for a human-readable default name (e.g. `book-club` → `Book Club`). */
function slugToTitle(slug: string): string {
  return slug
    .split(/[-_]/)
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

/**
 * Build the minimal VALID template YAML a `scaffold` writes — the smallest file
 * that passes `validateTemplate` AND the CP publish schema, for the author to
 * edit in place (create-then-configure: no wizard, no prompts). One workspace +
 * one profile + one property.
 */
export function scaffoldTemplateYaml(slug: string): string {
  const name = slugToTitle(slug) || slug;
  return `# ${name} — Synap workspace template
# Edit in place, then validate:  synap market validate ${slug}.template.yaml
# Publish (private by default):   synap market publish ${slug}.template.yaml
meta:
  slug: ${slug}
  name: ${name}
  description: A ${name} workspace.
  icon: "📦"
  color: "${PLACEHOLDER_COLOR}"

workspace:
  name: ${name}
  description: A ${name} workspace.

profiles:
  - slug: ${slug}-item
    displayName: ${name} Item
    properties:
      - slug: title
        label: Title
        valueType: string
`;
}
