/**
 * Which program a worker starts for its agent: the ENGINE.
 *
 * The pod says which agent template the agent is an instance of, and how that
 * template starts headless (its roster, `synap_list_agents` → `template.slug`
 * and `template.wake`, the pod's one template seam `resolveAgentTemplate`): a
 * program and its argv with `{param}` placeholders. The pod is the source. Only
 * when it serves no block (an older pod, or a built-in template the pod holds
 * no row for) is the block read from the catalog installed with this synap
 * (`readAgentTemplateWake`). Never a list kept here.
 *
 * What a pod serves becomes a program run on this computer, so it is PINNED
 * (`checkEnginePin`): the first run or `synap worker install` records the
 * program, its absolute path and the argv shape in
 * `~/.synap/worker/<agent>/engine.json`; a later start that would run anything
 * else is refused until the person runs `synap worker install` again.
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
import { writeFileAtomic } from "../lib/atomic-file.js";
import { findOnPath } from "./worker-github-broker.js";

/** The harness the worker's own Claude Code path runs. */
export const CLAUDE_HARNESS = "claude-code";

/** Where the wake block came from: the pod's roster, or this synap's catalog (an older pod, a built-in template). */
export type WakeSource = "pod" | "catalog";

export type WorkerEngine =
  | { kind: "claude"; template: string; version?: string | null; source?: WakeSource }
  | {
      kind: "program";
      template: string;
      program: string;
      programPath: string;
      wake: AgentWakeSpec;
      version?: string | null;
      source?: WakeSource;
    };

/** One line naming the engine, for the worker's start line and `install`. */
export function engineLine(e: WorkerEngine): string {
  return e.kind === "claude" ? `template ${e.template} (Claude Code)` : `template ${e.template} (${e.programPath})`;
}

/** The roster's template ref for one agent, as the pod serves it. */
export interface RosterTemplate {
  slug: string;
  /** The catalog version the pod installed it at; `null` = built in. */
  version: string | null;
  /**
   * The wake block the pod serves. `undefined` = this pod does not serve one
   * (older than the field); `null` = it serves none for this template.
   */
  wake: AgentWakeSpec | null | undefined;
}

/**
 * The template the pod's roster names for the agent `selfAgentId`, with the
 * wake block it serves. `null` = the pod names no template for it. THROWS when
 * the roster cannot be read or does not list the agent, or serves a wake block
 * that is not one: "no template" and "could not tell" are different answers.
 */
export function rosterTemplate(rosterText: string, selfAgentId: string): RosterTemplate | null {
  let roster: {
    agents?: Array<{ agentUserId?: unknown; template?: { slug?: unknown; version?: unknown; wake?: unknown } | null }>;
  };
  try {
    roster = JSON.parse(rosterText) as typeof roster;
  } catch {
    throw new Error(`the pod's agent roster could not be read: ${rosterText.slice(0, 160)}`);
  }
  if (!Array.isArray(roster?.agents)) throw new Error(`the pod's agent roster has no agents list: ${rosterText.slice(0, 160)}`);
  const self = roster.agents.find((a) => a?.agentUserId === selfAgentId);
  if (!self) throw new Error(`the pod's agent roster does not list this agent (${selfAgentId})`);
  const t = self.template;
  const slug = t?.slug;
  if (typeof slug !== "string" || !slug) return null;
  return {
    slug,
    version: typeof t!.version === "string" ? t!.version : null,
    wake: t && "wake" in t ? (t.wake == null ? null : servedWake(slug, t.wake)) : undefined,
  };
}

/** The template slug the pod's roster names for the agent (see `rosterTemplate`). */
export function rosterTemplateSlug(rosterText: string, selfAgentId: string): string | null {
  return rosterTemplate(rosterText, selfAgentId)?.slug ?? null;
}

