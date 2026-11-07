/**
 * `synap tools install|verify|remove <capability>` and `synap tools list`:
 * install, check and remove a capability's tool on THIS computer, and record
 * the result on the pod (plan b647769e §3.1, §3.3, §3.4; decision 168f34db).
 *
 * The CLI is the link between the pod and the computer (decision 1): it runs
 * the steps the capability declares for this OS, exactly as declared, with no
 * AI in the loop. Package managers first; a script runs only pinned by its
 * sha256; anything needing admin rights is asked first and never run by the
 * worker. The verify run happens with the same PATH the worker uses, so a tool
 * that passes here also passes for the background service.
 *
 * The rules (which steps, which argv, what a verify run means, the report) are
 * pure and live in `lib/computer-tools.ts`. This file runs processes, reads the
 * manifest and talks to the pod. `reconcileComputerTools` is the worker's loop.
 */

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import chalk from "chalk";
import { resolveStatusLabel } from "@synap-core/types/vocabulary";
import {
  buildToolReport,
  elevationRefusal,
  matchVerify,
  OS_LABEL,
  parseIsoDuration,
  planSteps,
  platformAllowed,
  readComputerManifest,
  redactSecrets,
  statusAfterVerify,
  stepsFor,
  verifyArgv,
  verifyFor,
  type ComputerManifest,
  type ComputerToolStatus,
  type PlaceholderValues,
  type PlannedStep,
  type ProcessResult,
  type ToolReport,
  type VerifyOutcome,
} from "../lib/computer-tools.js";
import { log } from "../utils/logger.js";

// ── Where things live on this computer ────────────────────────────────────────

const toolsHome = () => path.join(os.homedir(), ".synap", "tools");

/** The `{placeholder}` values of this computer (see `fillPlaceholders`). */
export function localPlaceholders(platform: string = process.platform, arch: string = process.arch): PlaceholderValues {
  const brewPrefix =
    platform === "darwin" ? (arch === "arm64" ? "/opt/homebrew" : "/usr/local") : "/home/linuxbrew/.linuxbrew";
  return {
    brewPrefix,
    home: os.homedir(),
    models: path.join(toolsHome(), "models"),
    workdir: path.join(toolsHome(), "work"),
  };
}

/**
 * The PATH every step and verify runs with: the login shell's PATH plus where
 * Homebrew and `uv tool` put programs. A service started by launchd does not
 * read the login shell, so without this a tool verifies in a terminal and
 * fails in the worker (prior-art 57716e9a §6).
 */
export function toolEnv(base: NodeJS.ProcessEnv = process.env, platform: string = process.platform): NodeJS.ProcessEnv {
  if (platform === "win32") return { ...base };
  const v = localPlaceholders(platform);
  const extra = [`${v.brewPrefix}/bin`, `${v.brewPrefix}/sbin`, "/usr/local/bin", path.join(os.homedir(), ".local", "bin")];
  const have = (base.PATH ?? "").split(path.delimiter).filter(Boolean);
  return { ...base, PATH: [...have, ...extra.filter((d) => !have.includes(d))].join(path.delimiter) };
}

/** Is `program` on this PATH? */
export function onPath(program: string, env: NodeJS.ProcessEnv = toolEnv()): boolean {
  if (path.isAbsolute(program)) return fs.existsSync(program);
  const exts = process.platform === "win32" ? ["", ".exe", ".cmd", ".bat"] : [""];
  for (const dir of (env.PATH ?? "").split(path.delimiter)) {
    for (const ext of exts) {
      try {
        fs.accessSync(path.join(dir, program + ext), fs.constants.X_OK);
        return true;
      } catch {
        /* not here */
      }
    }
  }
  return false;
}

const OUTPUT_CAP = 256 * 1024;

