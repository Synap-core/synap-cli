/**
 * The agents step of `synap init`: approve every key in one step FIRST, then
 * install each agent, one line per agent ("✓ Codex connected"). An install's
 * own output is shown only when it failed.
 *
 * "connected" is printed only after `confirm` read back the key the install
 * wrote and the pod said it works (`confirmSurfaceKey`). A pod "no" prints the
 * doctor's diagnosis; a check that could not run prints "? … could not
 * confirm". Either way the agent counts as not connected.
 *
 * The approve, install and confirm doors are injected so the order and the
 * per-agent outcome are testable without a pod.
 */

import chalk from "chalk";
import type { TargetName } from "./targets.js";
import type { BatchApprovalResult } from "./batch-approval.js";
import type { SetupCheck } from "./key-doctor.js";
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
  /** Read back what the install wrote and ask the pod (`confirmSurfaceKey`). */
  confirm: (target: T) => Promise<SetupCheck>;
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

/**
 * The ONE place a setup prints "<Agent> connected": only for a confirmed key.
 * Returns whether the agent counts as connected.
 */
export function reportSetupCheck(label: string, check: SetupCheck, connectedLine = `${label} connected`): boolean {
  if (check.verdict === "active") {
    log.success(connectedLine);
    return true;
  }
  if (check.verdict === "unchecked") {
    log.success(`${label} set up — not checked: ${check.reason}`);
    return true;
  }
  if (check.verdict === "unconfirmed") {
    // A failed check, not a dead key: "?" as the doctor prints it. Still not
    // counted as connected, so a script's exit code sees it.
    console.error(chalk.yellow(`  ? ${label} set up — could not confirm: ${check.reason}`));
    log.hint("→ synap doctor");
    return false;
  }
  log.warn(`${check.title} — not connected.`);
  if (check.command) log.hint(`→ ${check.command}`);
  return false;
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
    if (reportSetupCheck(label, await deps.confirm(target))) result.connected.push(target);
    else result.failed.push(target);
  }
  return result;
}
