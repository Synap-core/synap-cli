/**
 * `synap worker install | start | stop | status | uninstall` — the agent on
 * this Mac as a login service, so it runs without a terminal (founder,
 * 2026-11-01, session b9dd6a84: "Both").
 *
 * The service is a launchd LaunchAgent, one per agent:
 *   ~/Library/LaunchAgents/live.synap.worker-<agent>.plist
 *   label live.synap.worker-<agent>, domain gui/<uid>
 * It runs `<node> <synap> worker --agent <agent> …` with the flags given to
 * `install`, starts at login (RunAtLoad) and is restarted when it stops
 * (KeepAlive, at most every 30 s: ThrottleInterval). Its output goes to
 * ~/.synap/worker/<agent>/worker.log, next to the worker's state.
 *
 * The plist never holds a secret: it is a plain file any program of this user
 * can read. The worker reads its key from ~/.synap as it does in a terminal;
 * `--env` refuses a name that looks like a secret.
 *
 * Stop = `launchctl disable` + `bootout`, never `kill`: with KeepAlive, launchd
 * restarts a killed worker after the throttle, so a kill would not stop it. The
 * disable keeps it stopped after a restart too, until `start` (enable +
 * bootstrap) or `install` brings it back. Start on a loaded service that is not
 * running = `kickstart`.
 *
 * Every launchctl call goes through an injected runner, so the tests never
 * touch the real launchd.
 */

import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { writeFileAtomic } from "../lib/atomic-file.js";
import { unknownAgentMessage } from "../lib/agents-config.js";
import { findOnPath } from "./worker-github-broker.js";
import { parseProtocols, engineForSavedAgent } from "./worker.js";
import { engineLine, type WorkerEngine } from "./worker-engine.js";

export const LABEL_PREFIX = "live.synap.worker-";
/** Every worker service file this command recognises, its own and a hand-made one. */
const SERVICE_FILE = /^live\.synap\.worker[-.].*\.plist$/;

// ─── names and paths ──────────────────────────────────────────────────────────

const AGENT_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export function serviceLabel(agent: string): string {
  if (!AGENT_NAME.test(agent)) {
    throw new Error(`"${agent}" cannot name a service: use letters, digits, dot, dash or underscore.`);
  }
  return `${LABEL_PREFIX}${agent}`;
}

export function launchAgentsDir(home: string): string {
  return path.join(home, "Library", "LaunchAgents");
}

export function plistPathFor(home: string, label: string): string {
  return path.join(launchAgentsDir(home), `${label}.plist`);
}

export function workerLogPath(home: string, agent: string): string {
  return path.join(home, ".synap", "worker", agent, "worker.log");
}

/** `~/x` → `<home>/x`; a relative path → absolute against `cwd`. */
export function absolutePath(p: string, home: string, cwd: string): string {
  const expanded = p === "~" ? home : p.startsWith("~/") ? path.join(home, p.slice(2)) : p;
  return path.resolve(cwd, expanded);
}

// ─── what the service runs ────────────────────────────────────────────────────

/** The `synap worker` flags a service carries (not --once or --dry-run: a service runs for good). */
export interface ServiceOptions {
  agent: string;
  interval?: string;
  cwd?: string;
  workRoot?: string;
  maxParallel?: string;
  claudeBin?: string;
  claudeConfigDir?: string;
  accounts?: string;
  githubApp?: string;
  allowedTools?: string;
  skipPermissions?: boolean;
  /** Which runs this computer takes (`code`, `work-folder`); absent = the worker's default, every protocol. */
  protocols?: string;
  /** How long a program engine's run may take (`--run-timeout`). */
  runTimeout?: string;
  /** Extra environment for the service, KEY=VALUE each. Never a secret. */
  env?: string[];
}

export interface ServiceContext {
  home: string;
  /** Where relative paths given on the command line are resolved. */
  cwd: string;
  /** The node binary that runs synap (process.execPath). */
  nodePath: string;
  /** The synap entry this command was started as (process.argv[1]). */
  synapPath: string;
  /** The PATH to look `claude` up on when --claude-bin is a bare name. */
  searchPath?: string;
  /**
   * What the agent's template starts (`resolveWorkerEngine`). A program engine
   * is pinned by its absolute path's folder on the service's PATH and carries
   * no --claude-bin; absent = Claude Code.
   */
  engine?: WorkerEngine;
}

