/**
 * synap connectors — Manage pod connector integrations (Nango-powered)
 *
 * Subcommands: list, sync, disconnect, schema
 * Top-level alias: synap connect [service]
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

// ── Helpers ───────────────────────────────────────────────────────────────────

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

// ── Public: connectorsConnect ─────────────────────────────────────────────────

export interface ConnectOpts {
  workspace?: string;
  podUrl?: string;
  apiKey?: string;
}

export async function connectorsConnect(service: string | undefined, opts: ConnectOpts): Promise<void> {
  let cfg: HubCfg;
  try {
    cfg = await resolveHubConfig({ podUrl: opts.podUrl, apiKey: opts.apiKey });
  } catch (err) {
    log.error((err as Error).message);
    process.exit(1);
  }

  const workspaceId = opts.workspace ?? cfg.workspaceId;

  const spinner = ora({ text: "Starting OAuth session…", color: "cyan" }).start();

  let redirectUrl: string;
  try {
    const body: Record<string, unknown> = {};
    if (service) body.providerId = service;
    if (workspaceId) body.workspaceId = workspaceId;
    const res = await hubPost("/connectors/session", body, cfg);
    const r = res as Record<string, unknown>;
    redirectUrl = String(r.redirectUrl);
    spinner.stop();
  } catch (err) {
    spinner.fail(chalk.red("Failed to start connector session"));
    log.error((err as Error).message);
    process.exit(1);
  }

  log.heading(`Connect to ${service ?? "external services"}`);
  console.log();
  console.log(`  Opening OAuth flow in your browser…`);
  console.log(`  ${chalk.dim("If it didn't open, paste this URL in your browser:")}`);
  console.log();
  console.log(`  ${chalk.underline(chalk.cyan(redirectUrl))}`);
  console.log();

  openBrowser(redirectUrl);

  log.dim(`Once connected, records will import automatically. Run \`synap connectors list\` to check status.`);
}

// ── Public: connectorsList ────────────────────────────────────────────────────

export interface ListOpts {
  json?: boolean;
  workspace?: string;
}

export async function connectorsList(opts: ListOpts): Promise<void> {
  let cfg: HubCfg;
  try {
    cfg = await resolveHubConfig();
  } catch (err) {
    log.error((err as Error).message);
    process.exit(1);
  }

  const workspaceId = opts.workspace ?? cfg.workspaceId;

  const spinner = opts.json ? null : ora({ text: "Fetching connectors…", color: "cyan" }).start();

  let providers: ConnectorProvider[];
  try {
    providers = await fetchProviders(cfg, workspaceId);
    spinner?.stop();
  } catch (err) {
    spinner?.fail(chalk.red("Failed to fetch connectors"));
    log.error((err as Error).message);
    process.exit(1);
  }

  if (opts.json) {
    console.log(JSON.stringify({ providers }, null, 2));
    return;
  }

  if (providers.length === 0) {
    log.warn("No connectors configured on this pod.");
    log.dim(`Set up Nango at ${cfg.podUrl}/admin/settings.`);
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

// ── Public: connectorsSync ────────────────────────────────────────────────────

export interface SyncOpts {
  workspace?: string;
}

export async function connectorsSync(provider: string, opts: SyncOpts): Promise<void> {
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

// ── Public: connectorsDisconnect ──────────────────────────────────────────────

export interface DisconnectOpts {
  workspace?: string;
  force?: boolean;
}

export async function connectorsDisconnect(provider: string, opts: DisconnectOpts): Promise<void> {
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
    // hubDelete is not available — use POST fallback endpoint
    // Backend should support POST /api/hub/connectors/disconnect as an alternative to DELETE
    await hubPost("/connectors/disconnect", { connectionId, provider }, cfg);
    spinner.succeed(chalk.green(`Disconnected ${chalk.bold(provider)}. Your imported entities remain intact.`));
  } catch (err) {
    spinner.fail(chalk.red(`Failed to disconnect ${provider}`));
    log.error((err as Error).message);
    process.exit(1);
  }
}

// ── Public: connectorsSchema ──────────────────────────────────────────────────

export interface SchemaOpts {
  writeContext?: string | boolean;
  json?: boolean;
}

export async function connectorsSchema(opts: SchemaOpts): Promise<void> {
  let cfg: HubCfg;
  try {
    cfg = await resolveHubConfig();
  } catch (err) {
    log.error((err as Error).message);
    process.exit(1);
  }

  const spinner = opts.json ? null : ora({ text: "Fetching connector schema…", color: "cyan" }).start();

  let schema: unknown;
  try {
    schema = await hubGet("/connectors/schema", {}, cfg);
    spinner?.stop();
  } catch (err) {
    spinner?.fail(chalk.red("Failed to fetch connector schema"));
    log.error((err as Error).message);
    process.exit(1);
  }

  if (opts.json) {
    console.log(JSON.stringify(schema, null, 2));
    return;
  }

  const s = schema as Record<string, unknown>;
  const md = buildConnectorSchemaMarkdown(s, cfg.podUrl);

  if (opts.writeContext !== undefined && opts.writeContext !== false) {
    const outputPath =
      typeof opts.writeContext === "string" && opts.writeContext.length > 0
        ? opts.writeContext
        : ".claude/CONNECTOR_CONTEXT.md";

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

function buildConnectorSchemaMarkdown(schema: Record<string, unknown>, podUrl: string): string {
  const lines: string[] = [
    `# Synap Connector Reference`,
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
    `# List all connectors and connection status`,
    `synap connectors list`,
    `synap connectors list --json`,
    ``,
    `# Trigger a manual sync for a connected provider`,
    `synap connectors sync <provider>`,
    ``,
    `# Disconnect a provider`,
    `synap connectors disconnect <provider>`,
    `synap connectors disconnect google --force`,
    ``,
    `# Fetch this schema`,
    `synap connectors schema`,
    `synap connectors schema --write-context   # writes to .claude/CONNECTOR_CONTEXT.md`,
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
    `1. Check connected services: \`synap connectors list\``,
    `2. Connect a new service: \`synap connect <provider>\` — opens OAuth in browser`,
    `3. Once connected, records import automatically on Nango's schedule`,
    `4. Trigger immediate import: \`synap connectors sync <provider>\``,
    `5. Query imported entities: \`synap recall "meeting notes from Google Calendar"\``,
  );

  return lines.join("\n");
}
