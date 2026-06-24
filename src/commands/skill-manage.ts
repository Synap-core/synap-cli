/**
 * synap skill add / list / remove — manage instruction skills on the pod.
 *
 * Skills follow the Agent Skills open standard (SKILL.md directories), so users
 * can add skills from many sources — the bundled Synap-native set, a local
 * folder, their existing ~/.claude/skills/, or any GitHub repo — and the agent
 * loads them. One dedicated command, not buried in bridge-setup.
 */

import os from "node:os";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import chalk from "chalk";
import ora from "ora";
import { log } from "../utils/logger.js";
import {
  resolveHubConfig,
  resolveUserId,
  hubGet,
  hubDelete,
} from "../lib/hub-client.js";
import {
  discoverSkillDirs,
  parseSkillDir,
  importSkill,
} from "../lib/skill-import.js";
import { resolveBundledSkillsDir } from "./bridge-setup.js";

interface SkillManageOpts {
  podUrl?: string;
  apiKey?: string;
}

/** Expand ~ and resolve a local path. */
function expandPath(p: string): string {
  if (p.startsWith("~")) return path.join(os.homedir(), p.slice(1));
  return path.resolve(p);
}

/** GitHub `owner/repo` (and `owner/repo/skill`) shorthand — no dots, no leading ./ or ~. */
function parseGitHubShorthand(
  source: string
): { repo: string; skill?: string; ref?: string } | null {
  if (source.startsWith(".") || source.startsWith("/") || source.startsWith("~"))
    return null;
  if (source.startsWith("http") || source.startsWith("git@")) return null;
  const [pathPart, ref] = source.split("@");
  const parts = pathPart.split("/").filter(Boolean);
  if (parts.length < 2) return null;
  return {
    repo: `${parts[0]}/${parts[1]}`,
    skill: parts.length > 2 ? parts.slice(2).join("/") : undefined,
    ref,
  };
}

/**
 * Resolve a source to a list of SKILL.md directories on local disk.
 * Returns { dirs, cleanup } — cleanup removes any temp clone.
 */
function resolveSource(source: string): { dirs: string[]; cleanup?: () => void } {
  // 1. Bundled Synap-native skills
  if (source === "bundled" || source === "synap") {
    const dir = resolveBundledSkillsDir();
    if (!dir) throw new Error("Bundled skills not found in this CLI install");
    return { dirs: discoverSkillDirs(dir) };
  }

  // 2. Local path (incl. ~/.claude/skills/)
  if (source.startsWith(".") || source.startsWith("/") || source.startsWith("~")) {
    const abs = expandPath(source);
    if (!fs.existsSync(abs)) throw new Error(`Path not found: ${abs}`);
    return { dirs: discoverSkillDirs(abs) };
  }

  // 3. GitHub shorthand or full git URL → shallow clone to a temp dir
  const gh = parseGitHubShorthand(source);
  const cloneUrl = gh
    ? `https://github.com/${gh.repo}.git`
    : source.startsWith("http") || source.startsWith("git@")
      ? source
      : null;
  if (cloneUrl) {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "synap-skill-"));
    const args = ["clone", "--depth", "1"];
    if (gh?.ref) args.push("--branch", gh.ref);
    args.push(cloneUrl, tmp);
    try {
      execFileSync("git", args, { stdio: "pipe" });
    } catch (err) {
      fs.rmSync(tmp, { recursive: true, force: true });
      throw new Error(`git clone failed: ${(err as Error).message}`);
    }
    const root = gh?.skill ? path.join(tmp, gh.skill) : tmp;
    return {
      dirs: discoverSkillDirs(root),
      cleanup: () => fs.rmSync(tmp, { recursive: true, force: true }),
    };
  }

  throw new Error(
    `Unrecognized source "${source}". Use: bundled · a local path · ~/.claude/skills/ · owner/repo · a git URL.`
  );
}

