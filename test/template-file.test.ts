/**
 * Unit tests for the PURE authoring helpers (`lib/template-file`): the validator
 * door and the scaffold. No network, no process.exit — `validateTemplate` is
 * pure, so a good and a bad template are trivial to assert.
 */
import { describe, it, expect } from "vitest";
import { parse as parseYaml } from "yaml";
import type { WorkspaceYaml } from "@synap-core/workspace-templates";
import {
  validateTemplateYaml,
  scaffoldTemplateYaml,
  packageDefinitionToYaml,
} from "../src/lib/template-file.js";

// A minimal, correct template (the shape `scaffold` writes).
const GOOD: WorkspaceYaml = {
  meta: {
    slug: "book-club",
    name: "Book Club",
    description: "A book club workspace.",
    icon: "📚",
    color: "#6B7280",
  },
  workspace: { name: "Book Club", description: "A book club workspace." },
  profiles: [
    {
      slug: "book",
      displayName: "Book",
      properties: [{ slug: "title", label: "Title", valueType: "string" }],
    },
  ],
} as WorkspaceYaml;

describe("validateTemplateYaml", () => {
  it("passes a well-formed template", () => {
    const r = validateTemplateYaml(GOOD);
    expect(r.ok, JSON.stringify(r.errors)).toBe(true);
    expect(r.errors).toHaveLength(0);
  });

  it("fails a template with no profiles and reports the rule", () => {
    const bad = { ...GOOD, profiles: [] } as WorkspaceYaml;
    const r = validateTemplateYaml(bad);
    expect(r.ok).toBe(false);
    expect(r.errors.map((e) => e.rule)).toContain("profiles-required");
  });

  it("fails a view that scopes an unknown profile (referential integrity)", () => {
    const bad = {
      ...GOOD,
      views: [{ name: "Board", type: "kanban", scopeProfileSlug: "ghost" }],
    } as WorkspaceYaml;
    const r = validateTemplateYaml(bad);
    expect(r.ok).toBe(false);
    const rules = r.errors.map((e) => e.rule);
    expect(rules).toContain("view-scope-unknown");
    // The offending profile name is surfaced in the message.
    expect(r.errors.find((e) => e.rule === "view-scope-unknown")?.message).toContain("ghost");
  });

  it("resolves a system profile without the template defining it", () => {
    const withSystemView = {
      ...GOOD,
      views: [{ name: "Tasks", type: "table", scopeProfileSlug: "task" }],
    } as WorkspaceYaml;
    const r = validateTemplateYaml(withSystemView);
    expect(r.ok, JSON.stringify(r.errors)).toBe(true);
  });

  it("flags missing required meta fields", () => {
    const bad = {
      ...GOOD,
      meta: { slug: "x", name: "X", description: "d" },
    } as unknown as WorkspaceYaml;
    const r = validateTemplateYaml(bad);
    expect(r.ok).toBe(false);
    expect(r.errors.map((e) => e.rule)).toContain("meta-field-required");
  });
});

describe("scaffoldTemplateYaml", () => {
  it("emits a template that parses and passes validation", () => {
    const yamlStr = scaffoldTemplateYaml("reading-list");
    const parsed = parseYaml(yamlStr) as WorkspaceYaml;
    expect(parsed.meta.slug).toBe("reading-list");
    expect(parsed.meta.name).toBe("Reading List");
    const r = validateTemplateYaml(parsed);
    expect(r.ok, JSON.stringify(r.errors)).toBe(true);
  });
});

describe("packageDefinitionToYaml", () => {
  it("adapts a backend PackageDefinition (with _meta) into a validatable WorkspaceYaml", () => {
    const def = {
      _meta: { slug: "from-ws", version: "h-abc" },
      workspaceName: "From Workspace",
      description: "Serialized live workspace.",
      profiles: [
        { slug: "widget", displayName: "Widget", properties: [] },
      ],
    };
    const yaml = packageDefinitionToYaml(def);
    // Identity + placeholder icon/color are filled so validation runs.
    expect(yaml.meta.slug).toBe("from-ws");
    expect(yaml.workspace.name).toBe("From Workspace");
    expect(yaml.meta.icon).toBeTruthy();
    expect(yaml.meta.color).toBeTruthy();
    expect(validateTemplateYaml(yaml).ok).toBe(true);
  });
});
