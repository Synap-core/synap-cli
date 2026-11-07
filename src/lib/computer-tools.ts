/**
 * Computer tools: the pure half of `synap tools install|verify|remove` and of
 * the worker's desired-state loop (plan b647769e §2.1, §3; decision 168f34db).
 *
 * A capability whose `placement.runsOn` includes "computer" declares, per OS,
 * the steps that install, check and remove its tool. This file reads those
 * blocks and turns them into exact argv lists (never a shell string), checks a
 * verify run against what the manifest expects, captures the tool's version and
 * builds the report the pod records. Nothing here runs a process or touches the
 * network: `commands/computer-tools.ts` does, so every rule below is testable.
 *
 * Platform values are Node's own (`process.platform`, `process.arch`), as the
 * computer reports at enrolment; people read "Mac", "Linux", "Windows".
 */

import { createHash } from "node:crypto";

export type ComputerOs = "darwin" | "linux" | "win32";

export const OS_LABEL: Record<string, string> = { darwin: "Mac", linux: "Linux", win32: "Windows" };
const ARCH_LABEL: Record<string, string> = { arm64: "Apple Silicon or ARM", x64: "Intel or AMD (x64)" };

export interface InstallStep {
  /** brew | apt | dnf | winget | uv | pip | npm | download | script. Anything else is refused. */
  kind: string;
  /** uv: tool-install | tool-uninstall; the others: install (default) | uninstall. */
  action?: string;
  package?: string;
  /** brew: the tap the formula comes from (`homebrew-ffmpeg/ffmpeg`). */
  tap?: string;
  /** brew: a cask. */
  cask?: boolean;
  /** uv: extra packages in the same tool environment; the Python it uses. */
  with?: string[];
  python?: string;
  /** winget package id, or a model id for `download`. */
  id?: string;
  /** download: model | binary | archive | file. */
  what?: string;
  sizeMb?: number;
  resumable?: boolean;
  /** download/script: an https URL. */
  url?: string;
  /** download: where it lands, a `{placeholder}` path. */
  dest?: string;
  /** script, and a download by URL: the pinned checksum. Required by this runner. */
  sha256?: string;
  /** script: the argv that runs it, shown to the person first. */
  command?: string[];
  elevation?: string;
  /** apt/dnf: runs only when the step before it failed (apt, else dnf). */
  fallback?: boolean;
}

export interface StepsBlock {
  steps: InstallStep[];
  /** Programs pinned to a path (`{brewPrefix}/opt/ffmpeg-full/bin/ffmpeg`), so PATH order never decides. */
  bins?: Record<string, string>;
  licence?: string;
}

export interface Expect {
  exitCode?: number;
  stdoutMatches?: string;
  stdoutContains?: string;
  stderrMatches?: string;
}

export interface VerifyCheck {
  command: string[];
  expect?: Expect;
  /** The regex group of `stdoutMatches` that is the tool's version. */
  captureVersion?: number;
  smoke?: { command: string[]; expect?: Expect; fixture?: string };
}

export interface PlatformRule {
  os: string;
  arch?: string[];
}

/** The capability `spec` fields a computer reads (catalog `schema/computer.ts`). */
export interface ComputerSpec {
  key?: string;
  name?: string;
  licence?: string;
  placement?: {
    runsOn?: string[];
    platforms?: PlatformRule[];
    requires?: {
      capabilities?: Array<{ slug: string; os?: string }>;
      tool?: { name?: string; version?: string };
    };
  };
  install?: Partial<Record<ComputerOs, StepsBlock>> & { elevation?: string; diskFreeMb?: number };
  verify?: Partial<Record<ComputerOs, VerifyCheck>> & { timeoutSec?: number; reverifyEvery?: string };
  uninstall?: Partial<Record<ComputerOs, { steps: InstallStep[] }>> & { keepUserData?: boolean };
}

export interface ComputerManifest {
  slug: string;
  name: string;
  /** The manifest's own version (not the tool's): meta.version, spec.version, else a hash of its steps. */
  version: string;
  spec: ComputerSpec;
}

/**
 * Read a catalog manifest (`{apiVersion, kind, meta, spec}`), a CP package
 * definition, or a bare spec. Returns why it is not a computer capability
 * instead of guessing.
 */
