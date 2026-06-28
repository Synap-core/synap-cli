/**
 * synap tools — Add and manage external service tools (credentials + connections)
 *
 * Subcommands: list, connect, disconnect, sync, schema
 */

import chalk from "chalk";
import ora from "ora";
import prompts from "prompts";
import { exec } from "child_process";
import { mkdirSync, writeFileSync, existsSync } from "fs";
import { resolveHubConfig, hubGet, hubPost } from "../lib/hub-client.js";
import { log } from "../utils/logger.js";

// ── Types ─────────────────────────────────────────────────────────────────────

type HubCfg = Awaited<ReturnType<typeof resolveHubConfig>>;

interface ConnectorProvider {
  id: string;
  provider: string;
  displayName: string;
  connected: boolean;
  connectionId?: string;
}

interface UnlockedCapability {
  provider: string;
  displayName: string;
  skills: Array<{ name: string; description?: string }>;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Render the verbs a connection installed, e.g. after OAuth completes. */
function printUnlocked(unlocked: UnlockedCapability[] | undefined): void {
  const skills = (unlocked ?? []).flatMap((u) => u.skills);
  if (skills.length === 0) return;
  console.log();
  log.heading("Capabilities installed");
  for (const s of skills) {
    const label = s.name.replace(/_/g, " ");
    console.log(`  ${chalk.green("✓")} ${chalk.bold(label)}${s.description ? chalk.dim(` — ${s.description}`) : ""}`);
  }
  console.log();
  // Code skills are seeded as DRAFT (a deliberate gate — code runs unreviewed
  // only after an explicit enable). Be honest about the one-time step.
  log.dim("Enable these in Synap → Settings → Capabilities to let your agent use them.");
  log.dim("Once enabled, each action still asks for your approval before it runs.");
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * Poll the connect door until the provider flips to `connected` (the user
 * finished OAuth in the browser). The door is self-completing: on `connected`
 * it materializes the tool + family template server-side and returns `unlocked`.
 * Bounded so the CLI never hangs forever.
 */
async function pollUntilConnected(
  cfg: HubCfg,
  provider: string,
  workspaceId: string | undefined,
  timeoutMs = 180_000,
  intervalMs = 3_000
): Promise<Record<string, unknown> | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await sleep(intervalMs);
    try {
      const body: Record<string, unknown> = { provider };
      if (workspaceId) body.workspaceId = workspaceId;
      const res = (await hubPost("/connectors/connect", body, cfg)) as Record<string, unknown>;
      if (String(res.status) === "connected") return res;
    } catch {
      // transient — keep polling until the deadline
    }
  }
  return null;
}

function openBrowser(url: string): void {
  const platform = process.platform;
  let cmd: string;
  if (platform === "darwin") {
    cmd = `open "${url}"`;
  } else if (platform === "win32") {
    cmd = `start "" "${url}"`;
  } else {
    cmd = `xdg-open "${url}"`;
  }
  try {
    exec(cmd);
  } catch {
    // silently ignore — caller already prints the URL
  }
}

async function fetchProviders(cfg: HubCfg, workspaceId?: string): Promise<ConnectorProvider[]> {
  const params: Record<string, string> = {};
  if (workspaceId) params.workspaceId = workspaceId;
  const res = await hubGet("/connectors/providers", params, cfg);
  const r = res as Record<string, unknown>;
  return (r.providers ?? []) as ConnectorProvider[];
}

// ── Public: toolsConnect ───────────────────────────────────────────────────────

export interface ConnectOpts {
  workspace?: string;
  podUrl?: string;
  apiKey?: string;
}

