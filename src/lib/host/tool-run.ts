/**
 * The host runner's `tool` executor: install, check and remove a capability's
 * program on THIS computer with the steps its approved manifest declares for
 * this OS (plan b647769e §3; decision 168f34db; one installer, reconciliation
 * f75fbb48 §3.3). `lease.ts` runs it for a leased host job of an installation
 * of kind `tool`; `synap tools install|verify|remove` reaches it through the
 * same job, with a person at the keyboard.
 *
 * Package managers first; a script runs only pinned by its sha256; a step
 * needing admin rights is asked first, and never run with no person to ask.
 * Every step and the check run with the PATH the background worker has, so a
 * tool that passes here also passes for the worker. No AI in this path.
 *
 * It sends nothing to the pod: it returns the steps and the check, and the job
 * reports them (`ToolCheck`). The rules (which argv, what a check means) are
 * pure and live in `tool.ts`.
 */

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import chalk from "chalk";
import { writeSecretFileNoFollow } from "../atomic-file.js";
import {
  buildToolCheck,
  elevationRefusal,
  matchVerify,
  OS_LABEL,
  planSteps,
  platformAllowed,
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
  type VerifyOutcome,
} from "./tool.js";
import type { FinishStep, ToolCheck } from "./wire.js";

// ── Where things live on this computer ────────────────────────────────────────

export const toolsHome = () => path.join(os.homedir(), ".synap", "tools");

/** The `{placeholder}` values of this computer (see `fillPlaceholders`). */
export function localPlaceholders(platform: string = process.platform, arch: string = process.arch): PlaceholderValues {
  const brewPrefix =
    platform === "darwin" ? (arch === "arm64" ? "/opt/homebrew" : "/usr/local") : "/home/linuxbrew/.linuxbrew";
  return {
    brewPrefix,
    home: os.homedir(),
    models: path.join(toolsHome(), "models"),
    tools: path.join(toolsHome(), "opt"),
    workdir: path.join(toolsHome(), "work"),
  };
}

/**
 * The PATH every step and check runs with: the login shell's PATH plus where
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

// ── The executor ──────────────────────────────────────────────────────────────

export interface RunContext {
  os: string;
  arch: string;
  env: NodeJS.ProcessEnv;
  values: PlaceholderValues;
  /** A person is at the keyboard: steps needing admin rights are asked; a script is shown. */
  interactive: boolean;
  dryRun?: boolean;
  skipModels?: boolean;
  say: (line: string) => void;
  confirm?: (question: string) => Promise<boolean>;
  run?: typeof runProcess;
  /** Read a prerequisite's manifest (`placement.requires.capabilities`). */
  load?: (slug: string) => Promise<{ manifest: ComputerManifest } | { error: string }>;
  /**
   * A prerequisite is missing: install it (its own yes, its own installation on
   * the pod) and answer whether it now works. Absent (the worker): refused,
   * and the person approves the prerequisite on the pod first.
   */
  prerequisite?: (dep: ComputerManifest) => Promise<{ ok: true } | { ok: false; message: string }>;
  /** Free disk in MB where tools land (default: measured). */
  freeMb?: () => number | undefined;
}

export function defaultContext(over: Partial<RunContext> = {}): RunContext {
  const interactive = !!process.stdin.isTTY && !!process.stdout.isTTY;
  return {
    os: process.platform,
    arch: process.arch,
    env: toolEnv(),
    values: localPlaceholders(),
    interactive,
    say: () => {},
    confirm: async (q) => {
      const prompts = (await import("prompts")).default;
      const { ok } = await prompts({ type: "confirm", name: "ok", message: q, initial: false });
      return ok === true;
    },
    ...over,
  };
}

export interface ToolResult {
  /** `failed`: a step failed before the check; `refused`: nothing ran. */
  status: ComputerToolStatus | "failed" | "refused" | "dry-run";
  toolVersion: string | null;
  /** Plain words for the person. */
  message: string;
  /** What the job reports and finishes with (absent when nothing was checked). */
  check?: ToolCheck;
  /** Each step that ran, for the job's finish. */
  steps: FinishStep[];
  /** How the smoke run went, as words appended to a message ("" when none was declared). */
  smokeWords?: string;
}

export const WINDOWS_UNTESTED = "Windows: these steps are written but not tested on Windows yet.";

/** The tool's own name for a sentence: the first package the steps install, else the capability's name. */
function toolName(m: ComputerManifest, os: string): string {
  const s = stepsFor(m.spec.install, os);
  if ("error" in s) return m.name;
  const first = s.steps.find((x) => x.kind !== "download");
  return first?.package ?? first?.id ?? m.name;
}

const refused = (message: string): ToolResult => ({ status: "refused", toolVersion: null, message, steps: [] });

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

