/**
 * Skill import — read standard SKILL.md skill directories and push them to the pod.
 *
 * Follows the Agent Skills open standard (agentskills.io): a skill is a DIRECTORY
 * with a `SKILL.md` at its root (YAML frontmatter + markdown body) and optional
 * `references/` files loaded on demand. This is the same format Claude Code,
 * Codex, Gemini CLI, Copilot and others use — so a Synap skill is portable, and
 * users can import any standard skill (incl. their own ~/.claude/skills/).
 *
 * The pod stores them via POST /agent-skills/import: the SKILL.md body becomes
 * the instruction skill, each references/ file becomes a linked document.
 */

import fs from "node:fs";
import path from "node:path";
import { hubPost, type HubConfig } from "./hub-client.js";

export interface ParsedSkill {
  slug: string;
  name: string;
  description: string;
  body: string;
  /** auto_load=true → always-loaded core DNA; false → on-demand (catalog + load_skill). */
  autoLoad: boolean;
  documents: Array<{ title: string; content: string; type: string }>;
}

/**
 * Minimal YAML frontmatter parser for SKILL.md. The frontmatter is intentionally
 * simple (name, description, a flat `metadata:` block) so we avoid a YAML dep.
 */
function parseFrontmatter(raw: string): {
  fm: Record<string, string>;
  body: string;
} {
  if (!raw.startsWith("---")) return { fm: {}, body: raw };
  const end = raw.indexOf("\n---", 3);
  if (end === -1) return { fm: {}, body: raw };
  const fmBlock = raw.slice(3, end).trim();
  const body = raw.slice(end + 4).replace(/^\s*\n/, "");

  const fm: Record<string, string> = {};
  for (const line of fmBlock.split("\n")) {
    // Flatten nested metadata keys (e.g. "  auto_load: true") to their leaf key.
    const m = line.match(/^\s*([a-zA-Z0-9_-]+):\s*(.*)$/);
    if (m && m[2] !== "") fm[m[1].trim()] = m[2].trim().replace(/^["']|["']$/g, "");
  }
  return { fm, body };
}

/** Parse a single SKILL.md skill directory into an import payload. */
export function parseSkillDir(dir: string): ParsedSkill | null {
  const skillMd = path.join(dir, "SKILL.md");
  if (!fs.existsSync(skillMd)) return null;

  const raw = fs.readFileSync(skillMd, "utf-8");
  const { fm, body } = parseFrontmatter(raw);

  const slug = fm.name || path.basename(dir);
  const name = fm.name || slug;
  const description = fm.description || "";
  const autoLoad = fm.auto_load === "true";

  // references/ → documents (loaded on demand by the agent via get_document)
  const documents: ParsedSkill["documents"] = [];
  const refDir = path.join(dir, "references");
  if (fs.existsSync(refDir)) {
    for (const file of fs.readdirSync(refDir)) {
      const full = path.join(refDir, file);
      if (fs.statSync(full).isFile()) {
        documents.push({
          title: `references/${file}`,
          content: fs.readFileSync(full, "utf-8"),
          type: "markdown",
        });
      }
    }
  }

  return { slug, name, description, body: body.trim(), autoLoad, documents };
}

/** Find every skill directory (one containing SKILL.md) under a root, one level deep. */
export function discoverSkillDirs(root: string): string[] {
  if (!fs.existsSync(root)) return [];
  // The root itself may be a single skill dir.
  if (fs.existsSync(path.join(root, "SKILL.md"))) return [root];
  const out: string[] = [];
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const full = path.join(root, entry.name);
    const isDir =
      entry.isDirectory() ||
      (entry.isSymbolicLink() && fs.statSync(full).isDirectory());
    if (isDir && fs.existsSync(path.join(full, "SKILL.md"))) out.push(full);
  }
  return out;
}

export interface ImportResult {
  slug: string;
  status: "imported" | "exists" | "error";
  docs: number;
  error?: string;
}

/** Import a parsed skill into the pod via POST /agent-skills/import. */
export async function importSkill(
  parsed: ParsedSkill,
  userId: string,
  cfg: HubConfig
): Promise<ImportResult> {
  try {
    const res = (await hubPost(
      "/agent-skills/import",
      {
        userId,
        skill: {
          slug: parsed.slug,
          name: parsed.name,
          description: parsed.description,
          body: parsed.body,
          autoLoad: parsed.autoLoad,
        },
        documents: parsed.documents,
      },
      cfg
    )) as { skill?: { id: string }; documents?: unknown[]; error?: string };

    if (res.error && /already exists/i.test(res.error)) {
      return { slug: parsed.slug, status: "exists", docs: 0 };
    }
    if (res.skill) {
      return {
        slug: parsed.slug,
        status: "imported",
        docs: res.documents?.length ?? 0,
      };
    }
    return {
      slug: parsed.slug,
      status: "error",
      docs: 0,
      error: res.error ?? "unknown",
    };
  } catch (err) {
    return {
      slug: parsed.slug,
      status: "error",
      docs: 0,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
