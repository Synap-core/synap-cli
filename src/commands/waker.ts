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
 * says so. `synap waker install` runs the waker as a service: a launchd login
 * service on a Mac (the same machinery as `synap worker install`), a systemd
 * user unit on Linux (a server such as CT112, finding 9e274902). It opens the
 * computer's page in pod admin when the switch is off.
 */

import { execFile, spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { wakerRunnerHeader } from "../lib/conversation-headers.js";
import { savedAgentsById } from "../lib/agents-config.js";

/** How often the waker polls (and renews its lease). */
export const WAKER_INTERVAL_MS = 30_000;
/**
 * The pod counts the waker online for 2 min after a poll; past 60 s a single
 * slow poll lets the lease lapse and the computer flaps offline. Below 5 s the
 * waker only loads the pod.
 */
export const WAKER_MIN_INTERVAL_MS = 5_000;
export const WAKER_MAX_INTERVAL_MS = 60_000;
/** Back-off after failed polls never waits longer than this. */
export const WAKER_MAX_BACKOFF_MS = 10 * 60_000;
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

/** `--interval`, refused outside {@link WAKER_MIN_INTERVAL_MS}..{@link WAKER_MAX_INTERVAL_MS}. */
export function parseWakerInterval(
  raw: string | undefined,
  parse: (raw: string | undefined, fallbackMs: number) => number
): number {
  const ms = parse(raw, WAKER_INTERVAL_MS);
  if (ms < WAKER_MIN_INTERVAL_MS || ms > WAKER_MAX_INTERVAL_MS) {
    throw new Error(
      `--interval ${raw} is outside 5s to 60s: the pod counts the waker online for 2 min after each poll, so it must ask well inside that`
    );
  }
  return ms;
}

export interface WakerDeps {
  podUrl: string;
  computerKey: string;
  /** Starts `synap worker --agent <name> --once`; `done` resolves when it exits, `stop` asks it to end. */
  startWorker: (name: string) => { done: Promise<number | null>; stop?: () => void };
  fetchImpl?: typeof fetch;
  saved?: () => Map<string, string>;
  now?: () => number;
  say?: (line: string) => void;
}

export interface Waker {
  tick(): Promise<{ wakesAgents: boolean; started: string[] }>;
  waitForWorkers(): Promise<void>;
  /** Asks every worker it started to end, then waits for them. */
  stopWorkers(): Promise<void>;
}

export function createWaker(deps: WakerDeps): Waker {
  const now = deps.now ?? Date.now;
  const say = deps.say ?? ((l: string) => console.log(`[synap-waker] ${new Date().toISOString()} ${l}`));
  const saved = deps.saved ?? savedAgentsById;
  const running = new Map<string, Promise<number | null>>();
  const stoppers = new Map<string, () => void>();
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
      // Said once while it lasts, and again if it comes back after a good read.
      for (const key of [...said]) {
        if (key.startsWith("unreadable:") && !list.unreadable.includes(key.slice("unreadable:".length))) said.delete(key);
      }
      for (const id of list.unreadable) sayOnce(`unreadable:${id}`, `the pod could not read the work handed to agent ${id}; asking again every poll`);
      const plan = planWakes(list, { saved: saved(), running: new Set(running.keys()), woken, now: now() });
      for (const n of plan.notSaved) sayOnce(`unsaved:${n}`, `${n} has work handed to it on this computer, but is not saved here: run \`synap agents add\` for it on this computer`);
      const started: string[] = [];
      for (const s of plan.start) {
        const handed = list.agents.find((a) => a.agentUserId === s.agentUserId)!;
        woken.set(s.agentUserId, { sessions: handed.sessions.map((x) => x.id), at: now() });
        say(`starting ${s.name} (${s.reason})`);
        const { done, stop } = deps.startWorker(s.name);
        const p = done
          .then((code) => {
            say(`${s.name}'s worker exited${code === null ? "" : ` ${code}`}`);
            return code;
          })
          .finally(() => {
            running.delete(s.agentUserId);
            stoppers.delete(s.agentUserId);
          });
        running.set(s.agentUserId, p);
        if (stop) stoppers.set(s.agentUserId, stop);
        started.push(s.name);
      }
      return { wakesAgents: true, started };
    },
    async waitForWorkers() {
      while (running.size) await Promise.all([...running.values()]);
    },
    async stopWorkers() {
      for (const stop of stoppers.values()) stop();
      while (running.size) await Promise.all([...running.values()]);
    },
  };
}

