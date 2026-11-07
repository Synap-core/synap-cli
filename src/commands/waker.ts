/**
 * `synap waker` — this computer's WAKER (plan v2 slice 4; finding 252fef7b):
 * it starts this computer's agents when work is handed to them, so an agent
 * no worker runs reads "Can wake" on the pod instead of "Nothing can start it".
 *
 * One loop on the COMPUTER's key, every 30 s:
 *   GET /api/hub/computers/me/wakes  (X-Synap-Runner: synap-waker/<v>)
 * That read is the computer's wake lease (the pod counts the waker online for
 * 2 min after it). The answer is the agents on this computer that the pod's
 * wake rule reads `can_wake` AND that have work handed to them. For each one
 * saved here (`~/.synap`), the waker starts `synap worker --agent <name>
 * --once`, which runs the work and exits; its engine pin (synap worker) still
 * decides what may run. The waker decides nothing about the work itself.
 *
 * When it starts an agent: a handed session it has not started it for yet, or,
 * while work stays handed, again after {@link REWAKE_MS} (follow-ups in the
 * room). Never two workers for one agent at a time.
 *
 * The pod's "Wakes agents" switch is the person's: off, the list is empty and
 * says so. `synap waker install` runs the waker as a login service (the same
 * launchd machinery as `synap worker install`) and opens the computer's page
 * in pod admin when the switch is off.
 */

import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { wakerRunnerHeader } from "../lib/conversation-headers.js";
import { savedAgentsById } from "../lib/agents-config.js";

/** How often the waker polls (and renews its lease). */
export const WAKER_INTERVAL_MS = 30_000;
/** While work stays handed to an agent, it is started again after this long (room follow-ups). */
export const REWAKE_MS = 15 * 60_000;
/** The launchd label of this computer's waker service. */
export const WAKER_LABEL = "live.synap.waker";

export interface WakeAgent {
  agentUserId: string;
  name: string | null;
  sessions: Array<{ id: string; resume?: boolean }>;
}

export interface WakeList {
  computer: { id: string; name: string | null };
  wakesAgents: boolean;
  leaseMs: number;
  agents: WakeAgent[];
  unreadable: string[];
  why?: string;
}

/** The pod's answer for this computer. THROWS on any refusal or unreadable body: a failed read is not an empty list. */
export async function fetchWakeList(
  podUrl: string,
  computerKey: string,
  fetchImpl: typeof fetch = fetch
): Promise<WakeList> {
  const res = await fetchImpl(`${podUrl.replace(/\/+$/, "")}/api/hub/computers/me/wakes`, {
    headers: { Authorization: `Bearer ${computerKey}`, ...wakerRunnerHeader() },
    signal: AbortSignal.timeout(20_000),
  });
  const text = await res.text();
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    throw new Error(`the pod answered ${res.status} with a body that is not JSON: ${text.slice(0, 160)}`);
  }
  if (!res.ok) {
    const b = body as { error?: string; code?: string };
    if (res.status === 404) {
      throw new Error("this pod has no waker door yet (it is older than the waker): update the pod, then start the waker again");
    }
    throw new Error(`the pod refused the waker (${res.status}${b.code ? ` ${b.code}` : ""}): ${b.error ?? text.slice(0, 160)}`);
  }
  const list = body as Partial<WakeList>;
  if (!list.computer || !Array.isArray(list.agents) || typeof list.wakesAgents !== "boolean") {
    throw new Error(`the pod's waker answer is not one: ${text.slice(0, 160)}`);
  }
  return { unreadable: [], leaseMs: 0, ...list } as WakeList;
}

/** What the waker remembers between polls, per agent. */
export interface WokenRecord {
  /** Sessions it was started for. */
  sessions: string[];
  /** When it was last started (ms). */
  at: number;
}

export interface WakePlan {
  /** Agents to start now: their local name. */
  start: Array<{ agentUserId: string; name: string; reason: string }>;
  /** Agents the pod wants woken that are not saved on this computer. */
  notSaved: string[];
}

