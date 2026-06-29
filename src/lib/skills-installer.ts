/**
 * Skill installer — copies the synap skill tree into a target's skills directory.
 *
 * Source resolution order:
 *   1. $SYNAP_SKILLS_DIR (explicit override)
 *   2. adjacent ../synap-backend/skills/ (monorepo dev mode)
 *   3. bundled skills/ inside this package (production / published npm)
 *   4. fetch from a published tarball (fallback — not yet implemented)
 *
 * If none resolve, prints a manual install command and returns false.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { log } from "../utils/logger.js";

export const SKILL_NAMES = ["synap", "synap-schema", "synap-ui", "onboard", "agent-os"] as const;
export type SkillName = (typeof SKILL_NAMES)[number];

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/** Full deliverable set from manifest.json (baseline ++ workflow), with fallback to SKILL_NAMES. */
export function getDeliverableSkills(): string[] {
  const srcDir = resolveSkillsSource();
  if (srcDir) {
    const manifestPath = path.join(srcDir, "manifest.json");
    try {
      const raw = fs.readFileSync(manifestPath, "utf8");
      const manifest = JSON.parse(raw) as { baseline?: string[]; workflow?: string[] };
      const baseline = Array.isArray(manifest.baseline) ? manifest.baseline : [];
      const workflow = Array.isArray(manifest.workflow) ? manifest.workflow : [];
      const all = [...baseline, ...workflow];
      if (all.length > 0) return all;
    } catch {
      // manifest absent or malformed — fall through to hardcoded list
    }
  }
  return [...SKILL_NAMES];
}

export interface InstallOpts {
  destDir: string;
  skills?: readonly string[];
}

export async function installSkills(opts: InstallOpts): Promise<boolean> {
  const srcDir = resolveSkillsSource();
  if (!srcDir) {
    log.warn("Could not locate skills source.");
    log.dim("Set SYNAP_SKILLS_DIR to the folder containing synap/, synap-schema/, synap-ui/");
    log.dim("Or clone: git clone https://github.com/Synap-core/synap.git");
    log.dim(`Then copy synap/synap-backend/skills/* → ${opts.destDir}/`);
    return false;
  }

  const skills = opts.skills ?? getDeliverableSkills();
  let installed = 0;
  for (const name of skills) {
    const src = path.join(srcDir, name);
    if (!fs.existsSync(src)) {
      log.warn(`Skill '${name}' not found in source (skipping)`);
      continue;
    }
    const dst = path.join(opts.destDir, name);
    copyDir(src, dst);
    installed++;
    log.success(`Installed ${name} → ${shortenHome(dst)}`);
  }

  if (installed === 0) {
    log.error("No skills were installed.");
    return false;
  }
  return true;
}

function resolveSkillsSource(): string | null {
  // 1. Explicit override
  const override = process.env.SYNAP_SKILLS_DIR;
  if (override && fs.existsSync(override)) {
    return override;
  }

  // 2. Monorepo dev mode — ../synap-backend/skills/ relative to CLI source
  //    __dirname is .../synap-cli/dist/lib OR .../synap-cli/src/lib
  const candidates = [
    path.resolve(__dirname, "..", "..", "..", "synap-backend", "skills"),
    path.resolve(__dirname, "..", "..", "..", "..", "synap-backend", "skills"),
  ];
  for (const c of candidates) {
    if (fs.existsSync(path.join(c, "synap", "SKILL.md"))) {
      return c;
    }
  }

  // 3. Bundled inside the package — synap-cli/skills/
  const bundled = path.resolve(__dirname, "..", "..", "skills");
  if (fs.existsSync(path.join(bundled, "synap", "SKILL.md"))) {
    return bundled;
  }

  // 4. TODO: remote fetch fallback
  return null;
}

function copyDir(src: string, dst: string): void {
  fs.mkdirSync(dst, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, entry.name);
    const d = path.join(dst, entry.name);
    if (entry.isDirectory()) {
      copyDir(s, d);
    } else if (entry.isFile()) {
      fs.copyFileSync(s, d);
      // preserve executable bit for .sh
      if (entry.name.endsWith(".sh")) {
        try {
          fs.chmodSync(d, 0o755);
        } catch {
          // best effort
        }
      }
    }
  }
}

function shortenHome(p: string): string {
  const home = process.env.HOME ?? "";
  return home && p.startsWith(home) ? p.replace(home, "~") : p;
}