export async function toolsConnect(service: string | undefined, opts: ConnectOpts): Promise<void> {
  let cfg: HubCfg;
  try {
    cfg = await resolveHubConfig({ podUrl: opts.podUrl, apiKey: opts.apiKey });
  } catch (err) {
    log.error((err as Error).message);
    process.exit(1);
  }

  const workspaceId = opts.workspace ?? cfg.workspaceId;

  const spinner = ora({ text: "Resolving connection…", color: "cyan" }).start();

  // The unified door: resolves the provider, checks for an existing connection,
  // and returns connected / setup_required / provider_required in one call.
  // Connects as the operator (the CLI's key owner) — no per-user binding here.
  let res: Record<string, unknown>;
  try {
    const body: Record<string, unknown> = {};
    if (service) body.provider = service;
    if (workspaceId) body.workspaceId = workspaceId;
    res = (await hubPost("/connectors/connect", body, cfg)) as Record<string, unknown>;
    spinner.stop();
  } catch (err) {
    spinner.fail(chalk.red("Failed to resolve connection"));
    log.error((err as Error).message);
    process.exit(1);
  }

  const status = String(res.status);

  if (status === "connected") {
    log.heading(`${res.displayName ?? res.provider} is already connected`);
    printUnlocked(res.unlocked as UnlockedCapability[] | undefined);
    log.dim(`Run \`synap tools list\` to see all tools and their credentials.`);
    return;
  }

  if (status === "provider_required") {
    const providers = (res.providers ?? []) as Array<{ provider: string; displayName?: string }>;
    if (providers.length > 0) {
      log.heading("Which service do you want to connect?");
      console.log();
      for (const p of providers) {
        console.log(`  ${chalk.cyan(p.provider)}${p.displayName ? chalk.dim(`  (${p.displayName})`) : ""}`);
      }
      console.log();
      log.dim(`Run \`synap tools connect <name>\` with one of the above.`);
      return;
    }
    // No integrations declared — go straight to a Connect session. The Nango
    // Connect UI handles discovery (which integrations are available + OAuth).
    log.info("No integration catalog available — opening Connect session for all services...");
    try {
      const sessionBody: Record<string, unknown> = {};
      if (service) sessionBody.providerId = service;
      if (workspaceId) sessionBody.workspaceId = workspaceId;
      const sess = (await hubPost("/connectors/session", sessionBody, cfg)) as Record<string, unknown>;
      const redirectUrl = String(sess.redirectUrl);
      log.heading(`Connect to ${service ?? "external services"}`);
      console.log();
      console.log(`  Opening OAuth flow in your browser…`);
      console.log(`  ${chalk.underline(chalk.cyan(redirectUrl))}`);
      console.log();
      openBrowser(redirectUrl);
      log.dim(`Once connected, run \`synap tools list\` to check status.`);
    } catch (err) {
      spinner.fail(chalk.red("Failed to start Connect session"));
      log.error((err as Error).message);
      process.exit(1);
    }
    return;
  }

  // setup_required
  const redirectUrl = String(res.redirectUrl);
  const matchedProvider = res.provider ? String(res.provider) : service;
  log.heading(`Connect to ${res.displayName ?? res.provider ?? service ?? "external service"}`);
  console.log();
  console.log(`  Opening OAuth flow in your browser…`);
  console.log(`  ${chalk.dim("If it didn't open, paste this URL in your browser:")}`);
  console.log();
  console.log(`  ${chalk.underline(chalk.cyan(redirectUrl))}`);
  console.log();

  openBrowser(redirectUrl);

  // Wait for the user to finish OAuth, then confirm + show what unlocked. The
  // connect door materializes the capability server-side on `connected`, so by
  // the time this resolves the agent can already use the new verbs.
  if (matchedProvider) {
    const waitSpinner = ora({ text: "Waiting for you to finish in the browser…", color: "cyan" }).start();
    const connected = await pollUntilConnected(cfg, matchedProvider, workspaceId);
    if (connected) {
      waitSpinner.succeed(chalk.green(`Connected ${chalk.bold(String(connected.displayName ?? matchedProvider))}!`));
      printUnlocked(connected.unlocked as UnlockedCapability[] | undefined);
      return;
    }
    waitSpinner.stop();
    log.dim(`Didn't detect a connection yet — finish the browser flow, then run \`synap tools list\` to check status.`);
    return;
  }

  log.dim(`Once connected, records will import automatically. Run \`synap tools list\` to check status.`);
}

// ── Public: toolsList ──────────────────────────────────────────────────────────

export interface ListOpts {
  json?: boolean;
  workspace?: string;
}

