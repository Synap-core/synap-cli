/**
 * `synap proposals await <id>` — block until a proposal is decided.
 *
 * The dev-loop primitive: an agent files a proposal, then WAITS for the human
 * to answer it before continuing. Without this the only shapes available were
 * "fire and forget" (the agent never learns the outcome) or a hand-rolled sleep
 * loop in every caller.
 *
 * Reuses `pollForApproval` — the ONE poll loop already shared by CP login and
 * agent-key provisioning. This command adds no second poller; it supplies the
 * predicates and a first immediate check so an already-decided proposal returns
 * without paying one interval of latency.
 *
 * Status vocabulary and the "still the person's to decide?" rule come from the
 * pod's own leaf (`@synap-core/types/proposals/attention`: `PROPOSAL_STATUSES`,
 * `STATUS_ATTENTION`), never a list kept here: a new pod status is classified
 * by the leaf, and a test iterates `PROPOSAL_STATUSES` to prove none falls
 * through. `approval_failed` ("approved, but applying it threw") is `decide`,
 * so the wait goes on instead of reporting a rejection nobody made.
 */

import chalk from "chalk";
import { log } from "../utils/logger.js";
import {
  resolveHubConfig,
  hubGet,
  renderHubError,
  type HubConfig,
} from "../lib/hub-client.js";
import { requireFullId } from "../lib/id.js";
import { pollForApproval } from "../lib/approval-poll.js";
import {
  PROPOSAL_STATUSES,
  STATUS_ATTENTION,
} from "@synap-core/types/proposals/attention";
import { PROPOSAL_STATUS_FILTERS, proposalStatusLabel } from "./data-extra.js";
import { type BaseOpts } from "./data.js";

// ─── status classification ────────────────────────────────────────────────────

/** Every value a proposal ROW can hold: the pod's own list, imported. */
export const PROPOSAL_ROW_STATUSES: readonly string[] = PROPOSAL_STATUSES;

/** Decided, and the decision was YES (the write stood or already executed). */
const YES_STATUSES = new Set(["approved", "auto_approved"]);

/** The status the pod sets when a person approved but the write then threw. */
export const APPROVAL_FAILED = "approval_failed";

export type ProposalOutcome = "approved" | "rejected" | "pending" | "unknown";

/**
 * Classify a proposal's status from the pod's attention rule.
 *
 * - `decide` (pending, approval_failed): a verdict is still owed, so keep
 *   waiting ("pending").
 * - `notice` / `history`: settled. YES for approved / auto_approved, else
 *   "rejected" (rejected, expired, withdrawn, reverted: the write did not
 *   stand).
 *
 * `unknown` is deliberately NON-terminal: a status this CLI has never heard of
 * may well be transient on a newer pod, and calling it "rejected" would be the
 * client inventing a decision the pod never made. An unknown status therefore
 * keeps polling and, failing that, times out (exit 2).
 */
export function classifyProposalStatus(status: string | undefined): ProposalOutcome {
  if (!status) return "unknown";
  const s = status.trim().toLowerCase();
  if (!Object.hasOwn(STATUS_ATTENTION, s)) return "unknown";
  const attention = STATUS_ATTENTION[s as keyof typeof STATUS_ATTENTION];
  if (attention === "decide") return "pending";
  return YES_STATUSES.has(s) ? "approved" : "rejected";
}

/** The wait line for `approval_failed`: the person approved, the write threw. */
export function approvalFailedLine(reviewHandle: string): string {
  return `Approved, but the write failed: retry or dismiss it at ${reviewHandle}`;
}

/** Process exit code for a finished await. */
export function exitCodeForOutcome(outcome: ProposalOutcome): number {
  if (outcome === "approved") return 0;
  if (outcome === "rejected") return 1;
  return 2; // pending at deadline, or an outcome we could not classify
}

/** Read `status` off a `GET /proposals/:id` body, tolerating an envelope. */
export function statusOf(data: unknown): string | undefined {
  if (!data || typeof data !== "object") return undefined;
  const row = data as Record<string, unknown>;
  const nested = row.proposal;
  const source =
    nested && typeof nested === "object" ? (nested as Record<string, unknown>) : row;
  const status = source.status;
  return typeof status === "string" ? status : undefined;
}

