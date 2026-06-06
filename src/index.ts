#!/usr/bin/env node
/**
 * @synap/cli — Connect OpenClaw to sovereign knowledge infrastructure
 *
 * Usage:
 *   npx @synap/cli init              Full setup: detect, harden, connect, install
 *   npx @synap/cli connect           Connect OpenClaw to an existing Synap pod
 *   npx @synap/cli security-audit    Check OpenClaw for known vulnerabilities
 *   npx @synap/cli status            Show pod + OpenClaw health
 *   npx @synap/cli update            Update skill + check for CLI updates
 *
 * Or install globally:
 *   npm i -g @synap/cli
 *   synap init
 */

import { Command } from "commander";
import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

let version = "0.1.0";
try {
  const pkg = JSON.parse(
    readFileSync(join(__dirname, "..", "package.json"), "utf-8")
  );
  version = pkg.version;
} catch {
  // use default
}

const program = new Command();

program
  .name("synap")
  .description(
    "Synap CLI — connect OpenClaw to sovereign knowledge infrastructure"
  )
  .version(version);

program
  .command("init")
  .description(
    "Full setup: detect OpenClaw, harden security, connect to Synap pod, install skill"
  )
  .option("--pod-url <url>", "Synap pod URL (skip pod choice prompt)")
  .option("--api-key <key>", "Hub Protocol API key (skip key generation)")
  .option("--skip-security", "Skip security hardening step")
  .option("--skip-is", "Skip Intelligence Service provider setup")
  .action(async (opts) => {
    const { init } = await import("./commands/init.js");
    await init(opts);
  });

program
  .command("finish")
  .description("One-shot post-install: skill, AI key, public domain, IS")
  .option("--skip-is", "Skip Intelligence Service provider setup")
  .option("--skip-ai-key", "Skip AI provider key setup")
  .option("--skip-domain", "Skip public domain exposure")
  .action(
    async (opts: { skipIs?: boolean; skipAiKey?: boolean; skipDomain?: boolean }) => {
      const { finish } = await import("./commands/finish.js");
      await finish(opts);
    }
  );

program
  .command("connect")
  .description(
    "Connect an AI surface (Claude Code, Claude Desktop, Cursor, Raycast, OpenClaw) to a Synap pod"
  )
  .option(
    "--target <name>",
    "AI surface: claude-code | claude-desktop | cursor | raycast | openclaw"
  )
  .option("--pod-url <url>", "Synap pod URL")
  .option("--api-key <key>", "Hub Protocol API key")
  .option("--name <name>", "Pod profile name to save credentials under (default: 'default')")
  .option("--list", "List supported targets and exit")
  .option(
    "--manual-key",
    "Skip the browser approval flow and paste a key (or provisioning token)"
  )
  .action(async (opts) => {
    const { connect } = await import("./commands/connect.js");
    await connect(opts);
  });

// ─── pods ─────────────────────────────────────────────────────────────────────

const pods = program
  .command("pods")
  .description("Manage multiple Synap pod profiles and switch between them");

pods
  .command("list", { isDefault: true })
  .description("List all configured pod profiles")
  .action(async () => {
    const { podsList } = await import("./commands/pods.js");
    await podsList();
  });

pods
  .command("add [name] [url]")
  .description("Connect a new pod and save as a named profile")
  .action(async (name?: string, url?: string) => {
    const { podsAdd } = await import("./commands/pods.js");
    await podsAdd(name, url);
  });

pods
  .command("use <name>")
  .description("Switch active pod and propagate credentials to all agent surfaces")
  .option("--surface <surface>", "Only switch this surface (raycast, claude-code, claude-desktop, cursor, openclaw)")
  .action(async (name: string, opts: { surface?: string }) => {
    const { podsUse } = await import("./commands/pods.js");
    await podsUse(name, { surface: opts.surface as import("./commands/pods.js").SurfaceName | undefined });
  });

pods
  .command("remove <name>")
  .alias("rm")
  .description("Remove a pod profile")
  .action(async (name: string) => {
    const { podsRemove } = await import("./commands/pods.js");
    await podsRemove(name);
  });

