/**
 * synap capability — Discover, enable, and LAUNCH capability verbs
 *
 * A capability VERB is a runnable action backed by a skill (verbId = skill name).
 * `run` is the launcher: it parses arbitrary `--key value` flags into the skill's
 * `parameters` and POSTs to /capabilities/execute (the agnostic capability door).
 *
 * Subcommands: list, enable, run, test
 */

import chalk from "chalk";
import ora from "ora";
import { resolveHubConfig, hubGet, hubPost } from "../lib/hub-client.js";
import { log } from "../utils/logger.js";

// ── Types ─────────────────────────────────────────────────────────────────────

type HubCfg = Awaited<ReturnType<typeof resolveHubConfig>>;

interface CapVerb {
  id: string;
  label: string;
  kind: string;
  granted?: boolean;
  effectiveExecMode?: string;
  govDefault?: string;
  argsSchema?: Record<string, unknown>;
}

interface Capability {
  kind: string;
  id: string;
  name: string;
  description?: string | null;
  governance?: "auto" | "propose";
  approved?: boolean;
  inputSchema?: Record<string, unknown>;
  verbs?: CapVerb[];
}

interface SkillRow {
  id: string;
  name: string;
  approved?: boolean;
  parameters?: unknown;
  kind?: string;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/** A capability is "enabled" when its AI use is auto-approved (not draft). */
function isEnabled(cap: Capability): boolean {
  return cap.approved === true || cap.governance === "auto";
}

/**
 * GET /capabilities requires a workspaceId (uuid) — resolve it the way tools.ts
 * does, and bail with a clear message when none is configured.
 */
function requireWorkspace(opts: { workspace?: string }, cfg: HubCfg): string {
  const workspaceId = opts.workspace ?? cfg.workspaceId;
  if (!workspaceId) {
    log.error("A workspace is required. Set one with `synap use <workspace>` or pass --workspace <id>.");
    process.exit(1);
  }
  return workspaceId;
}

async function fetchCapabilities(cfg: HubCfg, workspaceId: string): Promise<Capability[]> {
  const res = await hubGet("/capabilities", { workspaceId }, cfg);
  return ((res as Record<string, unknown>).capabilities ?? []) as Capability[];
}

async function fetchSkills(cfg: HubCfg, workspaceId: string): Promise<SkillRow[]> {
  const res = await hubGet("/skills", { workspaceId }, cfg);
  return ((res as Record<string, unknown>).skills ?? []) as SkillRow[];
}

/**
 * Resolve a verb/skill NAME (or label) to its skill UUID. A verb's `id` is the
 * backing skill's NAME, so name→id needs the skills list. Order: skill name →
 * verb label → skill-kind capability name.
 */
async function resolveSkillId(
  cfg: HubCfg,
  workspaceId: string,
  input: string
): Promise<string | undefined> {
  const [caps, skills] = await Promise.all([
    fetchCapabilities(cfg, workspaceId),
    fetchSkills(cfg, workspaceId),
  ]);
  const byName = new Map(skills.map((s) => [s.name, s.id]));

  // 1. Direct skill name (covers verb ids — a verb id IS a skill name).
  if (byName.has(input)) return byName.get(input);

  // 2. A verb's human label → its id (skill name) → skill row.
  for (const cap of caps) {
    for (const v of cap.verbs ?? []) {
      if (v.label === input) {
        const id = byName.get(v.id);
        if (id) return id;
      }
    }
  }

  // 3. A skill-kind capability matched by name — its id IS the skill uuid.
  const skillCap = caps.find((c) => c.kind === "skill" && c.name === input);
  if (skillCap) return skillCap.id;

  return undefined;
}

/** Turn a variadic `--key value` token array into a parameters object. */
function parseParams(tokens: string[]): Record<string, unknown> {
  const params: Record<string, unknown> = {};
  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i];
    if (!tok.startsWith("--")) continue;
    const key = tok.slice(2);
    const next = tokens[i + 1];
    if (next === undefined || next.startsWith("--")) {
      params[key] = true; // bare flag → boolean
    } else {
      params[key] = next;
      i++;
    }
  }
  return params;
}

