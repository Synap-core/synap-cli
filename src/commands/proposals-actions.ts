import chalk from "chalk";
import { log } from "../utils/logger.js";
import { resolveHubConfig, hubPost, renderHubError } from "../lib/hub-client.js";
import { requireFullId } from "../lib/id.js";
import {
  classifyActiveCredential,
  isAgentReviewRejection,
  renderCannotReview,
} from "../lib/credential-class.js";
import {
  resolveReviewConfig,
  reviewGuard,
  terminalIo,
  announceReviewCredential,
} from "../lib/review-credential.js";
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
  requireFullId(id, "proposal", chalk, log);

  // ── Credential: the HUMAN key on disk, NOT the session's ambient key ───────
  // Resolved through `resolveReviewConfig`, a door that never consults
  // `$SYNAP_HUB_API_KEY`, `--api-key`, or `resolveHubConfig`'s ladder — in an
  // agent session that ambient key IS the agent's. See review-credential.ts for
  // the honest scope of this control (a guardrail against accident, not a
  // security boundary).
  const cred = resolveReviewConfig({ podUrl: opts.podUrl });
  if (cred.kind === "absent") {
    // No human key configured → the existing browser handoff, not an error.
    // Approval is still possible; it just happens where the human already is.
    log.info(`Approval is human review, and ${cred.reason}.`);
    renderCannotReview(id, await resolveHubConfig(opts), "approve");
    process.exit(1);
    return;
  }
  const cfg = cred.config;

  announceReviewCredential(cred);

  const guard = await reviewGuard(id, cfg.podUrl, terminalIo());
  if (!guard.ok) {
    process.exit(1);
    return;
  }

  try {
    // PRE-FLIGHT: an agent credential can NEVER approve — the pod hard-rejects
    // it (`rejectAgentReviewer`, _shared.ts:144-161). Still checked, because the
    // profile key on disk is not GUARANTEED to be a human key (an agent-only
    // install saves one too). Fail before the mutation attempt and point at the
    // door that works. `unknown` deliberately PROCEEDS so a key we can't
    // classify is never blocked locally — the 403 translation below is the
    // authoritative backstop.
    if ((await classifyActiveCredential(cfg)) === "agent") {
      renderCannotReview(id, cfg, "approve");
      process.exit(1);
    }

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
    // POST-HOC: the pre-flight classifier is a proxy (see credential-class.ts);
    // the server's 403 is the truth. Translate it into the same explanatory
    // message rather than dumping a raw "(HTTP 403)".
    if (isAgentReviewRejection(e)) {
      renderCannotReview(id, cfg, "approve");
      process.exit(1);
    }
    renderHubError(e);
    process.exit(1);
  }
}

// ─── rejectProposal ───────────────────────────────────────────────────────────

export async function rejectProposal(
  id: string,
  opts: BaseOpts & { reason?: string }
): Promise<void> {
  requireFullId(id, "proposal", chalk, log);
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
