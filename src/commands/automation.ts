/**
 * synap automation — Create, manage, and inspect pod automations
 *
 * Subcommands: list, describe, create, enable, disable, delete, schema
 */

import chalk from "chalk";
import ora from "ora";
import prompts from "prompts";
import { readFileSync, mkdirSync, writeFileSync, existsSync } from "fs";
import { resolveHubConfig, resolveUserId, hubGet, hubPost } from "../lib/hub-client.js";
import { unwrapList } from "../lib/unwrapList.js";
import { log } from "../utils/logger.js";

// ── Types ─────────────────────────────────────────────────────────────────────

type HubCfg = Awaited<ReturnType<typeof resolveHubConfig>>;

type AutomationStatus = "active" | "draft" | "paused" | "error";
type TriggerType = "event" | "cron" | "webhook" | "manual";
type ActionType = "notify" | "channel-message" | "none";

interface FlowNode {
  id: string;
  type: string;
  position: { x: number; y: number };
  data: Record<string, unknown>;
}

interface FlowEdge {
  id: string;
  source: string;
  target: string;
}

interface FlowDefinition {
  nodes: FlowNode[];
  edges: FlowEdge[];
}

interface TriggerConfig {
  eventPattern?: string;
  filters?: Record<string, string>;
  expression?: string;
}

interface Automation {
  id: string;
  name: string;
  description?: string;
  status: AutomationStatus;
  triggerType: TriggerType;
  triggerConfig: TriggerConfig;
  flowDefinition: FlowDefinition;
  workspaceId?: string;
  createdAt?: string;
  updatedAt?: string;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function statusBadge(status: AutomationStatus): string {
  switch (status) {
    case "active":
      return chalk.green("●");
    case "draft":
      return chalk.yellow("○");
    case "paused":
      return chalk.red("⊘");
    case "error":
      return chalk.red("✗");
    default:
      return chalk.dim("?");
  }
}

function extractResult(res: unknown): unknown {
  // tRPC wraps responses in { result: { data: { json: ... } } }
  const r = res as Record<string, unknown>;
  if (r.result !== undefined) {
    const result = r.result as Record<string, unknown>;
    if (result.data !== undefined) {
      const data = result.data as Record<string, unknown>;
      if (data.json !== undefined) return data.json;
      return data;
    }
    return result;
  }
  return res;
}

async function trpcQuery(
  procedure: string,
  input: Record<string, unknown>,
  cfg: HubCfg
): Promise<unknown> {
  // Hub-protocol procedures require the acting userId in their input.
  if (input.userId === undefined) input.userId = await resolveUserId(cfg);
  // Backend tRPC uses the superjson transformer: GET input must be wrapped
  // in the { json: ... } envelope (mirrors the POST body shape below).
  const res = await hubGet(
    `/trpc/${procedure}`,
    { input: JSON.stringify({ json: input }) },
    cfg
  );
  return extractResult(res);
}

async function trpcMutation(
  procedure: string,
  input: Record<string, unknown>,
  cfg: HubCfg
): Promise<unknown> {
  if (input.userId === undefined) input.userId = await resolveUserId(cfg);
  const res = await hubPost(`/trpc/${procedure}`, { json: input }, cfg);
  return extractResult(res);
}

function parseYamlOrJson(filePath: string): Record<string, unknown> {
  const content = readFileSync(filePath, "utf-8").trim();

  // JSON path
  if (filePath.endsWith(".json") || content.startsWith("{")) {
    return JSON.parse(content) as Record<string, unknown>;
  }

  // YAML path — require js-yaml if available, otherwise throw a helpful error
  try {
    // Dynamic require-style import for optional dependency
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const yaml = require("js-yaml") as { load: (s: string) => unknown };
    return yaml.load(content) as Record<string, unknown>;
  } catch {
    throw new Error(
      "YAML parsing requires js-yaml. Install it: pnpm add js-yaml\n" +
      "Alternatively, convert your file to JSON and pass a .json file."
    );
  }
}

function interpolateEnv(obj: unknown): unknown {
  if (typeof obj === "string") {
    return obj.replace(/\{\{env\.([^}]+)\}\}/g, (_, varName: string) => {
      const val = process.env[varName];
      if (val === undefined) {
        log.warn(`Environment variable not set: ${varName}`);
        return `{{env.${varName}}}`;
      }
      return val;
    });
  }
  if (Array.isArray(obj)) {
    return obj.map(interpolateEnv);
  }
  if (obj !== null && typeof obj === "object") {
    const result: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
      result[k] = interpolateEnv(v);
    }
    return result;
  }
  return obj;
}