// ─── duration parsing ─────────────────────────────────────────────────────────

/**
 * Parse `30m` / `10s` / `2h` / a bare number of seconds into milliseconds.
 * Returns null for anything unparseable so the caller can name the accepted
 * shapes instead of silently defaulting.
 */
export function parseDuration(value: string | undefined, fallbackMs: number): number | null {
  if (value === undefined || value === null || String(value).trim() === "") return fallbackMs;
  const m = String(value).trim().toLowerCase().match(/^(\d+(?:\.\d+)?)\s*(ms|s|m|h)?$/);
  if (!m) return null;
  const n = Number(m[1]);
  if (!Number.isFinite(n) || n <= 0) return null;
  const unit = m[2] ?? "s";
  const factor = unit === "ms" ? 1 : unit === "s" ? 1000 : unit === "m" ? 60_000 : 3_600_000;
  return Math.round(n * factor);
}

// ─── the await ────────────────────────────────────────────────────────────────

export interface AwaitProposalResult {
  id: string;
  /** The last status actually observed, or undefined if none ever was. */
  status?: string;
  outcome: ProposalOutcome;
  elapsedMs: number;
  proposal?: Record<string, unknown>;
}

export interface AwaitProposalOptions {
  timeoutMs: number;
  intervalMs: number;
  /** Called ONCE, the first time the proposal is seen `approval_failed` (still waiting). */
  onApprovalFailed?: (proposal: Record<string, unknown>) => void;
}

/**
 * Poll until the proposal is terminal or the deadline elapses. Never throws for
 * a decision — a rejection is a RESULT, not an error. Only a genuinely broken
 * call (bad id, 403) propagates, via the first immediate check.
 */
export async function awaitProposal(
  id: string,
  cfg: HubConfig,
  opts: AwaitProposalOptions
): Promise<AwaitProposalResult> {
  const startedAt = Date.now();
  let warned = false;
  const noticeFailure = (d: unknown): void => {
    if (warned || statusOf(d) !== APPROVAL_FAILED) return;
    warned = true;
    opts.onApprovalFailed?.(d as Record<string, unknown>);
  };

  // First check is IMMEDIATE — an already-decided proposal must not pay a full
  // interval of latency, and a 404/403 must surface as an error now rather than
  // being swallowed as a retryable blip by the poll loop.
  const first = (await hubGet(`/proposals/${id}`, {}, cfg)) as Record<string, unknown>;
  const firstStatus = statusOf(first);
  const firstOutcome = classifyProposalStatus(firstStatus);
  noticeFailure(first);
  if (firstOutcome === "approved" || firstOutcome === "rejected") {
    return {
      id,
      status: firstStatus,
      outcome: firstOutcome,
      elapsedMs: Date.now() - startedAt,
      proposal: first,
    };
  }

  let lastStatus = firstStatus;
  let decided: { data: Record<string, unknown>; outcome: ProposalOutcome } | null = null;

  try {
    const approved = await pollForApproval<Record<string, unknown>>({
      url: `${cfg.podUrl.replace(/\/+$/, "")}/api/hub/proposals/${id}`,
      headers: { Authorization: `Bearer ${cfg.apiKey}` },
      intervalMs: opts.intervalMs,
      timeoutMs: opts.timeoutMs,
      isApproved: (d) => classifyProposalStatus(statusOf(d)) === "approved",
      isRejected: (d) => {
        const status = statusOf(d);
        if (status) lastStatus = status;
        if (classifyProposalStatus(status) !== "rejected") return false;
        decided = { data: d as Record<string, unknown>, outcome: "rejected" };
        return true;
      },
      onApproved: (d) => {
        const status = statusOf(d);
        if (status) lastStatus = status;
        return d as Record<string, unknown>;
      },
      // Track the last status seen even on ticks that are neither terminal.
      onTick: ({ data }) => {
        noticeFailure(data);
        const status = statusOf(data);
        if (status) lastStatus = status;
      },
    });
    return {
      id,
      status: statusOf(approved) ?? lastStatus,
      outcome: "approved",
      elapsedMs: Date.now() - startedAt,
      proposal: approved,
    };
  } catch {
    // `pollForApproval` throws for exactly two reasons: isRejected fired, or the
    // deadline elapsed. `decided` disambiguates without string-matching a message.
    if (decided) {
      const settled = decided as { data: Record<string, unknown>; outcome: ProposalOutcome };
      return {
        id,
        status: statusOf(settled.data) ?? lastStatus,
        outcome: "rejected",
        elapsedMs: Date.now() - startedAt,
        proposal: settled.data,
      };
    }
    return {
      id,
      status: lastStatus,
      outcome: lastStatus && classifyProposalStatus(lastStatus) === "pending" ? "pending" : "unknown",
      elapsedMs: Date.now() - startedAt,
    };
  }
}

