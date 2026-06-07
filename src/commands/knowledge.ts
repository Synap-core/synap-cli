/**
 * synap capture / synap recall --structured
 *
 * Structured knowledge capture and retrieval using the engineering_knowledge
 * entity profile. Backed by Hub Protocol entity endpoints — separate from the
 * episodic /memory endpoints used by `synap remember` / `synap recall`.
 *
 * Workspace routing:
 *   capture   → memory workspace by default (auto-approved, agent-private)
 *   recall    → memory workspace by default
 *   --team    → first product workspace instead
 *   --workspace <id>  → explicit override (highest priority)
 */

import chalk from "chalk";
import { log } from "../utils/logger.js";
import {
  resolveHubConfig,
  resolveUserId,
  hubPost,
  hubGet,
} from "../lib/hub-client.js";
import { getAgentWorkspaceRouting } from "../lib/pod.js";

interface BaseOpts {
  podUrl?: string;
  apiKey?: string;
}

export type KnowledgeType = "gotcha" | "lesson" | "decision" | "reference";

export interface CaptureOpts {
  type: KnowledgeType;
  claim: string;
  why?: string;
  evidence?: string;
  tags?: string;
  /** Override to first product workspace instead of memory workspace */
  team?: boolean;
  /** Explicit workspace override — highest priority */
  workspace?: string;
  json?: boolean;
}

export interface RecallStructuredOpts extends BaseOpts {
  type?: KnowledgeType;
  tags?: string;
  limit?: string;
  /** Override to first product workspace instead of memory workspace */
  team?: boolean;
  /** Explicit workspace override — highest priority */
  workspace?: string;
  json?: boolean;
}

/**
 * Resolve the workspace to use for capture/recall based on routing config.
 * Priority: --workspace > --team (first product ws) > memory ws > active ws.
 */
function resolveKnowledgeWorkspace(
  opts: { team?: boolean; workspace?: string },
  activeWorkspaceId: string | undefined
): { workspaceId: string | undefined; source: string } {
  if (opts.workspace) {
    return { workspaceId: opts.workspace, source: "explicit" };
  }
  const routing = getAgentWorkspaceRouting();
  if (opts.team) {
    const teamWs = routing?.productWorkspaceIds?.[0];
    return { workspaceId: teamWs ?? activeWorkspaceId, source: teamWs ? "team" : "active (no team workspace configured)" };
  }
  const memWs = routing?.memoryWorkspaceId;
  return { workspaceId: memWs ?? activeWorkspaceId, source: memWs ? "memory" : "active (run `synap connect` to configure routing)" };
}

export async function captureKnowledge(opts: CaptureOpts): Promise<void> {
  try {
    const cfg = await resolveHubConfig();
    const userId = await resolveUserId(cfg);

    const { workspaceId, source } = resolveKnowledgeWorkspace(opts, cfg.workspaceId);

    if (!workspaceId) {
      console.error(
        chalk.red(
          "No workspace set. Run:\n" +
          "  synap connect   (sets up memory + team workspace routing)\n" +
          "  synap use <workspace-id>   (manual override)"
        )
      );
      process.exit(1);
    }

    const tags = opts.tags
      ? opts.tags.split(",").map((t) => t.trim()).filter(Boolean)
      : [];

    const title = opts.claim.slice(0, 120);

    const res = await hubPost("/entities", {
      userId,
      workspaceId,
      profileSlug: "engineering_knowledge",
      title,
      properties: {
        ek_type: opts.type,
        ek_claim: opts.claim,
        ...(opts.why ? { ek_why: opts.why } : {}),
        ...(opts.evidence ? { ek_evidence: opts.evidence } : {}),
        ...(tags.length > 0 ? { ek_tags: tags } : {}),
      },
    }, cfg) as Record<string, unknown>;

    // Governance may queue the write as a proposal rather than creating directly
    const isProposed = res.status === "proposed" || Boolean(res.proposalId);

    if (opts.json) {
      if (isProposed) {
        console.log(JSON.stringify({
          proposed: true,
          proposalId: res.proposalId ?? res.id,
          reviewUrl: res.reviewUrl ?? null,
          message: "Write queued for approval — not yet stored.",
        }, null, 2));
      } else {
        console.log(JSON.stringify({ id: res.id, stored: true, workspace: source }, null, 2));
      }
      return;
    }

    if (isProposed) {
      log.warn(`Queued for approval — not yet stored.`);
      log.dim(`  The target workspace requires human review for agent writes.`);
      if (res.reviewUrl) log.dim(`  Review: ${String(res.reviewUrl)}`);
      else log.dim(`  Open Synap and approve the pending proposal to persist this entry.`);
      log.dim(`  Tip: use the memory workspace (default) to capture without governance.`);
    } else {
      log.success(`[${opts.type}] ${opts.claim.slice(0, 80)}`);
      log.dim(`  workspace: ${source}  id: ${String(res.id ?? "")}`);
    }
  } catch (e) {
    console.error(chalk.red("Error: " + (e as Error).message));
    process.exit(1);
  }
}

