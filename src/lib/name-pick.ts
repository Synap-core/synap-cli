/**
 * Turn a name match (`name-match.ts`) into the one thing to act on, or a
 * refusal that names what the person probably meant.
 *
 * - exact: returned as is, nothing asked.
 * - near, in a terminal: "Did you mean X?" (one) or a pick list (several).
 * - near, not a terminal or `--json`: refused, with each suggestion's command.
 * - none: refused, with the command that lists what exists.
 */

import chalk from "chalk";
import prompts from "prompts";
import { log } from "../utils/logger.js";
import type { NameMatch } from "./name-match.js";

export interface PickOptions<T> {
  /** What the person typed. */
  query: string;
  /** "capability", "workspace", … */
  noun: string;
  /** How an item is named back to the person. */
  labelOf: (item: T) => string;
  /** The command to run for one suggestion: `synap cap add "Cal.com Scheduling"`. */
  commandFor: (item: T) => string;
  /** The command that lists every one: `synap cap list`. */
  listCommand: string;
  /** False under `--json` or with no terminal: never prompt. */
  interactive?: boolean;
}

export function isInteractiveTerminal(json?: boolean): boolean {
  return !json && !!process.stdin.isTTY && !!process.stdout.isTTY;
}

/** Print the refusal, with suggestions when there are any. */
export function refuseUnknownName<T>(candidates: readonly T[], o: PickOptions<T>): void {
  log.error(`No ${o.noun} named "${o.query}".`);
  if (candidates.length === 0) {
    log.hint(`See what exists:  ${o.listCommand}`);
    return;
  }
  log.hint(candidates.length === 1 ? "Did you mean:" : "Did you mean one of these:");
  for (const c of candidates) log.hint(`  ${o.commandFor(c)}`);
}

/** The item to act on, or undefined after printing why (the caller exits). */
export async function pickByName<T>(
  match: NameMatch<T>,
  o: PickOptions<T>
): Promise<T | undefined> {
  if (match.kind === "exact") return match.item;
  if (match.kind === "none") {
    refuseUnknownName([], o);
    return undefined;
  }
  const interactive = o.interactive ?? isInteractiveTerminal();
  if (!interactive) {
    refuseUnknownName(match.candidates, o);
    return undefined;
  }

  if (match.candidates.length === 1) {
    const only = match.candidates[0]!;
    const answer = await prompts({
      type: "confirm",
      name: "ok",
      message: `No ${o.noun} named "${o.query}". Did you mean ${chalk.bold(o.labelOf(only))}?`,
      initial: true,
    });
    if (answer.ok) return only;
    refuseUnknownName([], o);
    return undefined;
  }

  const none = -1;
  const answer = await prompts({
    type: "select",
    name: "index",
    message: `No ${o.noun} named "${o.query}". Did you mean:`,
    choices: [
      ...match.candidates.map((c, i) => ({ title: o.labelOf(c), value: i })),
      { title: chalk.dim("None of these"), value: none },
    ],
  });
  if (typeof answer.index !== "number" || answer.index === none) {
    refuseUnknownName([], o);
    return undefined;
  }
  return match.candidates[answer.index];
}
