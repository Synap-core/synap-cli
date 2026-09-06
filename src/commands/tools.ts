/**
 * synap tools — Add and manage external service tools (credentials + connections)
 *
 * Subcommands: list, connect, disconnect, sync, schema
 */

import chalk from "chalk";
import ora from "ora";
import { exec } from "child_process";
import { mkdirSync, writeFileSync, existsSync } from "fs";
import { resolveHubConfig, hubGet, hubPost, renderHubError } from "../lib/hub-client.js";
import { capabilityList, capabilityConnect, capabilityDisconnect } from "./capability.js";
import { log } from "../utils/logger.js";

/**
 * The one deprecation line every `tools` subcommand prints. `synap capability`
 * (alias `cap`) is the single capability root; `tools` survives only as an alias
 * so existing scripts keep working.
 */
const TOOLS_DEPRECATED = "`synap tools` is deprecated — use `synap cap`";

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
  log.dim(TOOLS_DEPRECATED);
  // Capabilities are the one root now — forward the named-service connect to
  // `cap connect` (the capability-first equivalent).
  if (service) {
    await capabilityConnect(service, { workspace: opts.workspace });
    return;
  }

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
    renderHubError(err);
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
    // The door only returns `provider_required` when Nango ANSWERED and declares
    // at least one integration — "nothing declared" is `provider_unavailable`
    // now, so this list is never empty. (The old fallback here opened a Connect
    // session "for all services" against a Nango that declared none: it could
    // only ever dead-end.)
    const providers = (res.providers ?? []) as Array<{ provider: string; displayName?: string }>;
    log.heading("Which service do you want to connect?");
    console.log();
    for (const p of providers) {
      console.log(`  ${chalk.cyan(p.provider)}${p.displayName ? chalk.dim(`  (${p.displayName})`) : ""}`);
    }
    console.log();
    log.dim(`Run \`synap cap connect <name>\` with one of the above.`);
    return;
  }

  if (status === "provider_unavailable") {
    // The pod can't offer this provider (not declared / unreachable / malformed).
    // The server message already names the real cause + remedy — print it as-is.
    // No browser, and no "re-run connect": re-running cannot fix a server-side gap.
    log.warn(`${res.displayName ?? res.provider ?? service ?? "That service"} is unavailable on this pod.`);
    if (res.message) log.dim(String(res.message));
    return;
  }

  // setup_required (or any status this CLI doesn't know) → only ever open a
  // browser when the server actually handed us a URL. An older/newer pod that
  // returns a status we don't handle must NOT send the user to "undefined".
  const redirectUrl =
    typeof res.redirectUrl === "string" && res.redirectUrl.length > 0 ? res.redirectUrl : null;
  if (!redirectUrl) {
    log.warn(`Couldn't start a connection for ${res.displayName ?? res.provider ?? service ?? "that service"}.`);
    if (res.message) log.dim(String(res.message));
    else log.dim(`The pod returned status "${status}" with no connect URL. Check the pod's connector configuration.`);
    return;
  }
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
  // `cap list` is the one capability-first view.
  log.dim(TOOLS_DEPRECATED);
  await capabilityList({ json: opts.json, workspace: opts.workspace });
}

// ── Public: toolsSync ────────────────────────────────────────────────────

export interface SyncOpts {
  workspace?: string;
}

export async function toolsSync(provider: string, opts: SyncOpts): Promise<void> {
  log.dim(TOOLS_DEPRECATED);

  let cfg: HubCfg;
  try {
    cfg = await resolveHubConfig();
  } catch (err) {
    log.error((err as Error).message);
    process.exit(1);
  }

  const workspaceId = opts.workspace ?? cfg.workspaceId;

  try {
    const providers = await fetchProviders(cfg, workspaceId);
    const match = providers.find(
      (p) => p.provider === provider || p.id === provider || p.displayName.toLowerCase() === provider.toLowerCase()
    );
    if (!match || !match.connected) {
      log.error(`Provider ${chalk.bold(provider)} is not connected. Run: ${chalk.cyan(`synap cap connect ${provider}`)}`);
      process.exit(1);
    }
  } catch (err) {
    renderHubError(err);
    process.exit(1);
  }

  // The old background-import "sync" (POST /connectors/actions, a Nango named
  // action) was retired — self-hosted Nango doesn't run Actions, and the model
  // moved to ON-DEMAND access: a connected service is reached live via its
  // capability skills (e.g. gmail_search), not pre-imported on a schedule. There
  // is nothing to trigger, so this command does nothing and must not claim
  // otherwise.
  log.warn(`\`synap tools sync\` does nothing and will be removed.`);
  log.dim(
    `${provider} is connected. Connected services are queried on demand by your ` +
      "agent's capabilities (e.g. search, list, send), not imported on a schedule — " +
      "so there is no sync to trigger."
  );
  log.dim(`See connection status:  synap cap list`);
}

// ── Public: toolsDisconnect ──────────────────────────────────────────────

export interface DisconnectOpts {
  workspace?: string;
  force?: boolean;
}

export async function toolsDisconnect(provider: string, opts: DisconnectOpts): Promise<void> {
  log.dim(TOOLS_DEPRECATED);
  // `cap disconnect` resolves a capability name OR a raw provider id, so the
  // provider ids this command has always taken keep resolving.
  await capabilityDisconnect(provider, { workspace: opts.workspace, force: opts.force });
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

  // The dedicated /connectors/schema route was retired; the provider catalog +
  // connection status now comes from /connectors/providers (the same source the
  // list command uses). Shape it into the { providers } envelope the markdown
  // builder expects.
  let schema: unknown;
  try {
    const providers = await fetchProviders(cfg);
    schema = { providers };
    spinner?.stop();
  } catch (err) {
    spinner?.fail(chalk.red("Failed to fetch tool schema"));
    renderHubError(err);
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
    `synap cap connect [name]`,
    `synap cap connect "Nango — Google Workspace"`,
    ``,
    `# List all capabilities and connection status`,
    `synap tools list`,
    `synap tools list --json`,
    `synap cap list`,
    ``,
    `# Show one capability's detail (status, connection, verbs, next action)`,
    `synap cap show <name>`,
    ``,
    `# Turn on a capability (ensures its connection, then picks verbs)`,
    `synap cap enable [name]`,
    ``,
    `# Run a verb`,
    `synap cap run <verb>`,
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
    `| POST | /api/hub/connectors/connect | Resolve-or-start a connection (unified door) |`,
    `| GET | /api/hub/connectors/providers | List providers and connection status |`,
    `| POST | /api/hub/connectors/session | Start OAuth session, get redirectUrl |`,
    `| POST | /api/hub/connectors/disconnect | Disconnect a provider |`,
    `| POST | /api/hub/connectors/tool-execute | Run a provider call (proxied, governed) |`,
    ``,
    `## AI Usage Flow`,
    ``,
    `1. Check connected services: \`synap cap list\``,
    `2. Connect a new service: \`synap cap connect <name>\` — opens OAuth in browser`,
    `3. Connecting installs the service's capability skills (e.g. gmail_send, gmail_search)`,
    `4. The agent reaches the service ON DEMAND through those skills (no scheduled import)`,
    `5. Ask naturally: \`synap ask "any emails from Acme this week?"\``,
  );

  return lines.join("\n");
}
