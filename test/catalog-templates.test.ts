/**
 * Where `synap bridge setup` and `synap skill add bundled` read catalog content.
 *
 * The catalog package (`@synap-core/catalog`, or `@synap-core/workspace-templates`
 * before the rename) is the ONE source of the agency skills and the bridge
 * automations (founder, 5 Nov 2026). The CLI reads them from the INSTALLED
 * package and has no fallback copy: an item the package does not ship is named
 * in `missing`, never taken from anywhere else. That the CLI holds no copy is
 * `test/catalog-no-copy.tripwire.test.ts`.
 */

import { describe, it, expect, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  AGENCY_SKILLS,
  BRIDGE_AUTOMATIONS,
  resolveAgencySkillDirs,
  resolveBridgeAutomationFiles,
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

describe("agency skills: from the installed catalog only; the CLI gives its runtime skills", () => {
  it("takes each agency skill from the catalog, the CLI's runtime skills from the CLI, never a CLI agency copy", () => {
    const catalog = tree({
      "skills/mapping-the-server/SKILL.md": "catalog",
      "skills/some-other-skill/SKILL.md": "catalog-only, not an agency skill",
      "skills/creative-director/creative-director.skill.json": "{}", // not a SKILL.md folder
    });
    const cli = tree({
      "skills/routing-to-channels/SKILL.md": "a stray CLI copy",
      "skills/authoring-playbooks/SKILL.md": "cli runtime skill",
    });
    const r = resolveAgencySkillDirs({ cliSkillsDir: path.join(cli, "skills"), catalogRoot: catalog });
    expect(r.dirs.sort()).toEqual(
      [path.join(catalog, "skills", "mapping-the-server"), path.join(cli, "skills", "authoring-playbooks")].sort(),
    );
    expect(r.fromCatalog).toEqual(["mapping-the-server"]);
    expect(r.missing).toEqual(AGENCY_SKILLS.filter((s) => s !== "mapping-the-server"));
  });

  it("no installed catalog: only the runtime skills, every agency skill missing", () => {
    const cli = tree({ "skills/authoring-playbooks/SKILL.md": "cli" });
    for (const catalogRoot of [null, tree({ "package.json": "{}" })]) {
      const r = resolveAgencySkillDirs({ cliSkillsDir: path.join(cli, "skills"), catalogRoot });
      expect(r.dirs).toEqual([path.join(cli, "skills", "authoring-playbooks")]);
      expect(r.fromCatalog).toEqual([]);
      expect(r.missing).toEqual([...AGENCY_SKILLS]);
    }
  });
});

describe("bridge automations: the env override, else the pinned set from the installed catalog", () => {
  it("takes only BRIDGE_AUTOMATIONS from the catalog, never its other automations", () => {
    const catalog = tree({
      "automations/mail-feed.automation.json": "{}",
      "automations/bookmark-enrichment.automation.json": "{}",
      "automations/ship-a-change-pr-opened.automation.json": "{}", // a template's automation, not a bridge one
    });
    const r = resolveBridgeAutomationFiles({ catalogRoot: catalog });
    expect(r.dir).toBe(path.join(catalog, "automations"));
    expect(r.files).toEqual([
      path.join(catalog, "automations", "bookmark-enrichment.automation.json"),
      path.join(catalog, "automations", "mail-feed.automation.json"),
    ]);
    expect(r.missing).toEqual(["url-bookmark-capture"]);
  });

  it("no catalog: nothing to seed, every bridge automation missing", () => {
    for (const catalogRoot of [null, tree({ "automations/README.md": "no templates" })]) {
      const r = resolveBridgeAutomationFiles({ catalogRoot });
      expect(r.files).toEqual([]);
      expect(r.missing).toEqual([...BRIDGE_AUTOMATIONS]);
    }
  });

  it("the override seeds every *.automation.json in it; a missing override seeds nothing", () => {
    const catalog = tree({ "automations/mail-feed.automation.json": "{}" });
    const custom = tree({ "a.automation.json": "{}", "b.automation.json": "{}", "notes.md": "x" });
    const r = resolveBridgeAutomationFiles({ override: custom, catalogRoot: catalog });
    expect(r).toEqual({
      dir: custom,
      files: [path.join(custom, "a.automation.json"), path.join(custom, "b.automation.json")],
      missing: [],
    });
    expect(resolveBridgeAutomationFiles({ override: "/does/not/exist", catalogRoot: catalog })).toEqual({
      dir: null,
      files: [],
      missing: [],
    });
  });
});

describe("the INSTALLED catalog package ships everything the CLI reads from it", () => {
  it("every agency skill and every bridge automation", () => {
    const catalogRoot = resolveInstalledCatalogRoot();
    expect(catalogRoot, "the catalog package is a CLI dependency and must resolve").not.toBeNull();
    expect(resolveAgencySkillDirs({ cliSkillsDir: null, catalogRoot }).missing).toEqual([]);
    expect(resolveBridgeAutomationFiles({ catalogRoot }).missing).toEqual([]);
  });
});

describe("the readers go through these resolvers", () => {
  // Source scan: proves the call sites, not their runtime (the seeding needs a pod).
  const read = (f: string) => fs.readFileSync(path.join(process.cwd(), f), "utf8");
  it("bridge-setup: skills and automations", () => {
    const src = read("src/commands/bridge-setup.ts");
    expect(src).toMatch(/resolveAgencySkillDirs\(/);
    expect(src).toMatch(/resolveBridgeAutomationFiles\(/);
    expect(src).not.toMatch(/"templates", "automations"|templates\/automations/);
  });
  it("skill add bundled: the agency skills", () => {
    expect(read("src/commands/skill-manage.ts")).toMatch(/resolveAgencySkillDirs\(/);
  });
});