function parseTriggerSpec(spec: string): { triggerType: TriggerType; triggerConfig: TriggerConfig } {
  if (spec.startsWith("event:")) {
    return {
      triggerType: "event",
      triggerConfig: { eventPattern: spec.slice("event:".length) },
    };
  }
  if (spec.startsWith("cron:")) {
    return {
      triggerType: "cron",
      triggerConfig: { expression: spec.slice("cron:".length) },
    };
  }
  if (spec === "webhook") {
    return { triggerType: "webhook", triggerConfig: {} };
  }
  if (spec === "manual") {
    return { triggerType: "manual", triggerConfig: {} };
  }
  throw new Error(
    `Invalid --trigger spec: "${spec}"\n` +
    `Valid formats: event:<pattern> | cron:<expression> | webhook | manual`
  );
}

function parseFilters(filterArgs: string[]): Record<string, string> {
  const result: Record<string, string> = {};
  for (const kv of filterArgs) {
    const eqIdx = kv.indexOf("=");
    if (eqIdx === -1) {
      throw new Error(`Invalid --filter value: "${kv}" — expected key=value format`);
    }
    result[kv.slice(0, eqIdx)] = kv.slice(eqIdx + 1);
  }
  return result;
}

function buildFlowDefinition(
  triggerType: TriggerType,
  triggerConfig: TriggerConfig,
  action: ActionType,
  message: string | undefined,
  channel: string | undefined
): FlowDefinition {
  const triggerNode: FlowNode = {
    id: "trigger-1",
    type: "trigger",
    position: { x: 0, y: 0 },
    data: {
      triggerType,
      label: "Trigger",
      config: triggerConfig,
    },
  };

  if (action === "none") {
    return { nodes: [triggerNode], edges: [] };
  }

  let outputType: string;
  let actionConfig: Record<string, unknown>;
  let actionLabel: string;

  if (action === "notify") {
    outputType = "notification";
    actionLabel = "Notify";
    actionConfig = { title: "Automation alert", body: message ?? "" };
  } else {
    // channel-message
    outputType = "channel_message";
    actionLabel = "Channel Message";
    actionConfig = { channelId: channel ?? "", content: message ?? "" };
  }

  const outputNode: FlowNode = {
    id: "output-1",
    type: "output",
    position: { x: 0, y: 200 },
    data: {
      label: actionLabel,
      outputType,
      config: actionConfig,
    },
  };

  return {
    nodes: [triggerNode, outputNode],
    edges: [{ id: "e1", source: "trigger-1", target: "output-1" }],
  };
}

// ── Public: automationList ────────────────────────────────────────────────────

export interface ListOpts {
  workspace?: string;
  status?: string;
  json?: boolean;
}

