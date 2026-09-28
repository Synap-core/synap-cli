/**
 * One-click approval for the agent keys `synap init` mints (V1 D5).
 *
 * Codex and Cursor each mint their agent key with `requireApproval`, and
 * `provisionAgentKey` used to open one review page per key and block on it.
 * Connecting both meant two pages and two clicks, one after the other.
 *
 * Now `init` mints every key that needs approval FIRST (deferred), opens ONE
 * page (`/approve-agents?keys=…` on the pod admin, backed by
 * `POST /api/hub/setup/agent/pending/approve-batch`), and polls every key
 * until the person approves them together. The approved keys are then handed
 * to the installers through `takePreApprovedKey`, so each installer's own
 * `provisionAgentKey` call returns the key the person already approved instead
 * of minting a second one.
 *
 * A pod older than the batch door has no `/approve-agents` page: `init`
 * probes the batch lookup door first and, when it is missing, opens each
 * key's own review page instead (every pod version serves those).
 */

import chalk from "chalk";
import type { TargetName } from "./targets.js";
import { log } from "../utils/logger.js";

/** How a target's installer mints its agent key — ONE table, read by both. */
export interface KeyMintSpec {
  agentType: string;
  idempotent: boolean;
}

/**
 * The targets whose installer mints an agent key that needs the person's
 * approval. Claude Code mints without approval and OpenClaw uses the person's
 * own key, so neither is here. The installers read their spec from this table
 * (`installCodex` / `installCursor`), so the pre-mint cannot ask for a key the
 * installer would not have asked for.
 */
export const TARGET_KEY_MINT: Partial<Record<TargetName, KeyMintSpec>> = {
  codex: { agentType: "codex", idempotent: true },
  cursor: { agentType: "cursor", idempotent: true },
};

export interface ReadyAgentKey {
  hubApiKey: string;
  agentUserId: string;
}

const ready = new Map<string, ReadyAgentKey>();

/** Take (once) the key already minted — and approved — for `agentType`. */
export function takePreApprovedKey(agentType: string): ReadyAgentKey | undefined {
  const key = ready.get(agentType);
  ready.delete(agentType);
  return key;
}

/** The ONE review page for several pending keys, on the same origin as a single key's review URL. */
export function batchReviewUrl(reviewUrl: string, keyIds: readonly string[]): string {
  const origin = new URL(reviewUrl).origin;
  return `${origin}/approve-agents?keys=${keyIds.map(encodeURIComponent).join(",")}`;
}

interface PendingKey extends ReadyAgentKey {
  target: TargetName;
  agentType: string;
  pendingToken: string;
  reviewUrl: string;
}

/**
 * Does this pod serve the batch approval page? Its lookup door answers 401/400
 * without a signed-in session; a pod older than it answers 404. Unreachable
 * reads as "no": the per-key pages work on every pod.
 */
export async function podSupportsBatchApproval(podUrl: string): Promise<boolean> {
  const res = await fetch(`${podUrl.replace(/\/$/, "")}/api/hub/setup/agent/pending/lookup`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ keyIds: [] }),
    signal: AbortSignal.timeout(10_000),
  }).catch(() => null);
  return res !== null && res.status !== 404;
}

export interface BatchApprovalDeps {
  provision?: typeof import("./targets.js").provisionAgentKey;
  poll?: typeof import("./approval-poll.js").pollForApproval;
  openUrl?: (url: string) => void;
  supportsBatch?: (podUrl: string) => Promise<boolean>;
}

export interface BatchApprovalResult {
  /** Targets the person did not approve (rejected, timed out, or the mint failed). */
  notApproved: TargetName[];
  /** Why, per target, for the one warning line `init` prints. */
  reasons: Partial<Record<TargetName, string>>;
}

/**
 * Mint every approval-gated key for `targets`, open one page, wait for all.
 * Returns the targets the person did NOT approve (rejected, timed out, or
 * failed to mint): `init` skips those instead of asking again, and prints
 * one line for each.
 */
export async function approveAgentKeysAtOnce(
  podUrl: string,
  humanApiKey: string,
  targets: readonly TargetName[],
  deps: BatchApprovalDeps = {}
): Promise<BatchApprovalResult> {
  const provision = deps.provision ?? (await import("./targets.js")).provisionAgentKey;
  const poll = deps.poll ?? (await import("./approval-poll.js")).pollForApproval;
  const openUrl = deps.openUrl ?? (await import("./targets.js")).openBrowserUrl;
  const supportsBatch = deps.supportsBatch ?? podSupportsBatchApproval;
  const podBase = podUrl.replace(/\/$/, "");

  const pending: PendingKey[] = [];
  const notApproved: TargetName[] = [];
  const reasons: BatchApprovalResult["reasons"] = {};
  for (const target of targets) {
    const spec = TARGET_KEY_MINT[target];
    if (!spec) continue;
    try {
      const r = await provision(podUrl, humanApiKey, spec.agentType, {
        idempotent: spec.idempotent,
        deferApproval: true,
      });
      if (r.pending) {
        pending.push({
          target,
          agentType: spec.agentType,
          hubApiKey: r.hubApiKey,
          agentUserId: r.agentUserId,
          ...r.pending,
        });
      } else {
        // Already valid (reused) or active on mint: nothing to approve.
        ready.set(spec.agentType, { hubApiKey: r.hubApiKey, agentUserId: r.agentUserId });
      }
    } catch (err) {
      notApproved.push(target);
      reasons[target] = err instanceof Error ? err.message : String(err);
    }
  }
  if (pending.length === 0) return { notApproved, reasons };

  // One key keeps its own review page (which every pod version serves); so do
  // several on a pod that predates the batch page.
  const batch = pending.length > 1 && (await supportsBatch(podUrl));
  const urls = batch
    ? [batchReviewUrl(pending[0]!.reviewUrl, pending.map((p) => p.pendingToken))]
    : pending.map((p) => p.reviewUrl);
  log.blank();
  log.info(
    batch
      ? `Approve your ${pending.length} agents in one step:`
      : pending.length > 1
        ? `Approve each of your ${pending.length} agents:`
        : "Approve your agent:"
  );
  for (const url of urls) {
    log.dim(url);
    openUrl(url);
  }
  process.stdout.write(chalk.dim("  Waiting for approval"));
  const ticker = setInterval(() => process.stdout.write(chalk.dim(".")), 2000);
  try {
    const outcomes = await Promise.allSettled(
      pending.map((p) =>
        poll<void>({
          url: `${podBase}/api/hub/setup/agent/pending/${p.pendingToken}`,
          headers: { Authorization: `Bearer ${humanApiKey}` },
          isApproved: (d) => (d as { status?: string }).status === "active",
          isRejected: (d) => (d as { status?: string }).status === "rejected",
          onApproved: () => undefined,
          rejectedError: "It was declined on the pod.",
          timeoutError: "Nobody approved it in time.",
        })
      )
    );
    process.stdout.write("\n");
    outcomes.forEach((o, i) => {
      const p = pending[i]!;
      if (o.status === "fulfilled") {
        ready.set(p.agentType, { hubApiKey: p.hubApiKey, agentUserId: p.agentUserId });
      } else {
        notApproved.push(p.target);
        reasons[p.target] = o.reason instanceof Error ? o.reason.message : String(o.reason);
      }
    });
  } finally {
    clearInterval(ticker);
  }
  const approved = pending.length - pending.filter((p) => notApproved.includes(p.target)).length;
  if (approved > 0) log.success(`Approved ${approved} agent${approved > 1 ? "s" : ""}.`);
  return { notApproved, reasons };
}
