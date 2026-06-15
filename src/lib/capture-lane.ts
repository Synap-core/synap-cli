/**
 * Capture-lane transparency helpers.
 *
 * The four-lane capture model routes knowledge by KIND (not by active workspace):
 *
 *   | Lane     | Destination                          | Governance      |
 *   |----------|--------------------------------------|-----------------|
 *   | ai-self  | shared agent / memory workspace      | auto            |
 *   | user     | pod-wide user_observation            | gated / auto    |
 *   | global   | pod-wide procedural                  | gated           |
 *   | work     | the linked product workspace         | gated           |
 *
 * This module does NOT change WHERE a capture routes — it only makes the
 * destination + governance TRANSPARENT in command output, so an agent always
 * knows where its knowledge landed (which workspace, and whether it was
 * auto-stored or proposed for review).
 */

import chalk from "chalk";
import { hubGet, type HubConfig } from "./hub-client.js";

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