export async function automationList(opts: ListOpts): Promise<void> {
  let cfg: HubCfg;
  try {
    cfg = await resolveHubConfig();
  } catch (err) {
    log.error((err as Error).message);
    process.exit(1);
  }

  const workspaceId = opts.workspace ?? cfg.workspaceId;

  if (opts.json) {
    const input: Record<string, unknown> = {};
    if (workspaceId) input.workspaceId = workspaceId;
    if (opts.status) input.status = opts.status;
    const data = await trpcQuery("automations.listAutomations", input, cfg);
    console.log(JSON.stringify(data, null, 2));
    return;
  }

  const spinner = ora({ text: "Fetching automations…", color: "cyan" }).start();
  let automations: Automation[];
  try {
    const input: Record<string, unknown> = {};
    if (workspaceId) input.workspaceId = workspaceId;
    if (opts.status) input.status = opts.status;
    const data = await trpcQuery("automations.listAutomations", input, cfg);
    automations = unwrapList<Automation>(data, ["automations"]);
    spinner.stop();
  } catch (err) {
    spinner.fail(chalk.red("Failed to fetch automations"));
    log.error((err as Error).message);
    process.exit(1);
  }

  if (automations.length === 0) {
    log.warn("No automations found.");
    log.dim('Create one: synap automation create --name "My automation" --trigger event:entity.create.completed');
    return;
  }

  log.heading(`Automations (${automations.length})`);
  console.log();
  for (const a of automations) {
    const badge = statusBadge(a.status);
    const triggerLabel = chalk.cyan(a.triggerType.padEnd(8));
    console.log(
      `  ${badge} ${chalk.bold(a.name.padEnd(32))} ${triggerLabel} ${chalk.dim(a.id)}`
    );
  }
  console.log();
}

// ── Public: automationDescribe ────────────────────────────────────────────────

export interface DescribeOpts {
  workspace?: string;
  json?: boolean;
}

export async function automationDescribe(id: string, opts: DescribeOpts): Promise<void> {
  let cfg: HubCfg;
  try {
    cfg = await resolveHubConfig();
  } catch (err) {
    log.error((err as Error).message);
    process.exit(1);
  }

  const workspaceId = opts.workspace ?? cfg.workspaceId;

  const input: Record<string, unknown> = { id };
  if (workspaceId) input.workspaceId = workspaceId;

  if (opts.json) {
    const data = await trpcQuery("automations.getAutomation", input, cfg);
    console.log(JSON.stringify(data, null, 2));
    return;
  }

  const spinner = ora({ text: "Fetching automation…", color: "cyan" }).start();
  let automation: Automation;
  try {
    const data = await trpcQuery("automations.getAutomation", input, cfg);
    automation = data as Automation;
    spinner.stop();
  } catch (err) {
    spinner.fail(chalk.red("Failed to fetch automation"));
    log.error((err as Error).message);
    process.exit(1);
  }

  log.heading(`Automation: ${chalk.bold(automation.name)}`);
  console.log();
  console.log(`  ${chalk.dim("id")}            ${chalk.dim(automation.id)}`);
  console.log(`  ${chalk.dim("status")}        ${statusBadge(automation.status)} ${automation.status}`);
  console.log(`  ${chalk.dim("trigger type")}  ${chalk.cyan(automation.triggerType)}`);

  if (automation.triggerConfig && Object.keys(automation.triggerConfig).length > 0) {
    console.log(`  ${chalk.dim("trigger config")}`);
    for (const [k, v] of Object.entries(automation.triggerConfig)) {
      if (v !== undefined) {
        const val = typeof v === "object" ? JSON.stringify(v) : String(v);
        console.log(`    ${chalk.dim(k.padEnd(16))} ${val}`);
      }
    }
  }

  const nodeCount = automation.flowDefinition?.nodes?.length ?? 0;
  console.log(`  ${chalk.dim("nodes")}         ${nodeCount}`);

  if (automation.description) {
    console.log(`  ${chalk.dim("description")}   ${automation.description}`);
  }

  if (automation.createdAt) {
    console.log(`  ${chalk.dim("created")}       ${new Date(automation.createdAt).toLocaleString()}`);
  }
  if (automation.updatedAt) {
    console.log(`  ${chalk.dim("updated")}       ${new Date(automation.updatedAt).toLocaleString()}`);
  }
  console.log();
}

// ── Public: automationCreate ──────────────────────────────────────────────────

