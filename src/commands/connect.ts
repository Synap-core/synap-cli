/**
 * synap connect [thing]
 *
 * The umbrella for "plug something into my pod". It owns no logic of its own:
 * an agent goes through `synap agents add` (lib/agent-door.ts), a tool or
 * account through `synap cap connect`.
 *
 * Usage:
 *   synap connect                         (interactive: an AI agent, or a tool/account?)
 *   synap connect cursor                  (a client → synap agents add cursor)
 *   synap connect --tool gmail            (a tool or account → synap cap connect gmail)
 *   synap connect cursor --tool           (the tool reading of a name that is also a client)
 *   synap connect gmial                   (unknown name: stops, suggests the closest clients)
 *   synap connect claude-code --project <id>   (scope; default pod-wide)
 *   synap connect raycast                 (extension key + Raycast AI's HTTP MCP entry)
 *
 * Escape hatch for scripting:
 *   synap connect cursor --pod-url <url> --api-key <key>
 */

import prompts from "prompts";
import { log, banner } from "../utils/logger.js";
import { isTargetName, listTargets, type TargetName } from "../lib/targets.js";
import { suggestTargets, unknownClientMessage } from "../lib/target-suggest.js";
import { connectKnownAgent, resolveAgentPod } from "../lib/agent-door.js";

interface ConnectOptions {
  podUrl?: string;
  apiKey?: string;
  /** Legacy spelling of the positional. */
  target?: string;
  list?: boolean;
  /** Pod profile to use. */
  name?: string;
  /** Force the tool reading of a name that is also an agent client. */
  tool?: boolean;
  workspace?: string;
  project?: string;
  /** Legacy spellings of --workspace / --project. */
  pinWorkspace?: string;
  pinProject?: string;
}

export type ConnectRoute =
  | { kind: "agent"; target: TargetName }
  | { kind: "tool"; name?: string }
  | { kind: "unknown"; name: string; suggestions: TargetName[] }
  | { kind: "pick" };

/**
 * A known agent client wins a name. A tool comes ONLY from `--tool` (with no
 * name, it opens the tool picker). Any other name stops with the closest
 * client names: a typo (`generic.`) must never be sent to the tools path,
 * where it fails with a refusal that says nothing about the typo.
 */
export function routeConnect(thing: string | undefined, opts: { tool?: boolean } = {}): ConnectRoute {
  const t = thing?.trim() || undefined;
  if (opts.tool) return { kind: "tool", name: t };
  if (!t) return { kind: "pick" };
  if (isTargetName(t)) return { kind: "agent", target: t };
  return { kind: "unknown", name: t, suggestions: suggestTargets(t) };
}

export async function connect(thing: string | undefined, opts: ConnectOptions = {}): Promise<void> {
  banner();

  if (opts.list) {
    log.heading("Agents");
    listTargets();
    log.dim("Any other agent: synap agents add --name <name>  (prints a URL + key to paste)");
    log.heading("Tools & accounts");
    log.dim("synap connect --tool   lists the services this pod can connect");
    return;
  }

  const scope = {
    workspaceId: opts.workspace ?? opts.pinWorkspace,
    projectId: opts.project ?? opts.pinProject,
  };
  let route = routeConnect(thing ?? opts.target, { tool: opts.tool });

  if (route.kind === "unknown") {
    const [first, ...rest] = unknownClientMessage(route.name, route.suggestions);
    log.error(first);
    for (const line of rest) log.hint(line);
    process.exitCode = 1;
    return;
  }

  if (route.kind === "pick") {
    if (!process.stdin.isTTY) {
      log.error("Say what to connect: synap connect <client|tool>  (synap connect --list)");
      process.exitCode = 1;
      return;
    }
    const { what } = await prompts({
      type: "select",
      name: "what",
      message: "What are you connecting?",
      choices: [
        { title: "An AI agent", description: "Claude Code, Cursor, Codex, … or your own", value: "agent" },
        { title: "A tool or account", description: "Gmail, GitHub, Notion, …", value: "tool" },
      ],
    });
    if (!what) return;
    if (what === "agent") {
      const { agentsAdd } = await import("./agents.js");
      await agentsAdd(undefined, { workspace: scope.workspaceId, project: scope.projectId });
      return;
    }
    route = { kind: "tool" };
  }

  if (route.kind === "tool") {
    if (scope.projectId) log.warn("--project doesn't apply to a tool connection; ignored.");
    const { capabilityConnect } = await import("./capability.js");
    await capabilityConnect(route.name, { workspace: scope.workspaceId });
    return;
  }

  const pod = await resolveAgentPod({ podUrl: opts.podUrl, apiKey: opts.apiKey, profileName: opts.name });
  if (!pod) return;
  const ok = await connectKnownAgent(route.target, pod, scope);
  if (!ok) process.exitCode = 1;
}