program
  .command("security-audit")
  .alias("audit")
  .description("Check OpenClaw configuration for known vulnerabilities")
  .option("--fix", "Auto-fix issues where possible")
  .option("--json", "Output results as JSON")
  .action(async (opts) => {
    const { securityAudit } = await import("./commands/security-audit.js");
    await securityAudit(opts);
  });

program
  .command("status")
  .description("Show Synap pod and OpenClaw health status")
  .action(async () => {
    const { status } = await import("./commands/status.js");
    await status();
  });

program
  .command("update")
  .description("Update synap skill and check for CLI updates")
  .option("--server", "Also trigger a Dokploy redeploy of the control-plane")
  .option("--all", "Trigger a Dokploy redeploy of all registered services")
  .action(async (opts: { server?: boolean; all?: boolean }) => {
    const { update } = await import("./commands/update.js");
    await update(opts);
  });

const oc = program
  .command("openclaw")
  .alias("oc")
  .description("Access, configure, and connect OpenClaw");

oc
  .command("status", { isDefault: true })
  .description("Overview: gateway status, AI key, skill, how to connect")
  .action(async () => {
    const { openclawOverview } = await import("./commands/openclaw.js");
    await openclawOverview();
  });

oc
  .command("dashboard")
  .alias("dash")
  .description("Open the OpenClaw web UI (or print SSH tunnel instructions for remote servers)")
  .action(async () => {
    const { openclawDashboard } = await import("./commands/openclaw.js");
    openclawDashboard();
  });

oc
  .command("connect")
  .description("Show MCP client configs for Claude Desktop, Cursor, Windsurf")
  .option("--client <name>", "Specific client: claude, cursor, windsurf")
  .action(async (opts: { client?: string }) => {
    const { openclawConnect } = await import("./commands/openclaw.js");
    await openclawConnect(opts);
  });

oc
  .command("configure")
  .alias("config")
  .description("Set AI provider API key via OpenClaw's own config system")
  .option("-i, --interactive", "Run OpenClaw's own interactive wizard")
  .option("--provider <name>", "Provider: anthropic | openai | google")
  .option("--key <key>", "API key (non-interactive)")
  .option("--model <id>", "Model id (e.g. anthropic/claude-sonnet-4-6)")
  .option("--show", "Print the current config")
  .action(
    async (opts: {
      interactive?: boolean;
      provider?: "anthropic" | "openai" | "google";
      key?: string;
      model?: string;
      show?: boolean;
    }) => {
      const { openclawConfigure } = await import("./commands/openclaw.js");
      await openclawConfigure(opts);
    }
  );

oc
  .command("token")
  .description("Print the OpenClaw gateway token (for MCP clients)")
  .option("--copy", "Copy to clipboard instead of printing")
  .option("--for <client>", "Print a pre-filled MCP config (claude, cursor, windsurf)")
  .action(async (opts: { copy?: boolean; for?: string }) => {
    const { openclawToken } = await import("./commands/openclaw.js");
    openclawToken(opts);
  });

oc
  .command("doctor")
  .description("Run OpenClaw's diagnostic (openclaw doctor)")
  .option("--fix", "Auto-fix detected issues")
  .action(async (opts: { fix?: boolean }) => {
    const { openclawDoctor } = await import("./commands/openclaw.js");
    openclawDoctor(opts);
  });

oc
  .command("logs")
  .description("Tail OpenClaw container logs")
  .option("-n, --lines <n>", "Number of log lines", "50")
  .option("-f, --follow", "Follow log output")
  .action(async (opts: { lines?: string; follow?: boolean }) => {
    const { openclawLogs } = await import("./commands/openclaw.js");
    openclawLogs({ lines: opts.lines ? parseInt(opts.lines, 10) : 50, follow: opts.follow });
  });

oc
  .command("restart")
  .description("Restart the OpenClaw container")
  .action(async () => {
    const { openclawRestart } = await import("./commands/openclaw.js");
    await openclawRestart();
  });