export interface CreateOpts {
  name?: string;
  trigger?: string;
  filter?: string[];
  action?: string;
  message?: string;
  channel?: string;
  status?: string;
  description?: string;
  workspace?: string;
  from?: string;
}

export async function automationCreate(opts: CreateOpts): Promise<void> {
  let cfg: HubCfg;
  try {
    cfg = await resolveHubConfig();
  } catch (err) {
    log.error((err as Error).message);
    process.exit(1);
  }

  const workspaceId = opts.workspace ?? cfg.workspaceId;
  const spinner = ora({ text: "Creating automation…", color: "cyan" }).start();

  let payload: Record<string, unknown>;

  if (opts.from) {
    // File mode
    let fileData: Record<string, unknown>;
    try {
      fileData = parseYamlOrJson(opts.from);
    } catch (err) {
      spinner.fail(chalk.red("Failed to read file"));
      log.error((err as Error).message);
      process.exit(1);
    }

    // Apply {{env.VAR}} substitution
    fileData = interpolateEnv(fileData) as Record<string, unknown>;

    // Map YAML structure to API payload
    const flowDef = (fileData.flow ?? fileData.flowDefinition) as FlowDefinition | undefined;
    const triggerCfg = fileData.triggerConfig as TriggerConfig | undefined;

    payload = {
      name: fileData.name as string,
      description: fileData.description as string | undefined,
      triggerType: fileData.trigger as TriggerType,
      triggerConfig: triggerCfg ?? {},
      flowDefinition: flowDef ?? { nodes: [], edges: [] },
      status: (opts.status ?? fileData.status ?? "draft") as AutomationStatus,
    };
    if (workspaceId) payload.workspaceId = workspaceId;

    if (!payload.name || !payload.triggerType) {
      spinner.fail(chalk.red("File must contain 'name' and 'trigger' fields"));
      process.exit(1);
    }
  } else {
    // Quick mode
    if (!opts.name) {
      spinner.fail(chalk.red("--name is required in quick mode"));
      log.dim("Use --from <file.yaml> for file-based creation, or --name + --trigger for quick mode.");
      process.exit(1);
    }
    if (!opts.trigger) {
      spinner.fail(chalk.red("--trigger is required in quick mode"));
      log.dim("Example: --trigger event:entity.create.completed  or  --trigger cron:0 9 * * MON");
      process.exit(1);
    }

    let triggerType: TriggerType;
    let triggerConfig: TriggerConfig;
    try {
      ({ triggerType, triggerConfig } = parseTriggerSpec(opts.trigger));
    } catch (err) {
      spinner.fail(chalk.red("Invalid --trigger spec"));
      log.error((err as Error).message);
      process.exit(1);
    }

    // Apply --filter for event triggers
    if (opts.filter && opts.filter.length > 0) {
      if (triggerType !== "event") {
        spinner.fail(chalk.red("--filter is only valid for event triggers"));
        process.exit(1);
      }
      try {
        triggerConfig.filters = parseFilters(opts.filter);
      } catch (err) {
        spinner.fail(chalk.red("Invalid --filter value"));
        log.error((err as Error).message);
        process.exit(1);
      }
    }

    const action = (opts.action ?? "none") as ActionType;

    if (action === "channel-message" && !opts.channel) {
      spinner.fail(chalk.red("--channel is required for channel-message action"));
      process.exit(1);
    }

    const flowDefinition = buildFlowDefinition(
      triggerType,
      triggerConfig,
      action,
      opts.message,
      opts.channel
    );

    payload = {
      name: opts.name,
      triggerType,
      triggerConfig,
      flowDefinition,
      status: (opts.status ?? "draft") as AutomationStatus,
    };
    if (opts.description) payload.description = opts.description;
    if (workspaceId) payload.workspaceId = workspaceId;
  }

  let result: Automation;
  try {
    const data = await trpcMutation("automations.createAutomation", payload, cfg);
    // Response shape may be: { automation: {...} } | { id, name, ... } | raw Automation
    const raw = data as Record<string, unknown>;
    const inner = (raw.automation ?? raw) as Record<string, unknown>;
    result = inner as unknown as Automation;
  } catch (err) {
    spinner.fail(chalk.red("Failed to create automation"));
    log.error((err as Error).message);
    process.exit(1);
  }

  spinner.succeed(chalk.green(`Automation created`));
  console.log();
  console.log(`  ${chalk.dim("id")}      ${chalk.dim(result.id ?? "—")}`);
  console.log(`  ${chalk.dim("name")}    ${chalk.bold(result.name ?? "—")}`);
  console.log(`  ${chalk.dim("status")}  ${statusBadge((result.status ?? "draft") as AutomationStatus)} ${result.status ?? "draft"}`);
  console.log();
  log.dim(`Enable it: synap automation enable ${result.id ?? "<id>"}`);
}

