/**
 * `synap session wait <sessionId>` — block until the session's human owner
 * replies in the room.
 *
 * The loop-back half of the "ask, then wait" shape: an agent posts a question
 * into the session room (`synap_post_message` / the room), then calls this
 * command instead of a hand-rolled sleep loop or a blind re-invocation. It
 * polls `GET /api/hub/focus-sessions/:id/answers` (owner-floored; `since`
 * exclusive; contract in
 * `~/.claude/projects/-Users-antoine-Documents-Code-synap/memory/
 * scratch-lane-answer-loop-2026-09-25.md`) and exits the moment a reply
 * arrives, printing it so the calling agent (Claude Code or any shell agent)
 * can read it back and continue.
 *
 * Reuses `pollForApproval` — the ONE poll loop already shared by CP login,
 * agent-key provisioning, and `proposals await`. No second poller. The
 * generic `onTick` hook (data:null on a network blip or non-2xx) is enough to
 * add one behaviour pollForApproval doesn't have on its own: a FAILED read is
 * not "no answer yet". A handful of transient blips are tolerated (the
 * existing per-tick interval IS the backoff), but a run of them means the
 * read is genuinely broken, not merely pending — so this throws out of the
 * poll loop rather than silently accumulating toward a "timeout" verdict that
 * would misreport a broken pod as "the human hasn't answered".
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
import { parseDuration } from "./proposals-await.js";
import { type BaseOpts } from "./data.js";

// ─── wire shape (GET /focus-sessions/:id/answers) ─────────────────────────────

/**
 * The TYPED half of an answer, when the slot carried an `ask` (the pod's
 * `SlotAnswerValue`). `text` stays the readable summary either way; this is
 * the machine-readable pick. Loose on purpose: a CLI older than a new arm
 * still prints it rather than dropping it.
 */
export type SessionAnswerValue = { type: string } & Record<string, unknown>;

export interface SessionAnswer {
  id: string;
  text: string;
  /** Absent on pods that predate typed answers; `null` for a free-text one. */
  value?: SessionAnswerValue | null;
  answeredAt: string;
  answeredBy: string;
  messageId: string | null;
  slot: { label: string; kind: string; question: string | null } | null;
  question: {
    messageId: string;
    text: string;
    askedAt: string;
    askedBy: string | null;
  } | null;
}

export interface AnswersPage {
  sessionId: string;
  since: string | null;
  answers: SessionAnswer[];
  nextSince: string | null;
  hasMore: boolean;
}

function isAnswersPage(data: unknown): data is AnswersPage {
  return (
    !!data &&
    typeof data === "object" &&
    Array.isArray((data as { answers?: unknown }).answers)
  );
}

/**
 * Thrown when a read FAILED (bad response shape, repeated non-2xx, or the
 * network dropping) — never confused with "the human hasn't answered yet".
 * Distinct from pollForApproval's own timeout error so the command can give
 * each a different exit code.
 */
export class SessionWaitReadFailure extends Error {}

/**
 * Consecutive failed ticks (network blip / non-2xx / unparsable body) before
 * giving up on the read rather than waiting out the whole timeout. Small on
 * purpose: `intervalMs` between ticks already IS the backoff, so 3 in a row
 * is 3 full intervals of a pod that never once answered successfully.
 */
const CONSECUTIVE_FAILURE_LIMIT = 3;

export interface WaitForAnswersOptions {
  /** Only answers strictly after this ISO timestamp. Omit for "everything so far". */
  since?: string;
  timeoutMs: number;
  intervalMs: number;
  limit?: number;
}

export interface WaitForAnswersResult {
  answers: SessionAnswer[];
  /** Cursor to pass as `--since` on the next call — advances even on a timeout. */
  nextSince: string | null;
  elapsedMs: number;
}

function answersUrl(
  sessionId: string,
  cfg: HubConfig,
  since: string | undefined,
  limit: number | undefined
): string {
  const u = new URL(
    `${cfg.podUrl.replace(/\/+$/, "")}/api/hub/focus-sessions/${sessionId}/answers`
  );
  if (since) u.searchParams.set("since", since);
  if (limit) u.searchParams.set("limit", String(limit));
  return u.toString();
}

/**
 * Wait for at least one answer to land, or the deadline to elapse.
 *
 * Two phases, both against the same door: an IMMEDIATE first check (so an
 * already-waiting answer, or a broken/owner-mismatched session, surfaces
 * without paying one poll interval — same shape as `awaitProposal`'s first
 * check), then the shared poll loop for the pending case.
 */