oc
  .command("setup-domain")
  .description("Expose the OpenClaw dashboard via a public HTTPS subdomain (Caddy)")
  .action(async () => {
    const { openclawSetupDomain } = await import("./commands/openclaw.js");
    openclawSetupDomain();
  });

oc
  .command("connections")
  .alias("conn")
  .description("Unified view: AI providers, skills, channels, MCP clients")
  .action(async () => {
    const { openclawConnections } = await import("./commands/openclaw.js");
    openclawConnections();
  });

oc
  .command("open [section]")
  .description("Open the OpenClaw dashboard (optionally at a section: channels, skills, config, chat, sessions, logs)")
  .action(async (section?: string) => {
    const { openclawOpen } = await import("./commands/openclaw.js");
    openclawOpen(section);
  });

// ─── infra ────────────────────────────────────────────────────────────────────

const infra = program
  .command("infra")
  .description("Manage servers and deployments via Dokploy");

infra
  .command("status", { isDefault: true })
  .description("Overview: all servers and services status")
  .action(async () => {
    const { infraStatus } = await import("./commands/infra.js");
    await infraStatus();
  });

infra
  .command("deploy <app>")
  .description("Trigger a redeploy for a named service")
  .action(async (app: string) => {
    const { infraDeploy } = await import("./commands/infra.js");
    await infraDeploy(app);
  });

infra
  .command("logs <app>")
  .description("Tail logs for a service")
  .option("-n, --lines <n>", "Number of log lines", "100")
  .option("-f, --follow", "Follow log output")
  .action(async (app: string, opts: { lines?: string; follow?: boolean }) => {
    const { infraLogs } = await import("./commands/infra.js");
    await infraLogs(app, { lines: opts.lines ? parseInt(opts.lines, 10) : 100, follow: opts.follow });
  });

infra
  .command("sync")
  .description("Pull Dokploy state into Synap entities (server + deployment profiles)")
  .option("--pod-url <url>", "Synap pod URL", process.env.SYNAP_POD_URL)
  .option("--api-key <key>", "Hub Protocol API key", process.env.SYNAP_API_KEY)
  .action(async (opts: { podUrl?: string; apiKey?: string }) => {
    if (!opts.podUrl || !opts.apiKey) {
      console.error("  --pod-url and --api-key are required (or set SYNAP_POD_URL / SYNAP_API_KEY)");
      process.exit(1);
    }
    const { infraSync } = await import("./commands/infra.js");
    await infraSync(opts.podUrl, opts.apiKey);
  });

infra
  .command("open")
  .description("Open the Dokploy dashboard in your browser")
  .action(async () => {
    const { infraOpen } = await import("./commands/infra.js");
    infraOpen();
  });

program
  .command("switch [name]")
  .description("Switch active pod (interactive picker if no name given)")
  .action(async (name?: string) => {
    const { podsSwitch } = await import("./commands/pods.js");
    await podsSwitch(name);
  });

program
  .command("connections")
  .alias("conn")
  .description("Show which pod each agent surface (Claude Code, Desktop, Cursor, OpenClaw) is connected to")
  .action(async () => {
    const { connections } = await import("./commands/connections.js");
    await connections();
  });

program
  .command("login")
  .description("Sign in to your Synap account via browser")
  .option("--token <token>", "Provide a Synap API token directly (for headless/server use)")
  .action(async (opts: { token?: string }) => {
    const chalk = (await import("chalk")).default;
    const ora = (await import("ora")).default;
    const { login, loginWithToken, isLoggedIn } = await import("./lib/auth.js");

    // Headless path: token provided directly
    if (opts.token) {
      const spinner = ora("Validating token...").start();
      const creds = await loginWithToken(opts.token);
      if (creds) {
        spinner.succeed(`Authenticated as ${creds.email}`);
      } else {
        spinner.fail("Token is invalid or expired. Get a token at https://synap.live/account/tokens");
      }
      return;
    }

    const status = await isLoggedIn();
    if (status.valid) {
      console.log(chalk.green(`  Already logged in as ${status.email}`));
      return;
    }

    console.log(chalk.blue("  Opening browser to sign in..."));
    const spinner = ora("Waiting for authentication...").start();

    const creds = await login();
    if (creds) {
      spinner.succeed(`Authenticated as ${creds.email}`);
    } else {
      spinner.fail("Authentication timed out. Try: synap login --token <token>");
      console.log(chalk.dim("  Get a token at: https://synap.live/account/tokens"));
    }
  });