/** synap skill add <source> */
export async function addSkill(
  source: string,
  opts: SkillManageOpts
): Promise<void> {
  const cfg = await resolveHubConfig(opts);
  const userId = await resolveUserId(cfg);

  let resolved: { dirs: string[]; cleanup?: () => void };
  try {
    resolved = resolveSource(source);
  } catch (err) {
    log.error((err as Error).message);
    process.exit(1);
  }

  if (resolved.dirs.length === 0) {
    log.warn(`No SKILL.md skill directories found in "${source}".`);
    resolved.cleanup?.();
    return;
  }

  const spinner = ora(`Importing ${resolved.dirs.length} skill(s)…`).start();
  let imported = 0,
    existed = 0,
    errored = 0;
  const lines: string[] = [];

  for (const dir of resolved.dirs) {
    const parsed = parseSkillDir(dir);
    if (!parsed) continue;
    const res = await importSkill(parsed, userId, cfg);
    if (res.status === "imported") {
      imported++;
      lines.push(
        `  ${chalk.green("✓")} ${parsed.slug}${res.docs ? chalk.dim(` · ${res.docs} docs`) : ""}${parsed.autoLoad ? chalk.dim(" · core") : ""}`
      );
    } else if (res.status === "exists") {
      existed++;
      lines.push(`  ${chalk.dim("•")} ${chalk.dim(parsed.slug + " (already on pod)")}`);
    } else {
      errored++;
      lines.push(`  ${chalk.red("✗")} ${parsed.slug} — ${chalk.red(res.error ?? "error")}`);
    }
  }

  resolved.cleanup?.();
  spinner.stop();
  lines.forEach((l) => console.log(l));
  log.success(
    `Added ${imported} skill(s)${existed ? `, ${existed} already present` : ""}${errored ? chalk.red(`, ${errored} failed`) : ""}.`
  );
}

/** synap skill list */
export async function listSkills(opts: SkillManageOpts): Promise<void> {
  const cfg = await resolveHubConfig(opts);
  const userId = await resolveUserId(cfg);
  // The executable route returns ALL skills (instruction + code) with kind and metadata.
  // The doc-style /agent-skills route only returns a subset and has empty slugs for legacy rows.
  const res = (await hubGet(
    `/agent-skills/executable?userId=${encodeURIComponent(userId)}&status=active&approved=true`,
    {},
    cfg
  )) as Array<{
    name: string;
    description?: string;
    kind?: string;
    metadata?: { autoLoad?: boolean };
    body?: string;
    code?: string;
  }>;
  const skills = Array.isArray(res) ? res : [];
  const core = skills.filter((s) => s.metadata?.autoLoad === true);
  const onDemand = skills.filter((s) => s.metadata?.autoLoad !== true);

  if (skills.length === 0) {
    log.dim("No skills on the pod yet. Add some: synap skill add bundled");
    return;
  }

  const summary = `${skills.length} total (${core.length} core auto-load, ${onDemand.length} on-demand)`;
  console.log(chalk.bold(`\nSkills on your pod — ${summary}\n`));

  const print = (skills: typeof core, badge: string) => {
    for (const s of skills) {
      const slug = s.name;
      const kind = s.kind ?? (s.body ? "instruction" : s.code ? "code" : "?");
      const desc = s.description?.slice(0, 120) ?? "";
      console.log(`  ${chalk.cyan(slug.padEnd(42))} ${chalk.dim(kind)}  ${badge}`);
      if (desc) console.log(`  ${" ".repeat(42)} ${chalk.dim(desc)}`);
    }
  };

  if (core.length > 0) {
    console.log(chalk.bold("Core (auto-injected every turn)"));
    print(core, chalk.green("● core"));
  }
  if (onDemand.length > 0) {
    if (core.length > 0) console.log("");
    console.log(chalk.bold("On-demand (catalog — agent calls load_skill when relevant)"));
    print(onDemand, chalk.yellow("○ on-demand"));
  }
  console.log("");
}

/** synap skill remove <slug> */
export async function removeSkill(
  slug: string,
  opts: SkillManageOpts
): Promise<void> {
  const cfg = await resolveHubConfig(opts);
  // Resolve slug → id, then delete by id.
  let id: string;
  try {
    const skill = (await hubGet(
      `/agent-skills/by-slug/${encodeURIComponent(slug)}`,
      {},
      cfg
    )) as { id?: string };
    if (!skill.id) {
      log.error(`No skill found with slug "${slug}".`);
      process.exit(1);
    }
    id = skill.id;
  } catch {
    log.error(`No skill found with slug "${slug}".`);
    process.exit(1);
  }
  await hubDelete(`/agent-skills/${id}`, cfg);
  log.success(`Removed skill "${slug}".`);
}
