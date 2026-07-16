/**
 * synap capture — the one canonical structured-WRITE verb.
 *
 * SMART MODE (no --type): `synap capture "free text"`
 *   → POST /capture/structure (AI pipeline: proposals + relations + followUp)
 *   → renders a proposal table, prompts y/N, then POST /capture/execute.
 *
 * TYPED MODE (--type): `synap capture --type gotcha --claim "…" [--why] [--evidence] [--tags]`
 *   → POST /entities as a typed `knowledge` entity; `ek_type` (gotcha|lesson|decision|
 *     reference) discriminates the kind — ONE store, type tags (the canonical pattern,
 *     NOT a residual dump). The workspace lens supplies the domain (no
 *     `engineering_knowledge`). A formal decision RECORD (rationale/alternatives/status
 *     lifecycle) comes from smart `capture "<text>"` or `create entity --profile=decision`.
 *
 * Workspace routing: --workspace > --team (first product ws) > memory ws (default,
 * auto-approved, agent-private) > active ws.
 */

import chalk from "chalk";
import * as readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { log } from "../utils/logger.js";
import {
  resolveHubConfig,
  resolveUserId,
  hubPost,
  readActiveSessionId,
  type HubConfig,
  renderHubError,
} from "../lib/hub-client.js";
import { getAgentWorkspaceRouting } from "../lib/pod.js";
import {
  laneFromSource,
  resolveWorkspaceName,
  formatLaneLine,
  laneJsonFields,
  type LaneReport,
} from "../lib/capture-lane.js";

export type KnowledgeType = "gotcha" | "lesson" | "decision" | "reference";

export interface CaptureOpts {
  /** Smart mode: positional free-text (no --type). When present, uses AI /capture/structure pipeline. */
  text?: string;
  /** Typed mode: one of gotcha|lesson|decision|reference */
  type?: KnowledgeType;
  claim?: string;
  why?: string;
  evidence?: string;
  tags?: string;
  /** Override to first product workspace instead of the active workspace */
  team?: boolean;
  /** Explicit workspace override — highest priority */
  workspace?: string;
  /**
   * GLOBAL lane: write a pod-wide procedural runbook to `knowledge_keys`
   * (cross-cutting best-practice/how-to, visible in every workspace) instead of
   * a domain `knowledge` entity in the active workspace.
   */
  global?: boolean;
  /** Optional stable key (namespace:slug) for a --global runbook; derived if absent. */
  key?: string;
  json?: boolean;
  /** Skip the y/N confirmation prompt (smart mode only) */
  yes?: boolean;
  /** Link the captured knowledge to the active session */
  session?: boolean;
}

/**
 * Resolve the workspace for a DOMAIN capture (the `knowledge` entity, the Work
 * lane). Knowledge is workspace-scoped, so the destination IS the separation:
 * a Builder lesson stays in Builder, a marketing one in marketing.
 *
 * Priority: --workspace > --team (first product ws) > active ws.
 *
 * NOTE: the agent-memory ("AI-self") lane was removed — the AI no longer dumps
 * captures into a private agent workspace. Everything it learns routes to a real
 * lane: Work (here), Global (`--global` → knowledge_keys), or User
 * (`record_observation` → user_observation). The per-adjunct memory workspace is
 * being decommissioned.
 */
async function resolveKnowledgeWorkspace(
  opts: { team?: boolean; workspace?: string },
  _cfg: HubConfig,
  activeWorkspaceId: string | undefined
): Promise<{ workspaceId: string | undefined; source: string }> {
  if (opts.workspace) {
    return { workspaceId: opts.workspace, source: "explicit" };
  }
  if (opts.team) {
    const routing = getAgentWorkspaceRouting();
    const teamWs = routing?.productWorkspaceIds?.[0];
    return { workspaceId: teamWs ?? activeWorkspaceId, source: teamWs ? "team" : "active (no team workspace configured)" };
  }
  return {
    workspaceId: activeWorkspaceId,
    source: activeWorkspaceId ? "active" : "active (run `synap use <id>` to set a workspace)",
  };
}

/** Slugify free text into a knowledge_keys slug fragment. */
function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80) || "entry";
}

/**
 * GLOBAL lane: write a pod-wide procedural runbook to `knowledge_keys`.
 * Cross-cutting best-practice/how-to, addressed by a stable `namespace:slug` key
 * and visible in every workspace (pod-wide). The kind (gotcha/lesson/decision/
 * reference) becomes the namespace; the claim derives the slug unless --key given.
 */