/** Run one argv (never a shell line), capture its output, optionally echo it. */
export function runProcess(
  argv: string[],
  opts: { env?: NodeJS.ProcessEnv; timeoutMs?: number; echo?: (chunk: string) => void } = {}
): Promise<ProcessResult> {
  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let settled = false;
    const done = (r: ProcessResult) => {
      if (!settled) {
        settled = true;
        resolve(r);
      }
    };
    let child;
    try {
      child = spawn(argv[0]!, argv.slice(1), { env: opts.env ?? toolEnv(), shell: false, windowsHide: true });
    } catch (err) {
      done({ exitCode: null, stdout, stderr, error: `${argv[0]} could not start: ${(err as Error).message}` });
      return;
    }
    const timer = opts.timeoutMs
      ? setTimeout(() => {
          child.kill("SIGTERM");
          done({ exitCode: null, stdout, stderr, error: `${argv[0]} took longer than ${Math.round(opts.timeoutMs! / 1000)} s and was stopped` });
        }, opts.timeoutMs)
      : undefined;
    child.stdout?.on("data", (b: Buffer) => {
      const s = b.toString();
      if (stdout.length < OUTPUT_CAP) stdout += s;
      opts.echo?.(s);
    });
    child.stderr?.on("data", (b: Buffer) => {
      const s = b.toString();
      if (stderr.length < OUTPUT_CAP) stderr += s;
      opts.echo?.(s);
    });
    child.on("error", (err: NodeJS.ErrnoException) => {
      if (timer) clearTimeout(timer);
      const why = err.code === "ENOENT" ? `${argv[0]} is not installed on this computer` : err.message;
      done({ exitCode: null, stdout, stderr, error: why });
    });
    child.on("close", (code) => {
      if (timer) clearTimeout(timer);
      done({ exitCode: code, stdout, stderr });
    });
  });
}

/** Free disk space, in MB, where the tools land. Undefined when it cannot be read. */
export function freeDiskMb(dir: string = os.homedir()): number | undefined {
  try {
    const s = fs.statfsSync(dir);
    return Math.floor((s.bavail * s.bsize) / (1024 * 1024));
  } catch {
    return undefined;
  }
}

/** This computer's name as a person reads it ("MacBook-Pro", not "MacBook-Pro.local"). */
export const computerName = (): string => os.hostname().replace(/\.local$/, "");

// ── The manifest ──────────────────────────────────────────────────────────────

export interface ManifestSourceOpts {
  /** A manifest file on disk (a catalog `*.capability.json`), read before anything else. */
  manifest?: string;
}

/**
 * Read the capability's manifest: a file given with `--manifest`, else the
 * catalog (the control plane's package registry, the one catalog), else the
 * catalog package this CLI ships with. Each answer says where it came from.
 */
export async function loadComputerManifest(
  slug: string,
  opts: ManifestSourceOpts = {}
): Promise<{ manifest: ComputerManifest; source: string } | { error: string }> {
  if (opts.manifest) {
    let raw: unknown;
    try {
      raw = JSON.parse(fs.readFileSync(opts.manifest, "utf8"));
    } catch (err) {
      return { error: `could not read ${opts.manifest}: ${(err as Error).message}` };
    }
    const m = readComputerManifest(raw, slug);
    return "error" in m ? m : { manifest: m, source: opts.manifest };
  }
  const tried: string[] = [];
  try {
    const { fetchPackageDefinition } = await import("../lib/cp-packages.js");
    const def = await fetchPackageDefinition(slug);
    if (def) {
      const m = readComputerManifest(def, slug);
      if (!("error" in m)) return { manifest: m, source: "the catalog" };
      tried.push(`the catalog: ${m.error}`);
    } else tried.push("the catalog has no such capability, or could not be reached");
  } catch (err) {
    tried.push(`the catalog: ${(err as Error).message}`);
  }
  const { resolveInstalledCatalogRoot } = await import("../lib/catalog-templates.js");
  const root = resolveInstalledCatalogRoot();
  const file = root ? path.join(root, "capabilities", `${slug}.capability.json`) : undefined;
  if (file && fs.existsSync(file)) {
    const m = readComputerManifest(JSON.parse(fs.readFileSync(file, "utf8")), slug);
    if (!("error" in m)) return { manifest: m, source: "the catalog shipped with this CLI" };
    tried.push(`the shipped catalog: ${m.error}`);
  } else tried.push("the catalog shipped with this CLI does not have it");
  return { error: `no manifest for ${slug} (${tried.join("; ")})` };
}

// ── The pod's door ────────────────────────────────────────────────────────────

/** A row of the computer's desired state, as the pod answers it. */
export interface DesiredTool {
  capabilitySlug: string;
  /** The manifest version the person approved (an upgrade is a new approval). */
  desiredVersion: string | null;
  /** The manifest version installed, as last reported. */
  manifestVersion: string | null;
  status: string;
  verifiedAt: string | null;
}

export interface ToolsDoor {
  report(r: ToolReport): Promise<void>;
  desired(): Promise<DesiredTool[]>;
}

/** Hub paths of the computer-capabilities door (backend lane w1-backend). */
export const REPORT_PATH = "/computer-capabilities/report";
export const DESIRED_PATH = "/computer-capabilities";

