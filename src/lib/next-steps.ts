/**
 * The guided path — one graph of "what to run next", shared by the journey
 * commands so the CLI reads as a coherent flow instead of a pile of one-off
 * `log.dim("Run synap …")` hints.
 *
 * Two consumers, one source of truth:
 *   - HUMANS get a consistent, dim `Next:` block via `renderNextSteps()`.
 *   - AGENTS get the SAME `NextStep[]` in every journey command's `--json`
 *     output (a `nextSteps` field), so a script/agent can parse the graph and
 *     chain the next call without scraping prose.
 *
 * `command` is a full, runnable `synap …` invocation (paste-able / executable);
 * `why` is a crisp one-liner. Placeholders like `<id>` / `<slug>` stay literal
 * where the concrete value isn't known yet.
 */

import chalk from "chalk";
import { log } from "../utils/logger.js";

export interface NextStep {
  /** A full runnable command, e.g. `synap market --list`. */
  command: string;
  /** Why you'd run it next — one crisp line. */
  why: string;
}

/**
 * Print a consistent, dim `Next:` block (aligned `command  — why`). No-op on an
 * empty list. Goes to stdout via the `log.*` helpers, alongside ordinary output
 * detail (a next-step block is guidance, not an error).
 */
export function renderNextSteps(steps: NextStep[]): void {
  if (steps.length === 0) return;
  const width = Math.max(...steps.map((s) => s.command.length));
  log.blank();
  console.log(chalk.dim("  Next:"));
  for (const s of steps) {
    console.log(chalk.dim(`    ${s.command.padEnd(width)}  — ${s.why}`));
  }
}

/**
 * The canonical flow graph. Each edge is a small function returning 1–3
 * `NextStep`s for "you just did X → here's the sensible next move(s)."
 */
export const FLOW = {
  /** After switching the active pod. */
  afterPodUse(podName: string): NextStep[] {
    return [
      { command: "synap project use <id>", why: `focus a project on ${podName} to scope your work` },
      { command: "synap market --list", why: "see what you can install" },
      { command: "synap orient", why: "map this pod's projects + workspaces" },
    ];
  },

  /** After logging in to the Synap account (control plane). */
  afterLogin(email?: string): NextStep[] {
    return [
      {
        command: "synap market --list",
        why: email ? `your private packages (${email}) are now visible` : "your private packages are now visible",
      },
      { command: "synap market install <slug>", why: "install an OS / template pod-wide" },
    ];
  },

  /** After pinning a project as the active lens. */
  afterProjectUse(name: string): NextStep[] {
    return [
      { command: "synap market install <slug>", why: `add a package to ${name}` },
      { command: "synap market --list", why: "browse installable packages" },
      { command: "synap orient", why: "see what's already in this pod" },
    ];
  },

  /** After creating a new project. */
  afterProjectNew(name: string, id: string): NextStep[] {
    return [
      { command: "synap launch", why: `stand up an OS (project + core workspaces) in ${name}` },
      { command: `synap market install <slug> --project ${id}`, why: `add a single package to ${name}` },
    ];
  },

  /** After listing projects (or after orient). */
  afterProjectList(): NextStep[] {
    return [
      { command: "synap project use <id>", why: "focus a project (cross-cutting lens)" },
      { command: "synap project new <name>", why: "create a new company / initiative" },
    ];
  },

  /** After browsing the marketplace. */
  afterMarketList(): NextStep[] {
    return [
      { command: "synap market install <slug>", why: "install it pod-wide" },
      { command: "synap market install <slug> --project <id>", why: "optionally also tag its seeded entities to a project" },
    ];
  },

  /** After a market install. `proposed` = governance queued it for approval. */
  afterMarketInstall(args: { slug: string; proposed: boolean; projectName?: string }): NextStep[] {
    if (args.proposed) {
      return [{ command: "synap proposals list", why: `approve the queued install of ${args.slug}` }];
    }
    return [
      { command: "synap orient", why: `see ${args.slug} in ${args.projectName ?? "your pod"}` },
      { command: "synap open", why: "open it in the browser" },
    ];
  },

  /** After `synap launch` stands up a company/OS (pod-wide, or under a project). */
  afterLaunch(projectName?: string): NextStep[] {
    return [
      {
        command: "synap orient",
        why: projectName
          ? `see the new workspaces under ${projectName}`
          : "see the new workspaces",
      },
      { command: "synap market --list", why: "add more packages" },
    ];
  },

  /** After orienting on the pod. */
  afterOrient(): NextStep[] {
    return [
      { command: "synap project use <id>", why: "focus a project (cross-cutting lens)" },
      { command: "synap market --list", why: "browse installable packages" },
    ];
  },

  /** After `synap market update` found drift but didn't apply (no --yes / no slug). */
  afterMarketUpdateCheck(slugsWithUpdates: string[]): NextStep[] {
    if (slugsWithUpdates.length === 0) return [];
    const steps: NextStep[] = slugsWithUpdates
      .slice(0, 3)
      .map((slug) => ({ command: `synap market update ${slug}`, why: "apply this template's update" }));
    if (slugsWithUpdates.length > 1) {
      steps.push({ command: "synap market update --yes", why: "apply every available update, no prompt" });
    }
    return steps;
  },

  /** After `synap market installed` inventoried the pod (found drift or not). */
  afterMarketInstalledCheck(slugsWithUpdates: string[]): NextStep[] {
    if (slugsWithUpdates.length === 0) return [];
    const steps: NextStep[] = slugsWithUpdates
      .slice(0, 3)
      .map((slug) => ({ command: `synap market update ${slug}`, why: "preview this package's update" }));
    if (slugsWithUpdates.length > 1) {
      steps.push({ command: "synap market update --yes", why: "apply every available update, no prompt" });
    }
    return steps;
  },

  /** After `synap market update` applied one or more updates. */
  afterMarketUpdateApply(): NextStep[] {
    return [
      { command: "synap orient", why: "see what changed in the pod" },
      { command: "synap market update", why: "re-check for further drift" },
    ];
  },
};
