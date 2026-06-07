/**
 * synap agent run / schedule / tick
 *
 * The CLI is a thin trigger. The IS handles all reasoning and tool execution
 * server-side via MCP. The CLI's responsibilities are:
 *   1. Resolve which agent (and its pod/workspace) to use
 *   2. Send the goal to IS /v1/chat/completions
 *   3. Store the final output as a `research` entity on the pod
 *   4. Display the result
 *
 * Schedules are stored as `task` entities on the pod (not local files) so they
 * are visible in pod-admin and shareable across machines.
 * `synap agent tick` reads due schedules from the pod and fires them.
 * Wire it to the pod server's crontab for autonomous execution.
 */

import chalk from "chalk";
import ora from "ora";
import { resolveHubConfig, hubGet, hubPost, hubPatch } from "../lib/hub-client.js";
import { log } from "../utils/logger.js";

// ── Types ─────────────────────────────────────────────────────────────────────

type Persona = "researcher" | "assistant" | "developer";

export interface RunOpts {
  goal: string;
  persona?: Persona;
  model?: string;
  workspace?: string;
  maxTokens?: number;
  dryRun?: boolean;
  podUrl?: string;
  apiKey?: string;
}

export interface ScheduleOpts {
  goal?: string;
  name?: string;
  persona?: Persona;
  model?: string;
  workspace?: string;
  every?: "hourly" | "daily" | "weekly";
  list?: boolean;
  remove?: string;
  runNow?: boolean;
  podUrl?: string;
  apiKey?: string;
}

// ── Persona system prompts ────────────────────────────────────────────────────
// Injected as the system message. The IS handles tool use via MCP.

const PERSONAS: Record<Persona, string> = {
  researcher:
    "You are a research agent. Investigate the given goal thoroughly using all available tools " +
    "(web search, URL fetch, memory recall, entity search). Capture findings as you go. " +
    "When you have a complete synthesis, produce a clear final answer.",

  assistant:
    "You are a helpful assistant. Complete the given task using all available tools. " +
    "Produce a clear, actionable final answer.",

  developer:
    "You are a software engineering agent. Analyze the task, recall relevant knowledge, " +
    "reason carefully, and produce a technical conclusion or recommendation.",
};

// ── IS call ───────────────────────────────────────────────────────────────────

interface ISMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

interface ISResponse {
  choices: Array<{
    message: { role: string; content: string | null };
    finish_reason: string;
  }>;
  usage?: { prompt_tokens: number; completion_tokens: number };
}