export async function toolsList(opts: ListOpts): Promise<void> {
  let cfg: HubCfg;
  try {
    cfg = await resolveHubConfig();
  } catch (err) {
    log.error((err as Error).message);
    process.exit(1);
  }

  const workspaceId = opts.workspace ?? cfg.workspaceId;

  const spinner = opts.json ? null : ora({ text: "Fetching tools…", color: "cyan" }).start();

  let providers: ConnectorProvider[];
  try {
    providers = await fetchProviders(cfg, workspaceId);
    spinner?.stop();
  } catch (err) {
    spinner?.fail(chalk.red("Failed to fetch tools"));
    log.error((err as Error).message);
    process.exit(1);
  }

  if (opts.json) {
    console.log(JSON.stringify({ providers }, null, 2));
    return;
  }

  if (providers.length === 0) {
    log.warn("No tools configured on this pod.");
    log.dim(`Centralized Nango is at https://nango.synap.live — connect a service first:`);
    log.dim(`  synap tools connect <name>`);
    return;
  }

  const connected = providers.filter((p) => p.connected);
  log.heading(`Connected Services (${connected.length} connected / ${providers.length} total)`);
  console.log();

  for (const p of providers) {
    const dot = p.connected ? chalk.green("●") : chalk.dim("○");
    const name = p.connected ? chalk.bold(p.displayName) : chalk.dim(p.displayName);
    const id = chalk.dim(`(${p.provider})`);
    const connLine = p.connected && p.connectionId ? `  ${chalk.dim(p.connectionId)}` : "";
    console.log(`  ${dot} ${name} ${id}${connLine}`);
  }
  console.log();
}

// ── Public: toolsSync ────────────────────────────────────────────────────

export interface SyncOpts {
  workspace?: string;
}

export async function toolsSync(provider: string, opts: SyncOpts): Promise<void> {
  let cfg: HubCfg;
  try {
    cfg = await resolveHubConfig();
  } catch (err) {
    log.error((err as Error).message);
    process.exit(1);
  }

  const workspaceId = opts.workspace ?? cfg.workspaceId;

  // Find the connectionId
  let connectionId: string | undefined;
  try {
    const providers = await fetchProviders(cfg, workspaceId);
    const match = providers.find(
      (p) => p.provider === provider || p.id === provider || p.displayName.toLowerCase() === provider.toLowerCase()
    );
    if (!match || !match.connected) {
      log.error(`Provider ${chalk.bold(provider)} is not connected. Run: ${chalk.cyan(`synap connect ${provider}`)}`);
      process.exit(1);
    }
    connectionId = match.connectionId;
  } catch (err) {
    log.error((err as Error).message);
    process.exit(1);
  }

  const spinner = ora({ text: "Triggering sync…", color: "cyan" }).start();

  try {
    await hubPost(
      "/connectors/actions",
      { connectionId, providerConfigKey: provider, actionName: "sync", input: {} },
      cfg
    );
    spinner.succeed(chalk.green(`Sync triggered for ${chalk.bold(provider)}. Records will import in the background.`));
  } catch (err) {
    const msg = (err as Error).message;
    // Non-200 may mean manual sync not configured — handle gracefully
    spinner.warn(
      chalk.yellow(
        `Sync triggered (manual sync may not be configured for this provider — automatic sync runs on the Nango schedule)`
      )
    );
    log.dim(msg);
  }
}

// ── Public: toolsDisconnect ──────────────────────────────────────────────

export interface DisconnectOpts {
  workspace?: string;
  force?: boolean;
}

export async function toolsDisconnect(provider: string, opts: DisconnectOpts): Promise<void> {
  let cfg: HubCfg;
  try {
    cfg = await resolveHubConfig();
  } catch (err) {
    log.error((err as Error).message);
    process.exit(1);
  }

  const workspaceId = opts.workspace ?? cfg.workspaceId;

  // Find the connectionId
  let connectionId: string | undefined;
  try {
    const providers = await fetchProviders(cfg, workspaceId);
    const match = providers.find(
      (p) => p.provider === provider || p.id === provider || p.displayName.toLowerCase() === provider.toLowerCase()
    );
    if (!match || !match.connected) {
      log.error(`Provider ${chalk.bold(provider)} is not connected.`);
      process.exit(1);
    }
    connectionId = match.connectionId;
  } catch (err) {
    log.error((err as Error).message);
    process.exit(1);
  }

  if (!opts.force) {
    const response = await prompts({
      type: "confirm",
      name: "confirmed",
      message: `Disconnect ${provider}? This will stop syncing but won't delete imported entities.`,
      initial: false,
    });
    if (!response.confirmed) {
      log.dim("Cancelled.");
      return;
    }
  }

  const spinner = ora({ text: `Disconnecting ${provider}…`, color: "cyan" }).start();

  try {
    await hubPost("/connectors/disconnect", { connectionId, provider }, cfg);
    spinner.succeed(chalk.green(`Disconnected ${chalk.bold(provider)}. Your imported entities remain intact.`));
  } catch (err) {
    spinner.fail(chalk.red(`Failed to disconnect ${provider}`));
    log.error((err as Error).message);
    process.exit(1);
  }
}

