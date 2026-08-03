/**
 * synap automate
 *
 * The natural-language front door for automations. It deliberately delegates
 * to the deployed workspace agent instead of attempting to parse a workflow in
 * the CLI. That keeps capability discovery, connection checks, and proposal
 * governance in the same path as the rest of the product.
 */

import chalk from "chalk";
import {
  agentAsk,
  type AgentAskOpts,
} from "./agent-chat.js";

export interface AutomateOpts extends Omit<AgentAskOpts, "message" | "agentType"> {}

type Ask = (opts: AgentAskOpts) => Promise<void>;

const AUTOMATION_BRIEF = `You are handling a request to set up a Synap automation. Work through the deployed Synap capabilities and governance path; do not use an ad-hoc workflow parser.

Before proposing anything, inspect the existing capabilities, installed templates, and relevant workspace context. Identify any missing capability or connection prerequisite explicitly. Never install a capability, enable a capability, create a connection, or authenticate an external service automatically.

First classify the request. "React" automations start from data already stored in Synap. "Ingest / store" requests start from an external source; verify that its connected source and inbound normalization into Synap already exist. Never invent an external trigger or claim data is stored when it is not. If the source is not available, explain the exact missing prerequisite and the smallest user-approved setup step; do not create an automation proposal yet.

Before proposing, declare the exact user-facing contract in three sections: "Gets data", "Stores in Synap", and "Reacts & sends". Empty sections are valid. These are promises, not guesses from node names, and must match the dataContract supplied to create_automation.

Only when the requested automation is grounded in existing, available capabilities and connections, create a governed automation proposal for the user to review. Do not directly create, activate, or enable an automation. If it is not grounded, explain the missing prerequisites and the smallest user-approved next step.`;

/** Build the canonical, governance-first instruction sent to the workspace agent. */
export function buildAutomatePrompt(instruction: string): string {
  return `${AUTOMATION_BRIEF}\n\nUser request:\n${instruction.trim()}`;
}

/**
 * Send a natural-language automation request through the proven agent-ask
 * channel. The optional dependency makes this thin adapter straightforward to
 * verify without network calls.
 */
export async function automate(
  instruction: string,
  opts: AutomateOpts,
  ask: Ask = agentAsk
): Promise<void> {
  if (!instruction.trim()) {
    // Match `agent ask`'s fail-fast behavior: otherwise the canonical brief
    // itself would make an empty user instruction look non-empty to agentAsk.
    console.error(
      chalk.red(
        'Error: an instruction is required. Usage: synap automate "your automation request"'
      )
    );
    process.exit(1);
    return;
  }

  await ask({
    ...opts,
    message: buildAutomatePrompt(instruction),
  });
}