/**
 * The poll loop. A failed poll backs off (one interval more per failure, at
 * most {@link WAKER_MAX_BACKOFF_MS}); `signal` ends the wait at once, then the
 * workers it started are asked to end and waited for.
 */
export async function runWakerLoop(opts: {
  waker: Pick<Waker, "tick" | "waitForWorkers" | "stopWorkers">;
  intervalMs: number;
  once?: boolean;
  signal: AbortSignal;
  log?: (line: string) => void;
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
}): Promise<void> {
  const log = opts.log ?? ((l: string) => console.log(`[synap-waker] ${l}`));
  const sleep = opts.sleep ?? abortableSleep;
  let failures = 0;
  while (!opts.signal.aborted) {
    try {
      await opts.waker.tick();
      failures = 0;
    } catch (err) {
      failures++;
      log(`poll failed (${failures} in a row): ${(err as Error).message}`);
      if (opts.once) throw err;
    }
    if (opts.once) return opts.waker.waitForWorkers();
    await sleep(Math.min(opts.intervalMs * Math.max(1, failures), WAKER_MAX_BACKOFF_MS), opts.signal);
  }
  log("stopping: asking the workers it started to end");
  await opts.waker.stopWorkers();
}

function abortableSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const t = setTimeout(done, ms);
    function done() {
      clearTimeout(t);
      signal.removeEventListener("abort", done);
      resolve();
    }
    signal.addEventListener("abort", done, { once: true });
  });
}

/** An agent's name as a log file name: never a path out of the log folder. */
export function workerLogName(name: string): string {
  return `${name.replace(/[^\w.-]/g, "_").replace(/^\.+/, "_")}.log`;
}

/** The real worker start: this synap, `worker --agent <name> --once`, its output in ~/.synap/waker/<name>.log. */
export function spawnWorker(
  name: string,
  extraArgs: string[] = [],
  ctx: { nodePath?: string; synapPath?: string; home?: string } = {}
): { child: ChildProcess; done: Promise<number | null>; stop: () => void } {
  const home = ctx.home ?? os.homedir();
  const logDir = path.join(home, ".synap", "waker");
  fs.mkdirSync(logDir, { recursive: true, mode: 0o700 });
  const out = fs.openSync(path.join(logDir, workerLogName(name)), "a", 0o600);
  const child = spawn(
    ctx.nodePath ?? process.execPath,
    [ctx.synapPath ?? path.resolve(process.argv[1] ?? ""), "worker", "--agent", name, "--once", ...extraArgs],
    { stdio: ["ignore", out, out], env: process.env }
  );
  const done = new Promise<number | null>((resolve) => {
    child.on("error", () => resolve(null));
    child.on("close", (code) => resolve(code));
  }).finally(() => fs.closeSync(out));
  return { child, done, stop: () => void child.kill("SIGTERM") };
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

// ─── the service on Linux: a systemd user unit ───────────────────────────────

/** The waker's systemd user unit (Linux). */
export const WAKER_UNIT = "synap-waker.service";

export function wakerUnitPath(home: string): string {
  return path.join(home, ".config", "systemd", "user", WAKER_UNIT);
}

/**
 * One ExecStart/Environment word, quoted the way systemd reads it: `%` is a
 * specifier everywhere; `$` is expanded only in ExecStart (`expandsDollar`).
 */
export function systemdWord(s: string, expandsDollar = true): string {
  let escaped = s.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/%/g, "%%");
  if (expandsDollar) escaped = escaped.replace(/\$/g, "$$$$");
  return /^[\w./:=@,+-]+$/.test(s) ? escaped : `"${escaped}"`;
}