export function readComputerManifest(raw: unknown, slugHint?: string): ComputerManifest | { error: string } {
  if (!raw || typeof raw !== "object") return { error: "the manifest is not a JSON object" };
  const r = raw as Record<string, unknown>;
  const meta = (r.meta && typeof r.meta === "object" ? r.meta : {}) as Record<string, unknown>;
  const spec = (r.spec && typeof r.spec === "object" ? r.spec : r) as ComputerSpec & Record<string, unknown>;
  const slug = String(meta.slug ?? spec.key ?? slugHint ?? "");
  if (!slug) return { error: "the manifest names no slug" };
  const runsOn = spec.placement?.runsOn;
  if (!Array.isArray(runsOn) || !runsOn.includes("computer")) {
    return { error: `${slug} runs on the pod, not on a computer: there is nothing to install here` };
  }
  if (!spec.install || !spec.verify) return { error: `${slug} declares no install or verify steps` };
  const declared = meta.version ?? spec.version;
  const version =
    typeof declared === "string" && declared
      ? declared
      : "sha256:" +
        createHash("sha256")
          .update(JSON.stringify({ i: spec.install, v: spec.verify, u: spec.uninstall ?? null }))
          .digest("hex")
          .slice(0, 12);
  return { slug, name: String(meta.name ?? spec.name ?? slug), version, spec };
}

/** Whether this computer may run the capability: `placement.platforms` is a hard filter, missing = any. */
export function platformAllowed(
  spec: ComputerSpec,
  os: string,
  arch: string
): { ok: true } | { ok: false; reason: string } {
  const rules = spec.placement?.platforms;
  if (!rules || rules.length === 0) return { ok: true };
  const rule = rules.find((p) => p.os === os);
  if (rule && (!rule.arch || rule.arch.length === 0 || rule.arch.includes(arch))) return { ok: true };
  const wanted = rules
    .map((p) => {
      const name = OS_LABEL[p.os] ?? p.os;
      return p.arch && p.arch.length ? `${name} (${p.arch.map((a) => ARCH_LABEL[a] ?? a).join(", ")})` : name;
    })
    .join(" or ");
  return { ok: false, reason: `needs a ${wanted}; this computer is ${OS_LABEL[os] ?? os} ${arch}` };
}

/** The install or uninstall steps for this OS, or why there are none. */
export function stepsFor(
  block: ComputerSpec["install"] | ComputerSpec["uninstall"] | undefined,
  os: string
): { steps: InstallStep[] } | { error: string } {
  const forOs = block ? (block as Record<string, unknown>)[os] : undefined;
  const steps = forOs && typeof forOs === "object" ? (forOs as StepsBlock).steps : undefined;
  if (!Array.isArray(steps) || steps.length === 0) return { error: `no steps for ${OS_LABEL[os] ?? os}` };
  return { steps };
}

/** The verify check for this OS (`verify.<os>`), undefined when the manifest has none. */
export function verifyFor(spec: ComputerSpec, os: string): VerifyCheck | undefined {
  const own = spec.verify ? ((spec.verify as Record<string, unknown>)[os] as VerifyCheck | undefined) : undefined;
  return own && Array.isArray(own.command) && own.command.length > 0 ? own : undefined;
}

/**
 * The verify argv to run: placeholders filled, and a first word that names one
 * of the OS's pinned `bins` replaced by its path, so PATH order never decides.
 */
export function verifyArgv(spec: ComputerSpec, os: string, command: string[], values: PlaceholderValues): { argv: string[] } | { error: string } {
  const bins = (spec.install as Record<string, StepsBlock | undefined> | undefined)?.[os]?.bins;
  const first = command[0]!;
  const pinned = bins?.[first];
  return fillArgv(pinned ? [pinned, ...command.slice(1)] : command, values);
}

export type StepAction = "install" | "uninstall";

export interface PlannedStep {
  step: InstallStep;
  /** The exact process to run, argv[0] first. Absent for a download by URL (the CLI fetches it). */
  argv?: string[];
  /** The program the step needs on PATH (brew, uv, …), to say what is missing before running. */
  needs?: string;
  /** Needs admin rights (sudo, UAC): the person is asked first, a worker never runs it. */
  admin: boolean;
  /** download by URL: the filled destination path. */
  dest?: string;
  /** One line a person reads. */
  describe: string;
}

const SHA256_RE = /^[a-f0-9]{64}$/i;
const PLACEHOLDER = /\{([^{}]*)\}/g;