program
  .command("logout")
  .description("Sign out and remove stored credentials")
  .action(async () => {
    const chalk = (await import("chalk")).default;
    const { logout, getStoredToken } = await import("./lib/auth.js");

    const creds = getStoredToken();
    logout();

    if (creds) {
      console.log(chalk.green(`  Logged out (was: ${creds.email})`));
    } else {
      console.log(chalk.dim("  Not logged in"));
    }
  });

// ─── orient ───────────────────────────────────────────────────────────────────

program
  .command("orient")
  .description("Show pod orientation: who you are, workspaces, profiles, and entity counts")
  .option("--json", "Output as JSON")
  .option("--pod-url <url>", "Pod URL override")
  .option("--api-key <key>", "API key override")
  .action(async (opts) => {
    const { orient } = await import("./commands/data.js");
    await orient(opts);
  });

// ─── use ──────────────────────────────────────────────────────────────────────

program
  .command("use <workspace>")
  .description("Set the active workspace (by ID or name) — persisted to ~/.synap/config.json")
  .option("--json", "Output as JSON")
  .option("--pod-url <url>", "Pod URL override")
  .option("--api-key <key>", "API key override")
  .action(async (workspace: string, opts) => {
    const { useWorkspace } = await import("./commands/data.js");
    await useWorkspace(workspace, opts);
  });

// ─── search ───────────────────────────────────────────────────────────────────

program
  .command("search <query>")
  .description("Search entities, documents, and views (Typesense-powered)")
  .option("--workspace <id>", "Scope to a specific workspace")
  .option("--type <type>", "Filter: entity | doc | view")
  .option("--limit <n>", "Max results", "20")
  .option("--json", "Output as JSON")
  .option("--pod-url <url>", "Pod URL override")
  .option("--api-key <key>", "API key override")
  .action(async (query: string, opts) => {
    const { searchData } = await import("./commands/data.js");
    await searchData(query, opts);
  });

// ─── remember / recall ────────────────────────────────────────────────────────

program
  .command("remember <text>")
  .description("Store a memory on the pod")
  .option("--context <entity-id>", "Link memory to an entity")
  .option("--json", "Output as JSON")
  .option("--pod-url <url>", "Pod URL override")
  .option("--api-key <key>", "API key override")
  .action(async (text: string, opts) => {
    const { rememberData } = await import("./commands/data.js");
    await rememberData(text, opts);
  });

program
  .command("recall <query>")
  .description("Retrieve memories from the pod (add --structured for knowledge entities)")
  .option("--structured", "Search structured knowledge entities instead of episodic memory")
  .option("--type <type>", "Filter by entry type: gotcha|lesson|decision|reference (--structured only)")
  .option("--tags <csv>", "Filter by tags e.g. repo:synap-backend (--structured only)")
  .option("--workspace <id>", "Workspace to search (--structured only, defaults to active)")
  .option("--limit <n>", "Max results", "10")
  .option("--json", "Output as JSON")
  .option("--pod-url <url>", "Pod URL override")
  .option("--api-key <key>", "API key override")
  .action(async (query: string, opts) => {
    if (opts.structured) {
      const { recallStructured } = await import("./commands/knowledge.js");
      await recallStructured(query, opts);
    } else {
      const { recallData } = await import("./commands/data.js");
      await recallData(query, opts);
    }
  });

// ─── capture ──────────────────────────────────────────────────────────────────
// Uses the active pod + workspace from config (set via `synap pods use` /
// `synap use` / `synap workspace provision-agent`). No auth flags needed.

