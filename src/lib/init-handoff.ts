/**
 * The last thing `synap init` prints: one real task to hand the agent, verbatim.
 *
 * The first prompt exercises the whole loop — the agent works in a session,
 * saves what it finds, then ASKS the person (the question lands on their phone)
 * and resumes on the answer.
 */

export interface Handoff {
  /** The agent to open, e.g. "Claude Code". */
  agentLabel: string;
  /** The prompt to paste into the agent, verbatim. */
  prompt: string;
  /** Two shorter follow-ups. */
  more: string[];
}

/**
 * MIRROR of `FIRST_AGENT_PROMPT` in synap-app
 * `packages/headless/src/onboarding-core/first-run.ts` — the one first prompt the
 * desktop, relay and this CLI all hand the person. The CLI cannot import
 * synap-app; `test/first-agent-prompt-parity.test.ts` reads that source and
 * fails on any drift.
 */
export const FIRST_AGENT_PROMPT =
  "Use Synap. Research 10 competitors to <your product>, save them, and ask me which 3 to contact.";

export function buildHandoff(connectedLabels: readonly string[]): Handoff {
  return {
    agentLabel: connectedLabels[0] ?? "your agent",
    prompt: FIRST_AGENT_PROMPT,
    more: [
      "Use Synap. Draft a short outreach email to the 3 I picked, and ask me before sending.",
      "Use Synap. Find duplicate contacts in my CRM and ask me which to merge.",
    ],
  };
}