/**
 * The values the runner fills in a manifest's `{name}` placeholders (argv,
 * `dest`, `bins`): `brewPrefix`, `home`, `models`, `workdir`, and `script` for
 * the fetched file of a script step. An unknown name is refused, never left in.
 */
export type PlaceholderValues = Record<string, string>;

export function fillPlaceholders(text: string, values: PlaceholderValues): { value: string } | { error: string } {
  let unknown: string | undefined;
  const value = text.replace(PLACEHOLDER, (all, name: string) => {
    const v = values[name];
    if (v === undefined) unknown ??= name;
    return v ?? all;
  });
  return unknown !== undefined ? { error: `the manifest uses {${unknown}}, which this computer does not know` } : { value };
}

export function fillArgv(argv: string[], values: PlaceholderValues): { argv: string[] } | { error: string } {
  const out: string[] = [];
  for (const a of argv) {
    const f = fillPlaceholders(a, values);
    if ("error" in f) return f;
    out.push(f.value);
  }
  return { argv: out };
}

/**
 * Turn one declared step into the exact command, or refuse it. A `script` (and
 * a download by URL) without a sha256 is refused: arbitrary code reaches the
 * computer only pinned. A kind this CLI does not know is refused, never guessed.
 */
export function planStep(
  step: InstallStep,
  action: StepAction,
  os: string,
  values: PlaceholderValues = {}
): PlannedStep | { error: string } {
  const removing = action === "uninstall" || step.action === "uninstall" || step.action === "tool-uninstall";
  const verb = removing ? "uninstall" : "install";
  const need = (what: string) => ({ error: `a ${step.kind} step needs ${what}` });
  switch (step.kind) {
    case "brew": {
      if (!step.package) return need("a package");
      const formula = step.tap ? `${step.tap}/${step.package}` : step.package;
      const argv = ["brew", verb, ...(step.cask ? ["--cask"] : []), removing ? step.package : formula];
      return { step, argv, needs: "brew", admin: false, describe: `Homebrew: ${argv.slice(1).join(" ")}` };
    }
    case "apt":
    case "dnf": {
      if (!step.package) return need("a package");
      const tool = step.kind === "apt" ? "apt-get" : "dnf";
      const argv = ["sudo", tool, removing ? "remove" : "install", "-y", step.package];
      return { step, argv, needs: tool, admin: true, describe: `${step.kind} (admin rights): ${removing ? "remove" : "install"} ${step.package}` };
    }
    case "winget": {
      if (!step.id) return need("an id");
      const argv = removing
        ? ["winget", "uninstall", "--id", step.id, "-e"]
        : ["winget", "install", "--id", step.id, "-e", "--accept-source-agreements", "--accept-package-agreements"];
      return { step, argv, needs: "winget", admin: false, describe: `winget: ${verb} ${step.id}` };
    }
    case "uv": {
      if (!step.package) return need("a package");
      const extra = removing
        ? []
        : [...(step.with ?? []).flatMap((w) => ["--with", w]), ...(step.python ? ["--python", step.python] : [])];
      const argv = ["uv", "tool", verb, step.package, ...extra];
      return { step, argv, needs: "uv", admin: false, describe: `uv: ${argv.slice(1).join(" ")}` };
    }
    case "pip": {
      if (!step.package) return need("a package");
      const py = os === "win32" ? "python" : "python3";
      const argv = removing ? [py, "-m", "pip", "uninstall", "-y", step.package] : [py, "-m", "pip", "install", "--user", step.package];
      return { step, argv, needs: py, admin: false, describe: `pip: ${verb} ${step.package}` };
    }
    case "npm": {
      if (!step.package) return need("a package");
      const argv = ["npm", verb, "-g", step.package];
      return { step, argv, needs: "npm", admin: false, describe: `npm: ${verb} -g ${step.package}` };
    }
    case "download": {
      // Removing a tool keeps what it downloaded (models): nothing to run.
      if (removing) return { step, admin: false, describe: `keep the downloaded ${step.what ?? "file"}` };
      const size = step.sizeMb ? `, about ${(step.sizeMb / 1000).toFixed(1)} GB` : "";
      if (step.url) {
        if (!step.sha256 || !SHA256_RE.test(step.sha256)) return { error: `refused: the download ${step.url} has no sha256 to check it against` };
        if (!step.dest) return need("a dest");
        const dest = fillPlaceholders(step.dest, values);
        if ("error" in dest) return dest;
        return { step, admin: false, dest: dest.value, describe: `download ${step.url} to ${dest.value} (checked against its sha256)${size}` };
      }
      if (step.what === "model" && step.id) {
        const argv = ["uvx", "--from", "huggingface_hub", "hf", "download", step.id];
        return { step, argv, needs: "uvx", admin: false, describe: `download the model ${step.id}${size}` };
      }
      return need("a url with a sha256, or a model id");
    }
    case "script": {
      if (!step.url) return { error: "refused: a script step with no url has nothing to check its sha256 against" };
      if (!step.sha256 || !SHA256_RE.test(step.sha256)) return { error: `refused: the script ${step.url} has no sha256, so it cannot run` };
      if (step.elevation !== "never") return { error: `refused: the script ${step.url} must declare elevation "never"` };
      if (!step.command?.length) return need("a command");
      const filled = fillArgv(step.command, { ...values, script: values.script ?? "{script}" });
      if ("error" in filled) return filled;
      return { step, argv: filled.argv, admin: false, describe: `run the script ${step.url} (shown first, checked against its sha256): ${filled.argv.join(" ")}` };
    }
    default:
      return { error: `refused: "${step.kind}" is not a step this computer runs` };
  }
}

