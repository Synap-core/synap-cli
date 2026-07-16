/**
 * Skill installer — copies the synap skill tree into a target's skills directory.
 *
 * Source resolution order:
 *   1. $SYNAP_SKILLS_DIR (explicit override) or an adjacent ../synap-backend/skills/
 *      checkout (monorepo dev mode) — both are local disk, dev escape hatches.
 *   2. the connected pod — GET /api/hub/skills/system (pod-first: production
 *      users get whatever skill packages their pod actually serves, not a
 *      snapshot baked into this CLI's npm release).
 *   3. bundled skills/ inside this package (production / published npm,
 *      offline, or pod unreachable).
 *
 * If none resolve, prints a manual install command and returns false.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { log } from "../utils/logger.js";
import { resolveHubConfig } from "./hub-client.js";

/** Last-resort constant — only used when no manifest.json can be found on
 *  disk (dev or bundled) AND the pod is unreachable/unconfigured. */
export const SKILL_NAMES = ["synap", "synap-schema", "synap-ui"] as const;
export type SkillName = (typeof SKILL_NAMES)[number];

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

interface SkillFile {
  path: string;
  content: string;
}
interface SkillPackage {
  slug: string;
  files: SkillFile[];
}

/**
 * Baseline skills are safe to install into every agent context. Workflow
 * packages are intentionally loaded only when the target/user asks for them;
 * installing them by default turns progressive teaching back into prompt bulk.
 */
export function getDeliverableSkills(): string[] {
  const srcDir = resolveDiskSource();
  if (srcDir) {
    const manifestPath = path.join(srcDir, "manifest.json");
    try {
      const raw = fs.readFileSync(manifestPath, "utf8");
      const manifest = JSON.parse(raw) as { baseline?: string[] };
      const baseline = Array.isArray(manifest.baseline) ? manifest.baseline : [];
      if (baseline.length > 0) return baseline;
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
  // 1. Local disk source — explicit override or monorepo dev checkout.
  const diskSrc = resolveDiskSource();
  if (diskSrc) {
    log.dim("Skill source: local disk");
    return installFromDisk(diskSrc, opts);
  }

  // 2. The connected pod.
  const podPackages = await fetchSkillsFromPod();
  if (podPackages && podPackages.length > 0) {
    const names = opts.skills ?? getDeliverableSkills();
    const installed = installFromPackages(podPackages, names, opts.destDir);
    if (installed > 0) {
      log.dim("Skill source: pod (/api/hub/skills/system)");
      return true;
    }
  }

  // 3. Bundled fallback inside this package.
  const bundledSrc = resolveBundledSource();
  if (bundledSrc) {
    log.dim("Skill source: bundled fallback");
    return installFromDisk(bundledSrc, opts);
  }

  log.warn("Could not locate skills source.");
  log.dim("Set SYNAP_SKILLS_DIR to the folder containing synap/, synap-schema/, synap-ui/");
  log.dim("Or connect a pod: synap pods add");
  log.dim("Or clone: git clone https://github.com/Synap-core/synap.git");
  log.dim(`Then copy synap/synap-backend/skills/* → ${opts.destDir}/`);
  return false;
}

/** Fetch the pod's system skill packages over Hub Protocol. Returns null on
 *  any failure (no pod configured, unreachable, non-2xx, bad payload) so
 *  installSkills() can fall through to the bundled tier gracefully. */
async function fetchSkillsFromPod(): Promise<SkillPackage[] | null> {
  try {
    const cfg = await resolveHubConfig();
    if (!cfg.podUrl || !cfg.apiKey) return null;
    const res = await fetch(`${cfg.podUrl}/api/hub/skills/system?scope=full`, {
      headers: { Authorization: `Bearer ${cfg.apiKey}` },
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) return null;
    const data = (await res.json()) as unknown;
    if (!Array.isArray(data)) return null;
    return data as SkillPackage[];
  } catch {
    return null;
  }
}

/** Write the requested packages' files to destDir, same on-disk layout as
 *  installFromDisk (destDir/<slug>/<file>). Returns count installed. */
function installFromPackages(
  packages: SkillPackage[],
  names: readonly string[],
  destDir: string
): number {
  let installed = 0;
  for (const name of names) {
    const pkg = packages.find((p) => p.slug === name);
    if (!pkg || pkg.files.length === 0) {
      log.warn(`Skill '${name}' not found on pod (skipping)`);
      continue;
    }
    const dst = resolveWithin(destDir, name);
    if (!dst) {
      log.warn(`Skill '${name}' has an unsafe destination (skipping)`);
      continue;
    }
    fs.mkdirSync(dst, { recursive: true });
    for (const file of pkg.files) {
      const filePath = resolveWithin(dst, file.path);
      if (!filePath) {
        log.warn(`Skill '${name}' contains unsafe file path '${file.path}' (skipping)`);
        continue;
      }
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      fs.writeFileSync(filePath, file.content, "utf8");
    }
    installed++;
    log.success(`Installed ${name} → ${shortenHome(dst)}`);
  }
  return installed;
}

/** Resolve a pod-supplied package/file name without allowing directory escape. */
function resolveWithin(root: string, relativePath: string): string | null {
  if (!relativePath || path.isAbsolute(relativePath)) return null;
  const rootPath = path.resolve(root);
  const target = path.resolve(rootPath, relativePath);
  return target.startsWith(rootPath + path.sep) ? target : null;
}

function installFromDisk(srcDir: string, opts: InstallOpts): boolean {
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

/** Explicit override ($SYNAP_SKILLS_DIR) or the adjacent ../synap-backend/skills/
 *  checkout (monorepo dev mode). Both are local-disk, dev-only escape hatches. */
function resolveDiskSource(): string | null {
  const override = process.env.SYNAP_SKILLS_DIR;
  if (override && fs.existsSync(override)) {
    return override;
  }

  // __dirname is .../synap-cli/dist/lib OR .../synap-cli/src/lib
  const candidates = [
    path.resolve(__dirname, "..", "..", "..", "synap-backend", "skills"),
    path.resolve(__dirname, "..", "..", "..", "..", "synap-backend", "skills"),
  ];
  for (const c of candidates) {
    if (fs.existsSync(path.join(c, "synap", "SKILL.md"))) {
      return c;
    }
  }
  return null;
}

/** Bundled inside the package — synap-cli/skills/ (production / published npm). */
function resolveBundledSource(): string | null {
  const bundled = path.resolve(__dirname, "..", "..", "skills");
  if (fs.existsSync(path.join(bundled, "synap", "SKILL.md"))) {
    return bundled;
  }
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
