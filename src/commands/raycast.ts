/**
 * synap raycast generate — Emit Raycast Script Commands for enabled capabilities
 *
 * For each ENABLED runnable verb on the pod, writes a Raycast Script Command shell
 * script that calls back into `synap capability run <verbId>`. Per-parameter
 * Raycast arguments are derived from the verb's argsSchema (or the backing skill's
 * `parameters`); if no schema is reachable, a single freeform `input` arg is used.
 *
 * Subcommand: generate
 */

import chalk from "chalk";
import ora from "ora";
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { resolveHubConfig, hubGet, renderHubError } from "../lib/hub-client.js";
import { unwrapList } from "../lib/unwrapList.js";
import { log } from "../utils/logger.js";

// ── Types (mirror the capability read-model) ────────────────────────────────

type HubCfg = Awaited<ReturnType<typeof resolveHubConfig>>;

interface CapVerb {
  id: string;
  label: string;
  kind: string;
  granted?: boolean;
  argsSchema?: Record<string, unknown>;
}

interface Capability {
  kind: string;
  id: string;
  name: string;
  governance?: "auto" | "propose";
  approved?: boolean;
  inputSchema?: Record<string, unknown>;
  verbs?: CapVerb[];
}

interface SkillRow {
  id: string;
  name: string;
  parameters?: unknown;
}

/** One runnable unit flattened for script generation. */
interface RunnableVerb {
  toolName: string;
  verbId: string;
  label: string;
  params: string[];
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function isEnabled(cap: Capability): boolean {
  return cap.approved === true || cap.governance === "auto";
}

/** Extract parameter NAMES from a skill `parameters` / verb `argsSchema` blob. */
function extractParamNames(schema: unknown): string[] {
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) return [];
  const obj = schema as Record<string, unknown>;
  // JSON-schema style: { type:"object", properties:{ to:{...}, subject:{...} } }
  if (obj.properties && typeof obj.properties === "object" && !Array.isArray(obj.properties)) {
    return Object.keys(obj.properties as Record<string, unknown>);
  }
  // Flat key→type map: { to:"string", subject:"string", body:"string" }
  return Object.keys(obj);
}

/** Filename-safe slug for a script name. */
function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "") || "verb";
}

/** Render one Raycast Script Command. Returns the script body + a fallback flag. */
function renderScript(verb: RunnableVerb): { content: string; usedFallback: boolean } {
  const usedFallback = verb.params.length === 0;
  const params = usedFallback ? ["input"] : verb.params;

  const argLines = params.map(
    (p, i) =>
      `# @raycast.argument${i + 1} { "type": "text", "placeholder": "${p}" }`
  );
  const flags = params.map((p, i) => `--${p} "$${i + 1}"`).join(" ");

  const content = [
    `#!/bin/bash`,
    `# @raycast.schemaVersion 1`,
    `# @raycast.title ${verb.toolName} — ${verb.label}`,
    `# @raycast.mode fullOutput`,
    `# @raycast.packageName Synap`,
    `# @raycast.icon 🧠`,
    ...argLines,
    ``,
    `exec synap capability run ${verb.verbId} ${flags}`,
    ``,
  ].join("\n");

  return { content, usedFallback };
}

// ── Public: raycastGenerate ──────────────────────────────────────────────────

export interface RaycastGenerateOpts {
  out?: string;
  workspace?: string;
}

export async function raycastGenerate(opts: RaycastGenerateOpts): Promise<void> {
  let cfg: HubCfg;
  try {
    cfg = await resolveHubConfig();
  } catch (err) {
    log.error((err as Error).message);
    process.exit(1);
  }

  const workspaceId = opts.workspace ?? cfg.workspaceId;
  if (!workspaceId) {
    log.error("A workspace is required. Set one with `synap use <workspace>` or pass --workspace <id>.");
    process.exit(1);
  }

  const outDir = opts.out ?? join(homedir(), ".synap", "raycast-commands");

  const spinner = ora({ text: "Fetching capabilities…", color: "cyan" }).start();

  // The capability read-model already carries each verb's `argsSchema` and each
  // skill cap's `inputSchema`, so /capabilities is the required source. /skills is
  // a best-effort fallback (verb.id → skill.parameters) — it can be slow, so a
  // failure there degrades gracefully rather than aborting generation.
  let caps: Capability[];
  let skills: SkillRow[] = [];
  try {
    const capRes = await hubGet("/capabilities", { workspaceId }, cfg);
    caps = unwrapList<Capability>(capRes, ["capabilities"]);
    spinner.stop();
  } catch (err) {
    spinner.fail(chalk.red("Failed to fetch capabilities"));
    renderHubError(err);
    process.exit(1);
  }
  try {
    const skillRes = await hubGet("/skills", { workspaceId }, cfg);
    skills = unwrapList<SkillRow>(skillRes, ["skills"]);
  } catch {
    // Best-effort enrichment only — proceed with the capability read-model's schemas.
  }

  const skillParamsByName = new Map<string, string[]>(
    skills.map((s) => [s.name, extractParamNames(s.parameters)])
  );

  // Flatten enabled, runnable verbs. Tool verbs carry an explicit `granted`
  // state; a skill-kind capability is itself the runnable unit when enabled.
  const runnables: RunnableVerb[] = [];
  for (const cap of caps) {
    if (cap.verbs && cap.verbs.length > 0) {
      for (const v of cap.verbs) {
        if (v.granted !== true) continue;
        const fromArgs = extractParamNames(v.argsSchema);
        const params = fromArgs.length > 0 ? fromArgs : skillParamsByName.get(v.id) ?? [];
        runnables.push({ toolName: cap.name, verbId: v.id, label: v.label, params });
      }
    } else if (cap.kind === "skill" && isEnabled(cap)) {
      const fromSchema = extractParamNames(cap.inputSchema);
      const params = fromSchema.length > 0 ? fromSchema : skillParamsByName.get(cap.name) ?? [];
      runnables.push({ toolName: cap.name, verbId: cap.name, label: cap.name, params });
    }
  }

  if (runnables.length === 0) {
    log.warn("No enabled runnable verbs found in this workspace.");
    log.dim("Enable one first:  synap capability enable <verb>");
    return;
  }

  try {
    mkdirSync(outDir, { recursive: true });
  } catch (err) {
    log.error(`Could not create output dir ${outDir}: ${(err as Error).message}`);
    process.exit(1);
  }

  let fallbackCount = 0;
  for (const verb of runnables) {
    const { content, usedFallback } = renderScript(verb);
    if (usedFallback) fallbackCount++;
    const file = join(outDir, `${slugify(verb.verbId)}.sh`);
    writeFileSync(file, content, "utf-8");
    chmodSync(file, 0o755);
  }

  log.heading(`Generated ${runnables.length} Raycast Script Command${runnables.length === 1 ? "" : "s"}`);
  console.log();
  log.dim(outDir);
  console.log();
  log.info("Add this directory in Raycast → Extensions → Script Commands → Add Directory");
  if (fallbackCount > 0) {
    console.log();
    log.warn(
      `${fallbackCount} verb${fallbackCount === 1 ? "" : "s"} had no parameter schema — ` +
        `generated with a single freeform "input" argument.`
    );
  }
}