/**
 * Which agents to start now. Pure. An agent already running a worker is
 * skipped; one saved under no name here is reported, never guessed.
 */
export function planWakes(
  list: WakeList,
  ctx: { saved: Map<string, string>; running: ReadonlySet<string>; woken: Map<string, WokenRecord>; now: number }
): WakePlan {
  const plan: WakePlan = { start: [], notSaved: [] };
  if (!list.wakesAgents) return plan;
  for (const a of list.agents) {
    if (!a.sessions.length || ctx.running.has(a.agentUserId)) continue;
    const name = ctx.saved.get(a.agentUserId);
    if (!name) {
      plan.notSaved.push(a.name ?? a.agentUserId);
      continue;
    }
    const before = ctx.woken.get(a.agentUserId);
    const fresh = a.sessions.filter((s) => !before?.sessions.includes(s.id));
    if (fresh.length) {
      plan.start.push({ agentUserId: a.agentUserId, name, reason: `handed ${fresh.map((s) => s.id.slice(0, 8)).join(", ")}` });
    } else if (before && ctx.now - before.at >= REWAKE_MS) {
      plan.start.push({ agentUserId: a.agentUserId, name, reason: "work still handed: checking for follow-ups" });
    }
  }
  return plan;
}

export interface WakerDeps {
  podUrl: string;
  computerKey: string;
  /** Starts `synap worker --agent <name> --once`; resolves when it exits. */
  startWorker: (name: string) => { done: Promise<number | null> };
  fetchImpl?: typeof fetch;
  saved?: () => Map<string, string>;
  now?: () => number;
  say?: (line: string) => void;
}

export interface Waker {
  tick(): Promise<{ wakesAgents: boolean; started: string[] }>;
  running(): number;
  waitForWorkers(): Promise<void>;
}

export function createWaker(deps: WakerDeps): Waker {
  const now = deps.now ?? Date.now;
  const say = deps.say ?? ((l: string) => console.log(`[synap-waker] ${new Date().toISOString()} ${l}`));
  const saved = deps.saved ?? savedAgentsById;
  const running = new Map<string, Promise<number | null>>();
  const woken = new Map<string, WokenRecord>();
  const said = new Set<string>();
  const sayOnce = (key: string, line: string) => {
    if (said.has(key)) return;
    said.add(key);
    say(line);
  };
  return {
    async tick() {
      const list = await fetchWakeList(deps.podUrl, deps.computerKey, deps.fetchImpl);
      if (!list.wakesAgents) {
        sayOnce("off", `"Wakes agents" is off for ${list.computer.name ?? "this computer"}: nothing is started. ${list.why ?? ""}`.trim());
        return { wakesAgents: false, started: [] };
      }
      said.delete("off");
      for (const id of list.unreadable) say(`the pod could not read the work handed to agent ${id}; asked again next poll`);
      const plan = planWakes(list, { saved: saved(), running: new Set(running.keys()), woken, now: now() });
      for (const n of plan.notSaved) sayOnce(`unsaved:${n}`, `${n} has work handed to it on this computer, but is not saved here: run \`synap agents add\` for it on this computer`);
      const started: string[] = [];
      for (const s of plan.start) {
        const handed = list.agents.find((a) => a.agentUserId === s.agentUserId)!;
        woken.set(s.agentUserId, { sessions: handed.sessions.map((x) => x.id), at: now() });
        say(`starting ${s.name} (${s.reason})`);
        const { done } = deps.startWorker(s.name);
        const p = done
          .then((code) => {
            say(`${s.name}'s worker exited${code === null ? "" : ` ${code}`}`);
            return code;
          })
          .finally(() => running.delete(s.agentUserId));
        running.set(s.agentUserId, p);
        started.push(s.name);
      }
      return { wakesAgents: true, started };
    },
    running: () => running.size,
    async waitForWorkers() {
      while (running.size) await Promise.all([...running.values()]);
    },
  };
}

