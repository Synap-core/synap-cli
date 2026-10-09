/**
 * TRANSITION TRIPWIRE: the CLI's agency/domain template copies are MIRRORS of
 * the ONE catalog (`synap-app/packages/workspace-templates`, later
 * `packages/catalog`).
 *
 * The agency/domain skills (`templates/skills/<name>/`, with every reference
 * file) and the bridge-setup automations (`templates/automations/*.automation.json`)
 * now live in the catalog (`skills/<name>/`, `automations/`). The CLI keeps its
 * copies only until the catalog package is published and the CLI pin bumped
 * (deploy steps), because `bridge-setup` still reads them from here. Until then
 * an edit on ONE side silently forks the two, so this test requires the files
 * to be byte-identical, in both directions (a file added on either side is a
 * difference).
 *
 * The runtime skills (`authoring-*`, `coordinating-*`) stay in the CLI and have
 * no catalog copy; the shared set is pinned below so a folder moving in or out
 * is a visible decision, not a silent one.
 *
 * Skips, with the reason logged, when the sibling synap-app checkout is absent.
 *
 * RETIRES when the CLI's local copies are deleted (bridge-setup then installs
 * the published catalog entries): delete this file in that same change.
 */

import { describe, it, expect } from "vitest";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const CLI = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PACKAGES = path.resolve(CLI, "..", "synap-app", "packages");
const CATALOG = ["catalog", "workspace-templates"]
  .map((d) => path.join(PACKAGES, d))
  .find((d) => fs.existsSync(path.join(d, "skills")) && fs.existsSync(path.join(d, "automations")));
const CLI_SKILLS = path.join(CLI, "templates", "skills");
const CLI_AUTOMATIONS = path.join(CLI, "templates", "automations");

if (!CATALOG)
  console.warn(`[catalog-mirror] SKIP: no catalog checkout with skills/ + automations/ under ${PACKAGES}`);

/** The agency/domain skill folders that moved to the catalog (catalog-M.md). */
const SHARED_SKILLS = [
  "bookmark-enrichment",
  "mapping-the-server",
  "reading-client-progress",
  "routing-to-channels",
  "stellar-scf-grants-advisor",
];

/** Every file under `dir`, relative, sorted (`.DS_Store` ignored). */
function filesUnder(dir: string): string[] {
  return (fs.readdirSync(dir, { recursive: true }) as string[])
    .filter((rel) => fs.statSync(path.join(dir, rel)).isFile() && path.basename(rel) !== ".DS_Store")
    .sort();
}

/** Differences between two trees: missing on either side, or differing bytes. */
function treeDiff(a: string, b: string): string[] {
  const fa = filesUnder(a);
  const fb = filesUnder(b);
  const out: string[] = [];
  for (const f of fa) if (!fb.includes(f)) out.push(`only in CLI: ${f}`);
  for (const f of fb) if (!fa.includes(f)) out.push(`only in catalog: ${f}`);
  for (const f of fa.filter((x) => fb.includes(x)))
    if (!fs.readFileSync(path.join(a, f)).equals(fs.readFileSync(path.join(b, f)))) out.push(`differs: ${f}`);
  return out;
}

describe.skipIf(!CATALOG)("catalog mirror — CLI template copies equal the catalog", () => {
  const cliSkillDirs = fs.readdirSync(CLI_SKILLS).filter((d) => fs.statSync(path.join(CLI_SKILLS, d)).isDirectory());
  const catalogSkillDirs = CATALOG
    ? fs.readdirSync(path.join(CATALOG, "skills")).filter((d) => fs.statSync(path.join(CATALOG, "skills", d)).isDirectory())
    : [];

  it("non-vacuity: the shared set is exactly the moved folders, and the differ sees a difference", () => {
    expect(cliSkillDirs.filter((d) => catalogSkillDirs.includes(d)).sort()).toEqual(SHARED_SKILLS);
    expect(filesUnder(path.join(CLI_SKILLS, "stellar-scf-grants-advisor")).length).toBeGreaterThanOrEqual(20);
    // self-check against two real, different folders
    expect(treeDiff(path.join(CLI_SKILLS, "mapping-the-server"), path.join(CLI_SKILLS, "routing-to-channels"))).toEqual([
      "differs: SKILL.md",
    ]);
  });

  it("every shared skill folder is byte-identical, file by file, both directions", () => {
    const diffs = SHARED_SKILLS.flatMap((s) =>
      treeDiff(path.join(CLI_SKILLS, s), path.join(CATALOG!, "skills", s)).map((d) => `${s}: ${d}`),
    );
    expect(diffs).toEqual([]);
  });

  it("every bundled automation template is byte-identical to the catalog's copy", () => {
    const files = fs.readdirSync(CLI_AUTOMATIONS).filter((f) => f.endsWith(".automation.json"));
    expect(files.length).toBeGreaterThanOrEqual(3);
    const diffs = files.filter((f) => {
      const c = path.join(CATALOG!, "automations", f);
      return !fs.existsSync(c) || !fs.readFileSync(c).equals(fs.readFileSync(path.join(CLI_AUTOMATIONS, f)));
    });
    expect(diffs).toEqual([]);
  });
});
