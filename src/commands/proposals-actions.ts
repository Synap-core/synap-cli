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

/**
 * The bits of a capability.run proposal's post-execution `data` this command reads.
 *
 * ⚠️ `success` is OPTIONAL AND OFTEN ABSENT. The executor materializes
 * `data.runResult = runOutcome.result` verbatim (`executors/capability.ts`), so
 * the shape is whatever the verb returned. `market.install` returns
 * `{ status: "installed", result: { created: [...], failed: [] } }` — no
 * `success` anywhere. Treating a missing `success` as failure is what made a
 * SUCCESSFUL install ("Task Board", "Priority Matrix", "Task Calendar",
 * "All Tasks" — all four created and verified on the pod) print
 * `✗ Ran market.install — it failed: Unknown error`.
 *
 * Mirror image of the `status ?? "installed"` bug in `market.ts`: there a
 * missing discriminator defaulted to SUCCESS, here it defaulted to FAILURE.
 * Both are the same root — assuming a contract the producer never promised.
 */
interface CapabilityRunOutcome {
  verbId?: string;
  runResult?: {
    /** Present on tool/provider runs. ABSENT on verb runs — never assume it. */
    success?: boolean;
    error?: string;
    /** Verb-run discriminator, e.g. "installed". */
    status?: string;
    executionTimeMs?: number;
    result?: Record<string, unknown>;
  };
}

/** Statuses a verb uses to say "this worked". */
const SUCCESS_STATUSES = new Set(["installed", "updated", "unchanged", "ok", "success"]);

/**
 * Decide what actually happened, reading every honest marker and refusing to
 * guess. Returns "unclear" rather than defaulting either way — an approval that
 * reports neither outcome is a reporting bug worth seeing, not a silent verdict.
 */
export function classifyRun(
  rr: NonNullable<CapabilityRunOutcome["runResult"]>
): "ok" | "failed" | "unclear" {
  if (rr.success === false) return "failed";
  if (typeof rr.error === "string" && rr.error.length > 0) return "failed";
  if (rr.success === true) return "ok";
  if (rr.status && SUCCESS_STATUSES.has(String(rr.status).toLowerCase())) return "ok";
  if (rr.result && typeof rr.result === "object") return "ok";
  return "unclear";
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
    const verb = chalk.bold(data.verbId ?? "capability");
    const took = runResult.executionTimeMs ? chalk.dim(`  (${runResult.executionTimeMs}ms)`) : "";
    const verdict = classifyRun(runResult);

    if (verdict === "ok") {
      // Per-item isolation: a run can report `failed[]` while still succeeding
      // overall. Say so rather than printing a clean tick over partial damage.
      const result = (runResult.result ?? {}) as Record<string, unknown>;
      const failedItems = Array.isArray(result.failed) ? result.failed : [];
      if (failedItems.length > 0) {
        log.warn(`Ran ${verb} — completed with ${failedItems.length} failure(s)${took}`);
      } else {
        log.success(`Ran ${verb} successfully${took}`);
      }
      for (const [key, value] of Object.entries(result)) {
        if (value === undefined || value === null || value === "") continue;
        if (Array.isArray(value) && value.length === 0) continue;
        log.dim(`  ${key}: ${typeof value === "string" ? value : JSON.stringify(value)}`);
      }
      return;
    }

    if (verdict === "failed") {
      log.error(`Ran ${verb} — it failed:`);
      log.dim(`  ${runResult.error ?? "no reason was recorded"}`);
      if (runResult.error?.toLowerCase().includes("not approved")) {
        log.dim(`  → The underlying tool/skill needs approval. Run \`synap cap show <name>\` to see which, then re-run \`synap cap enable <name>\`.`);
      }
      return;
    }

    // Neither marker present. Do not invent a verdict in either direction.
    log.warn(`Ran ${verb} — it returned no outcome marker, so this cannot say whether it worked.`);
    log.dim(`  ${JSON.stringify(runResult).slice(0, 300)}`);
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