/** The real worker start: this synap, `worker --agent <name> --once`, its output in ~/.synap/waker/<name>.log. */
export function spawnWorker(
  name: string,
  extraArgs: string[] = [],
  ctx: { nodePath?: string; synapPath?: string; home?: string } = {}
): { child: ChildProcess; done: Promise<number | null> } {
  const home = ctx.home ?? os.homedir();
  const logDir = path.join(home, ".synap", "waker");
  fs.mkdirSync(logDir, { recursive: true, mode: 0o700 });
  const out = fs.openSync(path.join(logDir, `${name}.log`), "a", 0o600);
  const child = spawn(
    ctx.nodePath ?? process.execPath,
    [ctx.synapPath ?? path.resolve(process.argv[1] ?? ""), "worker", "--agent", name, "--once", ...extraArgs],
    { stdio: ["ignore", out, out], env: process.env }
  );
  const done = new Promise<number | null>((resolve) => {
    child.on("error", () => resolve(null));
    child.on("close", (code) => resolve(code));
  }).finally(() => fs.closeSync(out));
  return { child, done };
}

// ─── the service (launchd), the same machinery as `synap worker install` ──────

/** The waker's login service: this synap, `waker`, with the person's PATH (it starts their engines). */
export function buildWakerServiceSpec(
  opts: { protocols?: string },
  ctx: { home: string; nodePath: string; synapPath: string; searchPath?: string }
): import("./worker-service.js").ServiceSpec {
  const args = [ctx.nodePath, ctx.synapPath, "waker"];
  if (opts.protocols) args.push("--protocols", opts.protocols);
  // The workers it starts look their engine up on PATH (claude, hermes, …): the person's own PATH,
  // with node's folder first and the usual system folders after. A PATH holds no secret.
  const dirs = [
    path.dirname(ctx.nodePath),
    ...(ctx.searchPath ?? "").split(path.delimiter).filter((d) => d && path.isAbsolute(d)),
    path.join(ctx.home, ".local", "bin"),
    "/opt/homebrew/bin",
    "/usr/local/bin",
    "/usr/bin",
    "/bin",
    "/usr/sbin",
    "/sbin",
  ];
  return {
    label: WAKER_LABEL,
    agent: "waker",
    programArguments: args,
    environment: { HOME: ctx.home, PATH: [...new Set(dirs)].join(":") },
    workingDirectory: ctx.home,
    logPath: path.join(ctx.home, ".synap", "waker", "waker.log"),
  };
}

async function computerOfThisPod(): Promise<{ podUrl: string; computerKey: string }> {
  const { resolveHubConfig } = await import("../lib/hub-client.js");
  const { ensureComputerEnrolled } = await import("../lib/device-connect.js");
  const cfg = await resolveHubConfig();
  // Never interactive: a waker under launchd has nobody to answer.
  const enrol = await ensureComputerEnrolled(cfg.podUrl, "run `synap waker` again", { interactive: false });
  if (!enrol.enrolled) throw new Error(enrol.message);
  return { podUrl: cfg.podUrl, computerKey: enrol.computerKey };
}

export async function wakerCommand(opts: { interval?: string; once?: boolean; protocols?: string }): Promise<void> {
  const { parseInterval, parseProtocols } = await import("./worker.js");
  if (opts.protocols !== undefined) parseProtocols(opts.protocols); // a typo stops here, not in every worker
  const intervalMs = parseInterval(opts.interval, WAKER_INTERVAL_MS);
  const { podUrl, computerKey } = await computerOfThisPod();
  const extra = opts.protocols ? ["--protocols", opts.protocols] : [];
  const waker = createWaker({ podUrl, computerKey, startWorker: (name) => spawnWorker(name, extra) });
  console.log(`[synap-waker] waking this computer's agents for ${podUrl}, every ${intervalMs / 1000}s`);
  let stopping = false;
  for (const sig of ["SIGTERM", "SIGINT"] as const) process.on(sig, () => (stopping = true));
  let failures = 0;
  while (!stopping) {
    try {
      await waker.tick();
      failures = 0;
    } catch (err) {
      failures++;
      console.log(`[synap-waker] poll failed (${failures} in a row): ${(err as Error).message}`);
      if (opts.once) throw err;
    }
    if (opts.once) break;
    await new Promise((r) => setTimeout(r, Math.min(intervalMs * Math.max(1, failures), 10 * 60_000)));
  }
  if (opts.once) await waker.waitForWorkers();
}

