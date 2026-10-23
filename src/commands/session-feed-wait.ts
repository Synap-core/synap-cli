/**
 * `synap session wait [sessionId] --events <kinds>` and `--hook`.
 *
 * `--events` waits on the session CHANGE FEED (`lib/session-feed.ts`) instead
 * of answers only: answers, decided proposals, stage moves, the owner's room
 * messages and — on pods that deliver them — messages from another session's
 * agent (`session_message`). It prints each event's FENCED text, its intent
 * and its sender session, and the exact reply (with `--cause`).
 *
 * `--hook` is the same wait shaped for a Claude Code `asyncRewake` Stop hook
 * (installed by `synap hooks install-wake` / `synap init`): it blocks until a
 * wake-worthy event, prints the message on stderr and exits 2 — the code
 * Claude Code reads as "wake the model with this" — and exits 0 on everything
 * else (timeout, no attached session, a newer waiter, a failure), so a hook
 * can never wake an agent with an error and loop. The contract it relies on is
 * documented in `lib/wake-hook-settings.ts`.
 */

import chalk from "chalk";
import { log } from "../utils/logger.js";
import {
  resolveHubConfig,
  resolveActiveSessionId,
  renderHubError,
  type HubConfig,
} from "../lib/hub-client.js";
import { getClaudeSessionId } from "../lib/session-lens.js";
import { isUuid, requireFullId } from "../lib/id.js";
import { parseDuration } from "./proposals-await.js";
import {
  SESSION_MESSAGE_KIND,
  SessionMessagesUnsupportedError,
  WAKE_HOOK_DEFAULT_KINDS,
  isWakeEvent,
  parseEventKinds,
  renderFeedEvent,
  renderWakeMessage,
  waitForSessionFeed,
  type SessionFeedEvent,
  type SessionFeedWaitResult,
} from "../lib/session-feed.js";
import {
  claimWake,
  isWakeOwner,
  readWakeState,
  recordRead,
  takeDelivery,
  wakeStatePath,
} from "../lib/wake-state.js";
import { SESSION_WAIT_EXIT, type WaitSessionOpts } from "./session-wait.js";

export interface WaitSessionFeedOpts extends WaitSessionOpts {
  events?: string;
  once?: boolean;
  wakeOnly?: boolean;
  peek?: boolean;
  hook?: boolean;
}

/** What `--hook` exits with — Claude Code's asyncRewake reads 2 as "wake". */
export const WAKE_HOOK_EXIT = { WAKE: 2, IDLE: 0 } as const;

const DEFAULT_TIMEOUT_MS = 30 * 60_000;

function parseLimit(raw: string | undefined): number | undefined | null {
  if (raw === undefined) return undefined;
  const n = Number(raw);
  return Number.isInteger(n) && n >= 1 && n <= 100 ? n : null;
}

// ─── --events ─────────────────────────────────────────────────────────────────