/**
 * The smoke run (does the tool WORK, not only answer --version), when the
 * manifest declares one this computer can fill. A smoke that needs a
 * `{fixture}` waits for the catalog to ship fixtures: not run, said so.
 */
export async function runSmoke(m: ComputerManifest, ctx: RunContext): Promise<{ run: ProcessResult; ok: boolean } | { skipped: string } | undefined> {
  const smoke = verifyFor(m.spec, ctx.os)?.smoke;
  if (!smoke) return undefined;
  const filled = verifyArgv(m.spec, ctx.os, smoke.command, ctx.values);
  if ("error" in filled) return { skipped: filled.error };
  const timeoutMs = (m.spec.verify?.timeoutSec ?? 60) * 1000;
  const run = await (ctx.run ?? runProcess)(filled.argv, { env: ctx.env, timeoutMs });
  return { run, ok: matchVerify(run, { command: filled.argv, expect: smoke.expect }).ok };
}

/** Check the tool: the version it prints, and its smoke run when one is declared. */
export async function verifyTool(m: ComputerManifest, ctx: RunContext): Promise<ToolResult> {
  if (ctx.os === "win32") ctx.say(chalk.yellow(WINDOWS_UNTESTED));
  const t0 = Date.now();
  const { outcome, run, argv } = await runVerify(m, ctx);
  if (ctx.dryRun) {
    return { status: "dry-run", toolVersion: null, message: `would check: ${argv?.join(" ") ?? outcome.reason}`, steps: [] };
  }
  const status = statusAfterVerify(m.spec, outcome);
  const smoke = outcome.ok ? await runSmoke(m, ctx) : undefined;
  const smokeRan = smoke && "run" in smoke ? smoke : undefined;
  const check = buildToolCheck({ toolVersion: outcome.toolVersion, os: ctx.os, arch: ctx.arch, ok: outcome.ok, run, smoke: smokeRan });
  const steps: FinishStep[] = [
    { name: `check: ${argv?.join(" ") ?? "no check"}`, ok: outcome.ok, durationMs: Date.now() - t0, ...(outcome.ok ? {} : { detail: outcome.reason }) },
  ];
  const smokeWords = !smoke ? "" : "skipped" in smoke ? " (smoke test not run: " + smoke.skipped + ")" : smoke.ok ? ", smoke test passed" : ", but its smoke test failed";
  const name = toolName(m, ctx.os);
  const v = outcome.toolVersion ? ` ${outcome.toolVersion}` : "";
  const message =
    status === "installed"
      ? `${name}${v} works on ${computerName()}, checked${smokeWords}`
      : status === "drifted"
        ? `${name}${v} on ${computerName()} is outside the version ${m.slug} needs (${m.spec.placement?.requires?.tool?.version})`
        : `${name} does not work on ${computerName()}: ${outcome.reason}`;
  return { status, toolVersion: outcome.toolVersion, message, check, steps, smokeWords };
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
  const plan = planSteps(steps.steps, action, ctx.os, ctx.values, ctx.arch);
  if ("error" in plan) return plan;
  const elevation = elevationRefusal(m.spec, plan.planned);
  if (elevation) return { error: elevation };
  const isModel = (p: PlannedStep) => p.step.kind === "download" && p.step.what === "model";
  const planned = ctx.skipModels ? plan.planned.filter((p) => !isModel(p)) : plan.planned;
  if (action === "install") {
    const downloads = (list: PlannedStep[]) => list.reduce((n, p) => n + (p.step.kind === "download" ? (p.step.sizeMb ?? 0) : 0), 0);
    // A skipped model is space the install no longer needs.
    const skippedMb = downloads(plan.planned) - downloads(planned);
    const needMb = m.spec.install?.diskFreeMb !== undefined ? m.spec.install.diskFreeMb - skippedMb : downloads(planned);
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
async function runSteps(
  planned: PlannedStep[],
  m: ComputerManifest,
  ctx: RunContext,
  logFile: string,
  record: FinishStep[]
): Promise<{ ok: true } | { error: string }> {
  const append = (s: string) => fs.appendFileSync(logFile, redactSecrets(s));
  let previousFailed = false;
  for (const p of planned) {
    if (p.step.fallback && !previousFailed) continue;
    const t0 = Date.now();
    const fail = (detail: string) => record.push({ name: p.describe, ok: false, detail: detail.slice(0, 1000), durationMs: Date.now() - t0 });
    ctx.say(`→ ${p.describe}`);
    append(`\n$ ${p.describe}\n`);
    const hasFallback = !!planned[planned.indexOf(p) + 1]?.step.fallback;
    if (p.needs && !onPath(p.needs, ctx.env)) {
      const err = `${p.needs} is not installed on this computer${p.needs === "brew" ? " (https://brew.sh)" : p.needs === "uv" || p.needs === "uvx" ? " (https://docs.astral.sh/uv/)" : ""}`;
      append(err + "\n");
      fail(err);
      if (hasFallback) {
        previousFailed = true;
        continue;
      }
      return { error: err };
    }
    let argv = p.argv;
    if (p.step.kind === "script" || (p.step.kind === "download" && p.step.url)) {
      // An inline script was checked against its sha256 when it was planned.
      const buf = p.step.source !== undefined ? Buffer.from(p.step.source, "utf8") : await fetchChecked(p.step.url!, p.step.sha256!);
      if (!Buffer.isBuffer(buf)) {
        fail(buf.error);
        return buf;
      }
      if (p.step.kind === "download" && p.step.what === "archive") {
        // Unpack with tar (macOS, Linux and Windows 10+ ship it), as an argv like any step.
        const file = path.join(toolsHome(), "downloads", `${m.slug}-${p.step.sha256!.slice(0, 12)}${path.extname(new URL(p.step.url!).pathname)}`);
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.mkdirSync(p.dest!, { recursive: true });
        fs.writeFileSync(file, buf);
        argv = ["tar", "-xf", file, "-C", p.dest!, ...(p.step.stripComponents ? [`--strip-components=${p.step.stripComponents}`] : [])];
      } else if (p.step.kind === "download") {
        fs.mkdirSync(path.dirname(p.dest!), { recursive: true });
        fs.writeFileSync(p.dest!, buf, { mode: p.step.what === "binary" ? 0o755 : 0o644 });
        record.push({ name: p.describe, ok: true, durationMs: Date.now() - t0 });
        previousFailed = false;
        continue;
      } else {
        const script = path.join(toolsHome(), "scripts", `${m.slug}-${p.step.sha256!.slice(0, 12)}${p.step.name ? `-${path.basename(p.step.name)}` : ""}`);
        fs.mkdirSync(path.dirname(script), { recursive: true });
        writeSecretFileNoFollow(script, buf, { mode: 0o700 });
        if (ctx.interactive) {
          ctx.say(chalk.dim(buf.toString("utf8").split("\n").slice(0, 40).join("\n")));
          if (!(await ctx.confirm?.(`Run this script (${p.step.name ?? p.step.url})?`))) {
            fail("the person did not run the script");
            return { error: "you did not run the script: nothing else was changed" };
          }
        }
        argv = argv!.map((a) => a.split("{script}").join(script));
      }
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
      fail(res.error ?? `exit ${res.exitCode}`);
      if (hasFallback) {
        previousFailed = true;
        continue;
      }
      return { error: `${p.describe} failed: ${res.error ?? `exit ${res.exitCode}`}. Log: ${logFile}` };
    }
    record.push({ name: p.describe, ok: true, durationMs: Date.now() - t0 });
    previousFailed = false;
  }
  return { ok: true };
}

function newLogFile(slug: string, action: string): string {
  const dir = path.join(toolsHome(), "logs");
  fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, `${slug}-${action}-${new Date().toISOString().replace(/[:.]/g, "-")}.log`);
}

/** The steps and the check this computer would run, one line each. */
export function describeInstall(m: ComputerManifest, ctx: RunContext, planned: PlannedStep[]): string[] {
  const lines = [`${m.name} (${m.slug} ${m.version}) on ${OS_LABEL[ctx.os] ?? ctx.os} ${ctx.arch}, licence ${m.spec.licence ?? "not stated"}:`];
  for (const p of planned) lines.push(`  ${p.admin ? "[admin] " : ""}${p.describe}${p.argv ? `\n      ${p.argv.join(" ")}` : ""}`);
  const check = verifyFor(m.spec, ctx.os);
  const argv = check ? verifyArgv(m.spec, ctx.os, check.command, ctx.values) : undefined;
  lines.push(`  then check: ${argv && "argv" in argv ? argv.argv.join(" ") : "no check declared"}`);
  if (ctx.skipModels) lines.push(`  (model downloads skipped)`);
  return lines;
}

/** Install the capability's tool on this computer, then check it. */
export async function installTool(m: ComputerManifest, ctx: RunContext): Promise<ToolResult> {
  if (ctx.os === "win32") ctx.say(chalk.yellow(WINDOWS_UNTESTED));
  const freeMb = (ctx.freeMb ?? freeDiskMb)();
  // A dry run shows the steps even when the disk is short, and says so.
  const pre = preflight(m, ctx, "install", ctx.dryRun ? undefined : freeMb);
  if ("error" in pre) return refused(pre.error);

  if (ctx.dryRun) {
    const disk = preflight(m, ctx, "install", freeMb);
    if ("error" in disk) ctx.say(chalk.yellow(`  ${disk.error}: the install would stop here`));
    for (const l of describeInstall(m, ctx, pre.planned)) ctx.say(l);
    return { status: "dry-run", toolVersion: null, message: "dry run: nothing was installed or recorded", steps: [] };
  }

  // What it needs first (requires.capabilities): each is its own installation, its own yes (decision 2).
  for (const dep of m.spec.placement?.requires?.capabilities ?? []) {
    if ((dep.os && dep.os !== ctx.os) || dep.slug === m.slug) continue;
    if (!ctx.load) return refused(`${m.name} needs ${dep.slug} first, and this runner cannot read its manifest`);
    const loaded = await ctx.load(dep.slug);
    if ("error" in loaded) return refused(`${m.name} needs ${dep.slug} first: ${loaded.error}`);
    const { outcome } = await runVerify(loaded.manifest, ctx);
    if (outcome.ok) continue;
    if (!ctx.prerequisite) {
      return refused(`${m.name} needs ${loaded.manifest.name} first: approve ${dep.slug} for this computer on the pod, then this one`);
    }
    const r = await ctx.prerequisite(loaded.manifest);
    if (!r.ok) return refused(`${m.name} needs ${loaded.manifest.name} first: ${r.message}`);
  }

  const admin = pre.planned.filter((p) => p.admin);
  if (admin.length) {
    const list = admin.map((p) => p.describe).join("; ");
    if (!ctx.interactive) {
      return refused(`${m.name} needs admin rights (${list}): run \`synap tools install ${m.slug}\` on this computer yourself`);
    }
    if (!(await ctx.confirm?.(`These steps need admin rights: ${list}. Continue?`))) {
      return refused("you said no: nothing was installed");
    }
  }

  const logFile = newLogFile(m.slug, "install");
  const steps: FinishStep[] = [];
  const ran = await runSteps(pre.planned, m, ctx, logFile, steps);
  if ("error" in ran) {
    return { status: "failed", toolVersion: null, message: `${m.name} was not installed: ${ran.error}`, steps, check: buildToolCheck({ toolVersion: null, os: ctx.os, arch: ctx.arch, ok: false }) };
  }
  const checked = await verifyTool(m, ctx);
  const all = [...steps, ...checked.steps];
  if (checked.status === "installed") {
    const v = checked.toolVersion ? ` ${checked.toolVersion}` : "";
    return { ...checked, steps: all, message: `Installed ${toolName(m, ctx.os)}${v} on ${computerName()}, checked${checked.smokeWords ?? ""}` };
  }
  return { ...checked, steps: all, message: `${checked.message}. Log: ${logFile}` };
}

/** Remove the tool from this computer (downloaded models are kept), then check it is gone. */
export async function removeTool(m: ComputerManifest, ctx: RunContext): Promise<ToolResult> {
  if (ctx.os === "win32") ctx.say(chalk.yellow(WINDOWS_UNTESTED));
  const pre = preflight(m, ctx, "uninstall", undefined);
  if ("error" in pre) return refused(pre.error);
  if (ctx.dryRun) {
    for (const p of pre.planned) ctx.say(`  ${p.admin ? "[admin] " : ""}${p.describe}${p.argv ? `\n      ${p.argv.join(" ")}` : ""}`);
    return { status: "dry-run", toolVersion: null, message: "dry run: nothing was removed or recorded", steps: [] };
  }
  const admin = pre.planned.filter((p) => p.admin);
  if (admin.length && !ctx.interactive) {
    return refused(`removing ${m.name} needs admin rights: run \`synap tools remove ${m.slug}\` on this computer yourself`);
  }
  if (admin.length && !(await ctx.confirm?.(`These steps need admin rights: ${admin.map((p) => p.describe).join("; ")}. Continue?`))) {
    return refused("you said no: nothing was removed");
  }
  const logFile = newLogFile(m.slug, "remove");
  const steps: FinishStep[] = [];
  const ran = await runSteps(pre.planned, m, ctx, logFile, steps);
  if ("error" in ran) return { status: "failed", toolVersion: null, message: `${m.name} was not removed: ${ran.error}`, steps };
  const t0 = Date.now();
  const { outcome, run, argv } = await runVerify(m, ctx);
  // Removed means the check no longer passes.
  steps.push({ name: `check it is gone: ${argv?.join(" ") ?? "no check"}`, ok: !outcome.ok, durationMs: Date.now() - t0 });
  const check = buildToolCheck({ toolVersion: outcome.toolVersion, os: ctx.os, arch: ctx.arch, ok: outcome.ok, run });
  if (outcome.ok) {
    return {
      status: "failed",
      toolVersion: outcome.toolVersion,
      message: `${toolName(m, ctx.os)} still works on ${computerName()} after removing it (installed another way?). Log: ${logFile}`,
      steps,
      check,
    };
  }
  const kept = m.spec.uninstall?.keepUserData === false ? "" : " (downloaded models kept)";
  return { status: "removed", toolVersion: null, message: `Removed ${toolName(m, ctx.os)} from ${computerName()}${kept}`, steps, check };
}