export async function recallStructured(
  query: string,
  opts: RecallStructuredOpts
): Promise<void> {
  try {
    const cfg = await resolveHubConfig(opts);
    const limit = parseInt(opts.limit ?? "10", 10);

    const { workspaceId } = resolveKnowledgeWorkspace(opts, cfg.workspaceId);

    const params: Record<string, string | number> = {
      profileSlug: "engineering_knowledge",
      q: query,
      limit,
    };

    if (workspaceId) params.workspaceId = workspaceId;

    const res = await hubGet("/entities", params, cfg) as Record<string, unknown>;
    const entities = (res.entities ?? res.items ?? res) as Record<string, unknown>[];
    let list = Array.isArray(entities) ? entities : [];

    if (opts.type) {
      list = list.filter((e) => {
        const props = (e.properties ?? {}) as Record<string, unknown>;
        return props.ek_type === opts.type;
      });
    }

    if (opts.json) {
      console.log(JSON.stringify(list, null, 2));
      return;
    }

    if (list.length === 0) {
      log.dim(`No knowledge entries found for "${query}"`);
      return;
    }

    for (const item of list) {
      const props = (item.properties ?? {}) as Record<string, unknown>;
      const type = String(props.ek_type ?? "–");
      const claim = String(props.ek_claim ?? item.name ?? "–");
      const why = props.ek_why ? `\n    why: ${props.ek_why}` : "";
      const tags = Array.isArray(props.ek_tags) && props.ek_tags.length > 0
        ? chalk.dim(`  [${props.ek_tags.join(", ")}]`)
        : "";
      console.log(`  ${chalk.cyan(type.padEnd(10))} ${claim}${tags}${chalk.dim(why)}`);
    }
  } catch (e) {
    console.error(chalk.red("Error: " + (e as Error).message));
    process.exit(1);
  }
}

export async function provisionAgentWorkspace(
  opts: { agentUserId?: string; name?: string; use?: boolean; json?: boolean }
): Promise<void> {
  try {
    const cfg = await resolveHubConfig();
    const userId = await resolveUserId(cfg);
    const agentUserId = opts.agentUserId ?? userId;

    const res = await hubPost("/workspaces/provision-agent", {
      agentUserId,
      ...(opts.name ? { workspaceName: opts.name } : {}),
    }, cfg) as { workspaceId: string; created: boolean };

    if (opts.json) {
      console.log(JSON.stringify(res, null, 2));
      return;
    }

    if (res.created) {
      log.success(`Agent workspace created: ${res.workspaceId}`);
    } else {
      log.info(`Agent workspace already exists: ${res.workspaceId}`);
    }

    if (opts.use ?? res.created) {
      const { setActiveWorkspaceId } = await import("../lib/pod.js");
      setActiveWorkspaceId(res.workspaceId);
      log.dim(`  Set as active workspace (synap use ${res.workspaceId})`);
    }
  } catch (e) {
    console.error(chalk.red("Error: " + (e as Error).message));
    process.exit(1);
  }
}