/**
 * The door, authenticated as THIS computer (its own key from enrolment): the
 * pod knows which computer reports from the key, never from a field it sends.
 * Null with the reason when this computer is not enrolled on the pod.
 */
export async function computerDoor(): Promise<{ door: ToolsDoor; pod: string } | { error: string }> {
  const { resolveHubConfig } = await import("../lib/hub-client.js");
  const { computerProfileFor, enrolCommand } = await import("../lib/device-connect.js");
  const { listPodProfiles } = await import("../lib/pod.js");
  let podUrl: string;
  try {
    podUrl = (await resolveHubConfig()).podUrl;
  } catch (err) {
    return { error: (err as Error).message };
  }
  const profiles = listPodProfiles();
  const computer = computerProfileFor(podUrl, profiles);
  if (!computer) return { error: `this computer is not connected to ${new URL(podUrl).host}: run \`${enrolCommand(podUrl, profiles)}\`` };
  return { pod: new URL(podUrl).host, door: await doorFor(podUrl, computer.config.hubApiKey) };
}

/** The door on `podUrl` with this computer's own key. */
export async function doorFor(podUrl: string, computerKey: string): Promise<ToolsDoor> {
  const { hubGet, hubPost } = await import("../lib/hub-client.js");
  const cfg = { podUrl, apiKey: computerKey, userId: "cli" };
  return {
    async report(r) {
      await hubPost(REPORT_PATH, r, cfg);
    },
    async desired() {
      const res = (await hubGet(DESIRED_PATH, { computer: "me" }, cfg)) as { items?: DesiredTool[] } | DesiredTool[];
      return Array.isArray(res) ? res : (res.items ?? []);
    },
  };
}

// ── Install, verify, remove ───────────────────────────────────────────────────

export interface RunContext {
  os: string;
  arch: string;
  env: NodeJS.ProcessEnv;
  values: PlaceholderValues;
  /** A person is at the keyboard: steps needing admin rights are asked; a script is shown. */
  interactive: boolean;
  /** The pod holds the person's approval of this install (the worker's desired state). */
  approvedOnPod?: boolean;
  dryRun?: boolean;
  skipModels?: boolean;
  sessionId?: string;
  say: (line: string) => void;
  confirm?: (question: string) => Promise<boolean>;
  door?: ToolsDoor;
  /** Capabilities already handled in this run (requires.capabilities). */
  visited?: Set<string>;
  run?: typeof runProcess;
  load?: typeof loadComputerManifest;
}

export function defaultContext(over: Partial<RunContext> = {}): RunContext {
  const interactive = !!process.stdin.isTTY && !!process.stdout.isTTY;
  return {
    os: process.platform,
    arch: process.arch,
    env: toolEnv(),
    values: localPlaceholders(),
    interactive,
    say: (l) => log.info(l),
    confirm: async (q) => {
      const prompts = (await import("prompts")).default;
      const { ok } = await prompts({ type: "confirm", name: "ok", message: q, initial: false });
      return ok === true;
    },
    ...over,
  };
}

export interface ToolResult {
  status: ComputerToolStatus | "refused" | "dry-run";
  toolVersion: string | null;
  /** Plain words for the person. */
  message: string;
  /** What the pod recorded: "recorded", or why it did not. */
  recorded?: string;
}

/** The tool's own name for a sentence: the first package the steps install, else the capability's name. */
function toolName(m: ComputerManifest, os: string): string {
  const s = stepsFor(m.spec.install, os);
  if ("error" in s) return m.name;
  const first = s.steps.find((x) => x.kind !== "download");
  return first?.package ?? first?.id ?? m.name;
}

async function sendReport(ctx: RunContext, r: ToolReport): Promise<string> {
  if (!ctx.door) return "not recorded: this computer is not connected to a pod";
  try {
    await ctx.door.report(r);
    return "recorded";
  } catch (err) {
    return `not recorded on the pod: ${(err as Error).message}`;
  }
}

/** Run the OS's verify check. */
export async function runVerify(
  m: ComputerManifest,
  ctx: RunContext
): Promise<{ outcome: VerifyOutcome; run?: ProcessResult; argv?: string[] }> {
  const check = verifyFor(m.spec, ctx.os);
  if (!check) return { outcome: { ok: false, toolVersion: null, reason: `no check for ${OS_LABEL[ctx.os] ?? ctx.os}` } };
  const filled = verifyArgv(m.spec, ctx.os, check.command, ctx.values);
  if ("error" in filled) return { outcome: { ok: false, toolVersion: null, reason: filled.error } };
  const timeoutMs = (m.spec.verify?.timeoutSec ?? 60) * 1000;
  const run = await (ctx.run ?? runProcess)(filled.argv, { env: ctx.env, timeoutMs });
  return { outcome: matchVerify(run, check), run, argv: filled.argv };
}

