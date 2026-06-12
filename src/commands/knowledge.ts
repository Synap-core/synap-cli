/**
 * synap capture / synap recall --structured
 *
 * Two modes:
 *
 * SMART MODE (no --type):
 *   synap capture "free text"
 *   → POST /capture/structure  (AI pipeline: proposals + relations + followUp)
 *   → Renders a compact table of proposals, then prompts y/N before writing.
 *   → On yes (or --yes): POST /capture/execute to materialize.
 *
 * LEGACY / ENGINEERING-MEMORY MODE (--type required):
 *   synap capture --type gotcha --claim "..." [--why ...] [--evidence ...] [--tags ...]
 *   → POST /entities with profileSlug=knowledge (unchanged behaviour).
 *
 * Workspace routing (both modes):
 *   capture   → memory workspace by default (auto-approved, agent-private)
 *   recall    → memory workspace by default
 *   --team    → first product workspace instead
 *   --workspace <id>  → explicit override (highest priority)
 */

import chalk from "chalk";
import * as readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { log } from "../utils/logger.js";
import {
  resolveHubConfig,
  resolveUserId,
  hubPost,
  hubGet,
  type HubConfig,
} from "../lib/hub-client.js";
import { getAgentWorkspaceRouting } from "../lib/pod.js";

interface BaseOpts {
  podUrl?: string;
  apiKey?: string;
}

export type KnowledgeType = "gotcha" | "lesson" | "decision" | "reference";

