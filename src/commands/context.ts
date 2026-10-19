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
import { unwrapList } from "../lib/unwrapList.js";
import { getAgentWorkspaceRouting } from "../lib/pod.js";
import { sessionKindLabel, resolveSessionTitle } from "./sessions.js";

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

// The readers THROW on a failed read (hubGet raises HubError) — a failure is
// never folded into [] (an EMPTY section). contextSummary settles each section
// on its own and says which one could not be read.

/** One section's read: its rows, or why it could not be read. */
type SectionRead = { items: EntityItem[] } | { error: string };

async function settle(read: Promise<EntityItem[]>): Promise<SectionRead> {
  try {
    return { items: await read };
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) };
  }
}

async function fetchEntities(
  cfg: HubConfig,
  params: Record<string, string | number>,
  workspaceId: string | undefined
): Promise<EntityItem[]> {
  if (workspaceId) params.workspaceId = workspaceId;
  const res = await hubGet("/entities", params, cfg) as Record<string, unknown>;
  return unwrapList<EntityItem>(res, ["entities", "items"]);
}

async function fetchProposals(
  cfg: HubConfig,
  workspaceId: string | undefined,
  limit: number
): Promise<EntityItem[]> {
  const params: Record<string, string | number> = { status: "pending", limit };
  if (workspaceId) params.workspaceId = workspaceId;
  const res = await hubGet("/proposals", params, cfg) as Record<string, unknown>;
  return unwrapList<EntityItem>(res, ["proposals", "items"]);
}

async function fetchSessions(
  cfg: HubConfig,
  workspaceId: string | undefined,
  limit: number
): Promise<EntityItem[]> {
  const params: Record<string, string | number> = { status: "active", limit };
  if (workspaceId) params.workspaceId = workspaceId;
  const res = await hubGet("/focus-sessions", params, cfg) as Record<string, unknown>;
  return unwrapList<EntityItem>(res, ["sessions", "items"]);
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

    const [knowledgeRead, proposalsRead, tasksRead, sessionsRead] = await Promise.all([
      settle(fetchEntities(cfg, { profileSlug: "knowledge", limit }, workspaceId)),
      settle(fetchProposals(cfg, workspaceId, limit)),
      settle(fetchEntities(cfg, { profileSlug: "task", limit, status: "todo" }, workspaceId)),
      settle(fetchSessions(cfg, workspaceId, limit)),
    ]);
    const reads = [knowledgeRead, proposalsRead, tasksRead, sessionsRead];
    // Nothing could be read at all: that is a failed command, not an empty pod.
    if (reads.every((r) => "error" in r)) {
      throw new Error(
        `could not read the pod — ${(reads[0] as { error: string }).error}`
      );
    }
    const itemsOf = (r: SectionRead): EntityItem[] => ("items" in r ? r.items : []);
    const rawKnowledge = itemsOf(knowledgeRead);
    const proposals = itemsOf(proposalsRead);
    const tasks = itemsOf(tasksRead);
    const sessions = itemsOf(sessionsRead);

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
      // A failed section carries `error` and NO `items` — a reader can never
      // mistake it for an empty one.
      const line = (section: string, read: SectionRead, items: EntityItem[]) =>
        JSON.stringify("error" in read ? { section, error: read.error } : { section, items });
      console.log(line("knowledge", knowledgeRead, knowledge));
      console.log(line("proposals", proposalsRead, proposals));
      console.log(line("tasks", tasksRead, tasks));
      console.log(line("sessions", sessionsRead, sessions));
      return;
    }

    /** The failed-read line, printed where "(none)" would have lied. */
    const unreadable = (read: SectionRead): boolean => {
      if (!("error" in read)) return false;
      console.log(chalk.yellow(`  (could not read: ${read.error})`));
      return true;
    };

    // ── Markdown output ────────────────────────────────────────────────────

    // Knowledge
    console.log(chalk.bold("\n## Engineering Knowledge"));
    if (unreadable(knowledgeRead)) {
      // said above
    } else if (knowledge.length === 0) {
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
    console.log(
      chalk.bold(
        "error" in proposalsRead
          ? "\n## Open Proposals (unknown)"
          : `\n## Open Proposals (${proposals.length} pending)`
      )
    );
    if (unreadable(proposalsRead)) {
      // said above
    } else if (proposals.length === 0) {
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
    console.log(
      chalk.bold("error" in tasksRead ? "\n## Active Tasks (unknown)" : `\n## Active Tasks (${tasks.length})`)
    );
    if (unreadable(tasksRead)) {
      // said above
    } else if (tasks.length === 0) {
      console.log(chalk.dim("  (none)"));
    } else {
      for (const item of tasks) {
        const props = (item.properties ?? {}) as Record<string, unknown>;
        const name = String(props.task_title ?? item.name ?? "–");
        console.log(`- ${name}`);
      }
    }

    // Focus sessions
    console.log(
      chalk.bold(
        "error" in sessionsRead
          ? "\n## Active Focus Sessions (unknown)"
          : `\n## Active Focus Sessions (${sessions.length})`
      )
    );
    if (unreadable(sessionsRead)) {
      // said above
    } else if (sessions.length === 0) {
      console.log(chalk.dim("  (none)"));
    } else {
      for (const s of sessions as Array<Record<string, unknown>>) {
        const progress = typeof s.progress === "number" ? ` ${chalk.dim(`[${s.progress}%]`)}` : "";
        // `kind` is projected on every row by the Hub REST list door — before
        // this, a run or receipt printed here indistinguishable from a
        // person's own work (same audit finding as `synap session list`).
        const kindLabel = typeof s.kind === "string" ? sessionKindLabel(s.kind) : null;
        const kindCol = kindLabel ? ` ${chalk.dim(`[${kindLabel}]`)}` : "";
        // Full id — feeds straight into `synap session update/attach <id>`.
        const id = String(s.id ?? "");
        console.log(`- ${chalk.cyan(id)}${kindCol}${progress}  ${resolveSessionTitle(s)}`);
      }
    }

    console.log("");
  } catch (e) {
    log.error("Error: " + (e as Error).message);
    process.exit(1);
  }
}