/** Check the tool and record what was found. */
export async function verifyTool(m: ComputerManifest, ctx: RunContext): Promise<ToolResult> {
  const { outcome, run, argv } = await runVerify(m, ctx);
  if (ctx.dryRun) {
    return { status: "dry-run", toolVersion: null, message: `would check: ${argv?.join(" ") ?? outcome.reason}` };
  }
  const status = statusAfterVerify(m.spec, outcome);
  const recorded = await sendReport(
    ctx,
    buildToolReport({ slug: m.slug, status, manifestVersion: m.version, toolVersion: outcome.toolVersion, os: ctx.os, arch: ctx.arch, run, sessionId: ctx.sessionId })
  );
  const name = toolName(m, ctx.os);
  const v = outcome.toolVersion ? ` ${outcome.toolVersion}` : "";
  const message =
    status === "installed"
      ? `${name}${v} works on ${computerName()}, checked`
      : status === "drifted"
        ? `${name}${v} on ${computerName()} is outside the version ${m.slug} needs (${m.spec.placement?.requires?.tool?.version})`
        : `${name} does not work on ${computerName()}: ${outcome.reason}`;
  return { status, toolVersion: outcome.toolVersion, message, recorded };
}

/** Everything that must hold before a step runs: platform, steps, refusals, disk. */
export function preflight(
  m: ComputerManifest,
  ctx: Pick<RunContext, "os" | "arch" | "values" | "skipModels">,
  action: "install" | "uninstall",
  freeMb: number | undefined
): { planned: PlannedStep[] } | { error: string } {
  const allowed = platformAllowed(m.spec, ctx.os, ctx.arch);
  if (!allowed.ok) return { error: `${m.name} ${allowed.reason}` };
  const steps = stepsFor(action === "install" ? m.spec.install : m.spec.uninstall, ctx.os);
  if ("error" in steps) return { error: `${m.name} has ${steps.error}` };
  const plan = planSteps(steps.steps, action, ctx.os, ctx.values);
  if ("error" in plan) return plan;
  const elevation = elevationRefusal(m.spec, plan.planned);
  if (elevation) return { error: elevation };
  const planned = ctx.skipModels ? plan.planned.filter((p) => !(p.step.kind === "download" && p.step.what === "model")) : plan.planned;
  if (action === "install") {
    const needMb =
      m.spec.install?.diskFreeMb ?? planned.reduce((n, p) => n + (p.step.kind === "download" ? (p.step.sizeMb ?? 0) : 0), 0);
    if (needMb && freeMb !== undefined && freeMb < needMb) {
      return { error: `${m.name} needs ${(needMb / 1000).toFixed(1)} GB free; this computer has ${(freeMb / 1000).toFixed(1)} GB` };
    }
  }
  return { planned };
}

async function fetchChecked(url: string, sha256: string): Promise<Buffer | { error: string }> {
  let res: Response;
  try {
    res = await fetch(url, { signal: AbortSignal.timeout(30 * 60_000) });
  } catch (err) {
    return { error: `could not download ${url}: ${(err as Error).message}` };
  }
  if (!res.ok) return { error: `could not download ${url}: HTTP ${res.status}` };
  const buf = Buffer.from(await res.arrayBuffer());
  const got = createHash("sha256").update(buf).digest("hex");
  if (got !== sha256.toLowerCase()) return { error: `refused: ${url} does not match its sha256 (got ${got.slice(0, 12)}…)` };
  return buf;
}