/** A wake block as the pod serves it (`AgentTemplateWake`), read strictly: it becomes a program run here. */
function servedWake(slug: string, raw: unknown): AgentWakeSpec {
  const w = raw as { program?: unknown; args?: unknown; params?: unknown; env?: { strip?: unknown } };
  const args = w?.args ?? [];
  if (typeof w?.program !== "string" || !Array.isArray(args) || !args.every((a) => typeof a === "string")) {
    throw new Error(`the pod serves a wake block for "${slug}" that is not one (it needs a program and a list of string args)`);
  }
  const strip = Array.isArray(w.env?.strip) ? w.env!.strip.filter((x): x is string => typeof x === "string") : [];
  const params = w.params && typeof w.params === "object" ? (w.params as AgentWakeSpec["params"]) : {};
  return { program: w.program, args: args as string[], params, envStrip: strip };
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
  // The Claude Code adapter: the claude-code template, or any wake that starts `claude` itself.
  if (tpl.harness === CLAUDE_HARNESS || tpl.slug === CLAUDE_HARNESS || tpl.wake?.program === "claude") {
    return { kind: "claude", template: tpl.slug };
  }
  if (!tpl.wake) {
    throw new Error(`The agent template "${tpl.slug}" has no wake: nothing can start "${agent}" on a computer.`);
  }
  const program = tpl.wake.program;
  // A template names a program, never a path (the catalog refuses one): what runs is found on THIS computer's PATH.
  if (!/^[^/\\\s]+$/.test(program)) {
    throw new Error(`The agent template "${tpl.slug}" names its program as "${program}", not a bare program name: refused.`);
  }
  const programPath = findOnPath(program, searchPath, "/nonexistent");
  if (!programPath) {
    throw new Error(
      `${program} is not installed here (the "${tpl.slug}" template starts "${agent}" with it, and it is not on PATH). Install it, then start the worker again.`
    );
  }
  return { kind: "program", template: tpl.slug, program, programPath, wake: tpl.wake };
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
  const ref = rosterTemplate(r.text, selfAgentId);
  if (!ref) return engineFor(agent, null, null, searchPath);
  // The pod serves the block (an installed template): it is the source. A built-in template
  // (version null) or a pod older than the field serves none: this synap's catalog answers.
  const fromPod = ref.wake !== undefined && !(ref.wake === null && ref.version === null);
  const tpl: AgentTemplateWake | null = fromPod
    ? { slug: ref.slug, harness: ref.slug, wake: ref.wake ?? null }
    : readTemplate(ref.slug);
  const e = engineFor(agent, ref.slug, tpl, searchPath);
  return { ...e, version: ref.version, source: fromPod ? "pod" : "catalog" };
}

// ─── the pin: what this computer agreed to run ────────────────────────────────

/** What `engine.json` records: the command this computer runs for the agent. */
export interface EnginePin {
  template: string;
  version: string | null;
  kind: WorkerEngine["kind"];
  program: string;
  /** Absolute path of the program (Claude: the worker's --claude-bin decides, so none). */
  programPath: string | null;
  args: string[];
  pinnedAt: string;
}

export function enginePinPath(home: string, agent: string): string {
  return path.join(home, ".synap", "worker", agent, "engine.json");
}

export function pinFor(e: WorkerEngine, now: Date = new Date()): EnginePin {
  return e.kind === "claude"
    ? { template: e.template, version: e.version ?? null, kind: "claude", program: "claude", programPath: null, args: [], pinnedAt: now.toISOString() }
    : {
        template: e.template,
        version: e.version ?? null,
        kind: "program",
        program: e.program,
        programPath: e.programPath,
        args: e.wake.args,
        pinnedAt: now.toISOString(),
      };
}

const commandOf = (p: Pick<EnginePin, "kind" | "program" | "args" | "programPath">) =>
  p.kind === "claude" ? "Claude Code" : [p.programPath ?? p.program, ...p.args].join(" ");

/** Write the pin: `synap worker install` (the person accepting what runs), or a first run. */
export function writeEnginePin(home: string, agent: string, e: WorkerEngine, now?: Date): EnginePin {
  const pin = pinFor(e, now);
  const file = enginePinPath(home, agent);
  // Atomic and 0600 even over an existing file (a bare writeFileSync applies the mode on create only).
  writeFileAtomic(file, `${JSON.stringify(pin, null, 2)}\n`, { mode: 0o600 });
  return pin;
}

export type PinCheck = { status: "pinned" | "same" } | { status: "version"; from: string | null; to: string | null };

/**
 * Before a start: the engine must be what this computer agreed to run. No pin
 * yet = the first run pins it. The same command (template, program, path,
 * argv) = runs; only the template version moved = runs, the pin follows. Any
 * other difference THROWS, naming both commands and how to accept the new one.
 * An unreadable pin also throws (never a silent re-pin).
 */
export function checkEnginePin(home: string, agent: string, e: WorkerEngine, now?: Date): PinCheck {
  const file = enginePinPath(home, agent);
  let raw: string;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    writeEnginePin(home, agent, e, now);
    return { status: "pinned" };
  }
  let pin: EnginePin;
  try {
    pin = JSON.parse(raw) as EnginePin;
  } catch {
    throw new Error(`${file} cannot be read. Run \`synap worker install --agent ${agent}\` again to record what this computer runs.`);
  }
  const want = pinFor(e, now);
  const same =
    pin.template === want.template &&
    pin.kind === want.kind &&
    pin.program === want.program &&
    pin.programPath === want.programPath &&
    JSON.stringify(pin.args) === JSON.stringify(want.args);
  if (!same) {
    throw new Error(
      `${agent}'s wake changed on your pod (${pin.template}: ${commandOf(pin)} → ${want.template}: ${commandOf(want)}). ` +
        `This computer runs only what it agreed to: run \`synap worker install --agent ${agent}\` again to accept it.`
    );
  }
  if (pin.version !== want.version) {
    writeEnginePin(home, agent, e, now);
    return { status: "version", from: pin.version, to: want.version };
  }
  return { status: "same" };
}
