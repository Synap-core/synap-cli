/**
 * synap skill — skill knowledge base commands
 *
 * Manage agent skills stored in the pod's agent_skills table.
 * Skills are structured knowledge packages shared across all agents.
 *
 * Commands:
 *   synap skill suggest <topic>   Search skills by topic/query
 *   synap skill get <slug>        Fetch a single skill by slug
 *   synap skill sync [--from]     Bulk import skills from local disk
 */

import chalk from "chalk";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { readFile } from "node:fs/promises";
import { log } from "../utils/logger.js";
import { resolveHubConfig, hubGet, hubPost } from "../lib/hub-client.js";
import type { HubConfig } from "../lib/hub-client.js";
import ora from "ora";

interface AgentSkill {
  id: string;
  slug: string;
  name: string;
  description: string | null;
  topics: string[];
  body: string;
  source: string | null;
  author: string | null;
  version: string | null;
  tags: string[];
  createdAt: string;
  updatedAt: string;
}

interface SkillOpts {
  podUrl?: string;
  apiKey?: string;
}

// ─── suggest ───────────────────────────────────────────────────────────────

export async function suggestSkills(topic: string, opts: SkillOpts): Promise<void> {
  try {
    const cfg = await resolveHubConfig(opts);

    const result = await hubGet(
      "/agent-skills",
      { topic, limit: 20 },
      cfg
    ) as { skills: AgentSkill[]; total: number };

    const skills = result.skills ?? [];

    if (skills.length === 0) {
      log.info(`No skills found for topic "${topic}".`);
      log.dim("Try: synap skill sync  — to import skills from ~/.claude/skills/");
      return;
    }

    log.heading(`Skills matching "${topic}" (${result.total} total)`);
    log.blank();

    for (const s of skills) {
      const tagStr = s.tags.length > 0 ? chalk.dim(` [${s.tags.slice(0, 3).join(", ")}${s.tags.length > 3 ? ", …" : ""}]`) : "";
      const desc = s.description ? chalk.dim(`  ${s.description}`) : "";
      console.log(`  ${chalk.bold(s.slug)}${tagStr}`);
      console.log(`    ${chalk.cyan(s.name)}${desc}`);
      const topicsStr = s.topics.length > 0 ? chalk.dim(`  topics: ${s.topics.join(", ")}`) : "";
      if (topicsStr) console.log(topicsStr);
      console.log();
    }

    log.dim("To view a skill body: synap skill get <slug>");
  } catch (e) {
    log.error("Error: " + (e as Error).message);
    process.exit(1);
  }
}

// ─── get ───────────────────────────────────────────────────────────────────

export async function getSkill(slug: string, opts: SkillOpts): Promise<void> {
  try {
    const cfg = await resolveHubConfig(opts);

    const skill = await hubGet(
      `/agent-skills/by-slug/${encodeURIComponent(slug)}`,
      {},
      cfg
    ) as AgentSkill;

    if (!skill || !skill.slug) {
      log.error(`Skill "${slug}" not found.`);
      log.dim("Try: synap skill suggest <topic>  — to find available skills");
      return;
    }

    log.heading(`${skill.name}  ${chalk.dim(`(${skill.slug})`)}`);
    log.blank();

    if (skill.description) {
      console.log(`  ${skill.description}`);
      log.blank();
    }

    if (skill.topics.length > 0) {
      console.log(`  ${chalk.dim("topics:")} ${skill.topics.join(", ")}`);
    }
    if (skill.tags.length > 0) {
      console.log(`  ${chalk.dim("tags:")} ${skill.tags.join(", ")}`);
    }
    if (skill.version) {
      console.log(`  ${chalk.dim("version:")} ${skill.version}`);
    }
    if (skill.author) {
      console.log(`  ${chalk.dim("author:")} ${skill.author}`);
    }
    log.blank();

    // Print the skill body
    console.log(skill.body);
    log.blank();
  } catch (e) {
    log.error("Error: " + (e as Error).message);
    process.exit(1);
  }
}

// ─── sync ──────────────────────────────────────────────────────────────────

/**
 * Sync skill files from local disk into the pod's agent_skills table.
 * Default source: ~/.claude/skills/ — each subdirectory with a SKILL.md
 * becomes one agent_skill row. Slug = directory name.
 */
export async function syncSkills(opts: SkillOpts & { from?: string }): Promise<void> {
  const skillsDir = opts.from ?? path.join(os.homedir(), ".claude", "skills");

  if (!fs.existsSync(skillsDir)) {
    log.error(`Skills directory not found: ${skillsDir}`);
    log.dim("Create skill files at ~/.claude/skills/<name>/SKILL.md");
    return;
  }

  const spinner = ora("Scanning skills directory...").start();

  const entries = fs.readdirSync(skillsDir, { withFileTypes: true });
  const skillDirs = entries.filter(
    (e) => e.isDirectory() || (e.isSymbolicLink() && fs.statSync(path.join(skillsDir, e.name)).isDirectory())
  );

  if (skillDirs.length === 0) {
    spinner.fail("No skill directories found");
    log.dim(`Each skill needs: ${skillsDir}/<slug>/SKILL.md`);
    return;
  }

  spinner.text = `Found ${skillDirs.length} skill(s)`;

  const cfg = await resolveHubConfig(opts);
  let imported = 0;
  let skipped = 0;
  let errors = 0;

  for (const dir of skillDirs) {
    const slug = dir.name;
    const skillPath = path.join(skillsDir, slug, "SKILL.md");
    const metaPath = path.join(skillsDir, slug, "meta.json");

    if (!fs.existsSync(skillPath)) {
      skipped++;
      continue;
    }

    try {
      const body = await readFile(skillPath, "utf-8");
      let name = slug;
      let description = "";
      let topics: string[] = [];
      let tags: string[] = [];
      let version = "";
      let author = "";

      // Read optional meta.json
      if (fs.existsSync(metaPath)) {
        try {
          const meta = JSON.parse(await readFile(metaPath, "utf-8"));
          name = meta.name ?? slug;
          description = meta.description ?? "";
          topics = meta.topics ?? [];
          tags = meta.tags ?? [];
          version = meta.version ?? "";
          author = meta.author ?? "";
        } catch {
          // non-fatal
        }
      }

      // Extract name from first heading if not from meta
      if (name === slug) {
        const firstLine = body.split("\n").find((l) => l.startsWith("# "));
        if (firstLine) name = firstLine.replace(/^#\s+/, "").trim();
      }

      await hubPost(
        "/agent-skills",
        {
          slug,
          name,
          description: description || null,
          topics,
          body,
          source: `file://${skillPath}`,
          author: author || os.userInfo().username,
          version: version || null,
          tags,
        },
        cfg
      );

      imported++;
      spinner.text = `Imported: ${slug}`;
    } catch (e) {
      const err = e as Error;
      // 409 = slug exists — skip
      if (err.message.includes("409")) {
        skipped++;
        continue;
      }
      errors++;
      spinner.text = `Error: ${slug} — ${err.message.slice(0, 80)}`;
    }
  }

  if (errors > 0) {
    spinner.warn(`Done: ${imported} imported, ${skipped} skipped, ${errors} errors`);
  } else {
    spinner.succeed(`Done: ${imported} imported, ${skipped} skipped`);
  }

  log.blank();
  log.dim("Try: synap skill suggest <topic>  — to search skills");
  log.dim("     synap skill get <slug>      — to view a skill");
}
