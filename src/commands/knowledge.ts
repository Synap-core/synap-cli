/**
 * synap capture / synap recall --structured
 *
 * Structured knowledge capture and retrieval using the engineering_knowledge
 * entity profile. Backed by Hub Protocol entity endpoints — separate from the
 * episodic /memory endpoints used by `synap remember` / `synap recall`.
 */

import chalk from "chalk";
import { log } from "../utils/logger.js";
import {
  resolveHubConfig,
  resolveUserId,
  hubPost,
  hubGet,
} from "../lib/hub-client.js";

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
  json?: boolean;
}

export interface RecallStructuredOpts extends BaseOpts {
  type?: KnowledgeType;
  tags?: string;
  limit?: string;
  workspace?: string;
  json?: boolean;
}

export async function captureKnowledge(opts: CaptureOpts): Promise<void> {
  try {
    const cfg = await resolveHubConfig();
    const userId = await resolveUserId(cfg);

    const workspaceId = cfg.workspaceId;
    if (!workspaceId) {
      console.error(
        chalk.red(
          "No workspace set. Run:\n" +
          "  synap workspace provision-agent   (create your agent workspace)\n" +
          "  synap use <workspace-id>           (set it as active)"
        )
      );
      process.exit(1);
    }

    const tags = opts.tags
      ? opts.tags.split(",").map((t) => t.trim()).filter(Boolean)
      : [];

    const name = opts.claim.slice(0, 120);

    const res = await hubPost("/entities", {
      userId,
      workspaceId,
      profileSlug: "engineering_knowledge",
      name,
      properties: {
        ek_type: opts.type,
        ek_claim: opts.claim,
        ...(opts.why ? { ek_why: opts.why } : {}),
        ...(opts.evidence ? { ek_evidence: opts.evidence } : {}),
        ...(tags.length > 0 ? { ek_tags: tags } : {}),
      },
    }, cfg) as Record<string, unknown>;

    if (opts.json) {
      console.log(JSON.stringify({ id: res.id, stored: true }, null, 2));
      return;
    }

    log.success(`[${opts.type}] ${opts.claim.slice(0, 80)}`);
    if (res.id) log.dim(`  id: ${res.id}`);
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

    const params: Record<string, string | number> = {
      profileSlug: "engineering_knowledge",
      q: query,
      limit,
    };

    const workspaceId = opts.workspace ?? cfg.workspaceId;
    if (workspaceId) params.workspaceId = workspaceId;
    if (opts.type) params.type = opts.type;

    const res = await hubGet("/entities", params, cfg) as Record<string, unknown>;
    const entities = (res.entities ?? res.items ?? res) as Record<string, unknown>[];
    const list = Array.isArray(entities) ? entities : [];

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
