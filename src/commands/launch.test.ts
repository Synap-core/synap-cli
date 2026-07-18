/**
 * Unit tests for `partitionCatalog` — the pure catalog-partitioning helper
 * behind the `synap launch` guided picker (bundle components vs add-ons vs
 * personal vs "just one" curated list). No prompts, no I/O: safe to test
 * directly. Run: `npx tsx --test src/commands/launch.test.ts`
 *
 * This package has no test runner installed (no vitest/jest, no `test`
 * script) — following the precedent in
 * `synap-app/packages/workspace-templates/src/catalog.test.ts`, this uses
 * node's built-in `node:test` so no new dependency is needed.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { partitionCatalog } from "./launch.js";
import type { WorkspaceYaml, CatalogEntry } from "@synap-core/workspace-templates";

/** Minimal bundled template — only the fields `partitionCatalog` reads. */
function yaml(slug: string, deps?: WorkspaceYaml["dependencies"]): WorkspaceYaml {
  return {
    meta: { slug, name: slug, description: `${slug} desc`, icon: "layers", color: "#fff" },
    workspace: { name: slug, description: "" },
    profiles: [],
    dependencies: deps,
  } as WorkspaceYaml;
}

/** Minimal merged catalog entry — bundled unless `isPrivate` (then remote, matching how a private template actually arrives). */
function entry(slug: string, opts?: { isPrivate?: boolean }): CatalogEntry {
  const base = { slug, name: slug, description: `${slug} desc`, tags: [], isPrivate: opts?.isPrivate ?? false };
  return opts?.isPrivate
    ? ({ ...base, source: "remote", remote: { slug, name: slug, category: "workspace", tags: [] } } as CatalogEntry)
    : ({ ...base, source: "bundled", template: yaml(slug) } as CatalogEntry);
}

/** Builds the `Catalog` shape `partitionCatalog` consumes, from a slug list. */
function catalogOf(
  slugs: string[],
  yamls: Record<string, WorkspaceYaml> = {},
  privateSlugs: string[] = []
) {
  const entries = slugs.map((s) => entry(s, { isPrivate: privateSlugs.includes(s) }));
  return {
    entries,
    entryMap: new Map(entries.map((e) => [e.slug, e])),
    sources: { bundled: "ok", remote: "ok" } as unknown,
    remote: { status: "ok", loggedIn: true, privateCount: privateSlugs.length } as unknown,
    yaml: new Map(Object.entries(yamls)),
  } as Parameters<typeof partitionCatalog>[0];
}

const ENTERPRISE_OS_DEPS: WorkspaceYaml["dependencies"] = [
  { slug: "foundation", kind: "workspace", relation: "require" },
  { slug: "ecosystem", kind: "workspace", relation: "require" },
  { slug: "operations", kind: "workspace", relation: "require" },
  { slug: "crm", kind: "workspace", relation: "require" },
  { slug: "content-os", kind: "workspace", relation: "require" },
];

test("company components exclude foundation — it is never a choice", () => {
  const cat = catalogOf(
    ["enterprise-os", "foundation", "ecosystem", "operations", "crm", "content-os"],
    { "enterprise-os": yaml("enterprise-os", ENTERPRISE_OS_DEPS) }
  );
  const { companyComponents } = partitionCatalog(cat);
  assert.ok(!companyComponents.includes("foundation"), "foundation must never appear");
  assert.deepEqual(companyComponents.sort(), ["content-os", "crm", "ecosystem", "operations"].sort());
});

test("company add-ons include the public add-on list plus private entries not already a component", () => {
  const cat = catalogOf(
    ["enterprise-os", "internal-runbook", "social", "the-arch"],
    { "enterprise-os": yaml("enterprise-os", ENTERPRISE_OS_DEPS) },
    ["the-arch"]
  );
  const { companyAddons } = partitionCatalog(cat);
  const slugs = companyAddons.map((e) => e.slug).sort();
  assert.deepEqual(slugs, ["internal-runbook", "social", "the-arch"]);
});

test("a private entry that IS already a bundle component is not double-listed as an add-on", () => {
  // Pathological but should never happen in practice — guards the addon filter.
  const cat = catalogOf(["enterprise-os", "crm"], { "enterprise-os": yaml("enterprise-os", ENTERPRISE_OS_DEPS) }, [
    "crm",
  ]);
  const { companyAddons } = partitionCatalog(cat);
  assert.ok(!companyAddons.some((e) => e.slug === "crm"));
});

test("personal lists only the slugs actually present in the catalog", () => {
  const cat = catalogOf(["life-os"], { "life-os": yaml("life-os") });
  const { personal } = partitionCatalog(cat);
  assert.deepEqual(personal, ["life-os"]);
});

test("personal lists both when both personal and life-os are present", () => {
  const cat = catalogOf(["personal", "life-os"], {
    personal: yaml("personal"),
    "life-os": yaml("life-os"),
  });
  const { personal } = partitionCatalog(cat);
  assert.deepEqual(personal.sort(), ["life-os", "personal"]);
});

test("just-one curated list excludes foundation, project-management, and unavailable slugs", () => {
  const cat = catalogOf(["crm", "operations", "hr"], {
    crm: yaml("crm"),
    operations: yaml("operations"),
    hr: yaml("hr"),
  });
  const { justOne } = partitionCatalog(cat);
  assert.ok(!justOne.includes("foundation"));
  assert.ok(!justOne.includes("project-management"));
  assert.deepEqual(justOne.sort(), ["crm", "hr", "operations"]);
});