export interface CaptureOpts {
  /** Smart mode: positional free-text (no --type). When present, uses AI /capture/structure pipeline. */
  text?: string;
  /** Legacy engineering-memory mode: one of gotcha|lesson|decision|reference */
  type?: KnowledgeType;
  claim?: string;
  why?: string;
  evidence?: string;
  tags?: string;
  /** Override to first product workspace instead of memory workspace */
  team?: boolean;
  /** Explicit workspace override — highest priority */
  workspace?: string;
  json?: boolean;
  /** Skip the y/N confirmation prompt (smart mode only) */
  yes?: boolean;
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
 * Live-detect an agent workspace (workspaceType: "agent") from the pod.
 * Falls back silently if the request fails or none exists.
 */
async function detectAgentWorkspace(cfg: HubConfig): Promise<string | undefined> {
  try {
    const res = await hubGet("/workspaces", {}, cfg) as Record<string, unknown>;
    const list = ((res.workspaces as unknown[]) ?? (Array.isArray(res) ? (res as unknown[]) : [])) as Record<string, unknown>[];
    const agentWs = list.find((w) => w.workspaceType === "agent");
    if (agentWs?.id) return String(agentWs.id);
  } catch { /* best-effort */ }
  return undefined;
}

/**
 * Resolve the workspace to use for capture/recall based on routing config.
 * Priority: --workspace > --team (first product ws) > persisted memory ws
 *           > live-detected agent workspace > active ws.
 */
async function resolveKnowledgeWorkspace(
  opts: { team?: boolean; workspace?: string },
  cfg: HubConfig,
  activeWorkspaceId: string | undefined
): Promise<{ workspaceId: string | undefined; source: string }> {
  if (opts.workspace) {
    return { workspaceId: opts.workspace, source: "explicit" };
  }
  const routing = getAgentWorkspaceRouting();
  if (opts.team) {
    const teamWs = routing?.productWorkspaceIds?.[0];
    return { workspaceId: teamWs ?? activeWorkspaceId, source: teamWs ? "team" : "active (no team workspace configured)" };
  }
  // Persisted routing first; if absent, live-detect agent workspace from pod
  const memWs = routing?.memoryWorkspaceId ?? await detectAgentWorkspace(cfg);
  return {
    workspaceId: memWs ?? activeWorkspaceId,
    source: memWs ? "agent-workspace" : "active (run `synap connect` to configure routing)",
  };
}

// ─── Smart capture mode (no --type) ──────────────────────────────────────────

interface StructureProposal {
  tempId: string;
  profileSlug: string;
  title: string;
  description?: string;
  properties?: Record<string, unknown>;
  content?: string;
  existingEntityId?: string;
}

interface StructureRelation {
  sourceTempId: string;
  targetTempId: string;
  relationType: string;
}

interface FollowUp {
  question: string;
  suggestions?: string[];
}

interface StructureResult {
  proposals: StructureProposal[];
  relations: StructureRelation[];
  followUp?: FollowUp | null;
  targetWorkspaceId?: string | null;
  degraded?: boolean;
}

/** Render the /capture/structure result as a compact human-readable summary. */
function renderStructureResult(result: StructureResult): void {
  const { proposals, relations, followUp, degraded } = result;

  if (degraded) {
    log.warn("AI structuring unavailable — degraded fallback.");
  }

  if (proposals.length === 0) {
    log.dim("No entity proposals extracted.");
    return;
  }

  log.heading("Proposed entities");
  // Column widths
  const typeW = Math.min(18, Math.max(6, ...proposals.map((p) => p.profileSlug.length)));
  const titleW = Math.min(48, Math.max(10, ...proposals.map((p) => p.title.length)));
  const header = [
    chalk.bold("#".padEnd(3)),
    chalk.bold("Type".padEnd(typeW)),
    chalk.bold("Title".padEnd(titleW)),
  ].join("  ");
  console.log("  " + header);
  console.log("  " + chalk.dim("-".repeat(3 + 2 + typeW + 2 + titleW)));
  for (let i = 0; i < proposals.length; i++) {
    const p = proposals[i];
    const row = [
      chalk.dim(String(i + 1).padEnd(3)),
      chalk.cyan(p.profileSlug.slice(0, typeW).padEnd(typeW)),
      p.title.slice(0, titleW).padEnd(titleW),
    ].join("  ");
    console.log("  " + row);
    if (p.description) {
      log.dim(`     ${p.description.slice(0, 80)}`);
    }
  }

  if (relations.length > 0) {
    log.blank();
    log.dim(`  ${relations.length} relation${relations.length !== 1 ? "s" : ""} will be created.`);
  }

  if (followUp?.question) {
    log.blank();
    log.info(`Follow-up: ${followUp.question}`);
    if (followUp.suggestions && followUp.suggestions.length > 0) {
      for (const s of followUp.suggestions) {
        log.dim(`  · ${s}`);
      }
    }
  }
}

async function runSmartCapture(text: string, opts: CaptureOpts): Promise<void> {
  const cfg = await resolveHubConfig();
  const userId = await resolveUserId(cfg);
  const { workspaceId } = await resolveKnowledgeWorkspace(opts, cfg, cfg.workspaceId);

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

  // 1. Structure
  const structureBody: Record<string, unknown> = { userId, text, workspaceId };
  const structureRes = await hubPost("/capture/structure", structureBody, cfg) as StructureResult;

  if (opts.json) {
    // --json without --yes: print structure result and exit
    if (!opts.yes) {
      console.log(JSON.stringify(structureRes, null, 2));
      return;
    }
    // --json + --yes: also execute and print combined result
    const executeRes = await hubPost("/capture/execute", {
      userId,
      workspaceId,
      entities: structureRes.proposals,
      relations: structureRes.relations ?? [],
    }, cfg);
    console.log(JSON.stringify({ structure: structureRes, execute: executeRes }, null, 2));
    return;
  }

  // 2. Render proposals
  renderStructureResult(structureRes);

  const count = structureRes.proposals?.length ?? 0;
  if (count === 0) return;

  // 3. Confirm
  let confirmed = opts.yes ?? false;
  if (!confirmed) {
    log.blank();
    const rl = readline.createInterface({ input, output });
    try {
      const answer = await rl.question(
        chalk.bold(`  Create ${count} entr${count !== 1 ? "ies" : "y"}? [y/N] `)
      );
      confirmed = answer.trim().toLowerCase() === "y";
    } finally {
      rl.close();
    }
  }

  if (!confirmed) {
    log.dim("Aborted.");
    return;
  }

  // 4. Execute
  const executeRes = await hubPost("/capture/execute", {
    userId,
    workspaceId,
    entities: structureRes.proposals,
    relations: structureRes.relations ?? [],
  }, cfg) as Record<string, unknown>;

  const created = (executeRes.entitiesCreated as number | undefined)
    ?? (executeRes.created as number | undefined)
    ?? count;
  log.success(`${created} entr${created !== 1 ? "ies" : "y"} created.`);
  if (executeRes.relationsCreated) {
    log.dim(`  ${executeRes.relationsCreated} relation${Number(executeRes.relationsCreated) !== 1 ? "s" : ""} created.`);
  }
}

// ─── Legacy engineering-memory capture ────────────────────────────────────────

export async function captureKnowledge(opts: CaptureOpts): Promise<void> {
  try {
    // Smart mode: positional text with no --type
    if (opts.text !== undefined && opts.type === undefined) {
      await runSmartCapture(opts.text, opts);
      return;
    }

    // Legacy mode: --type is required
    if (!opts.type) {
      console.error(chalk.red("Missing required option: --type <gotcha|lesson|decision|reference>"));
      console.error(chalk.dim("  Or pass free text as a positional arg for smart capture: synap capture \"your text\""));
      process.exit(1);
    }
    if (!opts.claim) {
      console.error(chalk.red("Missing required option: --claim <text>"));
      process.exit(1);
    }

    const cfg = await resolveHubConfig();
    const userId = await resolveUserId(cfg);

    const { workspaceId, source } = await resolveKnowledgeWorkspace(opts, cfg, cfg.workspaceId);

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
      profileSlug: "knowledge",
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

    const { workspaceId } = await resolveKnowledgeWorkspace(opts, cfg, cfg.workspaceId);

    let list: Record<string, unknown>[] = [];

    // Try the semantic recall endpoint first; fall back to a plain entity search
    try {
      const recallRes = await hubPost("/entities/recall", {
        query,
        profileSlug: "knowledge",
        ...(workspaceId ? { workspaceId } : {}),
        limit,
      }, cfg) as Record<string, unknown>;
      const items = (recallRes.entities ?? recallRes.items ?? recallRes) as Record<string, unknown>[];
      list = Array.isArray(items) ? items : [];
    } catch {
      // Fall back to GET /entities with q= param
      const params: Record<string, string | number> = {
        profileSlug: "knowledge",
        q: query,
        limit,
      };
      if (workspaceId) params.workspaceId = workspaceId;
      const res = await hubGet("/entities", params, cfg) as Record<string, unknown>;
      const items = (res.entities ?? res.items ?? res) as Record<string, unknown>[];
      list = Array.isArray(items) ? items : [];
    }

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