// ── Public: capabilityList ──────────────────────────────────────────────────

export interface CapListOpts {
  json?: boolean;
  workspace?: string;
}

export async function capabilityList(opts: CapListOpts): Promise<void> {
  let cfg: HubCfg;
  try {
    cfg = await resolveHubConfig();
  } catch (err) {
    log.error((err as Error).message);
    process.exit(1);
  }

  const workspaceId = requireWorkspace(opts, cfg);

  const spinner = opts.json ? null : ora({ text: "Fetching capabilities…", color: "cyan" }).start();

  let caps: Capability[];
  try {
    caps = await fetchCapabilities(cfg, workspaceId);
    spinner?.stop();
  } catch (err) {
    spinner?.fail(chalk.red("Failed to fetch capabilities"));
    log.error((err as Error).message);
    process.exit(1);
  }

  if (opts.json) {
    console.log(JSON.stringify({ capabilities: caps }, null, 2));
    return;
  }

  if (caps.length === 0) {
    log.warn("No capabilities available in this workspace.");
    log.dim("Connect a service (`synap tools connect <name>`) to install capability skills.");
    return;
  }

  const enabled = caps.filter(isEnabled);
  log.heading(`Capabilities (${enabled.length} enabled / ${caps.length} total)`);
  console.log();

  for (const cap of caps) {
    const on = isEnabled(cap);
    const dot = on ? chalk.green("●") : chalk.dim("○");
    const name = on ? chalk.bold(cap.name) : chalk.dim(cap.name);
    const kind = chalk.dim(`(${cap.kind})`);
    console.log(`  ${dot} ${name} ${kind}`);

    for (const v of cap.verbs ?? []) {
      const runnable = v.granted === true;
      const marker = runnable ? chalk.green("▸") : chalk.dim("·");
      const label = runnable ? v.label : chalk.dim(v.label);
      const mode = chalk.dim(`[${v.effectiveExecMode ?? v.govDefault ?? "?"}]`);
      const runHint = runnable ? "" : chalk.dim(" — not runnable");
      console.log(`      ${marker} ${label} ${chalk.dim(v.id)} ${mode}${runHint}`);
    }
  }
  console.log();
  log.dim("Run a verb:  synap capability run <verb> --<param> <value>");
}

// ── Public: capabilityEnable ────────────────────────────────────────────────

export interface CapEnableOpts {
  workspace?: string;
}

export async function capabilityEnable(verbOrSkill: string, opts: CapEnableOpts): Promise<void> {
  let cfg: HubCfg;
  try {
    cfg = await resolveHubConfig();
  } catch (err) {
    log.error((err as Error).message);
    process.exit(1);
  }

  const workspaceId = requireWorkspace(opts, cfg);

  const spinner = ora({ text: `Resolving ${chalk.bold(verbOrSkill)}…`, color: "cyan" }).start();

  let skillId: string | undefined;
  try {
    skillId = await resolveSkillId(cfg, workspaceId, verbOrSkill);
  } catch (err) {
    spinner.fail(chalk.red("Failed to resolve capability"));
    log.error((err as Error).message);
    process.exit(1);
  }

  if (!skillId) {
    spinner.fail(chalk.red(`No skill found for "${verbOrSkill}"`));
    log.dim("Run `synap capability list` to see available verbs and skills.");
    process.exit(1);
  }

  spinner.text = `Enabling ${chalk.bold(verbOrSkill)}…`;
  try {
    await hubPost(`/skills/${skillId}/approve`, { approved: true }, cfg);
    spinner.succeed(chalk.green(`Enabled ${chalk.bold(verbOrSkill)} — it can now run.`));
    log.dim(`Launch it:  synap capability run ${verbOrSkill} --<param> <value>`);
  } catch (err) {
    spinner.fail(chalk.red(`Failed to enable ${verbOrSkill}`));
    log.error((err as Error).message);
    process.exit(1);
  }
}

