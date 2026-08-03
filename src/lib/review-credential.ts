/**
 * Review-verb credential + guardrail — `synap proposals approve` (and revert).
 *
 * ── What this is ─────────────────────────────────────────────────────────────
 * Approving a proposal is HUMAN review: it is the act that makes an agent's
 * proposed write real. The pod already refuses to let an agent credential
 * approve (`rejectAgentReviewer`), which is correct but leaves the human with
 * no CLI door at all — the agent key is the one in the session's environment.
 *
 * RATIFIED: review verbs authenticate with the HUMAN key stored in the pod
 * profile on disk (`pods.<name>.hubApiKey` in `~/.synap/config.json`), and fall
 * back to the browser/deep-link handoff when no such key exists.
 *
 * ── What this is NOT ─────────────────────────────────────────────────────────
 * **This is not a hard security boundary, and must not be described as one.**
 * The agent runs as the same OS user as the human. It can read
 * `~/.synap/config.json` directly, it can spawn a PTY, and it can call the pod
 * over HTTP without going through this CLI at all. Nothing here stops a
 * deliberate bypass by a capable adversary.
 *
 * What it DOES stop is the realistic failure mode: an agent reaching for
 * `synap proposals approve <id>` as an ordinary next tool call — because it is
 * right there in the help text, because it just filed the proposal, or because
 * a human said "go ahead". Three independent obstacles, each cheap:
 *
 *   1. TTY-only        — an agent subprocess has no controlling terminal, so
 *                        the verb fails CLOSED before any network call.
 *   2. Typed phrase    — a deliberate word, not a keypress. `--yes` does NOT
 *                        bypass it; blind auto-confirmation is the whole thing
 *                        being prevented.
 *   3. Env isolation   — the key is read ONLY from the pod profile on disk,
 *                        never from `$SYNAP_HUB_API_KEY` or any other inherited
 *                        variable, and never through `resolveHubConfig`'s
 *                        normal ladder. An agent session's ambient credential
 *                        therefore cannot become the reviewer by accident.
 *
 * Treat it as a guardrail against accident and casual tool-call misuse. The
 * real boundary is, and remains, the pod's own authorization.
 */

import chalk from "chalk";
import { log } from "../utils/logger.js";
import { getActivePodConfig } from "./pod.js";
import type { HubConfig } from "./hub-client.js";

/** The word the human must type. Deliberate, unambiguous, and not a default-able keypress. */
export const REVIEW_CONFIRM_PHRASE = "approve";

export type ReviewCredential =
  /** A human key was found on disk — the caller may proceed to the guard. */
  | { kind: "human"; config: HubConfig; podName: string; identity?: string }
  /** No pod profile / no key on disk — the caller must hand off to the browser. */
  | { kind: "absent"; reason: string };

/**
 * Resolve the credential for a REVIEW verb — deliberately NOT `resolveHubConfig`.
 *
 * `resolveHubConfig` exists to answer "what key should this command use", and
 * its ladder starts at `--api-key` and `$SYNAP_HUB_API_KEY`. That is right for
 * every ordinary verb and wrong for this one: the ambient variable in an agent
 * session IS the agent's key, so reusing that ladder would quietly make the
 * agent the reviewer. This is a separate door on purpose — a branch inside
 * `resolveHubConfig` would be one refactor away from leaking the env rung back
 * in.
 *
 * NOTE: `--pod-url` is still honoured (it selects WHICH pod, not WHO you are),
 * but `--api-key` is not: passing a key on the command line is exactly the
 * substitution this door refuses.
 */