program
  .command("capture")
  .description("Capture a structured knowledge entry into the active agent workspace")
  .requiredOption("--type <type>", "Entry type: gotcha|lesson|decision|reference")
  .requiredOption("--claim <text>", "One-line assertion")
  .option("--why <text>", "Reasoning or context")
  .option("--evidence <text>", "Supporting file path, URL, or code snippet")
  .option("--tags <csv>", "Comma-separated tags e.g. repo:synap-backend,layer:migrations")
  .option("--json", "Output as JSON")
  .action(async (opts) => {
    const { captureKnowledge } = await import("./commands/knowledge.js");
    await captureKnowledge(opts);
  });

program
  .command("discover")
  .description("Runtime discovery: entity profiles with property schemas + CLI command tree")
  .option("--json", "Output as JSON (default: human-readable)")
  .option("--profiles", "Show only profiles (use with --json for machine-readable schema)")
  .option("--commands", "Show only the command tree")
  .option("--workspace <id>", "Workspace to query (defaults to active workspace)")
  .action(async (opts) => {
    const { discover } = await import("./commands/discover.js");
    await discover(opts);
  });

// ─── workspace ────────────────────────────────────────────────────────────────
// Context setup commands. Run once to configure the session — all subsequent
// commands (capture, recall, search, …) inherit the active pod + workspace.

const workspace = program
  .command("workspace")
  .description("Set up and switch workspace context (run once — persisted to ~/.synap/config.json)");

workspace
  .command("provision-agent")
  .description("Provision an agent-owned workspace and set it as active (idempotent)")
  .option("--agent-user-id <uuid>", "Agent user ID (defaults to caller)")
  .option("--name <name>", "Workspace display name override")
  .option("--no-use", "Do not set as active workspace after provisioning")
  .option("--json", "Output as JSON")
  .action(async (opts) => {
    const { provisionAgentWorkspace } = await import("./commands/knowledge.js");
    await provisionAgentWorkspace({ ...opts, agentUserId: opts.agentUserId });
  });

// ─── list ─────────────────────────────────────────────────────────────────────

const list = program
  .command("list")
  .description("List pod resources");

list
  .command("workspaces")
  .description("List workspaces you belong to")
  .option("--json", "Output as JSON")
  .option("--pod-url <url>", "Pod URL override")
  .option("--api-key <key>", "API key override")
  .action(async (opts) => {
    const { listWorkspaces } = await import("./commands/data.js");
    await listWorkspaces(opts);
  });

list
  .command("profiles")
  .description("List entity profile types available in a workspace")
  .option("--workspace <id>", "Workspace (defaults to active)")
  .option("--json", "Output as JSON")
  .action(async (opts) => {
    const { listProfiles } = await import("./commands/data.js");
    await listProfiles(opts);
  });

list
  .command("entities")
  .description("List entities on the pod")
  .option("--workspace <id>", "Scope to a workspace (omit for pod-wide)")
  .option("--profile <slug>", "Filter by profile slug (e.g. person, task, note)")
  .option("--limit <n>", "Max results", "50")
  .option("--json", "Output as JSON")
  .option("--pod-url <url>", "Pod URL override")
  .option("--api-key <key>", "API key override")
  .action(async (opts) => {
    const { listEntities } = await import("./commands/data.js");
    await listEntities(opts);
  });

// ─── get ──────────────────────────────────────────────────────────────────────

const get = program
  .command("get")
  .description("Get a single pod resource");

get
  .command("entity <id>")
  .description("Get an entity by ID")
  .option("--workspace <id>", "Workspace context")
  .option("--json", "Output as JSON")
  .option("--pod-url <url>", "Pod URL override")
  .option("--api-key <key>", "API key override")
  .action(async (id: string, opts) => {
    const { getEntity } = await import("./commands/data.js");
    await getEntity(id, opts);
  });

// ─── create ───────────────────────────────────────────────────────────────────

const create = program
  .command("create")
  .description("Create pod resources");

