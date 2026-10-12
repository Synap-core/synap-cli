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

/**
 * Hand an installer a key that is already approved — the device flow returns
 * one per agent the person approved with the computer (`device-connect.ts`).
 * The installer's own `provisionAgentKey` call then takes it instead of minting,
 * and `approveAgentKeysAtOnce` asks for nothing more for that agent.
 */
export function presetApprovedKey(agentType: string, key: ReadyAgentKey): void {
  ready.set(agentType, key);
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

/** One pending key, as the wait sees it. */
export interface PendingKeyWait {
  podUrl: string;
  pendingKey: string;
  pendingToken: string;
  humanApiKey: string;
}

export interface BatchApprovalDeps {
  provision?: typeof import("./targets.js").provisionAgentKey;
  /**
   * Wait for one pending key to go live. Default `waitForKeyLive`: it asks
   * about the pending key WITH the pending key (`/auth/key-state`), so the
   * wait still sees the approval when the person's own key is the one that
   * approval just replaced (2026-10-12). Older pods: the per-key pending door.
   */
  wait?: (p: PendingKeyWait) => Promise<import("./key-approval.js").KeyWaitOutcome>;
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
  const wait = deps.wait ?? (await import("./key-approval.js")).waitForKeyLive;
  const openUrl = deps.openUrl ?? (await import("./targets.js")).openBrowserUrl;
  const supportsBatch = deps.supportsBatch ?? podSupportsBatchApproval;
  const podBase = podUrl.replace(/\/$/, "");

  const pending: PendingKey[] = [];
  const notApproved: TargetName[] = [];
  const reasons: BatchApprovalResult["reasons"] = {};
  for (const target of targets) {
    const spec = TARGET_KEY_MINT[target];
    if (!spec) continue;
    // Approved already (with the computer, in the device flow): nothing to ask.
    if (ready.has(spec.agentType)) continue;
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
        wait({ podUrl: podBase, pendingKey: p.hubApiKey, pendingToken: p.pendingToken, humanApiKey })
      )
    );
    process.stdout.write("\n");
    const { clearPendingAgentKey } = await import("./pod.js");
    outcomes.forEach((o, i) => {
      const p = pending[i]!;
      const outcome = o.status === "fulfilled" ? o.value : null;
      if (outcome === "approved") {
        // Live now: the recorded request is done; the installer writes the key.
        clearPendingAgentKey(p.agentType, podUrl);
        ready.set(p.agentType, { hubApiKey: p.hubApiKey, agentUserId: p.agentUserId });
        return;
      }
      notApproved.push(p.target);
      if (outcome === "rejected") {
        clearPendingAgentKey(p.agentType, podUrl);
        reasons[p.target] = "It was declined on the pod.";
      } else if (outcome === "timeout") {
        // Still filed and recorded: the next connect resumes this request.
        reasons[p.target] = `Nobody approved it in time — approve it at ${p.reviewUrl}, then run: synap doctor --fix`;
      } else {
        reasons[p.target] = o.status === "rejected" && o.reason instanceof Error ? o.reason.message : String(o.status === "rejected" ? o.reason : "unknown");
      }
    });
  } finally {
    clearInterval(ticker);
  }
  const approved = pending.length - pending.filter((p) => notApproved.includes(p.target)).length;
  if (approved > 0) log.success(`Approved ${approved} agent${approved > 1 ? "s" : ""}.`);
  return { notApproved, reasons };
}