// ── Public: automationEnable ──────────────────────────────────────────────────

export interface EnableOpts {
  workspace?: string;
}

export async function automationEnable(id: string, opts: EnableOpts): Promise<void> {
  let cfg: HubCfg;
  try {
    cfg = await resolveHubConfig();
  } catch (err) {
    log.error((err as Error).message);
    process.exit(1);
  }

  const workspaceId = opts.workspace ?? cfg.workspaceId;
  const spinner = ora({ text: "Activating automation…", color: "cyan" }).start();

  const input: Record<string, unknown> = { id };
  if (workspaceId) input.workspaceId = workspaceId;

  let result: Automation;
  try {
    const data = await trpcMutation("automations.activateAutomation", input, cfg);
    result = data as Automation;
  } catch (err) {
    spinner.fail(chalk.red("Failed to activate automation"));
    log.error((err as Error).message);
    process.exit(1);
  }

  spinner.stop();
  log.success(`Automation ${chalk.bold(result.name ?? id)} is now active`);
}

// ── Public: automationDisable ─────────────────────────────────────────────────

export interface DisableOpts {
  workspace?: string;
}

export async function automationDisable(id: string, opts: DisableOpts): Promise<void> {
  let cfg: HubCfg;
  try {
    cfg = await resolveHubConfig();
  } catch (err) {
    log.error((err as Error).message);
    process.exit(1);
  }

  const workspaceId = opts.workspace ?? cfg.workspaceId;
  const spinner = ora({ text: "Pausing automation…", color: "cyan" }).start();

  const input: Record<string, unknown> = { id };
  if (workspaceId) input.workspaceId = workspaceId;

  let result: Automation;
  try {
    const data = await trpcMutation("automations.pauseAutomation", input, cfg);
    result = data as Automation;
  } catch (err) {
    spinner.fail(chalk.red("Failed to pause automation"));
    log.error((err as Error).message);
    process.exit(1);
  }

  spinner.stop();
  console.log(`  ${chalk.red("⊘")} Automation ${chalk.bold(result.name ?? id)} paused`);
}

// ── Public: automationDelete ──────────────────────────────────────────────────

export interface DeleteOpts {
  workspace?: string;
  force?: boolean;
}

export async function automationDelete(id: string, opts: DeleteOpts): Promise<void> {
  let cfg: HubCfg;
  try {
    cfg = await resolveHubConfig();
  } catch (err) {
    log.error((err as Error).message);
    process.exit(1);
  }

  const workspaceId = opts.workspace ?? cfg.workspaceId;

  // Fetch name for confirmation prompt
  let automationName = id;
  if (!opts.force) {
    try {
      const input: Record<string, unknown> = { id };
      if (workspaceId) input.workspaceId = workspaceId;
      const data = await trpcQuery("automations.getAutomation", input, cfg);
      automationName = (data as Automation).name ?? id;
    } catch {
      // Fall back to ID in prompt
    }

    const response = await prompts({
      type: "confirm",
      name: "confirmed",
      message: `Delete automation '${automationName}'?`,
      initial: false,
    });

    if (!response.confirmed) {
      log.dim("Cancelled.");
      return;
    }
  }

  const spinner = ora({ text: "Deleting automation…", color: "cyan" }).start();

  const input: Record<string, unknown> = { id };
  if (workspaceId) input.workspaceId = workspaceId;

  try {
    await trpcMutation("automations.deleteAutomation", input, cfg);
  } catch (err) {
    spinner.fail(chalk.red("Failed to delete automation"));
    log.error((err as Error).message);
    process.exit(1);
  }

  spinner.succeed(chalk.green(`Automation '${automationName}' deleted`));
}