export async function waitSessionFeedCommand(
  sessionIdArg: string | undefined,
  opts: WaitSessionFeedOpts
): Promise<void> {
  const fail = (msg: string): never => {
    console.error(chalk.red(msg));
    process.exit(SESSION_WAIT_EXIT.FAILURE);
  };
  let kinds: string[];
  try {
    kinds = opts.events ? parseEventKinds(opts.events) : [...WAKE_HOOK_DEFAULT_KINDS];
  } catch (e) {
    return fail((e as Error).message);
  }
  const timeoutMs = parseDuration(opts.timeout, DEFAULT_TIMEOUT_MS);
  if (timeoutMs === null) {
    return fail("Unparseable duration. Use a number with a unit: 500ms, 30s, 15m, 2h (bare number = seconds).");
  }
  const limit = parseLimit(opts.limit);
  if (limit === null) return fail("--limit must be a whole number between 1 and 100.");

  let cfg: HubConfig;
  let sessionId: string;
  let result: SessionFeedWaitResult;
  try {
    cfg = await resolveHubConfig(opts);
    const resolved = sessionIdArg ?? resolveActiveSessionId(cfg.podUrl);
    if (!resolved) {
      return fail("No session given and none attached to this terminal. Pass one, or run: synap session attach <id>");
    }
    requireFullId(resolved, "session", chalk, log);
    sessionId = resolved;
    if (!opts.json) {
      log.dim(
        `Waiting on session ${sessionId.slice(0, 8)} for ${kinds.join(", ")}${opts.wakeOnly ? " (wake-worthy only)" : ""} — up to ${timeoutMs < 120_000 ? `${Math.round(timeoutMs / 1000)}s` : `${Math.round(timeoutMs / 60_000)}m`}.`
      );
    }
    result = await waitForSessionFeed(sessionId, cfg, {
      kinds,
      // No --since: the pod's UNREAD mode — answers not picked up and mail not
      // read yet, of any age, so a message that landed before this wait counts.
      since: opts.since,
      timeoutMs,
      limit,
      stamp: !opts.peek,
      once: opts.once,
      ...(opts.wakeOnly ? { accept: isWakeEvent } : {}),
    });
  } catch (e) {
    if (e instanceof SessionMessagesUnsupportedError) return fail(e.message);
    renderHubError(e);
    process.exit(SESSION_WAIT_EXIT.FAILURE);
    return;
  }

  const resume = `synap session wait ${sessionId} --events ${kinds.join(",")}${opts.wakeOnly ? " --wake-only" : ""} --since ${result.nextSince ?? "<cursor>"}`;
  if (opts.json) {
    console.log(
      JSON.stringify(
        {
          sessionId,
          since: result.nextSince,
          events: result.events,
          state: result.state,
          hasMore: result.hasMore,
          skipped: result.skipped,
          ...(result.events.length === 0 ? { timedOut: true, elapsedMs: result.elapsedMs } : {}),
        },
        null,
        2
      )
    );
  } else if (result.events.length === 0) {
    log.error(`Timed out after ${Math.round(result.elapsedMs / 1000)}s — nothing new.`);
    if (result.skipped > 0) log.hint(`${result.skipped} event(s) read that do not wake (--wake-only).`);
    log.hint(`Resume  →  ${resume}`);
  } else {
    for (const e of result.events) {
      const [head, ...rest] = renderFeedEvent(e);
      log.success(head ?? e.kind);
      for (const line of rest) console.log(line);
    }
    if (result.skipped > 0) log.dim(`${result.skipped} other event(s) read that do not wake (--wake-only).`);
    if (result.hasMore) log.dim("More waiting: run the cursor line again.");
    log.dim(`Cursor  →  ${resume}`);
  }
  process.exit(result.events.length > 0 ? SESSION_WAIT_EXIT.ANSWERED : SESSION_WAIT_EXIT.TIMEOUT);
}

// ─── --hook ───────────────────────────────────────────────────────────────────

/** The Stop hook's stdin (`session_id`, `cwd`, …); `{}` when there is none. */
async function readHookInput(timeoutMs = 1_000): Promise<{ session_id?: string }> {
  if (process.stdin.isTTY) return {};
  return new Promise((resolve) => {
    let raw = "";
    const done = () => {
      process.stdin.removeAllListeners();
      process.stdin.pause();
      try {
        const v = JSON.parse(raw) as unknown;
        resolve(v && typeof v === "object" ? (v as { session_id?: string }) : {});
      } catch {
        resolve({});
      }
    };
    const timer = setTimeout(done, timeoutMs);
    timer.unref();
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => (raw += chunk));
    process.stdin.on("end", () => {
      clearTimeout(timer);
      done();
    });
    process.stdin.on("error", () => {
      clearTimeout(timer);
      done();
    });
  });
}

/** Write to stderr, THEN exit: a pipe write is async, and exit would cut it. */
function finishHook(code: number, message = ""): Promise<never> {
  return new Promise(() => {
    if (!message) process.exit(code);
    process.stderr.write(message, () => process.exit(code));
  });
}

/**
 * The hook's whole decision, without the process around it — what the tests
 * drive. Returns the exit code and the stderr text.
 */