/** Plan every step, stopping at the first refusal (nothing runs when one step is refused). */
export function planSteps(
  steps: InstallStep[],
  action: StepAction,
  os: string,
  values: PlaceholderValues = {}
): { planned: PlannedStep[] } | { error: string } {
  const planned: PlannedStep[] = [];
  for (const s of steps) {
    const p = planStep(s, action, os, values);
    if ("error" in p) return p;
    planned.push(p);
  }
  return { planned };
}

/** An admin step when the manifest says `elevation: never` is a manifest error, never a prompt. */
export function elevationRefusal(spec: ComputerSpec, planned: PlannedStep[]): string | undefined {
  if (spec.install?.elevation !== "never") return undefined;
  const admin = planned.find((p) => p.admin);
  return admin ? `refused: "${admin.describe}" needs admin rights, and the manifest says it never asks for them` : undefined;
}

export interface ProcessResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  /** Spawn failed (the program is not installed) or it timed out. */
  error?: string;
}

export interface VerifyOutcome {
  ok: boolean;
  /** The version the tool printed (captureVersion group), null when none was captured. */
  toolVersion: string | null;
  /** Why it failed, in plain words. */
  reason?: string;
}

/** Check a verify run against what the manifest expects (default: exit code 0). */
export function matchVerify(run: ProcessResult, check: VerifyCheck): VerifyOutcome {
  if (run.error) return { ok: false, toolVersion: null, reason: run.error };
  const expect = check.expect ?? {};
  const wantExit = expect.exitCode ?? 0;
  if (run.exitCode !== wantExit) {
    return { ok: false, toolVersion: null, reason: `${check.command[0]} exited with ${run.exitCode}, expected ${wantExit}` };
  }
  let toolVersion: string | null = null;
  if (expect.stdoutMatches) {
    let re: RegExp;
    try {
      re = new RegExp(expect.stdoutMatches, "m");
    } catch {
      return { ok: false, toolVersion: null, reason: `the manifest's stdoutMatches is not a valid pattern` };
    }
    const m = re.exec(run.stdout);
    if (!m) return { ok: false, toolVersion: null, reason: `${check.command[0]} did not print what was expected (${expect.stdoutMatches})` };
    if (check.captureVersion !== undefined) toolVersion = m[check.captureVersion] ?? null;
  }
  if (expect.stderrMatches) {
    let re: RegExp;
    try {
      re = new RegExp(expect.stderrMatches, "m");
    } catch {
      return { ok: false, toolVersion: null, reason: `the manifest's stderrMatches is not a valid pattern` };
    }
    if (!re.test(run.stderr)) return { ok: false, toolVersion, reason: `${check.command[0]} did not print what was expected (${expect.stderrMatches})` };
  }
  if (expect.stdoutContains && !run.stdout.includes(expect.stdoutContains)) {
    return { ok: false, toolVersion, reason: `${check.command[0]} did not print "${expect.stdoutContains}"` };
  }
  return { ok: true, toolVersion };
}