create
  .command("entity")
  .description("Create a new entity")
  .requiredOption("--profile <slug>", "Profile slug (e.g. person, note, task)")
  .requiredOption("--name <name>", "Entity name")
  .option("--workspace <id>", "Create in this workspace")
  .option("--props <json>", "Properties as JSON string", "{}")
  .option("--json", "Output as JSON")
  .option("--pod-url <url>", "Pod URL override")
  .option("--api-key <key>", "API key override")
  .action(async (opts) => {
    const { createEntity } = await import("./commands/data.js");
    await createEntity(opts);
  });

create
  .command("relation")
  .description("Create a typed relation between two entities")
  .requiredOption("--source <id>", "Source entity ID")
  .requiredOption("--target <id>", "Target entity ID")
  .requiredOption("--type <type>", "Relation type (e.g. extends, part_of, implements, governs, related_to)")
  .option("--workspace <id>", "Workspace context")
  .option("--json", "Output as JSON")
  .option("--pod-url <url>", "Pod URL override")
  .option("--api-key <key>", "API key override")
  .action(async (opts) => {
    const { createRelation } = await import("./commands/data.js");
    await createRelation(opts);
  });

// ─── set ──────────────────────────────────────────────────────────────────────

const set = program
  .command("set")
  .description("Update pod resources");

set
  .command("entity <id>")
  .description("Update entity properties")
  .requiredOption("--props <json>", "Properties as JSON string")
  .option("--json", "Output as JSON")
  .option("--pod-url <url>", "Pod URL override")
  .option("--api-key <key>", "API key override")
  .action(async (id: string, opts) => {
    const { updateEntity } = await import("./commands/data.js");
    await updateEntity(id, opts);
  });

// ─── agents ───────────────────────────────────────────────────────────────────

const agents = program
  .command("agents")
  .description("Manage named agent identities (different keys, different pod access)");

agents
  .command("list", { isDefault: true })
  .description("List configured agent identities")
  .option("--json", "Output as JSON")
  .action(async (opts: { json?: boolean }) => {
    const { agentsList } = await import("./commands/agents.js");
    agentsList(opts);
  });

agents
  .command("add")
  .description("Register a pre-existing agent credential locally. Use `synap agents create` for new agents.")
  .option("--name <name>", "Agent name (e.g. researcher, builder)")
  .option("--api-key <key>", "Hub Protocol API key for this agent")
  .option("--pod <name>", "Pod profile to link (default: active pod)")
  .option("--workspace <id>", "Default workspace for this agent")
  .option("--label <label>", "Human-readable description")
  .action(async (opts) => {
    const { agentsAdd } = await import("./commands/agents.js");
    await agentsAdd(opts);
  });

agents
  .command("create")
  .description("Create a new agent on the pod (template-aware). Replaces `add` for new agents.")
  .option("--template <tmpl>", "Agent template: twin | assistant | custom (default: custom)")
  .option("--name <name>", "Agent name (not needed for twin — auto-generated)")
  .option("--type <type>", "Agent type string for custom agents (default: matches template)")
  .option("--role <role>", "Workspace role: admin | editor | viewer (default: editor; twin auto-inherits)")
  .option("--workspace <id>", "Workspace ID to add the agent to (auto-detected if omitted)")
  .option("--pod <name>", "Pod profile to use (default: active pod)")
  .action(async (opts: { template?: string; name?: string; type?: string; role?: string; workspace?: string; pod?: string }) => {
    const { agentsCreate } = await import("./commands/agents.js");
    await agentsCreate(opts);
  });

agents
  .command("rotate-key <name-or-id>")
  .description("Rotate the Hub Protocol API key for an agent (invalidates the current key)")
  .action(async (nameOrId: string) => {
    const { agentsRotateKey } = await import("./commands/agents.js");
    await agentsRotateKey(nameOrId);
  });

agents
  .command("remove <name>")
  .alias("rm")
  .description("Remove a named agent identity")
  .action(async (name: string) => {
    const { agentsRemove } = await import("./commands/agents.js");
    agentsRemove(name);
  });

agents
  .command("info <name>")
  .description("Show details for a named agent identity")
  .action(async (name: string) => {
    const { agentsInfo } = await import("./commands/agents.js");
    agentsInfo(name);
  });

program.parse();