export interface ServiceSpec {
  label: string;
  agent: string;
  programArguments: string[];
  environment: Record<string, string>;
  workingDirectory: string;
  logPath: string;
}

const SECRET_NAME = /(TOKEN|SECRET|PASSWORD|PASSWD|API_?KEY|PRIVATE|CREDENTIAL|AUTH|COOKIE|SESSION)/i;
const SYSTEM_PATH = ["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin", "/usr/sbin", "/sbin"];

/** A synap entry a service can keep running from, or why not. */
export function checkSynapEntry(synapPath: string): string | null {
  if (/\.[cm]?tsx?$/.test(synapPath)) {
    return `This synap runs from source (${synapPath}). Install it first (npm install -g @synap-core/cli), then run \`synap worker install\` from that one.`;
  }
  if (/[/\\]_npx[/\\]/.test(synapPath)) {
    return `This synap runs from npx's cache (${synapPath}), which can be emptied at any time. Install it first (npm install -g @synap-core/cli), then run \`synap worker install\` again.`;
  }
  return null;
}

export function buildServiceSpec(opts: ServiceOptions, ctx: ServiceContext): ServiceSpec {
  const label = serviceLabel(opts.agent);
  const entryProblem = checkSynapEntry(ctx.synapPath);
  if (entryProblem) throw new Error(entryProblem);
  const abs = (p: string) => absolutePath(p, ctx.home, ctx.cwd);

  // launchd starts with a bare PATH: `claude` is pinned to an absolute path, another
  // engine's program by its folder on the service's PATH (the worker finds it there).
  const program = ctx.engine?.kind === "program" ? ctx.engine.programPath : undefined;
  const claudeName = opts.claudeBin ?? "claude";
  const claudeBin = program
    ? undefined
    : claudeName.includes("/")
      ? abs(claudeName)
      : (findOnPath(claudeName, ctx.searchPath, "/nonexistent") ?? claudeName);

  const args = [ctx.nodePath, ctx.synapPath, "worker", "--agent", opts.agent];
  if (opts.interval) args.push("--interval", opts.interval);
  if (opts.cwd) args.push("--cwd", abs(opts.cwd));
  if (opts.workRoot) args.push("--work-root", abs(opts.workRoot));
  if (opts.maxParallel) args.push("--max-parallel", opts.maxParallel);
  if (claudeBin) args.push("--claude-bin", claudeBin);
  if (opts.claudeConfigDir) args.push("--claude-config-dir", abs(opts.claudeConfigDir));
  if (opts.accounts) args.push("--accounts", abs(opts.accounts));
  if (opts.githubApp) args.push("--github-app", abs(opts.githubApp));
  if (opts.allowedTools) args.push("--allowed-tools", opts.allowedTools);
  if (opts.skipPermissions) args.push("--skip-permissions");
  // Checked here, not at the first restart: a typo must never become a service that dies every 30 s.
  if (opts.protocols !== undefined) args.push("--protocols", [...parseProtocols(opts.protocols)].join(","));
  if (opts.runTimeout) args.push("--run-timeout", opts.runTimeout);

  const pathDirs = [
    path.dirname(ctx.nodePath),
    ...(program ? [path.dirname(program)] : []),
    ...(claudeBin?.includes("/") ? [path.dirname(claudeBin)] : []),
    path.join(ctx.home, ".local", "bin"),
    ...SYSTEM_PATH,
  ];
  const environment: Record<string, string> = {
    HOME: ctx.home,
    PATH: [...new Set(pathDirs)].join(":"),
  };
  for (const pair of opts.env ?? []) {
    const eq = pair.indexOf("=");
    const name = eq > 0 ? pair.slice(0, eq) : "";
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) throw new Error(`--env takes NAME=value, got "${pair}".`);
    if (name === "HOME" || name === "PATH") throw new Error(`--env cannot set ${name}: the service sets it.`);
    if (SECRET_NAME.test(name)) {
      throw new Error(
        `--env ${name} looks like a secret, and the service file can be read by any program on this Mac. ` +
          `The worker reads its key from ~/.synap; a Claude token goes in the accounts file (--accounts).`
      );
    }
    environment[name] = pair.slice(eq + 1);
  }

  return {
    label,
    agent: opts.agent,
    programArguments: args,
    environment,
    workingDirectory: ctx.home,
    logPath: workerLogPath(ctx.home, opts.agent),
  };
}

