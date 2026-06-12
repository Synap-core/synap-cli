/**
 * synap context
 *
 * Emit a session-start context summary: recent engineering knowledge,
 * open proposals, active tasks. Designed for injection into CLAUDE.md or
 * as JSON for agents to consume at session start.
 *
 * Usage:
 *   synap context                   # markdown output
 *   synap context --json            # NDJSON (one object per section)
 *   synap context --repo synap-backend  # filter knowledge by repo tag
 *   synap context --limit 5         # entries per section (default: 5)
 */

import chalk from "chalk";
import { log } from "../utils/logger.js";
import { resolveHubConfig, hubGet, type HubConfig } from "../lib/hub-client.js";
import { getAgentWorkspaceRouting } from "../lib/pod.js";

export interface ContextOpts {
  repo?: string;
  limit?: string;
  json?: boolean;
  podUrl?: string;
  apiKey?: string;
  workspace?: string;
}

interface EntityItem {
  id?: string;
  name?: string;
  title?: string;
  status?: string;
  workspaceName?: string;
  workspace?: string;
  properties?: Record<string, unknown>;
}

async function fetchEntities(
  cfg: HubConfig,
  params: Record<string, string | number>,
  workspaceId: string | undefined
): Promise<EntityItem[]> {
  try {
    if (workspaceId) params.workspaceId = workspaceId;
    const res = await hubGet("/entities", params, cfg) as Record<string, unknown>;
    const items = (res.entities ?? res.items ?? res) as unknown[];
    return Array.isArray(items) ? (items as EntityItem[]) : [];
  } catch {
    return [];
  }
}

async function fetchProposals(
  cfg: HubConfig,
  workspaceId: string | undefined,
  limit: number
): Promise<EntityItem[]> {
  try {
    const params: Record<string, string | number> = { status: "pending", limit };
    if (workspaceId) params.workspaceId = workspaceId;
    const res = await hubGet("/proposals", params, cfg) as Record<string, unknown>;
    const items = (res.proposals ?? res.items ?? res) as unknown[];
    return Array.isArray(items) ? (items as EntityItem[]) : [];
  } catch {
    return [];
  }
}

async function fetchSessions(
  cfg: HubConfig,
  workspaceId: string | undefined,
  limit: number
): Promise<EntityItem[]> {
  try {
    const params: Record<string, string | number> = { status: "active", limit };
    if (workspaceId) params.workspaceId = workspaceId;
    const res = await hubGet("/focus-sessions", params, cfg) as Record<string, unknown>;
    const items = (res.sessions ?? res.items ?? res) as unknown[];
    return Array.isArray(items) ? (items as EntityItem[]) : [];
  } catch {
    return [];
  }
}

export async function contextSummary(opts: ContextOpts): Promise<void> {
  try {
    const cfg = await resolveHubConfig(opts);
    const limit = parseInt(opts.limit ?? "5", 10);

    // Resolve workspace: explicit > agent routing memory workspace > cfg active
    const routing = getAgentWorkspaceRouting();
    const workspaceId =
      opts.workspace ??
      routing?.memoryWorkspaceId ??
      cfg.workspaceId;

    const [rawKnowledge, proposals, tasks, sessions] = await Promise.all([
      fetchEntities(cfg, { profileSlug: "knowledge", limit }, workspaceId),
      fetchProposals(cfg, workspaceId, limit),
      fetchEntities(cfg, { profileSlug: "task", limit, status: "todo" }, workspaceId),
      fetchSessions(cfg, workspaceId, limit),
    ]);

    // Filter knowledge by repo tag if requested
    const knowledge = opts.repo
      ? rawKnowledge.filter((item) => {
          const tags = (item.properties?.ek_tags ?? []) as unknown[];
          if (!Array.isArray(tags)) return false;
          return tags.some((t) => {
            const tag = String(t);
            return tag === opts.repo || tag === `repo:${opts.repo}`;
          });
        })
      : rawKnowledge;

    if (opts.json) {
      console.log(JSON.stringify({ section: "knowledge", items: knowledge }));
      console.log(JSON.stringify({ section: "proposals", items: proposals }));
      console.log(JSON.stringify({ section: "tasks", items: tasks }));
      console.log(JSON.stringify({ section: "sessions", items: sessions }));
      return;
    }

    // ── Markdown output ────────────────────────────────────────────────────

    // Knowledge
    console.log(chalk.bold("\n## Engineering Knowledge"));
    if (knowledge.length === 0) {
      console.log(chalk.dim("  (none)"));
    } else {
      for (const item of knowledge) {
        const props = (item.properties ?? {}) as Record<string, unknown>;
        const type = String(props.ek_type ?? "–");
        const claim = String(props.ek_claim ?? item.name ?? "–");
        const tags = Array.isArray(props.ek_tags) && (props.ek_tags as unknown[]).length > 0
          ? chalk.dim(`  [${(props.ek_tags as unknown[]).join(", ")}]`)
          : "";
        console.log(`- [${type}] ${claim}${tags}`);
      }
    }

    // Proposals
    console.log(chalk.bold(`\n## Open Proposals (${proposals.length} pending)`));
    if (proposals.length === 0) {
      console.log(chalk.dim("  (none)"));
    } else {
      for (const item of proposals) {
        const title = String(item.title ?? item.name ?? "–");
        const ws = String(item.workspaceName ?? item.workspace ?? "");
        const wsPart = ws ? `  — workspace: ${ws}` : "";
        console.log(`- ${title}${wsPart}`);
      }
    }

    // Tasks
    console.log(chalk.bold(`\n## Active Tasks (${tasks.length})`));
    if (tasks.length === 0) {
      console.log(chalk.dim("  (none)"));
    } else {
      for (const item of tasks) {
        const props = (item.properties ?? {}) as Record<string, unknown>;
        const name = String(props.task_title ?? item.name ?? "–");
        console.log(`- ${name}`);
      }
    }

    // Focus sessions
    console.log(chalk.bold(`\n## Active Focus Sessions (${sessions.length})`));
    if (sessions.length === 0) {
      console.log(chalk.dim("  (none)"));
    } else {
      for (const s of sessions as Array<Record<string, unknown>>) {
        const progress = typeof s.progress === "number" ? ` ${chalk.dim(`[${s.progress}%]`)}` : "";
        const id = String(s.id ?? "").slice(0, 8);
        console.log(`- ${chalk.cyan(id)}${progress}  ${String(s.goal ?? "")}`);
      }
    }

    console.log("");
  } catch (e) {
    log.error("Error: " + (e as Error).message);
    process.exit(1);
  }
}