/** Compare dotted versions numerically (1.10 > 1.9). */
function cmpVersion(a: string, b: string): number {
  const pa = a.split(/[.+-]/).map((x) => parseInt(x, 10) || 0);
  const pb = b.split(/[.+-]/).map((x) => parseInt(x, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d) return d < 0 ? -1 : 1;
  }
  return 0;
}

/**
 * Whether `version` satisfies a range of space-separated comparators
 * (`>=6.0 <8`). An unparseable range answers undefined: unmeasured, not drift.
 */
export function versionSatisfies(version: string, range: string): boolean | undefined {
  const parts = range.trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return undefined;
  for (const p of parts) {
    const m = /^(>=|<=|>|<|=)?v?(\d+(?:\.\d+)*)$/.exec(p);
    if (!m) return undefined;
    const c = cmpVersion(version, m[2]!);
    const op = m[1] ?? "=";
    const ok = op === ">=" ? c >= 0 : op === "<=" ? c <= 0 : op === ">" ? c > 0 : op === "<" ? c < 0 : c === 0;
    if (!ok) return false;
  }
  return true;
}

/** ISO-8601 durations a manifest uses for `reverifyEvery` (P7D, PT12H, PT30M). Undefined when unreadable. */
export function parseIsoDuration(d: string | undefined): number | undefined {
  if (!d) return undefined;
  const m = /^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?)?$/.exec(d);
  if (!m || (!m[1] && !m[2] && !m[3])) return undefined;
  return ((+(m[1] ?? 0) * 24 + +(m[2] ?? 0)) * 60 + +(m[3] ?? 0)) * 60_000;
}

/** Strip what must never leave the computer in a log excerpt: bearer tokens, key=value secrets, provider keys. */
export function redactSecrets(text: string): string {
  return text
    .replace(/(Bearer\s+)[A-Za-z0-9._~+/=-]+/gi, "$1[redacted]")
    .replace(/\b([A-Z0-9_]*(?:TOKEN|SECRET|PASSWORD|API_?KEY)[A-Z0-9_]*)\s*([=:])\s*\S+/gi, "$1$2[redacted]")
    .replace(/\b(sk|hf|ghp|gho|xox[bp])[-_][A-Za-z0-9_-]{12,}/g, "[redacted]");
}

export type ComputerToolStatus = "installing" | "installed" | "verify_failed" | "drifted" | "uninstalling" | "removed";

export interface ToolReport {
  capabilitySlug: string;
  status: ComputerToolStatus;
  manifestVersion: string;
  toolVersion: string | null;
  observedOs: string;
  observedArch: string;
  verifiedAt: string | null;
  verifyResult: { exitCode: number | null; excerpt: string; outputSha256: string } | null;
  sessionId?: string;
}

export const EXCERPT_MAX = 2000;

/** The payload the pod records for one (computer, capability). The computer is the key that sends it. */
export function buildToolReport(p: {
  slug: string;
  status: ComputerToolStatus;
  manifestVersion: string;
  toolVersion: string | null;
  os: string;
  arch: string;
  run?: ProcessResult;
  at?: Date;
  sessionId?: string;
}): ToolReport {
  const out = p.run ? `${p.run.stdout}${p.run.stderr ? `\n${p.run.stderr}` : ""}${p.run.error ? `\n${p.run.error}` : ""}` : "";
  const excerpt = redactSecrets(out.trim()).slice(0, EXCERPT_MAX);
  return {
    capabilitySlug: p.slug,
    status: p.status,
    manifestVersion: p.manifestVersion,
    toolVersion: p.toolVersion,
    observedOs: p.os,
    observedArch: p.arch,
    verifiedAt: p.run ? (p.at ?? new Date()).toISOString() : null,
    verifyResult: p.run
      ? { exitCode: p.run.exitCode, excerpt, outputSha256: createHash("sha256").update(out).digest("hex") }
      : null,
    ...(p.sessionId ? { sessionId: p.sessionId } : {}),
  };
}

/**
 * The status a verify run means for a tool that was installed: `installed`
 * when it passes and its version is in range, `drifted` when it passes outside
 * the manifest's `requires.tool.version`, `verify_failed` otherwise.
 */
export function statusAfterVerify(spec: ComputerSpec, outcome: VerifyOutcome): ComputerToolStatus {
  if (!outcome.ok) return "verify_failed";
  const range = spec.placement?.requires?.tool?.version;
  if (range && outcome.toolVersion && versionSatisfies(outcome.toolVersion, range) === false) return "drifted";
  return "installed";
}