/** Run planned steps in order. A `fallback` step runs only when the one before it failed. */
async function runSteps(planned: PlannedStep[], m: ComputerManifest, ctx: RunContext, logFile: string): Promise<{ ok: true } | { error: string }> {
  const append = (s: string) => fs.appendFileSync(logFile, redactSecrets(s));
  let previousFailed = false;
  for (const p of planned) {
    if (p.step.fallback && !previousFailed) continue;
    ctx.say(`→ ${p.describe}`);
    append(`\n$ ${p.describe}\n`);
    if (p.needs && !onPath(p.needs, ctx.env)) {
      const err = `${p.needs} is not installed on this computer${p.needs === "brew" ? " (https://brew.sh)" : p.needs === "uv" || p.needs === "uvx" ? " (https://docs.astral.sh/uv/)" : ""}`;
      append(err + "\n");
      if (planned[planned.indexOf(p) + 1]?.step.fallback) {
        previousFailed = true;
        continue;
      }
      return { error: err };
    }
    let argv = p.argv;
    if (p.step.kind === "script" || (p.step.kind === "download" && p.step.url)) {
      const buf = await fetchChecked(p.step.url!, p.step.sha256!);
      if (!Buffer.isBuffer(buf)) return buf;
      if (p.step.kind === "download") {
        fs.mkdirSync(path.dirname(p.dest!), { recursive: true });
        fs.writeFileSync(p.dest!, buf);
        previousFailed = false;
        continue;
      }
      const script = path.join(toolsHome(), "scripts", `${m.slug}-${p.step.sha256!.slice(0, 12)}`);
      fs.mkdirSync(path.dirname(script), { recursive: true });
      fs.writeFileSync(script, buf, { mode: 0o700 });
      if (ctx.interactive && !ctx.approvedOnPod) {
        ctx.say(chalk.dim(buf.toString("utf8").split("\n").slice(0, 40).join("\n")));
        if (!(await ctx.confirm?.(`Run this script from ${p.step.url}?`))) return { error: "you did not run the script: nothing else was changed" };
      }
      argv = argv!.map((a) => a.split("{script}").join(script));
    }
    const res = await (ctx.run ?? runProcess)(argv!, {
      env: ctx.env,
      echo: (c) => {
        append(c);
        if (ctx.interactive) process.stdout.write(chalk.dim(c));
      },
    });
    if (res.error || res.exitCode !== 0) {
      append(`\n(exit ${res.exitCode}${res.error ? `: ${res.error}` : ""})\n`);
      if (planned[planned.indexOf(p) + 1]?.step.fallback) {
        previousFailed = true;
        continue;
      }
      return { error: `${p.describe} failed: ${res.error ?? `exit ${res.exitCode}`}. Log: ${logFile}` };
    }
    previousFailed = false;
  }
  return { ok: true };
}

function newLogFile(slug: string, action: string): string {
  const dir = path.join(toolsHome(), "logs");
  fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, `${slug}-${action}-${new Date().toISOString().replace(/[:.]/g, "-")}.log`);
}

/** Install the capability's tool on this computer, check it, record it. */
export async function installTool(m: ComputerManifest, ctx: RunContext): Promise<ToolResult> {
  if (ctx.os === "win32") ctx.say(chalk.yellow("Windows: these steps are written but not tested on Windows yet."));
  const pre = preflight(m, ctx, "install", freeDiskMb());
  if ("error" in pre) return { status: "refused", toolVersion: null, message: pre.error };

  if (ctx.dryRun) {
    ctx.say(`${m.name} (${m.slug} ${m.version}) on ${OS_LABEL[ctx.os] ?? ctx.os} ${ctx.arch}, licence ${m.spec.licence ?? "not stated"}:`);
    for (const p of pre.planned) ctx.say(`  ${p.admin ? "[admin] " : ""}${p.describe}${p.argv ? `\n      ${p.argv.join(" ")}` : ""}`);
    const check = verifyFor(m.spec, ctx.os);
    const argv = check ? verifyArgv(m.spec, ctx.os, check.command, ctx.values) : undefined;
    ctx.say(`  then check: ${argv && "argv" in argv ? argv.argv.join(" ") : "no check declared"}`);
    if (ctx.skipModels) ctx.say(`  (model downloads skipped)`);
    return { status: "dry-run", toolVersion: null, message: "dry run: nothing was installed or recorded" };
  }

  // What it needs first (requires.capabilities), each checked and installed if missing.
  const visited = ctx.visited ?? new Set<string>();
  visited.add(m.slug);
  for (const dep of m.spec.placement?.requires?.capabilities ?? []) {
    if ((dep.os && dep.os !== ctx.os) || visited.has(dep.slug)) continue;
    const loaded = await (ctx.load ?? loadComputerManifest)(dep.slug);
    if ("error" in loaded) return { status: "refused", toolVersion: null, message: `${m.name} needs ${dep.slug} first: ${loaded.error}` };
    const { outcome } = await runVerify(loaded.manifest, ctx);
    if (outcome.ok) continue;
    ctx.say(`${m.name} needs ${loaded.manifest.name} first.`);
    const r = await installTool(loaded.manifest, { ...ctx, visited });
    if (r.status !== "installed") return { status: "refused", toolVersion: null, message: `${m.name} needs ${loaded.manifest.name} first: ${r.message}` };
  }

  const admin = pre.planned.filter((p) => p.admin);
  if (admin.length) {
    const list = admin.map((p) => p.describe).join("; ");
    if (!ctx.interactive) {
      return { status: "refused", toolVersion: null, message: `${m.name} needs admin rights (${list}): run \`synap tools install ${m.slug}\` on this computer yourself` };
    }
    if (!(await ctx.confirm?.(`These steps need admin rights: ${list}. Continue?`))) {
      return { status: "refused", toolVersion: null, message: "you said no: nothing was installed" };
    }
  }

  const logFile = newLogFile(m.slug, "install");
  await sendReport(ctx, buildToolReport({ slug: m.slug, status: "installing", manifestVersion: m.version, toolVersion: null, os: ctx.os, arch: ctx.arch, sessionId: ctx.sessionId }));
  const ran = await runSteps(pre.planned, m, ctx, logFile);
  if ("error" in ran) {
    const recorded = await sendReport(
      ctx,
      buildToolReport({ slug: m.slug, status: "verify_failed", manifestVersion: m.version, toolVersion: null, os: ctx.os, arch: ctx.arch, run: { exitCode: null, stdout: "", stderr: "", error: ran.error }, sessionId: ctx.sessionId })
    );
    return { status: "verify_failed", toolVersion: null, message: `${m.name} was not installed: ${ran.error}`, recorded };
  }
  const checked = await verifyTool(m, ctx);
  if (checked.status === "installed") {
    const v = checked.toolVersion ? ` ${checked.toolVersion}` : "";
    return { ...checked, message: `Installed ${toolName(m, ctx.os)}${v} on ${computerName()}, checked` };
  }
  return { ...checked, message: `${checked.message}. Log: ${logFile}` };
}

