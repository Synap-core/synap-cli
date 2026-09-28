/**
 * The agents step of `synap init`: approve every key in one step FIRST, then
 * install each agent, one line per agent ("✓ Codex connected"). An install's
 * own output is shown only when it failed.
 *
 * The approve and install doors are injected so the order and the per-agent
 * outcome are testable without a pod.
 */

import chalk from "chalk";
import type { TargetName } from "./targets.js";
import type { BatchApprovalResult } from "./batch-approval.js";
import { log } from "../utils/logger.js";

export interface InstallOutcome {
  ok: boolean;
  /** What the installer printed; replayed only on failure. */
  output: string;
  error?: string;
}

export interface ConnectAgentsDeps<T extends TargetName> {
  approve: (targets: readonly T[]) => Promise<BatchApprovalResult>;
  install: (target: T) => Promise<InstallOutcome>;
  /** Extra setup after a successful install (OpenClaw's skill + seed). */
  after?: (target: T) => Promise<void>;
  labelOf: (target: T) => string;
}

export interface ConnectAgentsResult<T extends TargetName> {
  connected: T[];
  notApproved: T[];
  failed: T[];
}

export function retryCommand(target: TargetName): string {
  return chalk.cyan(`synap connect --target=${target}`);
}

export async function connectAgents<T extends TargetName>(
  picked: readonly T[],
  deps: ConnectAgentsDeps<T>
): Promise<ConnectAgentsResult<T>> {
  const result: ConnectAgentsResult<T> = { connected: [], notApproved: [], failed: [] };
  if (picked.length === 0) return result;

  const { notApproved, reasons } = await deps.approve(picked);
  for (const target of picked) {
    const label = deps.labelOf(target);
    if (notApproved.includes(target)) {
      log.warn(`${label} wasn't approved. Retry: ${retryCommand(target)}`);
      const why = reasons[target];
      if (why) log.dim(why);
      result.notApproved.push(target);
      continue;
    }
    const outcome = await deps.install(target);
    if (!outcome.ok) {
      if (outcome.output) process.stdout.write(outcome.output);
      const why = outcome.error ? `: ${outcome.error.replace(/\.$/, "")}.` : ".";
      log.warn(`${label} wasn't connected${why} Retry: ${retryCommand(target)}`);
      result.failed.push(target);
      continue;
    }
    await deps.after?.(target);
    log.success(`${label} connected`);
    result.connected.push(target);
  }
  return result;
}
