/**
 * Where `synap bridge setup` reads the agency skills and the bridge automations.
 *
 * Their home is the catalog package (`@synap-core/catalog`, or
 * `@synap-core/workspace-templates` before the rename): `skills/<name>/SKILL.md`
 * and `automations/*.automation.json`. The CLI keeps copies under `templates/`
 * for installs whose catalog package does not ship them yet. Resolution is per
 * item: the INSTALLED package wins when it ships the item, the CLI copy is the
 * fallback. The runtime skills (`authoring-*`, `coordinating-*`) have no catalog
 * copy and always come from the CLI.
 *
 * Retirement: once the installed package ships an item, its CLI copy is dead
 * weight that can silently fork. `catalogRetirementViolations` names those
 * copies; `test/catalog-templates.test.ts` fails on any, so the pin bump that
 * brings them in also deletes the CLI copies.
 */

import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
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

/** `<cli package root>/templates` (same depth from `src/lib` and `dist/lib`). */
export const CLI_TEMPLATES_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "templates");

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
 * The SKILL.md directories bridge-setup seeds: each agency skill from the
 * installed catalog when it ships it, else from the CLI; plus every CLI runtime
 * skill. `fromCatalog` names the skills read from the catalog.
 */
export function resolveAgencySkillDirs(opts: {
  cliSkillsDir: string | null;
  catalogRoot: string | null;
}): { dirs: string[]; fromCatalog: string[] } {
  const agency = new Set<string>(AGENCY_SKILLS);
  const dirs: string[] = [];
  const fromCatalog: string[] = [];
  const cliDirs = opts.cliSkillsDir ? discoverSkillDirs(opts.cliSkillsDir) : [];
  for (const cliDir of cliDirs) if (!agency.has(path.basename(cliDir))) dirs.push(cliDir);
  for (const name of AGENCY_SKILLS) {
    const fromPkg = catalogSkillDir(opts.catalogRoot, name);
    if (fromPkg) {
      dirs.push(fromPkg);
      fromCatalog.push(name);
      continue;
    }
    const cliDir = cliDirs.find((d) => path.basename(d) === name);
    if (cliDir) dirs.push(cliDir);
  }
  return { dirs, fromCatalog };
}

/**
 * The automation templates directory: the `override` (AUTOMATION_TEMPLATES_DIR)
 * when set (null if it does not exist), else the installed catalog's
 * `automations/` when it ships any `*.automation.json`, else the CLI copy.
 */
export function resolveAutomationTemplatesDir(opts: {
  override?: string;
  catalogRoot: string | null;
  cliDir: string;
}): string | null {
  if (opts.override) return fs.existsSync(opts.override) ? opts.override : null;
  if (opts.catalogRoot && catalogAutomationFiles(opts.catalogRoot).length > 0)
    return path.join(opts.catalogRoot, "automations");
  return fs.existsSync(opts.cliDir) ? opts.cliDir : null;
}

/**
 * CLI copies the installed catalog makes redundant, as paths relative to the CLI
 * package root (`templates/skills/<name>`, `templates/automations/<file>`).
 */
export function catalogRetirementViolations(catalogRoot: string | null, cliTemplatesDir: string): string[] {
  const out: string[] = [];
  for (const name of AGENCY_SKILLS)
    if (catalogSkillDir(catalogRoot, name) && fs.existsSync(path.join(cliTemplatesDir, "skills", name)))
      out.push(`templates/skills/${name}`);
  for (const file of catalogAutomationFiles(catalogRoot))
    if (fs.existsSync(path.join(cliTemplatesDir, "automations", file))) out.push(`templates/automations/${file}`);
  return out;
}