/** Remove the tool from this computer (downloaded models are kept), check it is gone, record it. */
export async function removeTool(m: ComputerManifest, ctx: RunContext): Promise<ToolResult> {
  const pre = preflight(m, ctx, "uninstall", undefined);
  if ("error" in pre) return { status: "refused", toolVersion: null, message: pre.error };
  if (ctx.dryRun) {
    for (const p of pre.planned) ctx.say(`  ${p.admin ? "[admin] " : ""}${p.describe}${p.argv ? `\n      ${p.argv.join(" ")}` : ""}`);
    return { status: "dry-run", toolVersion: null, message: "dry run: nothing was removed or recorded" };
  }
  const admin = pre.planned.filter((p) => p.admin);
  if (admin.length && !ctx.interactive) {
    return { status: "refused", toolVersion: null, message: `removing ${m.name} needs admin rights: run \`synap tools remove ${m.slug}\` on this computer yourself` };
  }
  if (admin.length && !(await ctx.confirm?.(`These steps need admin rights: ${admin.map((p) => p.describe).join("; ")}. Continue?`))) {
    return { status: "refused", toolVersion: null, message: "you said no: nothing was removed" };
  }
  await sendReport(ctx, buildToolReport({ slug: m.slug, status: "uninstalling", manifestVersion: m.version, toolVersion: null, os: ctx.os, arch: ctx.arch, sessionId: ctx.sessionId }));
  const logFile = newLogFile(m.slug, "remove");
  const ran = await runSteps(pre.planned, m, ctx, logFile);
  if ("error" in ran) return { status: "refused", toolVersion: null, message: `${m.name} was not removed: ${ran.error}` };
  const { outcome, run } = await runVerify(m, ctx);
  if (outcome.ok) {
    const recorded = await sendReport(ctx, buildToolReport({ slug: m.slug, status: statusAfterVerify(m.spec, outcome), manifestVersion: m.version, toolVersion: outcome.toolVersion, os: ctx.os, arch: ctx.arch, run, sessionId: ctx.sessionId }));
    return { status: "refused", toolVersion: outcome.toolVersion, message: `${toolName(m, ctx.os)} still works on ${computerName()} after removing it (installed another way?). Log: ${logFile}`, recorded };
  }
  const recorded = await sendReport(ctx, buildToolReport({ slug: m.slug, status: "removed", manifestVersion: m.version, toolVersion: null, os: ctx.os, arch: ctx.arch, run, sessionId: ctx.sessionId }));
  const kept = m.spec.uninstall?.keepUserData === false ? "" : " (downloaded models kept)";
  return { status: "removed", toolVersion: null, message: `Removed ${toolName(m, ctx.os)} from ${computerName()}${kept}`, recorded };
}

// ── The worker's loop: apply the computer's desired state ─────────────────────

export type ReconcileAction = "install" | "upgrade" | "verify" | "repair" | "remove" | "upgrade-waits" | "none";