async function captureGlobalRunbook(
  opts: CaptureOpts,
  cfg: HubConfig,
  authorUserId: string
): Promise<void> {
  const type = opts.type ?? "reference";
  const claim = opts.claim ?? opts.text ?? "";
  const key = opts.key ?? `${type}:${slugify(claim)}`;
  const [namespace, ...slugParts] = key.split(":");
  const slug = slugParts.join(":") || slugify(claim);

  const valueParts = [claim];
  if (opts.why) valueParts.push(`\n**Why:** ${opts.why}`);
  if (opts.evidence) valueParts.push(`\n**Evidence:** ${opts.evidence}`);
  if (opts.tags) valueParts.push(`\n_tags: ${opts.tags}_`);

  const res = await hubPost("/knowledge", {
    key,
    namespace,
    slug,
    value: valueParts.join("\n"),
    author: authorUserId,
    // workspaceId omitted → pod-wide (null). The Global lane is, by definition,
    // cross-workspace. (Workspace-scoped knowledge_keys await a backend fix —
    // POST /knowledge currently drops workspaceId; domain knowledge uses the
    // `knowledge` entity instead, which IS workspace-scoped.)
  }, cfg) as Record<string, unknown>;

  const report: LaneReport = {
    lane: "global",
    workspaceId: undefined,
    workspaceName: "pod-wide",
    governance: "auto",
  };

  if (opts.json) {
    console.log(JSON.stringify({ key, id: res.id, stored: true, ...laneJsonFields(report) }, null, 2));
    return;
  }
  log.success(`[${type}] ${claim.slice(0, 80)}`);
  log.dim(`  key: ${key}`);
  console.log("  " + formatLaneLine(report));
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

// Mirrors @synap/hub-rest-client's StructuredFollowUp/FollowUpChip. Kept local
// (the CLI resolves the SDK via its built dist); the chip is an OBJECT, not a
// string — a `string[]` here rendered chips as "[object Object]".
interface FollowUpChip {
  label: string;
  value: string;
  action?: "link_entity" | "set_property" | "add_relation" | "confirm" | "dismiss";
  entityId?: string;
  propertyKey?: string;
}

interface FollowUp {
  question: string;
  suggestions?: FollowUpChip[];
}

interface StructureResult {
  proposals: StructureProposal[];
  relations: StructureRelation[];
  // May be a plain string OR a structured { question, suggestions[] } object.
  followUp?: string | FollowUp | null;
  targetWorkspaceId?: string | null;
  targetWorkspaceConfidence?: number | null;
  targetWorkspaceReason?: string | null;
  targetProjectId?: string | null;
  targetProjectConfidence?: number | null;
  targetProjectReason?: string | null;
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

  if (result.targetWorkspaceId || result.targetProjectId) {
    log.blank();
    if (result.targetWorkspaceId) {
      const conf =
        typeof result.targetWorkspaceConfidence === "number"
          ? ` (${Math.round(result.targetWorkspaceConfidence * 100)}%)`
          : "";
      log.dim(`  → workspace: ${result.targetWorkspaceId}${conf}`);
      if (result.targetWorkspaceReason) {
        log.dim(`      ${result.targetWorkspaceReason.slice(0, 90)}`);
      }
    }
    if (result.targetProjectId) {
      const conf =
        typeof result.targetProjectConfidence === "number"
          ? ` (${Math.round(result.targetProjectConfidence * 100)}%)`
          : "";
      log.dim(`  → project:   ${result.targetProjectId}${conf}`);
      if (result.targetProjectReason) {
        log.dim(`      ${result.targetProjectReason.slice(0, 90)}`);
      }
    }
  }

  // followUp may be a bare string (previously dropped — the `.question` guard
  // never matched) or a { question, suggestions[] } object (chips previously
  // rendered as "[object Object]"). Handle both; render each chip by its label.
  if (followUp) {
    const question = typeof followUp === "string" ? followUp : followUp.question;
    if (question) {
      log.blank();
      log.info(`Follow-up: ${question}`);
      const chips = typeof followUp === "string" ? [] : followUp.suggestions ?? [];
      for (const c of chips) {
        log.dim(`  · ${c.label ?? c.value}`);
      }
    }
  }
}

async function runSmartCapture(text: string, opts: CaptureOpts): Promise<void> {
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

  // 1. Structure
  const smartSessionId = opts.session ? readActiveSessionId() : undefined;
  const structureBody: Record<string, unknown> = { userId, text, workspaceId, ...(smartSessionId ? { sessionId: smartSessionId } : {}) };
  const structureRes = await hubPost("/capture/structure", structureBody, cfg) as StructureResult;

  // Explicit --workspace is a deliberate pin: send it as-is, no AI routing hints.
  // Otherwise forward the AI's routing signal and let the backend decide
  // (auto = AI target wins over ambient when confidence is high enough AND the
  // user is a member). Project from structure is forwarded when present.
  const isExplicitOverride = Boolean(opts.workspace);
  const routingFields: Record<string, unknown> = isExplicitOverride
    ? {}
    : {
        workspaceRouting: "auto",
        aiWorkspaceId: structureRes.targetWorkspaceId,
        aiWorkspaceConfidence: structureRes.targetWorkspaceConfidence,
        aiWorkspaceReason: structureRes.targetWorkspaceReason,
      };
  if (structureRes.targetProjectId) {
    routingFields.projectId = structureRes.targetProjectId;
  }

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
      ...(smartSessionId ? { sessionId: smartSessionId } : {}),
      ...routingFields,
      entities: structureRes.proposals,
      relations: structureRes.relations ?? [],
    }, cfg) as Record<string, unknown>;
    const report = await buildSmartLaneReport(executeRes, workspaceId, source, cfg);
    console.log(JSON.stringify({ structure: structureRes, execute: executeRes, ...laneJsonFields(report) }, null, 2));
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
    ...(smartSessionId ? { sessionId: smartSessionId } : {}),
    ...routingFields,
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
  if (executeRes.movedToWorkspace) {
    log.dim(`  → filed into workspace ${String(executeRes.movedToWorkspace)}`);
  }

  const report = await buildSmartLaneReport(executeRes, workspaceId, source, cfg);
  console.log("  " + formatLaneLine(report));
}