/** The unit file: restarts on any exit (the waker only stops when told to), its output appended to the waker's log. */
export function renderWakerUnit(spec: import("./worker-service.js").ServiceSpec): string {
  const env = Object.entries(spec.environment).map(([k, v]) => `Environment=${systemdWord(`${k}=${v}`, false)}`);
  return [
    "[Unit]",
    "Description=Synap waker: starts this computer's agents when work is handed to them",
    "After=network-online.target",
    "Wants=network-online.target",
    "",
    "[Service]",
    `ExecStart=${spec.programArguments.map((a) => systemdWord(a)).join(" ")}`,
    `WorkingDirectory=${systemdWord(spec.workingDirectory)}`,
    ...env,
    "Restart=always",
    "RestartSec=30",
    `StandardOutput=append:${spec.logPath}`,
    `StandardError=append:${spec.logPath}`,
    "",
    "[Install]",
    "WantedBy=default.target",
    "",
  ].join("\n");
}

export interface CommandResult {
  code: number;
  stdout: string;
  stderr: string;
}
/** Runs `systemctl` / `loginctl` with these args (injected in tests). */
export type RunCommand = (cmd: "systemctl" | "loginctl", args: string[]) => Promise<CommandResult>;

export const defaultRunCommand: RunCommand = (cmd, args) =>
  new Promise((resolve) => {
    execFile(cmd, args, { timeout: 30_000 }, (err, stdout, stderr) => {
      const code = err ? (typeof (err as { code?: unknown }).code === "number" ? ((err as { code: number }).code) : 1) : 0;
      resolve({ code, stdout: String(stdout), stderr: String(stderr || (err && !stderr ? err.message : "")) });
    });
  });

export interface LinuxServiceDeps {
  home: string;
  user: string;
  run: RunCommand;
}

async function systemctlUser(deps: LinuxServiceDeps, args: string[], what: string): Promise<CommandResult> {
  const r = await deps.run("systemctl", ["--user", ...args]);
  if (r.code !== 0) {
    throw new Error(`${what} failed: systemctl --user ${args.join(" ")}: ${(r.stderr || r.stdout).trim() || `exit ${r.code}`}`);
  }
  return r;
}

/**
 * Writes the unit and starts it now and at every boot of the user manager.
 * `lingers: false` means the user manager stops when the person logs out, so
 * on a server the waker would stop with their last ssh session.
 */
export async function installLinuxWaker(
  spec: import("./worker-service.js").ServiceSpec,
  deps: LinuxServiceDeps
): Promise<{ action: "installed" | "updated" | "unchanged"; unitPath: string; lingers: boolean | null }> {
  const unitPath = wakerUnitPath(deps.home);
  const unit = renderWakerUnit(spec);
  const before = fs.existsSync(unitPath) ? fs.readFileSync(unitPath, "utf8") : null;
  fs.mkdirSync(path.dirname(unitPath), { recursive: true });
  fs.mkdirSync(path.dirname(spec.logPath), { recursive: true, mode: 0o700 });
  if (before !== unit) fs.writeFileSync(unitPath, unit, { mode: 0o644 });
  await systemctlUser(deps, ["daemon-reload"], "Reloading the user units");
  await systemctlUser(deps, ["enable", "--now", WAKER_UNIT], "Starting the waker");
  // A changed unit only takes effect on a restart; enable --now leaves a running one as it is.
  if (before !== null && before !== unit) await systemctlUser(deps, ["restart", WAKER_UNIT], "Restarting the waker");
  const linger = await deps.run("loginctl", ["show-user", deps.user, "--property=Linger", "--value"]);
  const lingers = linger.code === 0 ? linger.stdout.trim() === "yes" : null;
  return { action: before === null ? "installed" : before === unit ? "unchanged" : "updated", unitPath, lingers };
}

/** The unit's state (`active`, `inactive`, `failed`…) and main pid, or null when no unit is installed. */
export async function linuxWakerStatus(deps: LinuxServiceDeps): Promise<{ state: string; pid: number | null } | null> {
  if (!fs.existsSync(wakerUnitPath(deps.home))) return null;
  const r = await deps.run("systemctl", ["--user", "show", WAKER_UNIT, "--property=ActiveState,MainPID"]);
  const props = Object.fromEntries(
    r.stdout
      .split("\n")
      .map((l) => l.split("="))
      .filter((kv) => kv.length === 2)
  );
  const pid = Number(props.MainPID);
  return { state: props.ActiveState || (r.code === 0 ? "unknown" : "unreadable"), pid: pid > 0 ? pid : null };
}