const DEFAULT_REVERIFY_MS = 7 * 24 * 3600_000;

/**
 * What the worker does for one desired row (decision 2): an approved install
 * runs; a check runs when it is due; a tool that stopped working is repaired
 * without asking (same steps, same version); an upgrade runs only when the pod
 * holds the person's approval of that version, otherwise it waits.
 */
export function planReconcile(row: DesiredTool, manifest: ComputerManifest, nowMs: number): ReconcileAction {
  const catalogVersion = manifest.version;
  const approved = row.desiredVersion ?? catalogVersion;
  if (row.status === "uninstalling") return "remove";
  if (row.status === "removed") return "none";
  if (row.status === "requested" || row.status === "installing") return approved === catalogVersion ? "install" : "upgrade-waits";
  if (row.manifestVersion && row.manifestVersion !== catalogVersion) {
    if (approved === catalogVersion) return "upgrade";
  }
  if (row.status === "verify_failed") return row.manifestVersion === catalogVersion || !row.manifestVersion ? "repair" : "upgrade-waits";
  const every = parseIsoDuration(manifest.spec.verify?.reverifyEvery) ?? DEFAULT_REVERIFY_MS;
  const last = row.verifiedAt ? Date.parse(row.verifiedAt) : NaN;
  if (Number.isNaN(last) || nowMs - last >= every) return "verify";
  return row.manifestVersion && row.manifestVersion !== catalogVersion ? "upgrade-waits" : "none";
}

/** One computer, one reconciler: several workers (one per agent) share a lock file. */
export function takeReconcileLock(file: string = path.join(toolsHome(), "reconcile.lock")): (() => void) | undefined {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  try {
    const fd = fs.openSync(file, "wx");
    fs.writeSync(fd, String(process.pid));
    fs.closeSync(fd);
  } catch {
    const pid = Number(fs.readFileSync(file, "utf8").trim());
    let alive = false;
    try {
      if (pid) process.kill(pid, 0);
      alive = !!pid;
    } catch {
      alive = false;
    }
    if (alive) return undefined;
    fs.writeFileSync(file, String(process.pid));
  }
  return () => {
    try {
      if (fs.readFileSync(file, "utf8").trim() === String(process.pid)) fs.unlinkSync(file);
    } catch {
      /* already gone */
    }
  };
}

/** Apply the computer's desired state once. Returns one line per thing done. */
export async function reconcileComputerTools(ctx: RunContext & { door: ToolsDoor; now?: () => number }): Promise<string[]> {
  const rows = await ctx.door.desired();
  const lines: string[] = [];
  for (const row of rows) {
    const loaded = await (ctx.load ?? loadComputerManifest)(row.capabilitySlug);
    if ("error" in loaded) {
      lines.push(`${row.capabilitySlug}: ${loaded.error}`);
      continue;
    }
    const m = loaded.manifest;
    const action = planReconcile(row, m, (ctx.now ?? Date.now)());
    const wctx: RunContext = { ...ctx, interactive: false, approvedOnPod: true };
    if (action === "none") continue;
    if (action === "upgrade-waits") {
      lines.push(`${m.name}: version ${m.version} is in the catalog; the upgrade waits for your approval on the pod`);
      continue;
    }
    let r: ToolResult;
    if (action === "remove") r = await removeTool(m, wctx);
    else if (action === "verify") {
      r = await verifyTool(m, wctx);
      if (r.status === "verify_failed" && row.manifestVersion === m.version) {
        lines.push(r.message);
        r = await installTool(m, wctx); // a repair runs without asking: the install was approved
      }
    } else r = await installTool(m, wctx);
    lines.push(r.recorded && r.recorded !== "recorded" ? `${r.message} (${r.recorded})` : r.message);
  }
  return lines;
}

// ── Commands ──────────────────────────────────────────────────────────────────

export interface ToolsCommandOpts extends ManifestSourceOpts {
  dryRun?: boolean;
  computer?: string;
  skipModels?: boolean;
  session?: string;
  json?: boolean;
}

/** `--computer` names this computer only: installing on another one is a pod dispatch (wave 2). */
function computerRefusal(opts: ToolsCommandOpts): string | undefined {
  if (!opts.computer) return undefined;
  const here = computerName().toLowerCase();
  const asked = opts.computer.toLowerCase().replace(/\.local$/, "");
  if (asked === "this" || asked === here) return undefined;
  return `synap tools runs on the computer it is typed on (${computerName()}). To install on ${opts.computer}, run it there.`;
}