// ── Public: toolsSchema ──────────────────────────────────────────────────

export interface SchemaOpts {
  writeContext?: string | boolean;
  json?: boolean;
}

export async function toolsSchema(opts: SchemaOpts): Promise<void> {
  let cfg: HubCfg;
  try {
    cfg = await resolveHubConfig();
  } catch (err) {
    log.error((err as Error).message);
    process.exit(1);
  }

  const spinner = opts.json ? null : ora({ text: "Fetching tool schema…", color: "cyan" }).start();

  let schema: unknown;
  try {
    schema = await hubGet("/connectors/schema", {}, cfg);
    spinner?.stop();
  } catch (err) {
    spinner?.fail(chalk.red("Failed to fetch tool schema"));
    log.error((err as Error).message);
    process.exit(1);
  }

  if (opts.json) {
    console.log(JSON.stringify(schema, null, 2));
    return;
  }

  const s = schema as Record<string, unknown>;
  const md = buildToolSchemaMarkdown(s, cfg.podUrl);

  if (opts.writeContext !== undefined && opts.writeContext !== false) {
    const outputPath =
      typeof opts.writeContext === "string" && opts.writeContext.length > 0
        ? opts.writeContext
        : ".claude/TOOLS_CONTEXT.md";

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

function buildToolSchemaMarkdown(schema: Record<string, unknown>, podUrl: string): string {
  const lines: string[] = [
    `# Synap Tool Reference`,
    ``,
    `> Fetched from pod: ${podUrl} — use this context to connect, manage, and query external service integrations.`,
    ``,
    `## Supported Providers`,
  ];

  const providers = (schema.providers ?? schema.supported ?? []) as Array<Record<string, unknown>>;
  if (providers.length > 0) {
    for (const p of providers) {
      lines.push(``, `### ${p.displayName ?? p.provider ?? p.id}`);
      if (p.description) lines.push(``, String(p.description));
      if (p.actions) {
        lines.push(``, `**Available actions:**`);
        for (const action of p.actions as string[]) {
          lines.push(`- \`${action}\``);
        }
      }
    }
  } else {
    lines.push(
      ``,
      `Providers are configured in Nango. Common integrations include:`,
      `- Google Workspace (gmail, google-calendar, google-drive)`,
      `- GitHub (github)`,
      `- Notion (notion)`,
      `- Linear (linear)`,
      `- Slack (slack)`,
      `- HubSpot (hubspot)`,
    );
  }

  lines.push(
    ``,
    `## CLI Commands`,
    ``,
    `\`\`\`bash`,
    `# Connect a service (opens OAuth flow in browser)`,
    `synap connect [service]`,
    `synap connect google`,
    `synap connect github`,
    ``,
    `# List all tools and connection status`,
    `synap tools list`,
    `synap tools list --json`,
    ``,
    `# Trigger a manual sync for a connected provider`,
    `synap tools sync <provider>`,
    ``,
    `# Disconnect a provider`,
    `synap tools disconnect <provider>`,
    `synap tools disconnect google --force`,
    ``,
    `# Fetch this schema`,
    `synap tools schema`,
    `synap tools schema --write-context   # writes to .claude/TOOLS_CONTEXT.md`,
    `\`\`\``,
    ``,
    `## Hub REST Endpoints`,
    ``,
    `| Method | Path | Description |`,
    `|--------|------|-------------|`,
    `| GET | /api/hub/connectors/providers | List providers and connection status |`,
    `| POST | /api/hub/connectors/session | Start OAuth session, get redirectUrl |`,
    `| POST | /api/hub/connectors/disconnect | Disconnect a provider |`,
    `| GET | /api/hub/connectors/schema | This schema |`,
    `| POST | /api/hub/connectors/actions | Trigger a provider action (e.g. sync) |`,
    ``,
    `## AI Usage Flow`,
    ``,
    `1. Check connected services: \`synap tools list\``,
    `2. Connect a new service: \`synap connect <provider>\` — opens OAuth in browser`,
    `3. Once connected, records import automatically on Nango's schedule`,
    `4. Trigger immediate import: \`synap tools sync <provider>\``,
    `5. Query imported entities: \`synap ask "meeting notes from Google Calendar"\``,
  );

  return lines.join("\n");
}