/**
 * Human wording for a status. Goes through the SAME helper the listing uses
 * (`proposalStatusLabel`) so the two surfaces can never render one status two
 * ways — the fork that put "Refused" in one governance surface and "Rejected"
 * in another. An unrecognised value falls back to "undecided" rather than
 * leaking a raw token.
 */
function describeStatus(status: string | undefined): string {
  if (!status) return "undecided";
  const known = (PROPOSAL_STATUS_FILTERS as readonly string[]).includes(status);
  return known
    ? proposalStatusLabel(status as (typeof PROPOSAL_STATUS_FILTERS)[number])
    : "undecided";
}

// ─── command ──────────────────────────────────────────────────────────────────

const DEFAULT_TIMEOUT_MS = 30 * 60_000;
const DEFAULT_INTERVAL_MS = 10_000;

export async function awaitProposalCommand(
  id: string,
  opts: BaseOpts & { timeout?: string; interval?: string }
): Promise<void> {
  requireFullId(id, "proposal", chalk, log);

  const timeoutMs = parseDuration(opts.timeout, DEFAULT_TIMEOUT_MS);
  const intervalMs = parseDuration(opts.interval, DEFAULT_INTERVAL_MS);
  if (timeoutMs === null || intervalMs === null) {
    console.error(
      chalk.red(
        `Unparseable duration. Use a number with a unit: 500ms, 30s, 15m, 2h (bare number = seconds).`
      )
    );
    process.exit(2);
    return;
  }

  let cfg: HubConfig;
  let result: AwaitProposalResult;
  try {
    cfg = await resolveHubConfig(opts);
    if (!opts.json) {
      log.dim(
        `Waiting for proposal ${id.slice(0, 8)} — checking every ${Math.round(intervalMs / 1000)}s, up to ${Math.round(timeoutMs / 60_000)}m.`
      );
    }
    result = await awaitProposal(id, cfg, {
      timeoutMs,
      intervalMs,
      onApprovalFailed: (p) => {
        if (opts.json) return;
        const nested = p.proposal && typeof p.proposal === "object" ? (p.proposal as Record<string, unknown>) : p;
        const url = typeof nested.reviewUrl === "string" ? nested.reviewUrl : `synap open proposal ${id}`;
        log.error(approvalFailedLine(url));
      },
    });
  } catch (e) {
    renderHubError(e);
    process.exit(2);
    return;
  }

  if (opts.json) {
    console.log(
      JSON.stringify(
        {
          id: result.id,
          status: result.status ?? null,
          outcome: result.outcome,
          elapsedMs: result.elapsedMs,
        },
        null,
        2
      )
    );
  } else if (result.outcome === "approved") {
    log.success(`Proposal ${describeStatus(result.status)}  ${chalk.dim(id.slice(0, 8))}`);
  } else if (result.outcome === "rejected") {
    log.error(`Proposal ${describeStatus(result.status)}  ${chalk.dim(id.slice(0, 8))}`);
  } else {
    log.error(
      `Timed out after ${Math.round(result.elapsedMs / 1000)}s — still ${describeStatus(result.status)}.`
    );
    log.dim(`  Review  →  synap open proposal ${id}`);
  }

  process.exit(exitCodeForOutcome(result.outcome));
}