// ── Public: capabilityRun (the launcher) ────────────────────────────────────

export interface CapRunOpts {
  workspace?: string;
}

export async function capabilityRun(
  verb: string,
  params: string[],
  opts: CapRunOpts
): Promise<void> {
  let cfg: HubCfg;
  try {
    cfg = await resolveHubConfig();
  } catch (err) {
    log.error((err as Error).message);
    process.exit(1);
  }

  const workspaceId = requireWorkspace(opts, cfg);
  const parameters = parseParams(params);

  const spinner = ora({ text: `Running ${chalk.bold(verb)}…`, color: "cyan" }).start();

  let res: Record<string, unknown>;
  try {
    res = (await hubPost(
      "/capabilities/execute",
      { verbId: verb, parameters, workspaceId },
      cfg
    )) as Record<string, unknown>;
    spinner.stop();
  } catch (err) {
    spinner.stop();
    const msg = (err as Error).message;
    if (msg.includes("HTTP 404")) {
      log.error(`Capability not found: ${chalk.bold(verb)}`);
      log.dim("Run `synap capability list` to see available verbs.");
      process.exit(1);
    }
    if (msg.includes("HTTP 403")) {
      log.error(`Refused: ${chalk.bold(verb)} is not runnable yet.`);
      log.dim(`Enable it first:  synap capability enable ${verb}`);
      process.exit(1);
    }
    log.error(msg);
    process.exit(1);
  }

  // 202 → a reviewable proposal was created instead of running.
  if (res.proposed === true) {
    log.heading(`⏳ Queued for approval`);
    log.dim(`Approve in Synap (proposalId: ${String(res.proposalId)})`);
    return;
  }

  // 200 → ran (or dry-run preview).
  log.success(`${chalk.bold(verb)} ran.`);
  if (res.result !== undefined) {
    console.log();
    console.log(JSON.stringify(res.result, null, 2));
  }
}

// ── Public: capabilityTest (dry-run preview) ────────────────────────────────

export interface CapTestOpts {
  workspace?: string;
}

export async function capabilityTest(verb: string, opts: CapTestOpts): Promise<void> {
  let cfg: HubCfg;
  try {
    cfg = await resolveHubConfig();
  } catch (err) {
    log.error((err as Error).message);
    process.exit(1);
  }

  const workspaceId = requireWorkspace(opts, cfg);

  const spinner = ora({ text: `Resolving ${chalk.bold(verb)}…`, color: "cyan" }).start();

  let skillId: string | undefined;
  try {
    skillId = await resolveSkillId(cfg, workspaceId, verb);
  } catch (err) {
    spinner.fail(chalk.red("Failed to resolve capability"));
    log.error((err as Error).message);
    process.exit(1);
  }

  if (!skillId) {
    spinner.fail(chalk.red(`No skill found for "${verb}"`));
    log.dim("Run `synap capability list` to see available verbs and skills.");
    process.exit(1);
  }

  spinner.text = `Dry-running ${chalk.bold(verb)}…`;
  let res: Record<string, unknown>;
  try {
    res = (await hubPost(`/skills/${skillId}/dry-run`, {}, cfg)) as Record<string, unknown>;
    spinner.stop();
  } catch (err) {
    spinner.fail(chalk.red(`Dry-run failed for ${verb}`));
    log.error((err as Error).message);
    process.exit(1);
  }

  log.heading(`Dry-run preview — ${chalk.bold(verb)}`);
  if (res.result !== undefined) {
    console.log();
    console.log(JSON.stringify(res.result, null, 2));
  }
  const effects = (res.dryRunEffects ?? []) as unknown[];
  console.log();
  log.dim(`Intended side effects: ${effects.length}`);
  if (effects.length > 0) {
    console.log(JSON.stringify(effects, null, 2));
  }
}
