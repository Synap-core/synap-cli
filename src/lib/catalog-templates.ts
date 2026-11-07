/**
 * Where `synap bridge setup` and `synap skill add bundled` read catalog content.
 *
 * ONE source (founder, 5 Nov 2026): the agency skills and the bridge automations
 * live only in the catalog package (`@synap-core/catalog`, or
 * `@synap-core/workspace-templates` before the rename), as `skills/<name>/` and
 * `automations/*.automation.json`. The CLI reads them from the INSTALLED package
 * and keeps no copy. What stays under the CLI's `templates/` is not catalog
 * content: the runtime skills (`authoring-*`, `coordinating-*`, which have no
 * catalog twin) and the box runner (`templates/box/runner.py`, a program).
 *
 * `test/catalog-no-copy.tripwire.test.ts` fails on any CLI file that copies
 * catalog content, against the real installed package.
 */

import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { discoverSkillDirs } from "./skill-import.js";

/** Package names the catalog may be installed under (new name first). */
export const CATALOG_TEMPLATE_PACKAGES = ["@synap-core/catalog", "@synap-core/workspace-templates"] as const;

/**
 * The agency/domain skills whose home is the catalog. Every other bundled skill
 * is a CLI runtime skill. Pinned (not derived from the catalog) so the set
 * bridge-setup seeds does not grow because the catalog gained a skill.
 */
export const AGENCY_SKILLS = [
  "bookmark-enrichment",
  "mapping-the-server",
  "reading-client-progress",
  "routing-to-channels",
  "stellar-scf-grants-advisor",
] as const;

/**
 * The domain-agnostic automations bridge-setup seeds (`<name>.automation.json`
 * in the catalog's `automations/`). Pinned for the same reason as AGENCY_SKILLS.
 */
export const BRIDGE_AUTOMATIONS = ["bookmark-enrichment", "mail-feed", "url-bookmark-capture"] as const;

/**
 * Root directory of the installed catalog package, or null when none resolves.
 * Resolves the package's entry point and walks up to its package.json, because
 * older versions do not export `./package.json`.
 */
export function resolveInstalledCatalogRoot(
  resolve: (id: string) => string = createRequire(import.meta.url).resolve,
): string | null {
  for (const name of CATALOG_TEMPLATE_PACKAGES) {
    let entry: string;
    try {
      entry = resolve(name);
    } catch {
      continue; // not installed under this name
    }
    for (let dir = path.dirname(entry); dir !== path.dirname(dir); dir = path.dirname(dir)) {
      const pj = path.join(dir, "package.json");
      if (!fs.existsSync(pj)) continue;
      if ((JSON.parse(fs.readFileSync(pj, "utf8")) as { name?: string }).name === name) return dir;
    }
  }
  return null;
}

function catalogSkillDir(catalogRoot: string | null, name: string): string | null {
  if (!catalogRoot) return null;
  const dir = path.join(catalogRoot, "skills", name);
  return fs.existsSync(path.join(dir, "SKILL.md")) ? dir : null;
}

function catalogAutomationFiles(catalogRoot: string | null): string[] {
  const dir = catalogRoot ? path.join(catalogRoot, "automations") : null;
  if (!dir || !fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((f) => f.endsWith(".automation.json"));
}

/**
 * The SKILL.md directories to seed: every CLI runtime skill, plus each agency
 * skill from the installed catalog. An agency skill the catalog does not ship is
 * named in `missing` (never taken from anywhere else). `fromCatalog` names the
 * skills read from the catalog.
 */
export function resolveAgencySkillDirs(opts: {
  cliSkillsDir: string | null;
  catalogRoot: string | null;
}): { dirs: string[]; fromCatalog: string[]; missing: string[] } {
  const agency = new Set<string>(AGENCY_SKILLS);
  const dirs: string[] = [];
  const fromCatalog: string[] = [];
  const missing: string[] = [];
  const cliDirs = opts.cliSkillsDir ? discoverSkillDirs(opts.cliSkillsDir) : [];
  for (const cliDir of cliDirs) if (!agency.has(path.basename(cliDir))) dirs.push(cliDir);
  for (const name of AGENCY_SKILLS) {
    const fromPkg = catalogSkillDir(opts.catalogRoot, name);
    if (fromPkg) {
      dirs.push(fromPkg);
      fromCatalog.push(name);
    } else missing.push(name);
  }
  return { dirs, fromCatalog, missing };
}

/**
 * The automation files bridge-setup seeds. With `override` (AUTOMATION_TEMPLATES_DIR)
 * set: every `*.automation.json` in it (`dir` null when it does not exist).
 * Otherwise each BRIDGE_AUTOMATIONS file from the installed catalog's
 * `automations/`; one the catalog does not ship is named in `missing` (never
 * taken from anywhere else). The catalog's other automations (e.g. `ship-a-change-*`)
 * belong to the templates that declare them and are never seeded here.
 */
export function resolveBridgeAutomationFiles(opts: {
  override?: string;
  catalogRoot: string | null;
}): { dir: string | null; files: string[]; missing: string[] } {
  if (opts.override) {
    if (!fs.existsSync(opts.override)) return { dir: null, files: [], missing: [] };
    const files = fs
      .readdirSync(opts.override)
      .filter((f) => f.endsWith(".automation.json"))
      .sort()
      .map((f) => path.join(opts.override!, f));
    return { dir: opts.override, files, missing: [] };
  }
  const shipped = new Set(catalogAutomationFiles(opts.catalogRoot));
  const dir = opts.catalogRoot ? path.join(opts.catalogRoot, "automations") : null;
  const files: string[] = [];
  const missing: string[] = [];
  for (const name of BRIDGE_AUTOMATIONS) {
    const file = `${name}.automation.json`;
    if (dir && shipped.has(file)) files.push(path.join(dir, file));
    else missing.push(name);
  }
  return { dir, files, missing };
}