export async function runWakeHook(
  sessionId: string,
  cfg: HubConfig,
  p: {
    kinds: string[];
    timeoutMs: number;
    conversationId: string | undefined;
    limit?: number;
    pollSeconds?: number;
    retryDelayMs?: number;
  }
): Promise<{ code: number; message: string }> {
  const file = wakeStatePath(p.conversationId, sessionId);
  const owner = claimWake(file);
  let kinds = p.kinds;
  let note = "";
  const deadline = Date.now() + p.timeoutMs;

  for (;;) {
    let result: SessionFeedWaitResult;
    try {
      result = await waitForSessionFeed(sessionId, cfg, {
        kinds,
        since: readWakeState(file).since ?? undefined,
        timeoutMs: Math.max(deadline - Date.now(), 1_000),
        limit: p.limit,
        pollSeconds: p.pollSeconds,
        retryDelayMs: p.retryDelayMs,
        accept: isWakeEvent,
        onCursor: (since) => recordRead(file, { since }),
        onSkipped: (carry: SessionFeedEvent[]) => recordRead(file, { since: null, carry }),
        shouldStop: () => !isWakeOwner(file, owner) && false,
      });
    } catch (e) {
      if (e instanceof SessionMessagesUnsupportedError && kinds.includes(SESSION_MESSAGE_KIND)) {
        kinds = kinds.filter((k) => k !== SESSION_MESSAGE_KIND);
        note = `[synap wake] ${e.message} Waiting on ${kinds.join(", ") || "nothing"} only.\n`;
        if (kinds.length === 0) return { code: WAKE_HOOK_EXIT.IDLE, message: note };
        continue;
      }
      // Never wake an agent with an error: a hook that exits 2 on a failure
      // would wake it, stop, re-arm and fail again, forever.
      return {
        code: WAKE_HOOK_EXIT.WAKE,
        message: `${note}[synap wake] not waiting: ${(e as Error).message}\n`,
      };
    }
    if (result.stopped) return { code: WAKE_HOOK_EXIT.IDLE, message: `${note}[synap wake] a newer wait took over.\n` };
    if (result.events.length === 0) return { code: WAKE_HOOK_EXIT.IDLE, message: `${note}[synap wake] timed out, nothing new.\n` };

    const delivery = takeDelivery(file, { events: result.events, since: result.nextSince });
    if (delivery.events.length === 0) {
      return { code: WAKE_HOOK_EXIT.IDLE, message: `${note}[synap wake] already delivered by another wait.\n` };
    }
    return {
      code: WAKE_HOOK_EXIT.WAKE,
      message: note + renderWakeMessage(sessionId, delivery.events, delivery.carried),
    };
  }
}

export async function waitSessionHookCommand(
  sessionIdArg: string | undefined,
  opts: WaitSessionFeedOpts
): Promise<void> {
  // `claude -p` (and the SDK without streaming input) runs an asyncRewake hook
  // in the FOREGROUND (Claude Code 2.1.309: backgrounded only when interactive
  // or with streaming input), so a wait here would hold the whole run open.
  const entrypoint = process.env.CLAUDE_CODE_ENTRYPOINT;
  if (entrypoint?.startsWith("sdk-")) {
    return finishHook(
      WAKE_HOOK_EXIT.IDLE,
      `[synap wake] not waiting: a non-interactive run (${entrypoint}) would block on this hook.\n`
    );
  }
  const input = await readHookInput();
  // The hook's stdin names the conversation; the lens and the conversation
  // header read it from the same variable the statusline uses.
  if (input.session_id && !getClaudeSessionId()) process.env.SYNAP_LENS_SESSION = input.session_id;

  let kinds: string[];
  try {
    kinds = opts.events ? parseEventKinds(opts.events) : [...WAKE_HOOK_DEFAULT_KINDS];
  } catch (e) {
    return finishHook(WAKE_HOOK_EXIT.IDLE, `[synap wake] ${(e as Error).message}\n`);
  }
  const timeoutMs = parseDuration(opts.timeout, DEFAULT_TIMEOUT_MS);
  const limit = parseLimit(opts.limit);
  if (timeoutMs === null || limit === null) {
    return finishHook(WAKE_HOOK_EXIT.IDLE, "[synap wake] bad --timeout or --limit.\n");
  }

  let cfg: HubConfig;
  try {
    cfg = await resolveHubConfig(opts);
  } catch (e) {
    return finishHook(WAKE_HOOK_EXIT.IDLE, `[synap wake] no pod: ${(e as Error).message}\n`);
  }
  const sessionId = sessionIdArg ?? resolveActiveSessionId(cfg.podUrl);
  if (!sessionId || !isUuid(sessionId)) {
    return finishHook(
      WAKE_HOOK_EXIT.IDLE,
      "[synap wake] no session attached to this terminal (synap session attach <id>), nothing to wait on.\n"
    );
  }
  const { code, message } = await runWakeHook(sessionId, cfg, {
    kinds,
    timeoutMs,
    conversationId: getClaudeSessionId(),
    limit,
  });
  return finishHook(code, message);
}
