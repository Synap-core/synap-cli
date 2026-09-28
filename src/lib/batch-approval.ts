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

export interface BatchApprovalDeps {
  provision?: typeof import("./targets.js").provisionAgentKey;
  poll?: typeof import("./approval-poll.js").pollForApproval;
  openUrl?: (url: string) => void;
}

/**
 * Mint every approval-gated key for `targets`, open one page, wait for all.
 * Returns the targets the person did NOT approve (rejected, timed out, or
 * failed to mint) — `init` skips those instead of asking again.
 */
export async function approveAgentKeysAtOnce(
  podUrl: string,
  humanApiKey: string,
  targets: readonly TargetName[],
  deps: BatchApprovalDeps = {}
): Promise<{ notApproved: TargetName[] }> {
  const provision = deps.provision ?? (await import("./targets.js")).provisionAgentKey;
  const poll = deps.poll ?? (await import("./approval-poll.js")).pollForApproval;
  const openUrl = deps.openUrl ?? (await import("./targets.js")).openBrowserUrl;
  const podBase = podUrl.replace(/\/$/, "");

  const pending: PendingKey[] = [];
  const notApproved: TargetName[] = [];
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
      log.warn(`${spec.agentType}: ${err instanceof Error ? err.message : String(err)}`);
      notApproved.push(target);
    }
  }
  if (pending.length === 0) return { notApproved };

  // One key keeps its own review page (which every pod version serves).
  const url =
    pending.length === 1
      ? pending[0]!.reviewUrl
      : batchReviewUrl(pending[0]!.reviewUrl, pending.map((p) => p.pendingToken));
  log.info(
    pending.length > 1
      ? `\n  Approve your ${pending.length} agents in one step:`
      : "\n  Approve your agent:"
  );
  log.dim(`  ${url}`);
  openUrl(url);
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
          rejectedError: `${p.agentType} was not approved.`,
          timeoutError: `Timed out waiting for approval of ${p.agentType}.`,
        })
      )
    );
    process.stdout.write("\n");
    outcomes.forEach((o, i) => {
      const p = pending[i]!;
      if (o.status === "fulfilled") {
        ready.set(p.agentType, { hubApiKey: p.hubApiKey, agentUserId: p.agentUserId });
      } else {
        log.warn(o.reason instanceof Error ? o.reason.message : String(o.reason));
        notApproved.push(p.target);
      }
    });
  } finally {
    clearInterval(ticker);
  }
  const approved = pending.length - pending.filter((p) => notApproved.includes(p.target)).length;
  if (approved > 0) log.success(`  Approved ${approved} agent key${approved > 1 ? "s" : ""}.`);
  return { notApproved };
}