async function callIS(
  podUrl: string,
  apiKey: string,
  model: string,
  messages: ISMessage[],
  maxTokens: number
): Promise<ISResponse> {
  const res = await fetch(`${podUrl}/v1/chat/completions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ model, messages, max_tokens: maxTokens }),
    signal: AbortSignal.timeout(180_000),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`IS error (HTTP ${res.status}): ${body.slice(0, 300)}`);
  }

  return res.json() as Promise<ISResponse>;
}

// ── Pod entity storage ────────────────────────────────────────────────────────

type HubCfg = Awaited<ReturnType<typeof resolveHubConfig>>;

async function storeResearch(
  title: string,
  content: string,
  tags: string[],
  cfg: HubCfg
): Promise<string | undefined> {
  const res = await hubPost(
    "/entities",
    {
      userId: cfg.userId,
      workspaceId: cfg.workspaceId,
      profileSlug: "research",
      name: title,
      properties: { summary: content, tags, status: "concluded" },
    },
    cfg
  );
  return (res as Record<string, unknown>).id as string | undefined;
}

// ── Schedule helpers ──────────────────────────────────────────────────────────

const INTERVAL_MS = {
  hourly: 60 * 60 * 1000,
  daily: 24 * 60 * 60 * 1000,
  weekly: 7 * 24 * 60 * 60 * 1000,
} as const;

interface ScheduleEntity {
  id: string;
  name: string;
  properties: {
    goal: string;
    persona: Persona;
    model: string;
    interval: keyof typeof INTERVAL_MS;
    intervalMs: number;
    nextRunAt: string;
    lastRunAt?: string;
    enabled: boolean;
  };
}

async function listScheduleEntities(cfg: HubCfg): Promise<ScheduleEntity[]> {
  const res = await hubGet(
    "/entities",
    { q: "[agent-sched]", workspaceId: cfg.workspaceId, limit: "50" },
    cfg
  );
  const entities = ((res as Record<string, unknown>).entities ?? res) as ScheduleEntity[];
  return Array.isArray(entities)
    ? entities.filter((e) => e.name?.startsWith("[agent-sched]"))
    : [];
}

// ── Public: agentRun ──────────────────────────────────────────────────────────

export async function agentRun(opts: RunOpts): Promise<void> {
  const goal = opts.goal?.trim();
  if (!goal) {
    log.error("--goal is required.");
    log.dim('Example: synap agent run --goal "Research RAG architectures"');
    process.exit(1);
  }

  const persona: Persona = (opts.persona as Persona | undefined) ?? "researcher";
  const model = opts.model ?? "synap/advanced";
  const maxTokens = opts.maxTokens ?? 4000;

  let cfg: HubCfg;
  try {
    cfg = await resolveHubConfig({ podUrl: opts.podUrl, apiKey: opts.apiKey });
  } catch (err) {
    log.error((err as Error).message);
    log.dim("Run `synap pods add` to configure a pod, or pass --pod-url and --api-key.");
    process.exit(1);
  }

  const workspaceId = opts.workspace ?? cfg.workspaceId;
  const runCfg = { ...cfg, workspaceId };

  if (opts.dryRun) {
    log.heading("Agent run — dry run");
    console.log();
    console.log(`  ${chalk.dim("goal")}       ${chalk.bold(goal)}`);
    console.log(`  ${chalk.dim("persona")}    ${chalk.cyan(persona)}`);
    console.log(`  ${chalk.dim("model")}      ${chalk.cyan(model)}`);
    console.log(`  ${chalk.dim("pod")}        ${chalk.underline(cfg.podUrl)}`);
    console.log(
      `  ${chalk.dim("workspace")}  ${workspaceId ? chalk.underline(workspaceId) : chalk.yellow("none — entities will be pod-global")}`
    );
    console.log();
    log.dim(`Will POST to: ${cfg.podUrl}/v1/chat/completions`);
    log.dim("Remove --dry-run to execute.");
    return;
  }

  log.heading(`Agent run — ${chalk.bold(persona)}`);
  log.dim(`Goal: ${goal}`);
  log.dim(`Model: ${model}  ·  Pod: ${cfg.podUrl}`);
  console.log();

  const spinner = ora({ text: "Calling IS…", color: "cyan" }).start();
  const start = Date.now();

  let response: ISResponse;
  try {
    response = await callIS(cfg.podUrl, cfg.apiKey, model, [
      { role: "system", content: PERSONAS[persona] },
      { role: "user", content: goal },
    ], maxTokens);
  } catch (err) {
    const msg = (err as Error).message;
    spinner.fail(chalk.red("IS call failed"));
    console.log();
    log.error(msg);
    if (msg.includes("403") && msg.toLowerCase().includes("scope")) {
      log.warn("Your CLI key is missing a required scope.");
      log.dim("Fix: run  synap connect  to rotate your key with the updated scope list.");
      log.dim("Or in pod-admin → Trust & Keys, delete your CLI key and reconnect.");
    } else if (msg.includes("IS error")) {
      log.dim(`Verify the IS is running: curl ${cfg.podUrl}/v1/models -H "Authorization: Bearer <key>"`);
    }
    process.exit(1);
  }

  const content = response.choices?.[0]?.message?.content ?? "";
  const elapsed = ((Date.now() - start) / 1000).toFixed(1);
  spinner.text = "Storing result…";

  let entityId: string | undefined;
  try {
    entityId = await storeResearch(
      `Agent run: ${goal.slice(0, 80)}`,
      content,
      ["agent-run", persona],
      runCfg
    );
  } catch {
    // storage failure is non-fatal — still display the result
  }

  spinner.succeed(chalk.green(`Done · ${elapsed}s`));
  console.log();

  if (entityId) {
    log.success(`Research stored → ${chalk.underline(`${cfg.podUrl}/admin/entities/${entityId}`)}`);
    console.log();
  }

  if (content) {
    log.heading("Result");
    console.log(chalk.white(content.trim()));
    console.log();
  }
}

// ── Public: agentSchedule ─────────────────────────────────────────────────────

export async function agentSchedule(opts: ScheduleOpts): Promise<void> {
  let cfg: HubCfg;
  try {
    cfg = await resolveHubConfig({ podUrl: opts.podUrl, apiKey: opts.apiKey });
  } catch (err) {
    log.error((err as Error).message);
    process.exit(1);
  }

  // List
  if (opts.list) {
    const schedules = await listScheduleEntities(cfg);
    if (schedules.length === 0) {
      log.warn("No schedules found on this pod/workspace.");
      log.dim("Add one: synap agent schedule --goal '...' --name <name> --every daily");
      return;
    }
    log.heading(`Agent schedules (${schedules.length})`);
    for (const s of schedules) {
      const p = s.properties;
      const badge = p.enabled ? chalk.green("●") : chalk.red("○");
      const last = p.lastRunAt ? `last ran ${new Date(p.lastRunAt).toLocaleString()}` : "never ran";
      const next = new Date(p.nextRunAt).toLocaleString();
      console.log(
        `  ${badge} ${chalk.bold(s.name.replace("[agent-sched] ", "").padEnd(24))} ${chalk.cyan(p.interval.padEnd(8))} ${chalk.dim(last)}`
      );
      console.log(`       next: ${chalk.dim(next)}  |  goal: ${chalk.dim(p.goal.slice(0, 70))}`);
    }
    console.log();
    log.dim("Run due schedules now: synap agent tick");
    log.dim("Crontab (daily at 09:00):  0 9 * * *  synap agent tick");
    return;
  }

  // Remove
  if (opts.remove) {
    const schedules = await listScheduleEntities(cfg);
    const target = schedules.find(
      (s) => s.name === `[agent-sched] ${opts.remove}` || s.name === opts.remove
    );
    if (!target) {
      log.error(`No schedule named "${opts.remove}" found.`);
      process.exit(1);
    }
    // Disable it (soft delete — PATCH enabled=false)
    await hubPatch(`/entities/${target.id}`, { properties: { ...target.properties, enabled: false } }, cfg);
    log.info(`Disabled schedule: ${chalk.bold(opts.remove)}`);
    return;
  }

  // Add
  const { goal, name, every } = opts;
  if (!goal?.trim() || !name?.trim() || !every) {
    log.error("Required: --goal, --name, --every (hourly|daily|weekly)");
    log.dim('Example: synap agent schedule --goal "Research AI news" --name daily-ai --every daily');
    process.exit(1);
  }

  const existing = await listScheduleEntities(cfg).catch(() => []);
  if (existing.find((s) => s.name === `[agent-sched] ${name}`)) {
    log.error(`A schedule named "${name}" already exists.`);
    log.dim(`Remove it first: synap agent schedule --remove ${name}`);
    process.exit(1);
  }

  const now = new Date().toISOString();
  await hubPost(
    "/entities",
    {
      userId: cfg.userId,
      workspaceId: cfg.workspaceId,
      profileSlug: "task",
      name: `[agent-sched] ${name}`,
      properties: {
        goal: goal.trim(),
        persona: opts.persona ?? "researcher",
        model: opts.model ?? "synap/advanced",
        interval: every,
        intervalMs: INTERVAL_MS[every],
        nextRunAt: now,
        enabled: true,
        createdAt: now,
      },
    },
    cfg
  );

  log.info(`Schedule created: ${chalk.bold(name)} — runs ${chalk.cyan(every)}`);
  console.log();
  const cron = every === "hourly" ? "0 * * * *" : every === "daily" ? "0 9 * * *" : "0 9 * * 1";
  log.dim(`Add to pod server crontab:  ${cron}  synap agent tick`);

  if (opts.runNow) {
    console.log();
    await agentRun({
      goal: goal.trim(),
      persona: opts.persona,
      model: opts.model,
      workspace: opts.workspace ?? cfg.workspaceId,
      podUrl: opts.podUrl,
      apiKey: opts.apiKey,
    });
  }
}

// ── Public: agentTick ─────────────────────────────────────────────────────────

export async function agentTick(opts: {
  dryRun?: boolean;
  podUrl?: string;
  apiKey?: string;
}): Promise<void> {
  let cfg: HubCfg;
  try {
    cfg = await resolveHubConfig({ podUrl: opts.podUrl, apiKey: opts.apiKey });
  } catch (err) {
    log.error((err as Error).message);
    process.exit(1);
  }

  const schedules = await listScheduleEntities(cfg).catch(() => []);
  const enabled = schedules.filter((s) => s.properties.enabled);

  if (enabled.length === 0) {
    log.dim("No enabled schedules on this pod.");
    return;
  }

  const now = Date.now();
  const due = enabled.filter((s) => {
    const next = new Date(s.properties.nextRunAt).getTime();
    return now >= next;
  });

  if (due.length === 0) {
    const next = enabled
      .map((s) => new Date(s.properties.nextRunAt).getTime())
      .sort((a, b) => a - b)[0];
    log.dim(`No schedules due. Next: ${new Date(next).toLocaleString()}`);
    return;
  }

  log.heading(`Ticking ${due.length} due schedule(s)`);

  for (const s of due) {
    const p = s.properties;
    log.info(`Running: ${chalk.bold(s.name.replace("[agent-sched] ", ""))}`);

    if (opts.dryRun) {
      log.dim(`  [dry-run] goal: ${p.goal.slice(0, 70)}`);
      continue;
    }

    try {
      await agentRun({
        goal: p.goal,
        persona: p.persona,
        model: p.model,
        workspace: cfg.workspaceId,
        podUrl: opts.podUrl,
        apiKey: opts.apiKey,
      });

      const nextRunAt = new Date(now + p.intervalMs).toISOString();
      await hubPatch(
        `/entities/${s.id}`,
        { properties: { ...p, lastRunAt: new Date(now).toISOString(), nextRunAt } },
        cfg
      ).catch(() => {
        // non-fatal — schedule ran, just couldn't update nextRunAt
        log.dim(`  Warning: could not update nextRunAt for "${s.name}" on the pod.`);
      });
    } catch (err) {
      log.error(`Schedule "${s.name}" failed: ${(err as Error).message}`);
    }
  }
}
