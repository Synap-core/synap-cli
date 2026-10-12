/**
 * Waiting for a pending agent key to be approved — and resuming that wait.
 *
 * Two rules, both learnt from the 2026-10-12 incident:
 *
 *  1. The wait asks about the PENDING key, presenting the pending key itself
 *     (`/auth/key-state`). The old poll authenticated with the person's own
 *     key — which, mid-incident, was the very key the approval had just
 *     revoked, so the poll could never see the approval land.
 *  2. A request is never filed twice. A minted-but-unapproved key is recorded
 *     (`pendingAgentKeys`); the next connect / `doctor --fix` resumes it. Three
 *     orphaned requests accumulated in one evening before this.
 */

import chalk from "chalk";
import { log } from "../utils/logger.js";
import { fetchKeyState, type FetchLike, type KeyState } from "./key-state.js";
import type { PendingAgentKey } from "./pod.js";

/** The approval did not land in time. The request stays filed and resumable. */
export class AgentKeyAwaitingApprovalError extends Error {
  constructor(
    readonly agentType: string,
    readonly approvalUrl: string
  ) {
    super(
      `${agentType} is waiting for your approval — nothing was changed on this computer.\n` +
        `  Approve it: ${approvalUrl}\n` +
        `  Then finish with: synap doctor --fix`
    );
    this.name = "AgentKeyAwaitingApprovalError";
  }
}

export type KeyWaitOutcome = "approved" | "rejected" | "timeout";

export interface WaitForKeyLiveOpts {
  podUrl: string;
  /** The pending key's own plaintext — the bearer for `/auth/key-state`. */
  pendingKey: string;
  /** Older pods: its id, polled on `/setup/agent/pending/:id` with the human key. */
  pendingToken?: string;
  humanApiKey?: string;
  timeoutMs?: number;
  intervalMs?: number;
  fetch?: FetchLike;
  sleep?: (ms: number) => Promise<void>;
}

/**
 * Wait until the pod says the key is live (`approved`), refused
 * (`rejected`: revoked / expired / unknown), or the deadline passes.
 * Transient failures never end the wait early.
 */
export async function waitForKeyLive(opts: WaitForKeyLiveOpts): Promise<KeyWaitOutcome> {
  const f = opts.fetch ?? fetch;
  const sleep = opts.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  // SYNAP_APPROVAL_TIMEOUT_MS / SYNAP_APPROVAL_POLL_MS: wait longer for an
  // approval that needs a walk to the phone (and short in tests).
  const envMs = (name: string) => {
    const n = Number(process.env[name]);
    return Number.isFinite(n) && n > 0 ? n : undefined;
  };
  const interval = opts.intervalMs ?? envMs("SYNAP_APPROVAL_POLL_MS") ?? 2000;
  const deadline = Date.now() + (opts.timeoutMs ?? envMs("SYNAP_APPROVAL_TIMEOUT_MS") ?? 120_000);
  const base = opts.podUrl.replace(/\/+$/, "");
  while (Date.now() < deadline) {
    const s = await fetchKeyState(opts.podUrl, opts.pendingKey, { fetch: f });
    if (s.state === "active") return "approved";
    if (s.state === "revoked" || s.state === "expired" || s.state === "unknown") return "rejected";
    if (s.legacy && s.state === "inactive" && opts.pendingToken && opts.humanApiKey) {
      // Older pod: it cannot describe the pending key — ask the pending door.
      const res = await f(`${base}/api/hub/setup/agent/pending/${opts.pendingToken}`, {
        headers: { Authorization: `Bearer ${opts.humanApiKey}` },
        signal: AbortSignal.timeout(15_000),
      }).catch(() => null);
      const status = res?.ok ? ((await res.json().catch(() => ({}))) as { status?: string }).status : undefined;
      if (status === "active") return "approved";
      if (status === "rejected") return "rejected";
    }
    await sleep(interval);
  }
  return "timeout";
}

/**
 * What a recorded pending key is now: still waiting (resume it), live
 * (approved while we were away — promote it), or dead (forget it, file anew).
 * An unreachable pod keeps it recorded and says so (`unknown`).
 */
export async function classifyRecordedPending(
  pending: PendingAgentKey,
  deps: { fetch?: FetchLike } = {}
): Promise<{ kind: "pending" | "active" | "dead" | "unknown"; state: KeyState }> {
  const state = await fetchKeyState(pending.podUrl, pending.hubApiKey, deps);
  switch (state.state) {
    case "awaiting_approval":
      return { kind: "pending", state };
    case "active":
      return { kind: "active", state };
    case "revoked":
    case "expired":
    case "unknown":
      return { kind: "dead", state };
    case "inactive":
      // Older pod: inactive is either still pending or refused; resuming the
      // wait is safe (the pending door settles it), minting another is not.
      return { kind: "pending", state };
    case "unreachable":
      return { kind: "unknown", state };
  }
}

/** Print the approval link, open it, and wait — the one interactive wait. */
export async function openAndWait(
  agentType: string,
  approvalUrl: string,
  wait: () => Promise<KeyWaitOutcome>,
  openUrl: (url: string) => void
): Promise<KeyWaitOutcome> {
  log.info(`\n  Approve ${agentType} on your pod:`);
  log.dim(`  ${approvalUrl}`);
  openUrl(approvalUrl);
  process.stdout.write(chalk.dim("  Waiting for approval"));
  const ticker = setInterval(() => process.stdout.write(chalk.dim(".")), 2000);
  try {
    return await wait();
  } finally {
    clearInterval(ticker);
    process.stdout.write("\n");
  }
}
