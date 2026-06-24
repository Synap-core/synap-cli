/**
 * Skill import — read standard SKILL.md skill directories and push them to the pod.
 *
 * Follows the Agent Skills open standard (agentskills.io): a skill is a DIRECTORY
 * with a `SKILL.md` at its root (YAML frontmatter + markdown body) and optional
 * nested files/subdirs for reference docs, examples, templates, and code. Every
 * non-SKILL.md file becomes a linked document (the agent reads them on demand via
 * get_document). This is the same format Claude Code, Codex, Gemini CLI, Copilot
 * and others use.
 *
 * The pod stores them via POST /agent-skills/import: the SKILL.md body becomes
 * the instruction skill, every other file becomes a linked document.
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
  documents: Array<{ title: string; content: string; type: string; language?: string }>;
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
    const m = line.match(/^\s*([a-zA-Z0-9_-]+):\s*(.*)$/);
    if (m && m[2] !== "") fm[m[1].trim()] = m[2].trim().replace(/^["']|["']$/g, "");
  }
  return { fm, body };
}

/**
 * Recursively walk a directory, collecting every file (except SKILL.md) as a
 * document. Preserves the relative path from `root` as the document title so the
 * agent can reference files exactly as they appear in the skill (e.g.
 * "reference/02-scoring-framework.md", "examples/q2-description-rewrites.md",
 * "templates/abstract-review-builder.py").
 *
 * Binary files are skipped. Files over 512KB are skipped (anti-bloat guard).
 */
function collectAllDocuments(
  root: string,
  skillMdPath: string
): ParsedSkill["documents"] {
  const docs: ParsedSkill["documents"] = [];
  const MAX_BYTES = 512 * 1024;

  function walk(dir: string, prefix: string) {
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
    catch { return; }

    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      const relPath = prefix ? `${prefix}/${entry.name}` : entry.name;

      if (entry.isDirectory() || entry.isSymbolicLink()) {
        // Follow symlink dirs; skip node_modules + .git
        try {
          const stat = entry.isSymbolicLink() ? fs.statSync(full) : null;
          const isDir = entry.isDirectory() || (stat?.isDirectory() ?? false);
          if (isDir && !["node_modules", ".git"].includes(entry.name)) {
            walk(full, relPath);
          }
        } catch { /* broken symlink — skip */ }
        continue;
      }

      if (!entry.isFile()) continue;
      if (full === skillMdPath) continue; // body, not a document
      if (entry.name.startsWith(".")) continue; // hidden files

      try {
        const stat = fs.statSync(full);
        if (stat.size > MAX_BYTES) continue;
      } catch { continue; }

      // Map extension → document type
      const ext = path.extname(entry.name).toLowerCase();
      let type = "markdown";
      let language: string | undefined;
      if (ext === ".md") { type = "markdown"; }
      else if (ext === ".py") { type = "code"; language = "python"; }
      else if (ext === ".js" || ext === ".ts") { type = "code"; language = ext === ".ts" ? "typescript" : "javascript"; }
      else if (ext === ".json") { type = "code"; language = "json"; }
      else if (ext === ".txt") { type = "text"; }
      else { continue; } // skip binary/unrecognized

      let content: string;
      try { content = fs.readFileSync(full, "utf-8"); }
      catch { continue; } // binary file detected at read time — skip

      docs.push({ title: relPath, content, type, language });
    }
  }

  walk(root, "");
  return docs;
}

/** Parse a single SKILL.md skill directory into an import payload. */
export function parseSkillDir(dir: string): ParsedSkill | null {
  const skillMd = path.join(dir, "SKILL.md");
  if (!fs.existsSync(skillMd)) return null;

  const raw = fs.readFileSync(skillMd, "utf-8");
  const { fm, body } = parseFrontmatter(raw);

  return {
    slug: fm.name || path.basename(dir),
    name: fm.name || path.basename(dir),
    description: fm.description || "",
    body: body.trim(),
    autoLoad: fm.auto_load === "true",
    documents: collectAllDocuments(dir, skillMd),
  };
}

/** Find every skill directory (one containing SKILL.md) under a root, one level deep. */
export function discoverSkillDirs(root: string): string[] {
  if (!fs.existsSync(root)) return [];
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
