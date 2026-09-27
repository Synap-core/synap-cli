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

export function buildHandoff(connectedLabels: readonly string[]): Handoff {
  return {
    agentLabel: connectedLabels[0] ?? "your agent",
    prompt:
      "Use Synap. Research 10 competitors to <your product>, save them, " +
      "and ask me which 3 to contact.",
    more: [
      "Use Synap. Draft a short outreach email to the 3 I picked, and ask me before sending.",
      "Use Synap. Find duplicate contacts in my CRM and ask me which to merge.",
    ],
  };
}