export async function wakerInstallCommand(opts: { protocols?: string }): Promise<void> {
  const ws = await import("./worker-service.js");
  const { parseProtocols } = await import("./worker.js");
  if (opts.protocols !== undefined) parseProtocols(opts.protocols);
  const deps = ws.liveDeps();
  const synapPath = path.resolve(process.argv[1] ?? "");
  const entryProblem = ws.checkSynapEntry(synapPath);
  if (entryProblem) throw new Error(entryProblem.replace(/synap worker install/g, "synap waker install"));
  const spec = buildWakerServiceSpec(opts, { home: deps.home, nodePath: process.execPath, synapPath, searchPath: process.env.PATH });
  // The pod must know this computer before anything is installed: a waker that cannot poll would restart every 30 s.
  const { podUrl, computerKey } = await computerOfThisPod();
  const list = await fetchWakeList(podUrl, computerKey);
  if (deps.platform !== "darwin") throw new Error(ws.notMacMessage(deps.platform, spec).replace(/synap worker install/g, "synap waker install").replace("Keep the agent running", "Keep the waker running"));
  const r = await ws.installService(spec, deps);
  const verb = r.action === "unchanged" ? "already runs" : "now runs";
  console.log(`The waker ${verb} as a login service on this Mac (${r.label}). Log: ${ws.tildify(r.logPath, deps.home)}`);
  if (list.wakesAgents) {
    console.log(`"Wakes agents" is on for ${list.computer.name ?? "this computer"}: its agents start when work is handed to them.`);
    return;
  }
  // The switch is the person's, signed in with a proof of presence: never a key's.
  const { needsYouInPodAdmin } = await import("../lib/presence-refusal.js");
  needsYouInPodAdmin({ podUrl, page: `/computers/${list.computer.id}`, what: `turn on "Wakes agents" for ${list.computer.name ?? "this computer"}` });
}

export async function wakerStatusCommand(opts: { json?: boolean }): Promise<void> {
  const ws = await import("./worker-service.js");
  const deps = ws.liveDeps();
  const state = deps.platform === "darwin" ? await ws.printService(deps, WAKER_LABEL) : null;
  let pod: { wakesAgents: boolean; agents: number; computer: string | null } | { error: string };
  try {
    const { podUrl, computerKey } = await computerOfThisPod();
    const list = await fetchWakeList(podUrl, computerKey);
    pod = { wakesAgents: list.wakesAgents, agents: list.agents.length, computer: list.computer.name };
  } catch (err) {
    pod = { error: (err as Error).message };
  }
  const out = { service: state ? { state: state.state ?? "loaded", pid: state.pid ?? null } : null, pod };
  if (opts.json) return void console.log(JSON.stringify(out, null, 2));
  console.log(state ? `Service: ${WAKER_LABEL} ${state.state ?? "loaded"}${state.pid ? ` (pid ${state.pid})` : ""}` : "Service: not installed (`synap waker install`)");
  console.log(
    "error" in pod
      ? `Pod: could not be read: ${pod.error}`
      : `Pod: "Wakes agents" ${pod.wakesAgents ? "on" : "off"} for ${pod.computer ?? "this computer"}; ${pod.agents} agent(s) to wake now`
  );
}

export async function wakerUninstallCommand(): Promise<void> {
  const ws = await import("./worker-service.js");
  const removed = await ws.uninstallByLabel(ws.liveDeps(), WAKER_LABEL);
  console.log(removed ? `The waker no longer runs on this Mac (${WAKER_LABEL} removed).` : "No waker service was installed on this Mac.");
}