export function resolveReviewConfig(opts: { podUrl?: string } = {}): ReviewCredential {
  const profile = getActivePodConfig();
  if (!profile) {
    return { kind: "absent", reason: "no pod profile is saved in ~/.synap/config.json" };
  }
  if (!profile.hubApiKey) {
    return { kind: "absent", reason: `the saved pod profile has no key` };
  }
  return {
    kind: "human",
    // `??` is NOT enough here: these fields are persisted as "" by some connect
    // paths, and an empty string is not null — it rendered the announcement as
    // "Reviewing as  — human key", which is worse than no line at all.
    podName: profile.label?.trim() || profile.podUrl,
    identity: profile.agentUserId?.trim() || undefined,
    config: {
      podUrl: opts.podUrl ?? profile.podUrl,
      apiKey: profile.hubApiKey,
      userId: profile.agentUserId,
      workspaceId: profile.workspaceId,
    } as HubConfig,
  };
}

export type GuardResult =
  | { ok: true }
  /** Refused. `message` has already been rendered; the caller should exit non-zero. */
  | { ok: false; reason: "non-interactive" | "declined" };

/** Injectable I/O so the guard is testable without a real terminal. */
export interface GuardIo {
  isStdinTty: boolean;
  isStdoutTty: boolean;
  /** Read one line from the human. Only called when both streams are TTYs. */
  prompt: (question: string) => Promise<string>;
}

/** The real terminal. Kept out of {@link reviewGuard} so tests never touch stdin. */
export function terminalIo(): GuardIo {
  return {
    isStdinTty: Boolean(process.stdin.isTTY),
    isStdoutTty: Boolean(process.stdout.isTTY),
    prompt: async (question: string) => {
      const readline = await import("node:readline/promises");
      const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
      try {
        return await rl.question(question);
      } finally {
        rl.close();
      }
    },
  };
}

/**
 * Gate a review verb behind an interactive, typed confirmation.
 *
 * FAILS CLOSED without a terminal: an agent subprocess is non-interactive, and
 * a guard that degraded to "no TTY, so skip the prompt" would be no guard at
 * all — that degradation is the single most common way this control class is
 * defeated by accident.
 *
 * `--yes` is deliberately not a parameter here. Auto-confirmation is precisely
 * what must not be reachable, so the flag cannot be plumbed in even by mistake.
 */
export async function reviewGuard(
  id: string,
  podUrl: string,
  io: GuardIo
): Promise<GuardResult> {
  if (!io.isStdinTty || !io.isStdoutTty) {
    log.error("Approving a proposal requires an interactive terminal.");
    log.dim(
      "  This session has no TTY, so it cannot be a human review. Approval is the\n" +
        "  act that makes an agent's proposed write real — it is not a step an\n" +
        "  automated run may take on the human's behalf."
    );
    log.blank();
    log.info("  Review it yourself:");
    log.dim(`    synap open proposal ${id}`);
    log.dim(`    ${podUrl.replace(/\/+$/, "")}/open/${encodeURIComponent(id)}`);
    return { ok: false, reason: "non-interactive" };
  }

  const answer = await io.prompt(
    `Type ${chalk.bold(REVIEW_CONFIRM_PHRASE)} to approve proposal ${chalk.dim(id.slice(0, 8))}: `
  );
  if (answer.trim().toLowerCase() !== REVIEW_CONFIRM_PHRASE) {
    log.warn("Not approved — confirmation phrase did not match.");
    return { ok: false, reason: "declined" };
  }
  return { ok: true };
}

/**
 * Announce WHICH credential is about to act. A silent credential switch — the
 * CLI quietly using a different identity than the session's ambient key — is
 * how this became confusing in the first place, and it is also what made an
 * earlier analysis conclude the CLI and MCP were different people.
 */
export function announceReviewCredential(cred: Extract<ReviewCredential, { kind: "human" }>): void {
  log.info(
    `Reviewing as ${chalk.bold(reviewCredentialLabel(cred))} ${chalk.dim("— human key from ~/.synap/config.json")}`
  );
}

/**
 * The name to show for a review credential. Falls back through identity → pod
 * label/url, never to an empty string: an announcement that renders as
 * "Reviewing as  " tells the operator less than nothing.
 */
export function reviewCredentialLabel(cred: Extract<ReviewCredential, { kind: "human" }>): string {
  return cred.identity || cred.podName || "the saved pod profile";
}