// ── Public: automationSchema ──────────────────────────────────────────────────

export interface SchemaOpts {
  writeContext?: string | boolean;
  json?: boolean;
}

export async function automationSchema(opts: SchemaOpts): Promise<void> {
  let cfg: HubCfg;
  try {
    cfg = await resolveHubConfig();
  } catch (err) {
    log.error((err as Error).message);
    process.exit(1);
  }

  const spinner = opts.json ? null : ora({ text: "Fetching schema…", color: "cyan" }).start();

  let schema: unknown;
  try {
    // hubGet already prefixes ${podUrl}/api/hub — pass only the sub-path.
    schema = await hubGet("/automations/schema", {}, cfg);
    spinner?.stop();
  } catch (err) {
    spinner?.fail(chalk.red("Failed to fetch schema"));
    log.error((err as Error).message);
    process.exit(1);
  }

  if (opts.json) {
    console.log(JSON.stringify(schema, null, 2));
    return;
  }

  const s = schema as Record<string, unknown>;
  const podUrl = cfg.podUrl;

  const md = buildSchemaMarkdown(s, podUrl);

  if (opts.writeContext !== undefined && opts.writeContext !== false) {
    const outputPath =
      typeof opts.writeContext === "string" && opts.writeContext.length > 0
        ? opts.writeContext
        : ".claude/AUTOMATION_CONTEXT.md";

    const dir = outputPath.includes("/") ? outputPath.split("/").slice(0, -1).join("/") : ".";
    if (dir && dir !== "." && !existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }

    writeFileSync(outputPath, md, "utf-8");
    log.success(
      `Context written to ${chalk.underline(outputPath)} — Claude Code will auto-load this in all sessions from this directory`
    );
  } else {
    console.log(md);
  }
}

