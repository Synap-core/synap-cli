import chalk from "chalk";
import { log } from "../utils/logger.js";
import { resolveHubConfig, hubPost, renderHubError } from "../lib/hub-client.js";
import { type BaseOpts } from "./data.js";

/** The bits of a capability.run proposal's post-execution `data` this command reads. */
interface CapabilityRunOutcome {
  verbId?: string;
  runResult?: {
    success?: boolean;
    error?: string;
    executionTimeMs?: number;
    result?: Record<string, unknown>;
  };
}

/**
 * Print what actually happened, not just "approved" — the point of the fix.
 * A `capability.run` proposal's real outcome (success + returned data, or the
 * exact denial reason like "Capability is not approved") lives in
 * `proposal.data.runResult`, materialized by the executor onto the row itself
 * (the approve mutation's own return value is just `{success:true}`). Any
 * other proposal type falls back to whatever `summary`/`targetName` it carries.
 */
function printOutcome(proposal: Record<string, unknown> | null | undefined): void {
  if (!proposal) return;
  const data = (proposal.data ?? {}) as Record<string, unknown> & CapabilityRunOutcome;
  const runResult = data.runResult;

  if (runResult) {
    if (runResult.success) {
      log.success(`Ran ${chalk.bold(data.verbId ?? "capability")} successfully` + (runResult.executionTimeMs ? chalk.dim(`  (${runResult.executionTimeMs}ms)`) : ""));
      const result = runResult.result ?? {};
      for (const [key, value] of Object.entries(result)) {
        if (value === undefined || value === null || value === "") continue;
        log.dim(`  ${key}: ${typeof value === "string" ? value : JSON.stringify(value)}`);
      }
    } else {
      log.error(`Ran ${chalk.bold(data.verbId ?? "capability")} — it failed:`);
      log.dim(`  ${runResult.error ?? "Unknown error"}`);
      if (runResult.error?.toLowerCase().includes("not approved")) {
        log.dim(`  → The underlying tool/skill needs approval. Run \`synap cap show <name>\` to see which, then re-run \`synap cap enable <name>\`.`);
      }
    }
    return;
  }

  const summary = (data.summary as string | undefined) ?? (data.targetName as string | undefined);
  if (summary) log.dim(`  ${summary}`);
}

// ─── approveProposal ──────────────────────────────────────────────────────────

export async function approveProposal(
  id: string,
  opts: BaseOpts & { reason?: string }
): Promise<void> {
  try {
    const cfg = await resolveHubConfig(opts);

    const res = await hubPost(
      `/proposals/${id}/approve`,
      { reason: opts.reason },
      cfg
    ) as Record<string, unknown>;

    if (opts.json) {
      console.log(JSON.stringify(res, null, 2));
      return;
    }

    log.success(`Proposal approved  ${chalk.dim(id.slice(0, 8))}`);
    if (opts.reason) log.dim(`  reason: ${opts.reason}`);
    printOutcome(res.proposal as Record<string, unknown> | undefined);
  } catch (e) {
    renderHubError(e);
    process.exit(1);
  }
}

// ─── rejectProposal ───────────────────────────────────────────────────────────

export async function rejectProposal(
  id: string,
  opts: BaseOpts & { reason?: string }
): Promise<void> {
  try {
    const cfg = await resolveHubConfig(opts);

    const res = await hubPost(
      `/proposals/${id}/reject`,
      { reason: opts.reason },
      cfg
    ) as Record<string, unknown>;

    if (opts.json) {
      console.log(JSON.stringify(res, null, 2));
      return;
    }

    log.success(`Proposal rejected  ${chalk.dim(id.slice(0, 8))}`);
    if (opts.reason) log.dim(`  reason: ${opts.reason}`);
  } catch (e) {
    renderHubError(e);
    process.exit(1);
  }
}
