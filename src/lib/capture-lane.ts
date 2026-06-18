/**
 * Write-outcome transparency helpers — the glass-box for WRITES.
 *
 * Reads route through one verb (`ask`, which says how it routed). Writes route by
 * KIND into one of three lanes — and every write must report, honestly and in one
 * line, WHAT happened so the AI is GUIDED by the response, not guessing:
 *
 *   | Lane     | Destination                          | Governance      |
 *   |----------|--------------------------------------|-----------------|
 *   | user     | pod-wide user_observation            | gate inference  |
 *   | global   | pod-wide procedural (knowledge_keys) | reviewed        |
 *   | work     | the active product workspace         | proposal-gated  |
 *
 * The cardinal signal is **stored vs proposed**: `stored` = live, recallable now;
 * `proposed` = gated/refrained — queued for human approval, NOT yet live. Every
 * write command routes its hub response through `reportWrite` so this signal is
 * consistent across `capture`, `observe`, `create entity`, `create relation`, `doc`.
 */

import chalk from "chalk";
import { log } from "../utils/logger.js";
import { hubGet, type HubConfig } from "./hub-client.js";

// "ai-self" retained as a deprecated union member only; the lane was removed
// (no private agent scratchpad) — nothing routes there anymore.
export type CaptureLane = "ai-self" | "user" | "global" | "work";
export type Governance = "auto" | "proposed";

export interface LaneReport {
  /** One-line lane label. */
  lane: CaptureLane;
  /** Resolved destination workspace id (undefined if none could be resolved). */
  workspaceId?: string;
  /** Human-friendly workspace name, best-effort resolved from the pod. */
  workspaceName?: string;
  /** Whether the write was auto-approved (`auto`) or queued for review (`proposed`). */
  governance: Governance;
}

/**
 * Derive the lane from the workspace-routing `source` returned by
 * `resolveKnowledgeWorkspace`. A domain capture always lands in a real product
 * workspace → the Work lane. (The ai-self / agent-memory lane was removed; the
 * Global lane is set directly, not derived from a workspace source.)
 *
 *   source                              → lane
 *   "explicit" / "team" / "active …"    → work
 */
export function laneFromSource(_source: string): CaptureLane {
  return "work";
}

/** Best-effort resolve a workspace name from the pod. Never throws. */
export async function resolveWorkspaceName(
  workspaceId: string,
  cfg: HubConfig
): Promise<string | undefined> {
  try {
    const res = (await hubGet("/workspaces", {}, cfg)) as Record<string, unknown>;
    const list = ((res.workspaces as unknown[]) ??
      (Array.isArray(res) ? (res as unknown[]) : [])) as Record<string, unknown>[];
    const match = list.find((w) => String(w.id ?? "") === workspaceId);
    return match ? String(match.name ?? match.id ?? "") : undefined;
  } catch {
    return undefined;
  }
}

/** A human-readable lane label for terminal output. */
function laneLabel(lane: CaptureLane): string {
  switch (lane) {
    case "ai-self":
      return "agent memory";
    case "user":
      return "user observations";
    case "global":
      return "global runbooks";
    case "work":
      return "workspace";
  }
}

/**
 * Build the `→ stored in … / proposed to …` destination line for human output.
 * Returns a dim, single-line string (no trailing newline).
 */
export function formatLaneLine(report: LaneReport): string {
  const place = report.workspaceName ?? report.workspaceId ?? laneLabel(report.lane);
  const laneTag = chalk.dim(`[${laneLabel(report.lane)}]`);
  if (report.governance === "proposed") {
    return chalk.dim(`→ proposed to ${place} (awaiting approval) `) + laneTag;
  }
  return chalk.dim(`→ stored in ${place} (auto-approved) `) + laneTag;
}

/** The additive JSON fields that declare lane + destination + governance. */
export function laneJsonFields(report: LaneReport): Record<string, unknown> {
  return {
    lane: report.lane,
    workspaceId: report.workspaceId,
    workspaceName: report.workspaceName,
    governance: report.governance,
  };
}

/** Detect the governance outcome from a hub write response (entity / proposal). */
export function writeGovernance(res: Record<string, unknown>): Governance {
  return res.status === "proposed" ||
    Boolean(res.proposalId) ||
    Number(res.proposalsCreated ?? 0) > 0
    ? "proposed"
    : "auto";
}

/**
 * The ONE honest write reporter. Every write command routes its hub response
 * through this so the AI gets a consistent, guiding signal:
 *   • stored   → live now, recallable via `ask`
 *   • proposed → gated/refrained, awaiting human approval, NOT yet live
 * One human line + lane line; `--json` adds an `outcome` field while preserving
 * the original response fields (backward-compatible).
 */
export async function reportWrite(
  res: Record<string, unknown>,
  o: {
    label: string;
    lane: CaptureLane;
    workspaceId?: string;
    cfg: HubConfig;
    json?: boolean;
  }
): Promise<void> {
  const governance = writeGovernance(res);
  const report: LaneReport = {
    lane: o.lane,
    workspaceId: o.workspaceId,
    workspaceName: o.workspaceId
      ? await resolveWorkspaceName(o.workspaceId, o.cfg)
      : o.lane === "global" || o.lane === "user"
        ? "pod-wide"
        : undefined,
    governance,
  };
  const id = String(res.id ?? res.entityId ?? "");
  const proposalId = String(res.proposalId ?? "");

  if (o.json) {
    console.log(
      JSON.stringify(
        {
          ...res,
          outcome: governance === "proposed" ? "proposed" : "stored",
          ...laneJsonFields(report),
        },
        null,
        2
      )
    );
    return;
  }

  if (governance === "proposed") {
    // A proposal is normal (a PR under review), NOT a failure — neutral tone,
    // never an alarm. The agent keeps composing; it just goes live on approval.
    log.info(`${o.label} — proposed (under review)`);
    if (proposalId) log.dim(`  proposal: ${proposalId.slice(0, 8)}`);
    // Expose the stable proposed entity ID so the AI can reference this entity
    // in cross-write proposal graphs (e.g. create entity B linked to entity A).
    const proposedEntityId = String(res.proposedEntityId ?? "");
    if (proposedEntityId) log.dim(`  entity: ${proposedEntityId.slice(0, 8)}`);
  } else {
    log.success(`${o.label}${id ? "  " + chalk.dim(id.slice(0, 8)) : ""}`);
  }
  console.log("  " + formatLaneLine(report));
}
