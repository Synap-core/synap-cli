/**
 * Which program a worker starts for its agent: the ENGINE.
 *
 * The pod says which agent template the agent is an instance of (its roster,
 * `synap_list_agents` → `template.slug`, the pod's one template seam
 * `resolveAgentTemplate`). The template's `spec.wake` says how that agent
 * starts headless: a program, its argv with `{param}` placeholders. It is read
 * from the INSTALLED catalog package (`readAgentTemplateWake`, the same reader
 * as `synap agents add`), never from a list kept here.
 *
 * Two adapters:
 *   - `claude`  — a template whose harness is Claude Code keeps the worker's own
 *     richer path (stream-json, accounts, usage-limit resumes, design runs);
 *   - `program` — every other wake: the argv rendered from the run's params,
 *     the program spawned, its output and exit code are the run's result.
 *
 * Nothing here falls back silently: no template, a template without a wake, a
 * program missing from this computer, a roster that could not be read are each
 * refused with what to do.
 */

import fs from "node:fs";
import path from "node:path";
import { readAgentTemplateWake, type AgentTemplateWake, type AgentWakeSpec } from "../lib/agent-template.js";
import type { McpCallClient } from "../lib/mcp-call.js";
import { findOnPath } from "./worker-github-broker.js";

/** The harness the worker's own Claude Code path runs. */
export const CLAUDE_HARNESS = "claude-code";

export type WorkerEngine =
  | { kind: "claude"; template: string }
  | { kind: "program"; template: string; program: string; programPath: string; wake: AgentWakeSpec };

/** One line naming the engine, for the worker's start line and `install`. */
export function engineLine(e: WorkerEngine): string {
  return e.kind === "claude" ? `template ${e.template} (Claude Code)` : `template ${e.template} (${e.programPath})`;
}

/**
 * The template slug the pod's roster names for the agent `selfAgentId`.
 * `null` = the pod names no template for it. THROWS when the roster cannot be
 * read or does not list the agent: "no template" and "could not tell" are
 * different answers.
 */
export function rosterTemplateSlug(rosterText: string, selfAgentId: string): string | null {
  let roster: { agents?: Array<{ agentUserId?: unknown; template?: { slug?: unknown } | null }> };
  try {
    roster = JSON.parse(rosterText) as typeof roster;
  } catch {
    throw new Error(`the pod's agent roster could not be read: ${rosterText.slice(0, 160)}`);
  }
  if (!Array.isArray(roster?.agents)) throw new Error(`the pod's agent roster has no agents list: ${rosterText.slice(0, 160)}`);
  const self = roster.agents.find((a) => a?.agentUserId === selfAgentId);
  if (!self) throw new Error(`the pod's agent roster does not list this agent (${selfAgentId})`);
  const slug = self.template?.slug;
  return typeof slug === "string" && slug ? slug : null;
}

/**
 * The engine for `agent`, from the slug the pod names and that template's wake
 * block. `searchPath` is where a bare program name is looked up (the worker's
 * PATH). Pure apart from the file system check of the program.
 */
export function engineFor(
  agent: string,
  slug: string | null,
  tpl: AgentTemplateWake | null,
  searchPath: string | undefined
): WorkerEngine {
  if (!slug) {
    throw new Error(`The pod names no agent template for "${agent}", so this computer does not know how to start it.`);
  }
  if (!tpl) {
    // The pod's built-in Claude Code template, on a synap whose catalog package predates agent templates.
    if (slug === CLAUDE_HARNESS) return { kind: "claude", template: slug };
    throw new Error(
      `The agent template "${slug}" is not in the catalog installed with this synap. Update it (npm install -g @synap-core/cli@latest), then start the worker again.`
    );
  }
  if (tpl.harness === CLAUDE_HARNESS) return { kind: "claude", template: tpl.slug };
  if (!tpl.wake) {
    throw new Error(`The agent template "${tpl.slug}" has no wake: nothing can start "${agent}" on a computer.`);
  }
  const program = tpl.wake.program;
  const programPath = program.includes("/") ? (isExecutable(program) ? program : undefined) : findOnPath(program, searchPath, "/nonexistent");
  if (!programPath) {
    throw new Error(
      `${program} is not installed here (the "${tpl.slug}" template starts "${agent}" with it, and it is not on PATH). Install it, then start the worker again.`
    );
  }
  return { kind: "program", template: tpl.slug, program, programPath, wake: tpl.wake };
}

function isExecutable(file: string): boolean {
  try {
    fs.accessSync(file, fs.constants.X_OK);
    return fs.statSync(file).isFile();
  } catch {
    return false;
  }
}

const PLACEHOLDER = /\{([A-Za-z_][A-Za-z0-9_-]*)\}/g;

/**
 * The argv a wake runs with: each `{name}` replaced by that param's value. A
 * placeholder the run gives no value for, or a required param left out, THROWS:
 * a half-rendered argv would run the program with a literal `{prompt}`.
 */
export function renderWakeArgs(wake: AgentWakeSpec, values: Record<string, string>): string[] {
  for (const [name, p] of Object.entries(wake.params)) {
    if (p?.required && values[name] === undefined) throw new Error(`the wake needs the param "${name}", which this run does not give`);
  }
  return wake.args.map((arg) =>
    arg.replace(PLACEHOLDER, (_m, name: string) => {
      const v = values[name];
      if (v === undefined) throw new Error(`the wake arg "${arg}" needs {${name}}, which this run does not give`);
      return v;
    })
  );
}

/** The run's environment without the names the template strips (`spec.wake.env.strip`). */
export function stripWakeEnv(env: NodeJS.ProcessEnv, strip: readonly string[]): NodeJS.ProcessEnv {
  const out = { ...env };
  for (const name of strip) delete out[name];
  return out;
}

/** The program's directory, for a service's bare PATH. */
export function programDir(e: WorkerEngine): string | undefined {
  return e.kind === "program" ? path.dirname(e.programPath) : undefined;
}

/**
 * The engine of the agent this key is (`selfAgentId`): the pod's roster names
 * its template, the installed catalog says how that template wakes. A roster
 * the pod refused or that does not list the agent THROWS (never a guess).
 */
export async function resolveWorkerEngine(
  agent: string,
  mcp: McpCallClient,
  selfAgentId: string,
  searchPath: string | undefined,
  readTemplate: (slug: string) => AgentTemplateWake | null = (slug) => readAgentTemplateWake(slug)
): Promise<WorkerEngine> {
  const r = await mcp.call("synap_list_agents", {});
  if (r.isError) throw new Error(`the pod's agent roster could not be read: ${r.text.slice(0, 160)}`);
  const slug = rosterTemplateSlug(r.text, selfAgentId);
  return engineFor(agent, slug, slug ? readTemplate(slug) : null, searchPath);
}