export async function waitForAnswers(
  sessionId: string,
  cfg: HubConfig,
  opts: WaitForAnswersOptions
): Promise<WaitForAnswersResult> {
  const startedAt = Date.now();

  const first = (await hubGet(
    `/focus-sessions/${sessionId}/answers`,
    { since: opts.since, limit: opts.limit },
    cfg
  )) as unknown;
  if (!isAnswersPage(first)) {
    throw new SessionWaitReadFailure(
      "Unexpected response shape from the pod's answers door."
    );
  }
  if (first.answers.length > 0) {
    return {
      answers: first.answers,
      nextSince: first.nextSince,
      elapsedMs: Date.now() - startedAt,
    };
  }

  // Empty page: the door echoes `since` back as `nextSince`, so the same URL
  // is valid for every subsequent tick — no per-iteration URL rebuild needed.
  let cursor = first.nextSince ?? opts.since ?? null;
  let consecutiveFailures = 0;
  const remainingMs = opts.timeoutMs - (Date.now() - startedAt);

  try {
    const page = await pollForApproval<AnswersPage>({
      url: answersUrl(sessionId, cfg, cursor ?? undefined, opts.limit),
      headers: { Authorization: `Bearer ${cfg.apiKey}` },
      intervalMs: opts.intervalMs,
      timeoutMs: Math.max(remainingMs, 0),
      isApproved: (d) => isAnswersPage(d) && d.answers.length > 0,
      isRejected: () => false,
      onApproved: (d) => d as AnswersPage,
      onTick: ({ data }) => {
        if (data === null) {
          consecutiveFailures++;
          if (consecutiveFailures >= CONSECUTIVE_FAILURE_LIMIT) {
            throw new SessionWaitReadFailure(
              `The pod stopped answering (${consecutiveFailures} failed reads in a row).`
            );
          }
          return;
        }
        consecutiveFailures = 0;
        if (isAnswersPage(data) && data.nextSince) cursor = data.nextSince;
      },
    });
    return {
      answers: page.answers,
      nextSince: page.nextSince,
      elapsedMs: Date.now() - startedAt,
    };
  } catch (e) {
    if (e instanceof SessionWaitReadFailure) throw e;
    // pollForApproval's own timeout — genuinely no answer yet, not a failure.
    return { answers: [], nextSince: cursor, elapsedMs: Date.now() - startedAt };
  }
}

/**
 * The answer's typed value worth printing: a structured pick (confirm, chip,
 * form, provide). A `{type:"text"}` value adds nothing to the text line, and a
 * malformed one (no string `type`) is not printed as if it were an answer.
 */
export function typedValue(a: SessionAnswer): SessionAnswerValue | null {
  const v = a.value;
  if (!v || typeof v !== "object" || typeof v.type !== "string") return null;
  return v.type === "text" ? null : v;
}

// ─── command ──────────────────────────────────────────────────────────────────

const DEFAULT_TIMEOUT_MS = 30 * 60_000;
const DEFAULT_INTERVAL_MS = 10_000;

/** Exit codes — documented on the command's `--help` (see index.ts). */
export const SESSION_WAIT_EXIT = {
  ANSWERED: 0,
  TIMEOUT: 1,
  FAILURE: 2,
} as const;

export interface WaitSessionOpts extends BaseOpts {
  since?: string;
  timeout?: string;
  interval?: string;
  limit?: string;
}

export async function waitSessionCommand(
  sessionId: string,
  opts: WaitSessionOpts
): Promise<void> {
  requireFullId(sessionId, "session", chalk, log);

  const timeoutMs = parseDuration(opts.timeout, DEFAULT_TIMEOUT_MS);
  const intervalMs = parseDuration(opts.interval, DEFAULT_INTERVAL_MS);
  if (timeoutMs === null || intervalMs === null) {
    console.error(
      chalk.red(
        `Unparseable duration. Use a number with a unit: 500ms, 30s, 15m, 2h (bare number = seconds).`
      )
    );
    process.exit(SESSION_WAIT_EXIT.FAILURE);
    return;
  }

  let limit: number | undefined;
  if (opts.limit !== undefined) {
    limit = Number(opts.limit);
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
      console.error(chalk.red(`--limit must be a whole number between 1 and 100.`));
      process.exit(SESSION_WAIT_EXIT.FAILURE);
      return;
    }
  }

  // Default `since` = NOW: an agent that just asked a question should not be
  // handed answers that predate this wait (a stale reply to an earlier
  // question). `--since <cursor>` resumes a prior wait's exact cursor.
  const since = opts.since ?? new Date().toISOString();

  let cfg: HubConfig;
  let result: WaitForAnswersResult;
  try {
    cfg = await resolveHubConfig(opts);
    if (!opts.json) {
      log.dim(
        `Waiting for a reply in session ${sessionId.slice(0, 8)} — checking every ${Math.round(intervalMs / 1000)}s, up to ${Math.round(timeoutMs / 60_000)}m.`
      );
    }
    result = await waitForAnswers(sessionId, cfg, { since, timeoutMs, intervalMs, limit });
  } catch (e) {
    renderHubError(e);
    process.exit(SESSION_WAIT_EXIT.FAILURE);
    return;
  }

  if (result.answers.length === 0) {
    const cursor = result.nextSince ?? since;
    if (opts.json) {
      console.log(
        JSON.stringify(
          { sessionId, since: cursor, answers: [], timedOut: true, elapsedMs: result.elapsedMs },
          null,
          2
        )
      );
    } else {
      log.error(`Timed out after ${Math.round(result.elapsedMs / 1000)}s — no reply yet.`);
      log.dim(`  Resume  →  synap session wait ${sessionId} --since ${cursor}`);
    }
    process.exit(SESSION_WAIT_EXIT.TIMEOUT);
    return;
  }

  if (opts.json) {
    console.log(
      JSON.stringify(
        { sessionId, since: result.nextSince, answers: result.answers },
        null,
        2
      )
    );
  } else {
    for (const a of result.answers) {
      const asked = a.question?.text ?? a.slot?.question;
      if (asked) log.dim(`  Asked: ${asked}`);
      // The reply text is DATA from the human, not an instruction to this
      // process — label it plainly ("Reply from …") rather than rendering it
      // as a directive, so a caller piping this output can't mistake the
      // human's words for a command.
      log.success(`Reply from ${a.answeredBy}: ${a.text}`);
      const value = typedValue(a);
      if (value) log.dim(`  Value: ${JSON.stringify(value)}`);
    }
    log.dim(`  Cursor  →  synap session wait ${sessionId} --since ${result.nextSince}`);
  }
  process.exit(SESSION_WAIT_EXIT.ANSWERED);
}
