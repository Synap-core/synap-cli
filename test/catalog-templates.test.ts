/**
 * Where `synap bridge setup` reads the agency skills and bridge automations.
 *
 * The catalog package (`@synap-core/catalog`, or `@synap-core/workspace-templates`
 * before the rename) is their home. The CLI keeps its own copies under
 * `templates/` only until the INSTALLED package ships them; from then on the
 * installed package wins, per skill and per automation, and the CLI copies must
 * go. The retirement guard at the bottom runs against the real installed
 * package (node_modules, so it runs in CLI CI): it FAILS the day a pin bump
 * brings in a package that ships them while the CLI copies still exist.
 */

import { describe, it, expect, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  AGENCY_SKILLS,
  CATALOG_TEMPLATE_PACKAGES,
  CLI_TEMPLATES_DIR,
  catalogRetirementViolations,
  resolveAgencySkillDirs,
  resolveAutomationTemplatesDir,
  resolveInstalledCatalogRoot,
} from "../src/lib/catalog-templates.js";

const tmp: string[] = [];
afterEach(() => {
  for (const d of tmp.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

/** Build a fixture tree: `{ "skills/a/SKILL.md": "x" }`. */
function tree(files: Record<string, string>): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "synap-cattpl-"));
  tmp.push(root);
  for (const [rel, body] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), body);
  }
  return root;
}

describe("agency skills: the installed catalog wins per skill, the CLI copy is the fallback", () => {
  it("takes a shipped agency skill from the catalog, the rest from the CLI; never a non-agency catalog skill", () => {
    const catalog = tree({
      "skills/mapping-the-server/SKILL.md": "catalog",
      "skills/some-other-skill/SKILL.md": "catalog-only, not an agency skill",
      "skills/creative-director/creative-director.skill.json": "{}", // not a SKILL.md folder
    });
    const cli = tree({
      "skills/mapping-the-server/SKILL.md": "cli",
      "skills/routing-to-channels/SKILL.md": "cli",
      "skills/authoring-playbooks/SKILL.md": "cli runtime skill",
    });
    const r = resolveAgencySkillDirs({ cliSkillsDir: path.join(cli, "skills"), catalogRoot: catalog });
    expect(r.dirs.sort()).toEqual(
      [
        path.join(catalog, "skills", "mapping-the-server"),
        path.join(cli, "skills", "authoring-playbooks"),
        path.join(cli, "skills", "routing-to-channels"),
      ].sort(),
    );
    expect(r.fromCatalog).toEqual(["mapping-the-server"]);
  });

  it("no installed catalog (or one that ships no skills): every skill comes from the CLI", () => {
    const cli = tree({ "skills/mapping-the-server/SKILL.md": "cli", "skills/authoring-playbooks/SKILL.md": "cli" });
    for (const catalogRoot of [null, tree({ "package.json": "{}" })]) {
      const r = resolveAgencySkillDirs({ cliSkillsDir: path.join(cli, "skills"), catalogRoot });
      expect(r.dirs.sort()).toEqual(
        [path.join(cli, "skills", "authoring-playbooks"), path.join(cli, "skills", "mapping-the-server")].sort(),
      );
      expect(r.fromCatalog).toEqual([]);
    }
  });
});

describe("bridge automations: env override, then the installed catalog, then the CLI copy", () => {
  it("resolves in that order", () => {
    const catalog = tree({ "automations/mail-feed.automation.json": "{}" });
    const empty = tree({ "automations/README.md": "no templates" });
    const cli = tree({ "automations/mail-feed.automation.json": "{}" });
    const cliDir = path.join(cli, "automations");
    expect(resolveAutomationTemplatesDir({ catalogRoot: catalog, cliDir })).toBe(path.join(catalog, "automations"));
    expect(resolveAutomationTemplatesDir({ catalogRoot: empty, cliDir })).toBe(cliDir);
    expect(resolveAutomationTemplatesDir({ catalogRoot: null, cliDir })).toBe(cliDir);
    expect(resolveAutomationTemplatesDir({ override: cliDir, catalogRoot: catalog, cliDir })).toBe(cliDir);
    expect(resolveAutomationTemplatesDir({ override: "/does/not/exist", catalogRoot: catalog, cliDir })).toBeNull();
  });
});

describe("bridge-setup reads through these resolvers", () => {
  // Source scan: proves the call sites, not their runtime (the seeding needs a pod).
  const src = fs.readFileSync(path.join(process.cwd(), "src/commands/bridge-setup.ts"), "utf8");
  it("skills and automations both resolve through the catalog-aware door", () => {
    expect(src).toMatch(/resolveAgencySkillDirs\(/);
    expect(src).toMatch(/resolveAutomationTemplatesDir\(/);
    expect(src).not.toMatch(/function resolveAutomationsTemplatesDir/);
  });
});

describe("retirement guard: the CLI copies go once the installed catalog ships them", () => {
  it("names every CLI copy the catalog shadows (fixture)", () => {
    const catalog = tree({
      "skills/mapping-the-server/SKILL.md": "x",
      "skills/some-other-skill/SKILL.md": "x",
      "automations/mail-feed.automation.json": "{}",
    });
    const cli = tree({
      "skills/mapping-the-server/SKILL.md": "x",
      "skills/authoring-playbooks/SKILL.md": "x",
      "automations/mail-feed.automation.json": "{}",
      "automations/url-bookmark-capture.automation.json": "{}",
    });
    expect(catalogRetirementViolations(catalog, cli).sort()).toEqual([
      "templates/automations/mail-feed.automation.json",
      "templates/skills/mapping-the-server",
    ]);
    expect(catalogRetirementViolations(null, cli)).toEqual([]);
  });

  it("the INSTALLED catalog package ships nothing the CLI still keeps a copy of", () => {
    const root = resolveInstalledCatalogRoot();
    // non-vacuity: the guard is looking at the real dependency, not at nothing
    expect(root, "the catalog package is a CLI dependency and must resolve").not.toBeNull();
    const pkg = JSON.parse(fs.readFileSync(path.join(root!, "package.json"), "utf8"));
    expect(CATALOG_TEMPLATE_PACKAGES).toContain(pkg.name);
    expect(AGENCY_SKILLS.length).toBeGreaterThanOrEqual(5);
    const violations = catalogRetirementViolations(root, CLI_TEMPLATES_DIR);
    expect(
      violations,
      `The installed ${pkg.name}@${pkg.version} ships these, so bridge-setup now reads them from it. ` +
        "Delete the CLI copies (and test/catalog-mirror.tripwire.test.ts once none are left):",
    ).toEqual([]);
  });
});