/**
 * Build the lane report for a smart-capture execute response. Smart capture may
 * land directly or be queued as proposals — detect the latter from the execute
 * payload (proposed/proposalsCreated/status) and fall back to auto otherwise.
 */
async function buildSmartLaneReport(
  executeRes: Record<string, unknown>,
  workspaceId: string,
  source: string,
  cfg: HubConfig
): Promise<LaneReport> {
  const isProposed =
    executeRes.status === "proposed" ||
    Boolean(executeRes.proposalId) ||
    Number(executeRes.proposalsCreated ?? 0) > 0;
  return {
    lane: laneFromSource(source),
    workspaceId,
    workspaceName: await resolveWorkspaceName(workspaceId, cfg),
    governance: isProposed ? "proposed" : "auto",
  };
}

// ─── Legacy engineering-memory capture ────────────────────────────────────────

export async function captureKnowledge(opts: CaptureOpts): Promise<void> {
  try {
    // Mutual exclusion: smart mode (positional text) and typed mode (--type/--claim)
    // are two distinct flows. Mixing them silently drops one — fail loud instead.
    if (opts.text !== undefined && opts.type !== undefined) {
      console.error(chalk.red("Cannot mix smart mode (positional text) with typed mode (--type/--claim)."));
      console.error(chalk.dim("  Use one: `synap capture \"free text\"`  OR  `synap capture --type gotcha --claim \"…\"`"));
      process.exit(1);
    }

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

    // GLOBAL lane: pod-wide procedural runbook → knowledge_keys.
    if (opts.global) {
      await captureGlobalRunbook(opts, cfg, userId);
      return;
    }

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

    // Every --type entry is a typed `knowledge` entity; ek_type discriminates the
    // kind. This is "one store, type tags" (the research-canonical pattern) — NOT a
    // residual catch-all: each row is typed by ek_type and lives in the workspace
    // lens that supplies its domain (so no `engineering_knowledge`). A structured
    // decision RECORD (rationale/alternatives/status) is a different artifact, reached
    // via smart `capture "<text>"` or `create entity --profile=decision`.
    const sessionId = opts.session ? readActiveSessionId() : undefined;

    const res = await hubPost("/entities", {
      userId,
      workspaceId,
      profileSlug: "knowledge",
      title,
      ...(sessionId ? { sessionId } : {}),
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

    // Declare which lane + workspace + governance this capture took, so the
    // caller always knows where its knowledge landed.
    const report: LaneReport = {
      lane: laneFromSource(source),
      workspaceId,
      workspaceName: await resolveWorkspaceName(workspaceId, cfg),
      governance: isProposed ? "proposed" : "auto",
    };

    if (opts.json) {
      if (isProposed) {
        console.log(JSON.stringify({
          proposed: true,
          proposalId: res.proposalId ?? res.id,
          reviewUrl: res.reviewUrl ?? null,
          message: "Write queued for approval — not yet stored.",
          ...laneJsonFields(report),
        }, null, 2));
      } else {
        console.log(JSON.stringify({ id: res.id, stored: true, workspace: source, ...laneJsonFields(report) }, null, 2));
      }
      return;
    }

    if (isProposed) {
      log.warn(`Queued for approval — not yet stored.`);
      log.dim(`  The target workspace requires human review for agent writes.`);
      if (res.reviewUrl) log.dim(`  Review: ${String(res.reviewUrl)}`);
      else log.dim(`  Open Synap and approve the pending proposal to persist this entry.`);
      console.log("  " + formatLaneLine(report));
    } else {
      log.success(`[${opts.type}] ${opts.claim.slice(0, 80)}`);
      log.dim(`  workspace: ${source}  id: ${String(res.id ?? "")}`);
      console.log("  " + formatLaneLine(report));
    }
  } catch (e) {
    renderHubError(e);
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
    renderHubError(e);
    process.exit(1);
  }
}