async function toolsAction(action: "install" | "verify" | "remove", slug: string, opts: ToolsCommandOpts): Promise<void> {
  const refused = computerRefusal(opts);
  if (refused) {
    log.error(refused);
    process.exitCode = 1;
    return;
  }
  const loaded = await loadComputerManifest(slug, opts);
  if ("error" in loaded) {
    log.error(loaded.error);
    process.exitCode = 1;
    return;
  }
  let door: ToolsDoor | undefined;
  let notRecorded: string | undefined;
  if (!opts.dryRun) {
    const d = await computerDoor();
    if ("error" in d) notRecorded = d.error;
    else door = d.door;
  }
  const ctx = defaultContext({ dryRun: opts.dryRun, skipModels: opts.skipModels, sessionId: opts.session, door });
  log.dim(`manifest: ${loaded.source}`);
  const r =
    action === "install"
      ? await installTool(loaded.manifest, ctx)
      : action === "remove"
        ? await removeTool(loaded.manifest, ctx)
        : await verifyTool(loaded.manifest, ctx);
  if (opts.json) {
    console.log(JSON.stringify({ slug, ...r }, null, 2));
  } else if (r.status === "installed" || r.status === "removed" || r.status === "dry-run") log.success(r.message);
  else log.error(r.message);
  if (r.recorded && r.recorded !== "recorded") log.warn(r.recorded);
  else if (notRecorded && !opts.dryRun) log.warn(`not recorded: ${notRecorded}`);
  if (!["installed", "removed", "dry-run"].includes(r.status) || (r.recorded && r.recorded !== "recorded")) process.exitCode = 1;
}

export const toolsInstallCommand = (slug: string, opts: ToolsCommandOpts) => toolsAction("install", slug, opts);
export const toolsVerifyCommand = (slug: string, opts: ToolsCommandOpts) => toolsAction("verify", slug, opts);
export const toolsRemoveCommand = (slug: string, opts: ToolsCommandOpts) => toolsAction("remove", slug, opts);

/** `synap tools list`: what the pod records on this computer. A failed read is said, never shown as empty. */
export async function toolsListCommand(opts: { json?: boolean }): Promise<void> {
  const d = await computerDoor();
  if ("error" in d) {
    log.error(d.error);
    process.exitCode = 1;
    return;
  }
  let rows: DesiredTool[];
  try {
    rows = await d.door.desired();
  } catch (err) {
    log.error(`could not read the tools on ${computerName()} from ${d.pod}: ${(err as Error).message}`);
    process.exitCode = 1;
    return;
  }
  if (opts.json) {
    console.log(JSON.stringify(rows, null, 2));
    return;
  }
  log.heading(`Tools on ${computerName()}`);
  if (!rows.length) {
    log.info("None yet. Install one with `synap tools install <capability>`.");
    return;
  }
  for (const r of rows) {
    const checked = r.verifiedAt ? `, checked ${r.verifiedAt.slice(0, 10)}` : "";
    log.info(`${r.capabilitySlug}  ${resolveStatusLabel(r.status)}${r.manifestVersion ? `  ${r.manifestVersion}` : ""}${checked}`);
  }
}

/** How often the worker reads the computer's desired state. Checks are due per manifest (`reverifyEvery`). */
export const TOOLS_EVERY_MS = 5 * 60_000;

/**
 * The worker's tools loop: at most every `everyMs`, read the computer's desired
 * state and apply it, under one lock per computer. It never throws: tools are
 * a side job of the worker, and a pod without the door is said once.
 */
export function createToolsReconciler(deps: {
  door: ToolsDoor;
  say: (line: string) => void;
  everyMs?: number;
  now?: () => number;
  ctx?: Partial<RunContext>;
  lock?: () => (() => void) | undefined;
}): { tick(): Promise<void> } {
  let last = -Infinity;
  let lastError: string | undefined;
  const now = deps.now ?? Date.now;
  return {
    async tick() {
      if (now() - last < (deps.everyMs ?? TOOLS_EVERY_MS)) return;
      last = now();
      const release = (deps.lock ?? takeReconcileLock)();
      if (!release) return; // another worker on this computer is applying it
      try {
        const lines = await reconcileComputerTools({ ...defaultContext({ interactive: false, say: () => {} }), ...deps.ctx, door: deps.door, now });
        for (const l of lines) deps.say(`tools: ${l}`);
        lastError = undefined;
      } catch (err) {
        const msg = `tools: could not read this computer's tools from the pod: ${(err as Error).message}`;
        if (msg !== lastError) deps.say(msg);
        lastError = msg;
      } finally {
        release();
      }
    },
  };
}