// ─── the plist ────────────────────────────────────────────────────────────────

function xml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");
}

function unxml(s: string): string {
  return s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

export function renderPlist(spec: ServiceSpec): string {
  const str = (v: string) => `<string>${xml(v)}</string>`;
  const lines = [
    `<?xml version="1.0" encoding="UTF-8"?>`,
    `<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">`,
    `<!-- Written by \`synap worker install\`. Change it with that command, not by hand. -->`,
    `<plist version="1.0">`,
    `<dict>`,
    `  <key>Label</key>${str(spec.label)}`,
    `  <key>ProgramArguments</key>`,
    `  <array>`,
    ...spec.programArguments.map((a) => `    ${str(a)}`),
    `  </array>`,
    `  <key>WorkingDirectory</key>${str(spec.workingDirectory)}`,
    `  <key>EnvironmentVariables</key>`,
    `  <dict>`,
    ...Object.entries(spec.environment).map(([k, v]) => `    <key>${xml(k)}</key>${str(v)}`),
    `  </dict>`,
    `  <key>RunAtLoad</key><true/>`,
    `  <key>KeepAlive</key><true/>`,
    `  <key>ThrottleInterval</key><integer>30</integer>`,
    `  <key>ProcessType</key><string>Interactive</string>`,
    `  <key>StandardOutPath</key>${str(spec.logPath)}`,
    `  <key>StandardErrorPath</key>${str(spec.logPath)}`,
    `</dict>`,
    `</plist>`,
    ``,
  ];
  return lines.join("\n");
}

export interface ParsedPlist {
  label?: string;
  programArguments: string[];
  agent?: string;
  logPath?: string;
}

/** Reads what this command needs from a worker plist, ours or one made by hand. */
export function parsePlist(text: string): ParsedPlist {
  const keyString = (key: string) => {
    const m = new RegExp(`<key>${key}</key>\\s*<string>([^<]*)</string>`).exec(text);
    return m ? unxml(m[1]) : undefined;
  };
  const arr = /<key>ProgramArguments<\/key>\s*<array>([\s\S]*?)<\/array>/.exec(text);
  const programArguments = arr ? [...arr[1].matchAll(/<string>([^<]*)<\/string>/g)].map((m) => unxml(m[1])) : [];
  const i = programArguments.indexOf("--agent");
  const inline = programArguments.find((a) => a.startsWith("--agent="));
  const agent = i >= 0 ? programArguments[i + 1] : inline?.slice("--agent=".length);
  return { label: keyString("Label"), programArguments, agent, logPath: keyString("StandardOutPath") };
}

// ─── launchctl ────────────────────────────────────────────────────────────────

export interface LaunchctlResult {
  code: number;
  stdout: string;
  stderr: string;
}
export type Launchctl = (args: string[]) => Promise<LaunchctlResult>;

export const defaultLaunchctl: Launchctl = (args) =>
  new Promise((resolve) => {
    execFile("launchctl", args, { timeout: 30_000 }, (err, stdout, stderr) => {
      const code = err ? (typeof (err as { code?: unknown }).code === "number" ? (err as { code: number }).code : 1) : 0;
      resolve({ code, stdout: String(stdout ?? ""), stderr: String(stderr ?? "") });
    });
  });

export interface ServiceDeps {
  home: string;
  uid: number;
  platform: NodeJS.Platform;
  launchctl: Launchctl;
  sleep?: (ms: number) => Promise<void>;
}

export interface LaunchdState {
  state?: string;
  pid?: number;
  /** null = it never exited. */
  lastExitCode?: number | null;
  runs?: number;
}

/** The service's own lines of `launchctl print gui/<uid>/<label>` (its nested blocks come after). */
export function parseLaunchctlPrint(text: string): LaunchdState {
  const out: LaunchdState = {};
  const state = /^\s*state = (.+?)\s*$/m.exec(text);
  if (state) out.state = state[1];
  const pid = /^\s*pid = (\d+)/m.exec(text);
  if (pid) out.pid = Number(pid[1]);
  const runs = /^\s*runs = (\d+)/m.exec(text);
  if (runs) out.runs = Number(runs[1]);
  const last = /^\s*last exit code = (.+)$/m.exec(text);
  if (last) {
    const n = /^-?\d+/.exec(last[1].trim());
    out.lastExitCode = n ? Number(n[0]) : null;
  }
  return out;
}

/** Labels `launchctl print-disabled gui/<uid>` lists as disabled. */
export function parseDisabled(text: string): Set<string> {
  const out = new Set<string>();
  for (const m of text.matchAll(/"([^"]+)"\s*=>\s*(disabled|true)\b/g)) out.add(m[1]);
  return out;
}

const domain = (deps: ServiceDeps) => `gui/${deps.uid}`;
const target = (deps: ServiceDeps, label: string) => `gui/${deps.uid}/${label}`;

async function printService(deps: ServiceDeps, label: string): Promise<LaunchdState | null> {
  const r = await deps.launchctl(["print", target(deps, label)]);
  return r.code === 0 ? parseLaunchctlPrint(r.stdout) : null;
}

async function must(deps: ServiceDeps, args: string[], what: string): Promise<void> {
  const r = await deps.launchctl(args);
  if (r.code !== 0) {
    const why = (r.stderr || r.stdout).trim() || `exit ${r.code}`;
    throw new Error(`${what} failed: launchctl ${args.join(" ")}: ${why}`);
  }
}

/** bootout returns before launchd has let go; a bootstrap right after can fail with "Input/output error". */
async function bootoutAndWait(deps: ServiceDeps, label: string): Promise<void> {
  await must(deps, ["bootout", target(deps, label)], "Stopping the service");
  const sleep = deps.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  for (let i = 0; i < 20; i++) {
    if (!(await printService(deps, label))) return;
    await sleep(250);
  }
  throw new Error(`launchd still holds ${label} 5 s after it was stopped. Try again in a moment.`);
}

function requireMac(deps: ServiceDeps, cmd: string): void {
  if (deps.platform !== "darwin") {
    throw new Error(`\`synap worker ${cmd}\` manages a macOS login service, and this computer runs ${deps.platform}.`);
  }
}

// ─── finding the services on this Mac ─────────────────────────────────────────

export interface InstalledService {
  label: string;
  plistPath: string;
  agent?: string;
  logPath?: string;
  content: string;
}

/** Every worker service file in ~/Library/LaunchAgents, ours and hand-made ones. */
export function findServices(home: string): InstalledService[] {
  const dir = launchAgentsDir(home);
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
  const out: InstalledService[] = [];
  for (const name of names.filter((n) => SERVICE_FILE.test(n)).sort()) {
    const plistPath = path.join(dir, name);
    const content = fs.readFileSync(plistPath, "utf8");
    const parsed = parsePlist(content);
    out.push({
      label: parsed.label ?? name.replace(/\.plist$/, ""),
      plistPath,
      agent: parsed.agent,
      logPath: parsed.logPath,
      content,
    });
  }
  return out;
}

/** The service that runs this agent: ours first, else one made another way. */
export function serviceForAgent(home: string, agent: string): InstalledService | undefined {
  const all = findServices(home).filter((s) => s.agent === agent);
  return all.find((s) => s.label === `${LABEL_PREFIX}${agent}`) ?? all[0];
}

function pickServices(home: string, agent: string | undefined): InstalledService[] {
  if (!agent) return findServices(home);
  const svc = serviceForAgent(home, agent);
  if (!svc) throw new Error(`No service runs the agent ${agent} on this Mac. Set one up with \`synap worker install --agent ${agent}\`.`);
  return [svc];
}

// ─── install ──────────────────────────────────────────────────────────────────

export type InstallAction = "installed" | "updated" | "unchanged" | "started";

export interface InstallResult {
  action: InstallAction;
  label: string;
  plistPath: string;
  logPath: string;
  /** Services made another way for the same agent that --replace took out (label → where the old file was kept). */
  replaced: Array<{ label: string; keptAt: string }>;
}

export async function installService(
  spec: ServiceSpec,
  deps: ServiceDeps,
  opts: { replace?: boolean } = {}
): Promise<InstallResult> {
  requireMac(deps, "install");
  const plistPath = plistPathFor(deps.home, spec.label);
  const content = renderPlist(spec);

  // Two services for one agent would both claim its sessions.
  const others = findServices(deps.home).filter((s) => s.agent === spec.agent && s.label !== spec.label);
  if (others.length && !opts.replace) {
    const list = others.map((s) => `${s.label} (${s.plistPath})`).join(", ");
    throw new Error(
      `The agent ${spec.agent} already runs as another service on this Mac: ${list}. ` +
        `Two would claim the same sessions. Run again with --replace to swap it for this one (its file is kept in ~/.synap/worker/${spec.agent}/).`
    );
  }
  const replaced: InstallResult["replaced"] = [];
  for (const old of others) {
    if (await printService(deps, old.label)) await bootoutAndWait(deps, old.label);
    const keptAt = path.join(path.dirname(spec.logPath), `replaced-${path.basename(old.plistPath)}`);
    fs.mkdirSync(path.dirname(keptAt), { recursive: true });
    fs.renameSync(old.plistPath, keptAt);
    replaced.push({ label: old.label, keptAt });
  }

  let existing: string | null = null;
  try {
    existing = fs.readFileSync(plistPath, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
  const loaded = (await printService(deps, spec.label)) !== null;
  const same = existing === content;
  if (same && loaded) return { action: "unchanged", label: spec.label, plistPath, logPath: spec.logPath, replaced };

  fs.mkdirSync(path.dirname(spec.logPath), { recursive: true });
  if (!same) {
    fs.mkdirSync(path.dirname(plistPath), { recursive: true });
    writeFileAtomic(plistPath, content, { mode: 0o644 });
  }
  if (loaded) await bootoutAndWait(deps, spec.label);
  // A `synap worker stop` disabled it; installing means it should run.
  await must(deps, ["enable", target(deps, spec.label)], "Enabling the service");
  await must(deps, ["bootstrap", domain(deps), plistPath], "Starting the service");
  const action: InstallAction = same ? "started" : existing === null ? "installed" : loaded ? "updated" : "installed";
  return { action, label: spec.label, plistPath, logPath: spec.logPath, replaced };
}

// ─── start / stop / uninstall / status ────────────────────────────────────────

export interface ServiceOutcome {
  agent?: string;
  label: string;
  /** started | already running | stopped | already stopped | removed */
  result: string;
  pid?: number;
}

export async function startServices(deps: ServiceDeps, agent?: string): Promise<ServiceOutcome[]> {
  requireMac(deps, "start");
  const out: ServiceOutcome[] = [];
  for (const svc of pickServices(deps.home, agent)) {
    await must(deps, ["enable", target(deps, svc.label)], "Enabling the service");
    const now = await printService(deps, svc.label);
    if (!now) {
      await must(deps, ["bootstrap", domain(deps), svc.plistPath], "Starting the service");
    } else if (now.state === "running") {
      out.push({ agent: svc.agent, label: svc.label, result: "already running", pid: now.pid });
      continue;
    } else {
      await must(deps, ["kickstart", target(deps, svc.label)], "Starting the service");
    }
    const after = await printService(deps, svc.label);
    out.push({ agent: svc.agent, label: svc.label, result: "started", pid: after?.pid });
  }
  return out;
}

export async function stopServices(deps: ServiceDeps, agent?: string): Promise<ServiceOutcome[]> {
  requireMac(deps, "stop");
  const out: ServiceOutcome[] = [];
  for (const svc of pickServices(deps.home, agent)) {
    // Disabled first: a bootout alone would load it again at the next login.
    await must(deps, ["disable", target(deps, svc.label)], "Disabling the service");
    if (await printService(deps, svc.label)) {
      await bootoutAndWait(deps, svc.label);
      out.push({ agent: svc.agent, label: svc.label, result: "stopped" });
    } else {
      out.push({ agent: svc.agent, label: svc.label, result: "already stopped" });
    }
  }
  return out;
}

export async function uninstallService(deps: ServiceDeps, agent: string): Promise<ServiceOutcome & { logPath?: string }> {
  requireMac(deps, "uninstall");
  const [svc] = pickServices(deps.home, agent);
  if (await printService(deps, svc.label)) await bootoutAndWait(deps, svc.label);
  fs.rmSync(svc.plistPath, { force: true });
  return { agent: svc.agent, label: svc.label, result: "removed", logPath: svc.logPath };
}

export interface ServiceStatus {
  agent?: string;
  label: string;
  plistPath: string;
  logPath?: string;
  loaded: boolean;
  /** Stopped with `synap worker stop`: it stays stopped at login. */
  disabled: boolean;
  state?: string;
  pid?: number;
  lastExitCode?: number | null;
  runs?: number;
}

export async function serviceStatuses(deps: ServiceDeps, agent?: string): Promise<ServiceStatus[]> {
  requireMac(deps, "status");
  const services = pickServices(deps.home, agent);
  if (!services.length) return [];
  const dis = await deps.launchctl(["print-disabled", domain(deps)]);
  const disabled = dis.code === 0 ? parseDisabled(dis.stdout) : new Set<string>();
  const out: ServiceStatus[] = [];
  for (const svc of services) {
    const now = await printService(deps, svc.label);
    out.push({
      agent: svc.agent,
      label: svc.label,
      plistPath: svc.plistPath,
      logPath: svc.logPath,
      loaded: now !== null,
      disabled: disabled.has(svc.label),
      ...(now ?? {}),
    });
  }
  return out;
}

// ─── words ────────────────────────────────────────────────────────────────────

export function tildify(p: string, home: string): string {
  return p === home ? "~" : p.startsWith(home + "/") ? `~${p.slice(home.length)}` : p;
}

export function installMessage(r: InstallResult, agent: string, home: string): string {
  const head: Record<InstallAction, string> = {
    installed: `The agent ${agent} now runs on this Mac without a terminal: it starts when you log in and restarts if it stops.`,
    updated: `The agent ${agent} restarted with the new settings. A run in progress was stopped with it.`,
    unchanged: `Nothing to change: the agent ${agent} already runs as a service with these settings.`,
    started: `The service for ${agent} was set up but not running. It runs now.`,
  };
  const lines = [head[r.action]];
  for (const old of r.replaced) lines.push(`  Replaced ${old.label} (its file is kept at ${tildify(old.keptAt, home)}).`);
  lines.push(`  Service: ${r.label}`, `  Log:     ${tildify(r.logPath, home)}`);
  return lines.join("\n");
}

export function statusLine(s: ServiceStatus, home: string): string {
  const who = s.agent ?? "(unknown agent)";
  let state: string;
  if (s.state === "running") state = `running (pid ${s.pid ?? "?"})`;
  // Seen on a real Mac right after a (re)start: state = xpcproxy, with a pid.
  else if (s.pid) state = `starting (pid ${s.pid})`;
  else if (s.loaded) state = s.lastExitCode != null ? `not running, last exit ${s.lastExitCode}` : "not running";
  else state = s.disabled ? "stopped (stays stopped at login)" : "not loaded (starts at next login)";
  const log = s.logPath ? ` · log ${tildify(s.logPath, home)}` : "";
  return `${who}  ${state}  · ${s.label}${log}`;
}

/** What to run instead on a computer that is not a Mac. */
export function notMacMessage(platform: string, spec: Pick<ServiceSpec, "programArguments">): string {
  const cmd = spec.programArguments.map((a) => (/^[\w./:=@,-]+$/.test(a) ? a : `'${a.replace(/'/g, `'\\''`)}'`)).join(" ");
  return (
    `\`synap worker install\` sets up a macOS login service, and this computer runs ${platform}. ` +
    `Keep the agent running with this computer's service manager (on Linux, a systemd user unit with Restart=always) running:\n  ${cmd}`
  );
}

// ─── the commands ─────────────────────────────────────────────────────────────

function liveDeps(): ServiceDeps {
  return { home: os.homedir(), uid: process.getuid?.() ?? 0, platform: process.platform, launchctl: defaultLaunchctl };
}

export async function workerInstallCommand(
  opts: ServiceOptions & { replace?: boolean; runtime?: string }
): Promise<void> {
  const unknown = unknownAgentMessage(opts.agent);
  // --runtime asks the pod for the agent on its first run; a service restarting every 30 s must never
  // ask again and again, so that first run happens once, in a terminal, before the service exists.
  if (unknown && opts.runtime) {
    throw new Error(
      `${unknown}\nRun \`synap worker --agent ${opts.agent} --runtime ${opts.runtime} --once\` in a terminal first, then \`synap worker install\`.`
    );
  }
  if (unknown) throw new Error(unknown);
  const deps = liveDeps();
  // The program the agent's template starts, read as the worker reads it: a missing one is refused here,
  // not by a service that would die every 30 s.
  const engine = await engineForSavedAgent(opts.agent, process.env.PATH);
  const spec = buildServiceSpec(opts, {
    home: deps.home,
    cwd: process.cwd(),
    nodePath: process.execPath,
    synapPath: path.resolve(process.argv[1] ?? ""),
    searchPath: process.env.PATH,
    engine,
  });
  if (deps.platform !== "darwin") throw new Error(notMacMessage(deps.platform, spec));
  const r = await installService(spec, deps, { replace: opts.replace });
  console.log(installMessage(r, opts.agent, deps.home));
  console.log(`  Starts: ${engineLine(engine)}`);
}

export async function workerStartCommand(opts: { agent?: string }): Promise<void> {
  const deps = liveDeps();
  const out = await startServices(deps, opts.agent);
  if (!out.length) return void console.log("No agent runs as a service on this Mac. Set one up with `synap worker install --agent <name>`.");
  for (const o of out) {
    const pid = o.pid ? ` (pid ${o.pid})` : "";
    console.log(o.result === "started" ? `The agent ${o.agent ?? o.label} is running${pid}.` : `The agent ${o.agent ?? o.label} was already running${pid}.`);
  }
}

export async function workerStopCommand(opts: { agent?: string }): Promise<void> {
  const deps = liveDeps();
  const out = await stopServices(deps, opts.agent);
  if (!out.length) return void console.log("No agent runs as a service on this Mac.");
  for (const o of out) {
    const who = o.agent ?? o.label;
    const again = o.agent ? ` --agent ${o.agent}` : "";
    console.log(
      o.result === "stopped"
        ? `The agent ${who} is stopped, and stays stopped after a restart until \`synap worker start${again}\`. A run in progress was stopped with it.`
        : `The agent ${who} was not running. It stays stopped until \`synap worker start${again}\`.`
    );
  }
}

export async function workerUninstallCommand(opts: { agent?: string }): Promise<void> {
  if (!opts.agent) throw new Error("Name the agent to remove: `synap worker uninstall --agent <name>`.");
  const deps = liveDeps();
  const r = await uninstallService(deps, opts.agent);
  const log = r.logPath ? ` Its log stays at ${tildify(r.logPath, deps.home)}.` : "";
  console.log(`The agent ${opts.agent} no longer runs as a service on this Mac (${r.label} removed).${log}`);
}

export async function workerStatusCommand(opts: { agent?: string; json?: boolean }): Promise<void> {
  const deps = liveDeps();
  const all = await serviceStatuses(deps, opts.agent);
  if (opts.json) return void console.log(JSON.stringify(all, null, 2));
  if (!all.length) return void console.log("No agent runs as a service on this Mac. Set one up with `synap worker install --agent <name>`.");
  for (const s of all) console.log(statusLine(s, deps.home));
}