export async function uninstallLinuxWaker(deps: LinuxServiceDeps): Promise<boolean> {
  const unitPath = wakerUnitPath(deps.home);
  if (!fs.existsSync(unitPath)) return false;
  await systemctlUser(deps, ["disable", "--now", WAKER_UNIT], "Stopping the waker");
  fs.rmSync(unitPath);
  await systemctlUser(deps, ["daemon-reload"], "Reloading the user units");
  return true;
}

function linuxDeps(home: string): LinuxServiceDeps {
  return { home, user: os.userInfo().username, run: defaultRunCommand };
}

/** On a platform the waker cannot install itself on: the command to keep running instead. */
export function wakerNotSupportedMessage(platform: string, spec: Pick<import("./worker-service.js").ServiceSpec, "programArguments">): string {
  const cmd = spec.programArguments.map((a) => (/^[\w./:=@,-]+$/.test(a) ? a : `'${a.replace(/'/g, `'\\''`)}'`)).join(" ");
  return (
    `\`synap waker install\` sets up a service on macOS (launchd) and Linux (systemd), and this computer runs ${platform}. ` +
    `Keep the waker running with this computer's service manager, restarting it whenever it exits:\n  ${cmd}`
  );
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
  const intervalMs = parseWakerInterval(opts.interval, parseInterval);
  const { podUrl, computerKey } = await computerOfThisPod();
  const extra = opts.protocols ? ["--protocols", opts.protocols] : [];
  const waker = createWaker({ podUrl, computerKey, startWorker: (name) => spawnWorker(name, extra) });
  console.log(`[synap-waker] waking this computer's agents for ${podUrl}, every ${intervalMs / 1000}s`);
  const stop = new AbortController();
  for (const sig of ["SIGTERM", "SIGINT"] as const) process.once(sig, () => stop.abort());
  await runWakerLoop({ waker, intervalMs, once: opts.once, signal: stop.signal });
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
  if (deps.platform === "darwin") {
    const r = await ws.installService(spec, deps);
    const verb = r.action === "unchanged" ? "already runs" : "now runs";
    console.log(`The waker ${verb} as a login service on this Mac (${r.label}). Log: ${ws.tildify(r.logPath, deps.home)}`);
  } else if (deps.platform === "linux") {
    const r = await installLinuxWaker(spec, linuxDeps(deps.home));
    const verb = r.action === "unchanged" ? "already runs" : "now runs";
    console.log(`The waker ${verb} as a systemd user service on this computer (${WAKER_UNIT}). Log: ${ws.tildify(spec.logPath, deps.home)}`);
    if (r.lingers === false) {
      console.log(
        `It stops when you log out of this computer. To keep it running on a server, run once:\n  sudo loginctl enable-linger ${os.userInfo().username}`
      );
    }
  } else {
    throw new Error(wakerNotSupportedMessage(deps.platform, spec));
  }
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
  const state =
    deps.platform === "darwin"
      ? await ws.printService(deps, WAKER_LABEL)
      : deps.platform === "linux"
        ? await linuxWakerStatus(linuxDeps(deps.home))
        : null;
  const serviceName = deps.platform === "linux" ? WAKER_UNIT : WAKER_LABEL;
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
  console.log(state ? `Service: ${serviceName} ${state.state ?? "loaded"}${state.pid ? ` (pid ${state.pid})` : ""}` : "Service: not installed (`synap waker install`)");
  console.log(
    "error" in pod
      ? `Pod: could not be read: ${pod.error}`
      : `Pod: "Wakes agents" ${pod.wakesAgents ? "on" : "off"} for ${pod.computer ?? "this computer"}; ${pod.agents} agent(s) to wake now`
  );
}

export async function wakerUninstallCommand(): Promise<void> {
  const ws = await import("./worker-service.js");
  const deps = ws.liveDeps();
  if (deps.platform === "linux") {
    const removed = await uninstallLinuxWaker(linuxDeps(deps.home));
    console.log(removed ? `The waker no longer runs on this computer (${WAKER_UNIT} removed).` : "No waker service was installed on this computer.");
    return;
  }
  const removed = await ws.uninstallByLabel(deps, WAKER_LABEL);
  console.log(removed ? `The waker no longer runs on this Mac (${WAKER_LABEL} removed).` : "No waker service was installed on this Mac.");
}