function buildSchemaMarkdown(schema: Record<string, unknown>, podUrl: string): string {
  const lines: string[] = [
    `# Synap Automation DSL Reference`,
    ``,
    `> Fetched from pod: ${podUrl} — use this context to create, understand, and debug automations.`,
    ``,
    `## Trigger Types`,
  ];

  const triggerTypes = (schema.triggerTypes ?? schema.triggers ?? {}) as Record<string, unknown>;
  if (Object.keys(triggerTypes).length > 0) {
    for (const [name, def] of Object.entries(triggerTypes)) {
      const d = def as Record<string, unknown>;
      lines.push(``, `### ${name}`);
      if (d.description) lines.push(``, String(d.description));
      if (d.fields) {
        lines.push(``, `**Fields:**`);
        for (const [field, fdesc] of Object.entries(d.fields as Record<string, unknown>)) {
          lines.push(`- \`${field}\` — ${fdesc}`);
        }
      }
      if (d.examples) {
        lines.push(``, `**Examples:**`);
        for (const ex of d.examples as string[]) {
          lines.push(`- \`${ex}\``);
        }
      }
    }
  } else {
    lines.push(
      ``,
      `### event`,
      ``,
      `Fires when a pod event matches the pattern.`,
      ``,
      `**Fields:**`,
      `- \`eventPattern\` — event path with optional trailing wildcard`,
      `- \`filters\` — dot-notation key-value equality checks on event.data`,
      ``,
      `**Common patterns:**`,
      `- \`entity.create.completed\` — new entity created (use this; .validated only fires on proposal-approval path)`,
      `- \`entity.update.completed\` — entity updated`,
      `- \`entity.update.*\` — any entity update event`,
      `- \`import.complete\` — import finished`,
      ``,
      `### cron`,
      ``,
      `Fires on a cron schedule.`,
      ``,
      `**Fields:**`,
      `- \`expression\` — standard 5-part cron expression (minute hour day month weekday)`,
      ``,
      `### webhook`,
      ``,
      `Fires when the automation's webhook URL receives a POST request.`,
      ``,
      `### manual`,
      ``,
      `Only fires when explicitly triggered via the API or CLI.`,
    );
  }

  lines.push(``, `## Node Types`);

  const nodeTypes = (schema.nodeTypes ?? schema.nodes ?? {}) as Record<string, unknown>;
  if (Object.keys(nodeTypes).length > 0) {
    for (const [name, def] of Object.entries(nodeTypes)) {
      const d = def as Record<string, unknown>;
      lines.push(``, `### ${name}`);
      if (d.description) lines.push(``, String(d.description));
      if (d.fields) {
        lines.push(``, `**Fields:**`);
        for (const [field, fdesc] of Object.entries(d.fields as Record<string, unknown>)) {
          lines.push(`- \`${field}\` — ${fdesc}`);
        }
      }
    }
  } else {
    lines.push(
      ``,
      `### trigger`,
      ``,
      `Entry point for the flow. Exactly one per automation.`,
      ``,
      `**data fields:**`,
      `- \`triggerType\` — event | cron | webhook | manual`,
      `- \`label\` — display name`,
      `- \`config\` — trigger-specific config object (eventPattern, filters, expression)`,
      ``,
      `### output`,
      ``,
      `Sends a notification or message when reached.`,
      ``,
      `**data fields:**`,
      `- \`outputType\` — notification | channel_message`,
      `- \`label\` — display name`,
      `- \`config\` — output-specific config (title, body for notification; channelId, content for channel_message)`,
    );
  }

  lines.push(
    ``,
    `## Template Syntax`,
    ``,
    `String values support \`{{...}}\` template expressions:`,
    ``,
    `- \`{{trigger.payload.entity.title}}\` — field from the triggering event`,
    `- \`{{trigger.payload.entity.id}}\` — entity ID from trigger`,
    `- \`{{env.MY_VAR}}\` — environment variable (resolved at CLI create-time when using \`--from\`)`,
    ``,
    `## Quick-Create Examples`,
    ``,
    `\`\`\`bash`,
    `# Notify when a note is created`,
    `synap automation create --name "Note alert" --trigger "event:entity.create.completed" --filter "profileSlug=note" --action notify --message "New note: {{trigger.payload.entity.title}}"`,
    ``,
    `# Weekly digest every Monday at 9am`,
    `synap automation create --name "Weekly digest" --trigger "cron:0 9 * * MON" --action channel-message --channel "#general" --message "Weekly digest ready."`,
    ``,
    `# Manual-only automation (draft, no action)`,
    `synap automation create --name "Manual trigger" --trigger manual`,
    `\`\`\``,
    ``,
    `## YAML File Format`,
    ``,
    `\`\`\`yaml`,
    `name: string`,
    `description: string  # optional`,
    `trigger: event | cron | webhook | manual`,
    `triggerConfig:`,
    `  eventPattern: string   # for event triggers`,
    `  filters:               # for event triggers`,
    `    key: value`,
    `  expression: string     # for cron triggers`,
    `status: draft | active`,
    `flow:`,
    `  nodes:`,
    `    - id: trigger-1`,
    `      type: trigger`,
    `      position: { x: 0, y: 0 }`,
    `      data:`,
    `        triggerType: event`,
    `        label: Trigger`,
    `        config:`,
    `          eventPattern: entity.create.completed`,
    `  edges: []`,
    `\`\`\``,
    ``,
    `> **Env substitution**: \`{{env.MY_VAR}}\` in any string value is replaced with \`process.env.MY_VAR\` at create-time.`,
  );

  return lines.join("\n");
}
