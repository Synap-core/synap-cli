#!/usr/bin/env node
/**
 * @synap/cli — Connect AI agents to your Synap data pod
 *
 * Usage:
 *   npx @synap/cli init              Full setup: detect, harden, connect, install
 *   npx @synap/cli connect           Connect an AI surface to a Synap pod
 *   npx @synap/cli status            Show pod health and API status
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
    "Synap CLI — connect AI agents to your data pod"
  )
  .version(version)
  .showSuggestionAfterError(true);

program
  .command("init")
  .description(
    "Full setup: connect to a Synap pod and install the skill"
  )
  .option("--pod-url <url>", "Synap pod URL (skip pod choice prompt)")
  .option("--api-key <key>", "Hub Protocol API key (skip key generation)")
  .option("--skip-is", "Skip Intelligence Service provider setup")
  .action(async (opts) => {
    const { init } = await import("./commands/init.js");
    await init(opts);
  });

// ── launch — orchestrate a complete company OS from templates ──────────────────
const launch = program
  .command("launch")
  .description("Provision a complete workspace setup from templates");
launch
  .command("agent-os")
  .description("Launch a company OS — project + domain workspaces, interactively")
  .option("--json", "Output as JSON")
  .option("--pod-url <url>", "Pod URL override")
  .option("--api-key <key>", "API key override")
  .action(async (opts) => {
    const { launchAgentOs } = await import("./commands/launch.js");
    await launchAgentOs(opts);
  });

// Hidden: one-shot Discord↔Synap bridge provisioning (dogfood/dev convenience).
program
  .command("bridge-setup", { hidden: true })
  .description("(hidden) One-shot Discord↔Synap bridge provisioning")
  .option("--client-id <id>", "Discord application (client) id — prints the invite URL")
  .option("--bot-token <token>", "Discord bot token — provisioned into the pod vault")
  .option("--guild-id <id>", "Discord server (guild) id — written to the bridge .env")
  .option("--bridge-dir <path>", "Path to the telegram-discord-bridge repo")
  .option("--workspace-id <uuid>", "Target workspace (default: pod profile's)")
  .option("--proactive-channel <id>", "Discord channel id for the agent's proactive posts")
  .option("--enable-react", "Turn on ✅-react capture")
  .option("--pod <name>", "Pod profile to connect the bridge to (default: prompt)")
  .option("--governance <mode>", "Agent governance preset: safe | normal | crazy (default: prompt)")
  .option("--pod-url <url>", "Synap pod URL (override)")
  .option("--api-key <key>", "Hub Protocol API key (override)")
  .action(async (opts) => {
    const { bridgeSetup } = await import("./commands/bridge-setup.js");
    await bridgeSetup(opts);
  });

program
  .command("connect")
  .description(
    "Connect an AI surface (Claude Code, Claude Desktop, Cursor, Raycast) to a Synap pod"
  )
  .option(
    "--target <name>",
    "AI surface: claude-code | claude-desktop | cursor | raycast | custom"
  )
  .option("--pod-url <url>", "Synap pod URL")
  .option("--api-key <key>", "Hub Protocol API key")
  .option("--name <name>", "Pod profile name to save credentials under (default: 'default')")
  .option("--list", "List supported targets and exit")
  .option(
    "--manual-key",
    "Skip the browser approval flow and paste a key (or provisioning token)"
  )
  .option("--pin-workspace <id>", "Pin the connection to one workspace (default: pod-wide lens)")
  .option("--pin-project <id>", "Pin the connection to one project (composable with --pin-workspace)")
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
  .option("--surface <surface>", "Only switch this surface (raycast, claude-code, claude-desktop, cursor)")
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

pods
  .command("reconnect [name]")
  .description("Re-authenticate a saved pod (refresh API key without re-entering the URL)")
  .action(async (name?: string) => {
    const { podsReconnect } = await import("./commands/pods.js");
    await podsReconnect(name);
  });

program
  .command("status")
  .description("Show Synap pod health and API status")
  .action(async () => {
    const { status } = await import("./commands/status.js");
    await status();
  });

// Hidden: compact ANSI line for the Claude Code statusLine (reads stdin JSON).
program
  .command("statusline", { hidden: true })
  .description("(internal) Compact ANSI status line for Claude Code")
  .option("--refresh", "Refresh the pod cache (run detached in the background)")
  .action(async (opts: { refresh?: boolean }) => {
    const { statusline } = await import("./commands/statusline.js");
    await statusline({ refresh: opts.refresh });
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
  .description("Show which pod each agent surface (Claude Code, Desktop, Cursor, Raycast) is connected to")
  .action(async () => {
    const { connections } = await import("./commands/connections.js");
    await connections();
  });

// ─── mcp ────────────────────────────────────────────────────────────────────
// The MCP front door: point any AI client at the pod's /mcp server.
const mcp = program
  .command("mcp")
  .description("Connect any AI client to your pod's MCP server (the ambient tool layer)");

mcp
  .command("url")
  .description("Print a ready-to-paste MCP connection (URL + key + snippets) for UI clients like ChatGPT")
  .option("--client <name>", "Name the dedicated agent key after the target client")
  .option("--workspace <id>", "Scope to a specific workspace (omit for pod-wide)")
  .option("--project <id>", "Focus the agent on a project (narrows every tool call; orthogonal to --workspace)")
  .option("--json", "Output as JSON")
  .option("--pod-url <url>", "Pod URL override")
  .option("--api-key <key>", "API key override")
  .action(async (opts) => {
    const { mcpUrl } = await import("./commands/mcp.js");
    await mcpUrl(opts);
  });

mcp
  .command("verify")
  .description("Health-check: is the pod's /mcp endpoint reachable and the key valid?")
  .option("--workspace <id>", "Scope to a specific workspace")
  .option("--json", "Output as JSON")
  .option("--pod-url <url>", "Pod URL override")
  .option("--api-key <key>", "API key override")
  .action(async (opts) => {
    const { mcpVerify } = await import("./commands/mcp.js");
    await mcpVerify(opts);
  });

mcp
  .command("connect [client]")
  .description("Write the MCP config for a file-configurable client (Claude Code, Cursor, Desktop, …) — alias of `synap connect`")
  .option("--name <name>", "Pod profile to connect")
  .action(async (client: string | undefined, opts: { name?: string }) => {
    const { connect } = await import("./commands/connect.js");
    await connect({ target: client, name: opts.name });
  });

program
  .command("login")
  .description("Connect to a Synap pod (self-hosted or managed)")
  .option("--reconnect [name]", "Re-authenticate a saved pod without re-entering its URL")
  .action(async (opts: { reconnect?: string | boolean }) => {
    const chalk = (await import("chalk")).default;
    const { listPodProfiles } = await import("./lib/pod.js");

    // --reconnect: delegate to reconnect flow
    if (opts.reconnect !== undefined) {
      const name = typeof opts.reconnect === "string" ? opts.reconnect : undefined;
      const { podsReconnect } = await import("./commands/pods.js");
      await podsReconnect(name);
      return;
    }

    const profiles = listPodProfiles();

    if (profiles.length === 0) {
      // No pod saved — guide to pods add
      console.log(chalk.dim("  No pod configured yet."));
      console.log(chalk.blue("  Adding a new pod...\n"));
      const { podsAdd } = await import("./commands/pods.js");
      await podsAdd();
      return;
    }

    // Already have pods — show status and offer reconnect if any are unreachable
    const { checkPodHealth } = await import("./lib/pod.js");
    const ora = (await import("ora")).default;
    const spinner = ora("Checking pods + credentials...").start();
    const checks = await Promise.all(
      profiles.map(async (p) => {
        const h = await checkPodHealth(p.config.podUrl).catch(() => ({ healthy: false }));
        // A pod can be HEALTHY (public /health) while the saved key is REVOKED.
        // Validate the actual credential too — otherwise a dead key looks "ok"
        // and the user gets cryptic 401s downstream (the connect trap).
        let keyValid = false;
        if (h.healthy && p.config.hubApiKey) {
          try {
            const res = await fetch(
              `${p.config.podUrl.replace(/\/$/, "")}/api/hub/auth/status`,
              {
                headers: { Authorization: `Bearer ${p.config.hubApiKey}` },
                signal: AbortSignal.timeout(6000),
              }
            );
            keyValid = res.ok;
          } catch {
            keyValid = false;
          }
        }
        return { ...p, healthy: h.healthy, keyValid };
      })
    );
    spinner.stop();

    console.log("\n  Configured pods:\n");
    for (const p of checks) {
      const active = p.active ? chalk.green(" ● ") : "   ";
      const status = !p.healthy
        ? chalk.red("unreachable")
        : p.keyValid
          ? chalk.green("ok")
          : chalk.yellow("key expired");
      console.log(`  ${active}${chalk.bold(p.name.padEnd(14))} ${status}  ${chalk.dim(p.config.podUrl)}`);
    }
    console.log();

    // Anything that won't authenticate — unreachable OR a revoked/expired key.
    const needsReconnect = checks.filter((p) => !p.healthy || !p.keyValid);
    if (needsReconnect.length > 0) {
      console.log(chalk.yellow(`  ${needsReconnect.length} pod(s) need re-authentication. Refresh credentials:`));
      for (const p of needsReconnect) {
        console.log(chalk.dim(`    synap login --reconnect ${p.name}`));
      }
      console.log();
    } else {
      console.log(chalk.green("  All pods healthy."));
      const active = checks.find((p) => p.active);
      if (active) console.log(chalk.dim(`  Active: ${active.name} (${active.config.podUrl})`));
      console.log();
      console.log(chalk.dim("  synap pods use <name>    — switch active pod"));
      console.log(chalk.dim("  synap pods add           — connect another pod"));
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

// ─── project / lens (per-Claude-session scoping) ──────────────────────────────
const project = program
  .command("project")
  .description("Focus this Claude session on a project (cross-cutting lens)");
project
  .command("use <projectId>")
  .description("Scope this session to a project — narrows scoped calls + statusline")
  .option("--json", "Output as JSON")
  .option("--pod-url <url>", "Pod URL override")
  .option("--api-key <key>", "API key override")
  .action(async (projectId: string, opts) => {
    const { useProject } = await import("./commands/lens.js");
    await useProject(projectId, opts);
  });
project
  .command("clear")
  .description("Clear this session's project focus")
  .option("--json", "Output as JSON")
  .action(async (opts) => {
    const { clearProject } = await import("./commands/lens.js");
    await clearProject(opts);
  });

program
  .command("lens")
  .description("Show this Claude session's lens (workspace + project + focus session)")
  .option("--json", "Output as JSON")
  .action(async (opts) => {
    const { showLens } = await import("./commands/lens.js");
    await showLens(opts);
  });

// ─── note ─────────────────────────────────────────────────────────────────────
// Quick `note` entity. The one canonical READ verb is `ask`; the one canonical
// structured-WRITE verb is `capture`. (search / recall / remember removed — they
// were redundant doors `ask`/`capture`/`note` already cover.)

program
  .command("note <text>")
  .description("Quick freeform note → note entity (for structured learnings use `synap capture`)")
  .option("--context <entity-id>", "Link this note to an entity")
  .option("--json", "Output as JSON")
  .option("--pod-url <url>", "Pod URL override")
  .option("--api-key <key>", "API key override")
  .action(async (text: string, opts) => {
    const { noteData } = await import("./commands/data.js");
    await noteData(text, opts);
  });

// ─── ask (unified knowledge access) ─────────────────────────────────────────────
// The ONE read verb. Routes to the right substrate(s) — semantic (entities),
// procedural (how-to docs), episodic (captures) — and returns a glass-box answer.

program
  .command("ask <query>")
  .description("Ask your pod anything — routes to the right knowledge substrate(s) and shows which answered")
  .option("--workspace <id>", "Scope to a specific workspace (omit for pod-wide)")
  .option("--limit <n>", "Max results per substrate", "10")
  .option("--json", "Output as JSON")
  .option("--session", "Scope retrieval to the active session context")
  .option("--pod-url <url>", "Pod URL override")
  .option("--api-key <key>", "API key override")
  .action(async (query: string, opts) => {
    const { askKnowledge } = await import("./commands/data.js");
    await askKnowledge(query, opts);
  });

// ─── capture ──────────────────────────────────────────────────────────────────
// Uses the active pod + workspace from config (set via `synap pods use` /
// `synap use` / `synap workspace provision-agent`). No auth flags needed.

program
  .command("capture [text]")
  .description("Capture knowledge: smart `capture \"<free text>\"` (AI structures it) OR typed `capture --type gotcha --claim \"…\"`")
  .option("--type <type>", "Typed mode: gotcha|lesson|decision|reference")
  .option("--claim <text>", "Typed mode: one-line assertion (required with --type)")
  .option("--why <text>", "Reasoning or context")
  .option("--evidence <text>", "Supporting file path, URL, or code snippet")
  .option("--tags <csv>", "Comma-separated tags e.g. repo:synap-backend,layer:migrations")
  .option("--session", "Link captured knowledge to the active session")
  .option("--global", "GLOBAL lane: pod-wide cross-cutting runbook (→ knowledge_keys), visible in every workspace")
  .option("--key <ns:slug>", "Stable key for a --global runbook (derived from --type + --claim if omitted)")
  .option("--team", "Write to the first product workspace instead of the active workspace")
  .option("--workspace <id>", "Explicit workspace override")
  .option("--yes", "Skip the y/N confirmation prompt (smart mode)")
  .option("--json", "Output as JSON")
  .action(async (text, opts) => {
    const { captureKnowledge } = await import("./commands/knowledge.js");
    await captureKnowledge({ ...opts, text });
  });

program
  .command("subscribe")
  .description("Stream pod events as NDJSON (long-poll)")
  .option("--event <pattern>", "Filter by event type pattern (e.g. proposal.*)")
  .option("--limit <n>", "Events per poll", "20")
  .option("--json", "NDJSON output")
  .option("--pod-url <url>")
  .option("--api-key <key>")
  .action(async (opts) => {
    const { subscribeEvents } = await import("./commands/subscribe.js");
    await subscribeEvents(opts);
  });

program
  .command("home")
  .description("Show the active workspace's home bento layout (what cells are on screen)")
  .option("--workspace <id>", "Workspace to read (defaults to active workspace)")
  .option("--json", "Output as JSON")
  .option("--pod-url <url>", "Pod URL override")
  .option("--api-key <key>", "API key override")
  .action(async (opts) => {
    const { showHome } = await import("./commands/home.js");
    await showHome(opts);
  });

program
  .command("context")
  .description("Session-start context: knowledge, proposals, tasks, active sessions")
  .option("--repo <name>", "Filter knowledge by repo tag")
  .option("--limit <n>", "Entries per section", "5")
  .option("--json", "NDJSON output")
  .option("--workspace <id>", "Override workspace")
  .option("--pod-url <url>")
  .option("--api-key <key>")
  .action(async (opts) => {
    const { contextSummary } = await import("./commands/context.js");
    await contextSummary(opts);
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
  .command("views")
  .description("List views in a workspace (whiteboard, kanban, bento, …)")
  .option("--type <type>", "Filter by view type (e.g. whiteboard, kanban, calendar)")
  .option("--workspace <id>", "Workspace (defaults to active)")
  .option("--json", "Output as JSON")
  .option("--pod-url <url>", "Pod URL override")
  .option("--api-key <key>", "API key override")
  .action(async (opts) => {
    const { viewList } = await import("./commands/view.js");
    await viewList(opts);
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

// ─── show ─────────────────────────────────────────────────────────────────────
// Entity detail + its relations — one command to understand any node in the graph.

program
  .command("show <id>")
  .description("Show an entity with its properties and all linked relations")
  .option("--json", "Output as JSON")
  .option("--pod-url <url>", "Pod URL override")
  .option("--api-key <key>", "API key override")
  .action(async (id: string, opts) => {
    const { showEntity } = await import("./commands/data-extra.js");
    await showEntity(id, opts);
  });

// ─── proposals ────────────────────────────────────────────────────────────────
// Governance inbox — pending proposals attributed to this agent.

const proposals = program
  .command("proposals")
  .description("Review and act on governance proposals");

proposals
  .command("list", { isDefault: true })
  .description("List pending governance proposals for this agent")
  .option("--workspace <id>", "Scope to a specific workspace")
  .option("--limit <n>", "Max results", "20")
  .option("--json", "Output as JSON")
  .option("--pod-url <url>", "Pod URL override")
  .option("--api-key <key>", "API key override")
  .action(async (opts) => {
    const { listProposals } = await import("./commands/data-extra.js");
    await listProposals(opts);
  });

proposals
  .command("approve <id>")
  .description("Approve a pending proposal")
  .option("--reason <text>", "Optional approval note")
  .option("--json", "Output as JSON")
  .option("--pod-url <url>", "Pod URL override")
  .option("--api-key <key>", "API key override")
  .action(async (id: string, opts) => {
    const { approveProposal } = await import("./commands/proposals-actions.js");
    await approveProposal(id, opts);
  });

proposals
  .command("reject <id>")
  .description("Reject a pending proposal")
  .option("--reason <text>", "Rejection reason")
  .option("--json", "Output as JSON")
  .option("--pod-url <url>", "Pod URL override")
  .option("--api-key <key>", "API key override")
  .action(async (id: string, opts) => {
    const { rejectProposal } = await import("./commands/proposals-actions.js");
    await rejectProposal(id, opts);
  });

// ─── session ──────────────────────────────────────────────────────────────────
// Focus sessions — goal-bound work rooms tracked on the pod.
// AI agents: use start_session to begin, update_session to report progress,
// update_session({status:"closed"}) to finish. Sessions link goals, context,
// plans, execution logs, and verification reports together.

const session = program
  .command("session")
  .description("Manage focus sessions (goal-bound AI work rooms)");

session
  .command("start")
  .description("Start a new focus session and return its ID")
  .requiredOption("--goal <text>", "What this session is working toward")
  .option("--workspace <id>", "Workspace that owns the session")
  .option("--task-id <id>", "Link session to an existing task entity")
  .option("--json", "Output as JSON")
  .option("--pod-url <url>", "Pod URL override")
  .option("--api-key <key>", "API key override")
  .action(async (opts) => {
    const { startSession } = await import("./commands/sessions.js");
    await startSession(opts);
  });

session
  .command("list", { isDefault: true })
  .description("List focus sessions in the active workspace")
  .option("--workspace <id>", "Scope to a specific workspace")
  .option("--status <status>", "Filter by status: active | paused | closed")
  .option("--limit <n>", "Max results", "20")
  .option("--json", "Output as JSON")
  .option("--pod-url <url>", "Pod URL override")
  .option("--api-key <key>", "API key override")
  .action(async (opts) => {
    const { listSessions } = await import("./commands/sessions.js");
    await listSessions(opts);
  });

session
  .command("get <id>")
  .description("Show details for a specific focus session")
  .option("--workspace <id>", "Workspace that owns the session (required for scoped fetch)")
  .option("--json", "Output as JSON")
  .option("--pod-url <url>", "Pod URL override")
  .option("--api-key <key>", "API key override")
  .action(async (id: string, opts) => {
    const { getSession } = await import("./commands/sessions.js");
    await getSession(id, opts);
  });

session
  .command("update <id>")
  .description("Update progress or status of a focus session")
  .requiredOption("--workspace <id>", "Workspace that owns the session")
  .option("--progress <0-100>", "Progress percentage")
  .option("--status <status>", "New status: active | paused")
  .option("--goal <text>", "Revised goal")
  .option("--json", "Output as JSON")
  .option("--pod-url <url>", "Pod URL override")
  .option("--api-key <key>", "API key override")
  .action(async (id: string, opts) => {
    const { updateSession } = await import("./commands/sessions.js");
    await updateSession(id, opts);
  });

session
  .command("close <id>")
  .description("Close a focus session and optionally attach a recap")
  .requiredOption("--workspace <id>", "Workspace that owns the session")
  .option("--recap <text>", "Short summary of what was accomplished")
  .option("--json", "Output as JSON")
  .option("--pod-url <url>", "Pod URL override")
  .option("--api-key <key>", "API key override")
  .action(async (id: string, opts) => {
    const { closeSession } = await import("./commands/sessions.js");
    await closeSession(id, opts);
  });

session
  .command("attach <id>")
  .description("Attach a session to this terminal — all hub calls tag X-Session-Id until detached")
  .option("--json", "Output as JSON")
  .option("--pod-url <url>", "Pod URL override")
  .option("--api-key <key>", "API key override")
  .action(async (id: string, opts) => {
    const { attachSession } = await import("./commands/sessions.js");
    await attachSession(id, opts);
  });

session
  .command("detach")
  .description("Remove the active session from this terminal")
  .option("--json", "Output as JSON")
  .action(async (opts) => {
    const { detachSession } = await import("./commands/sessions.js");
    detachSession(opts);
  });

session
  .command("current")
  .description("Show the active session for this terminal (from .synap-session or SYNAP_SESSION_ID)")
  .option("--json", "Output as JSON")
  .action(async (opts) => {
    const { sessionStatus } = await import("./commands/sessions.js");
    sessionStatus(opts);
  });

// ─── skill ────────────────────────────────────────────────────────────────────
// Autonomous workspace session skills — context gathering, task planning, etc.

const skillCmd = program
  .command("skill")
  .description("Execute a skill in an autonomous workspace session")
  .action(() => {
    skillCmd.help();
  });

skillCmd
  .command("gather-context")
  .description("Gather pod KG + local context (CLAUDE.md, .claude/kg-verify) for a session")
  .option("--session <id>", "Focus session ID (required)")
  .option("--workspace <id>", "Workspace ID (defaults to active workspace)")
  .option("--json", "Output as JSON")
  .option("--pod-url <url>", "Pod URL override")
  .option("--api-key <key>", "API key override")
  .allowUnknownOption()
  .action(async (opts) => {
    const { gatherContext } = await import("./commands/skills.js");
    await gatherContext(opts);
  });

skillCmd
  .command("suggest <topic>")
  .description("Search the skill knowledge base by topic or keyword")
  .option("--pod-url <url>", "Pod URL override")
  .option("--api-key <key>", "API key override")
  .action(async (topic: string, opts) => {
    const { suggestSkills } = await import("./commands/skills-commands.js");
    await suggestSkills(topic, opts);
  });

skillCmd
  .command("get <slug>")
  .description("Fetch a skill from the knowledge base by slug and print its body")
  .option("--pod-url <url>", "Pod URL override")
  .option("--api-key <key>", "API key override")
  .action(async (slug: string, opts) => {
    const { getSkill } = await import("./commands/skills-commands.js");
    await getSkill(slug, opts);
  });

skillCmd
  .command("add <source>")
  .description(
    "Add skill(s) to your pod from: bundled · a local path · ~/.claude/skills/ · owner/repo · a git URL"
  )
  .option("--pod-url <url>", "Pod URL override")
  .option("--api-key <key>", "API key override")
  .action(async (source: string, opts) => {
    const { addSkill } = await import("./commands/skill-manage.js");
    await addSkill(source, opts);
  });

skillCmd
  .command("list")
  .alias("ls")
  .description("List the instruction skills installed on your pod")
  .option("--pod-url <url>", "Pod URL override")
  .option("--api-key <key>", "API key override")
  .option("--debug", "Show resolved credentials")
  .action(async (opts) => {
    const { listSkills } = await import("./commands/skill-manage.js");
    await listSkills(opts);
  });

skillCmd
  .command("remove <slug>")
  .alias("rm")
  .description("Remove a skill from your pod by slug")
  .option("--pod-url <url>", "Pod URL override")
  .option("--api-key <key>", "API key override")
  .action(async (slug: string, opts) => {
    const { removeSkill } = await import("./commands/skill-manage.js");
    await removeSkill(slug, opts);
  });

skillCmd
  .command("sync")
  .description("Bulk-import local skills from ~/.claude/skills/ into the pod")
  .option("--from <path>", "Skills directory path (default: ~/.claude/skills)")
  .option("--pod-url <url>", "Pod URL override")
  .option("--api-key <key>", "API key override")
  .action(async (opts) => {
    const { syncSkills } = await import("./commands/skills-commands.js");
    await syncSkills(opts);
  });

skillCmd
  .command("verify-code")
  .description("Run the project's type-check/test gate and store the result on the session")
  .requiredOption("--session <id>", "Focus session ID")
  .requiredOption("--workspace <id>", "Workspace that owns the session")
  .requiredOption("--cmd <command>", "Gate command to run (e.g. 'pnpm type-check')")
  .option("--json", "Output as JSON")
  .option("--pod-url <url>", "Pod URL override")
  .option("--api-key <key>", "API key override")
  .action(async (opts) => {
    const { verifyCode } = await import("./commands/skills.js");
    await verifyCode(opts);
  });

// ─── browse ───────────────────────────────────────────────────────────────────
// Paginated entity list — cleaner than `list entities`.

program
  .command("browse [profile]")
  .description("Browse entities in the active workspace, optionally filtered by profile type")
  .option("--workspace <id>", "Scope to a specific workspace")
  .option("--limit <n>", "Max results", "20")
  .option("--json", "Output as JSON")
  .option("--pod-url <url>", "Pod URL override")
  .option("--api-key <key>", "API key override")
  .action(async (profile: string | undefined, opts) => {
    const { browseEntities } = await import("./commands/data-extra.js");
    await browseEntities({ ...opts, profile });
  });

// ─── observe ──────────────────────────────────────────────────────────────────
// AI-maintained user model — write and query pod-scoped user observations.

const observe = program
  .command("observe")
  .description("Write and recall pod-wide user observations (AI-maintained user model)");

observe
  .command("write <text>", { isDefault: true })
  .description("Record an observation about the user (pod-scoped, AI-maintained)")
  .option("--category <cat>", "working_style | communication | focus | technical | preference", "preference")
  .option("--confidence <n>", "Confidence score 0-1", "0.5")
  .option("--json", "Output as JSON")
  .option("--pod-url <url>", "Pod URL override")
  .option("--api-key <key>", "API key override")
  .action(async (text: string, opts) => {
    const { observeWrite } = await import("./commands/observe.js");
    await observeWrite(text, opts);
  });

observe
  .command("recall <query>")
  .description("Search recorded user observations")
  .option("--category <cat>", "Filter by category")
  .option("--limit <n>", "Max results", "10")
  .option("--json", "Output as JSON")
  .option("--pod-url <url>", "Pod URL override")
  .option("--api-key <key>", "API key override")
  .action(async (query: string, opts) => {
    const { observeRecall } = await import("./commands/observe.js");
    await observeRecall(query, opts);
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
  .option("--workspace <id>", "Workspace ID (sent in PATCH body so workspace-scoped automations fire)")
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

// ─── agent (autonomous runner) ───────────────────────────────────────────────

const agent = program
  .command("agent")
  .description("Run autonomous agent loops against the IS, or schedule recurring goals");

agent
  .command("run")
  .description("Run an autonomous agent toward a goal using the Intelligence Service")
  .requiredOption("--goal <text>", "What the agent should accomplish")
  .option("--persona <type>", "researcher | assistant | developer (default: researcher)")
  .option("--model <model>", "IS model alias, e.g. synap/advanced (default: synap/advanced)")
  .option("--workspace <id>", "Workspace to store results in (uses active workspace if omitted)")
  .option("--max-steps <n>", "Max reasoning steps before auto-saving (default: 12)", parseInt)
  .option("--dry-run", "Print config without running")
  .option("--pod-url <url>", "Override pod URL")
  .option("--api-key <key>", "Override API key")
  .action(async (opts: { goal: string; persona?: string; model?: string; workspace?: string; maxSteps?: number; dryRun?: boolean; podUrl?: string; apiKey?: string }) => {
    const { agentRun } = await import("./commands/agent-run.js");
    await agentRun(opts as Parameters<typeof agentRun>[0]);
  });

agent
  .command("schedule")
  .description("Add, list, or remove recurring agent schedules")
  .option("--goal <text>", "Goal for the scheduled agent")
  .option("--name <label>", "Name for this schedule (required when adding)")
  .option("--every <interval>", "hourly | daily | weekly")
  .option("--persona <type>", "researcher | assistant | developer (default: researcher)")
  .option("--model <model>", "IS model alias (default: synap/advanced)")
  .option("--workspace <id>", "Workspace to store results in")
  .option("--run-now", "Also run immediately after creating the schedule")
  .option("--list", "List all configured schedules")
  .option("--remove <name>", "Remove a schedule by name")
  .option("--pod-url <url>", "Override pod URL")
  .option("--api-key <key>", "Override API key")
  .action(async (opts: { goal?: string; name?: string; every?: string; persona?: string; model?: string; workspace?: string; runNow?: boolean; list?: boolean; remove?: string; podUrl?: string; apiKey?: string }) => {
    const { agentSchedule } = await import("./commands/agent-run.js");
    await agentSchedule(opts as Parameters<typeof agentSchedule>[0]);
  });

agent
  .command("tick")
  .description("Check due schedules and run them — wire this to crontab: `0 * * * * synap agent tick`")
  .option("--dry-run", "Show what would run without executing")
  .option("--pod-url <url>", "Override pod URL")
  .option("--api-key <key>", "Override API key")
  .action(async (opts: { dryRun?: boolean; podUrl?: string; apiKey?: string }) => {
    const { agentTick } = await import("./commands/agent-run.js");
    await agentTick(opts);
  });

// ─── automation ──────────────────────────────────────────────────────────────

function collect(val: string, prev: string[]) { return [...prev, val]; }

const automation = program
  .command("automation")
  .description("Create, manage, and inspect pod automations");

automation
  .command("list")
  .description("List automations on the pod")
  .option("--workspace <id>", "Filter by workspace")
  .option("--status <status>", "Filter by status (active|draft|paused|error)")
  .option("--json", "Output raw JSON")
  .action(async (opts) => {
    const { automationList } = await import("./commands/automation.js");
    await automationList(opts);
  });

automation
  .command("describe <id>")
  .description("Show full details of an automation")
  .option("--workspace <id>")
  .option("--json")
  .action(async (id: string, opts) => {
    const { automationDescribe } = await import("./commands/automation.js");
    await automationDescribe(id, opts);
  });

automation
  .command("create")
  .description("Create an automation (quick flags or --from file.yaml)")
  .option("--name <name>", "Automation name (required in quick mode)")
  .option("--trigger <spec>", "event:<pattern> | cron:<expr> | webhook | manual")
  .option("--filter <kv>", "key=value filter (event triggers, repeatable)", collect, [])
  .option("--action <type>", "notify | channel-message | none (default: none)")
  .option("--message <text>", "Message content for notify/channel-message")
  .option("--channel <id>", "Channel ID for channel-message action")
  .option("--status <status>", "draft (default) | active")
  .option("--description <text>", "Description")
  .option("--workspace <id>", "Workspace ID")
  .option("--from <file>", "Create from YAML/JSON file instead of flags")
  .action(async (opts) => {
    const { automationCreate } = await import("./commands/automation.js");
    await automationCreate(opts);
  });

automation
  .command("enable <id>")
  .description("Activate an automation")
  .option("--workspace <id>")
  .action(async (id: string, opts) => {
    const { automationEnable } = await import("./commands/automation.js");
    await automationEnable(id, opts);
  });

automation
  .command("disable <id>")
  .description("Pause an automation")
  .option("--workspace <id>")
  .action(async (id: string, opts) => {
    const { automationDisable } = await import("./commands/automation.js");
    await automationDisable(id, opts);
  });

automation
  .command("delete <id>")
  .description("Delete an automation")
  .option("--workspace <id>")
  .option("--force", "Skip confirmation prompt")
  .action(async (id: string, opts) => {
    const { automationDelete } = await import("./commands/automation.js");
    await automationDelete(id, opts);
  });

automation
  .command("schema")
  .description("Fetch the automation DSL schema from the pod (AI context)")
  .option("--write-context [path]", "Write markdown context file for Claude Code")
  .option("--json", "Output raw JSON instead of formatted markdown")
  .action(async (opts) => {
    const { automationSchema } = await import("./commands/automation.js");
    await automationSchema(opts);
  });

// ─── graph ────────────────────────────────────────────────────────────────────

program
  .command("graph")
  .description("Low-level BFS graph traversal from an entity (prefer `synap ask` — graph is one of its signals)")
  .requiredOption("--entity <id>", "Start entity ID")
  .option("--depth <n>", "Traversal depth (max 3)", "2")
  .option("--json", "Raw JSON output")
  .option("--pod-url <url>", "Pod URL override")
  .option("--api-key <key>", "API key override")
  .action(async (opts) => {
    const { graphTraverse } = await import("./commands/graph.js");
    await graphTraverse(opts);
  });

// ─── events ───────────────────────────────────────────────────────────────────

program
  .command("events")
  .description("Show event chain for an entity or recent pod events")
  .option("--entity <id>", "Filter by entity ID (subjectId)")
  .option("--limit <n>", "Number of events", "20")
  .option("--json", "Raw JSON output")
  .option("--pod-url <url>", "Pod URL override")
  .option("--api-key <key>", "API key override")
  .action(async (opts) => {
    const { listEvents } = await import("./commands/events.js");
    await listEvents(opts);
  });

// ─── view ─────────────────────────────────────────────────────────────────────

const view = program
  .command("view")
  .description("Manage views");

view
  .command("create")
  .description("Create a view (table, kanban, bento, …)")
  .requiredOption("--type <type>", "View type: table|kanban|bento|list|grid|gallery|calendar|masonry|flow|matrix|branch_tree|whiteboard")
  .option("--profile <slug>", "Entity profile to display (passed as profileId)")
  .option("--name <name>", "View name")
  .option("--workspace <id>", "Workspace ID")
  .option("--json", "JSON output")
  .option("--pod-url <url>", "Pod URL override")
  .option("--api-key <key>", "API key override")
  .action(async (opts) => {
    const { viewCreate } = await import("./commands/view.js");
    await viewCreate(opts);
  });

view
  .command("list", { isDefault: true })
  .description("List views in the active workspace")
  .option("--type <type>", "Filter by view type (e.g. whiteboard, kanban, calendar)")
  .option("--workspace <id>", "Workspace ID")
  .option("--json", "JSON output")
  .option("--pod-url <url>", "Pod URL override")
  .option("--api-key <key>", "API key override")
  .action(async (opts) => {
    const { viewList } = await import("./commands/view.js");
    await viewList(opts);
  });

view
  .command("arrange <viewId>")
  .description("Replace the widget arrangement of a bento view")
  .option("--file <path>", "JSON file containing widget layout (array or { widgets: [...] })")
  .option("--workspace <id>", "Workspace ID")
  .option("--json", "JSON output")
  .option("--pod-url <url>", "Pod URL override")
  .option("--api-key <key>", "API key override")
  .addHelpText("after", `
Examples:
  synap view arrange <viewId> --file layout.json
  echo '[{"id":"w1","kind":"widget","x":0,"y":0,"w":6,"h":4}]' | synap view arrange <viewId>

Layout format (array of BentoWidget):
  [{ "id": "<widgetId>", "kind": "widget|view|entity", "x": 0, "y": 0, "w": 6, "h": 4, "config": {} }]
  `)
  .action(async (viewId: string, opts) => {
    const { viewArrange } = await import("./commands/view.js");
    await viewArrange(viewId, opts);
  });

// ─── explain ──────────────────────────────────────────────────────────────────

program
  .command("explain [topic]")
  .description("Full capability map — what Synap can do and how (no network required)")
  .action(async (topic?: string) => {
    const { explain } = await import("./commands/explain.js");
    await explain({ topic });
  });

// ─── open ─────────────────────────────────────────────────────────────────────

program
  .command("open <kind-or-id> [id]")
  .description("Open in the Synap desktop app. Use: open <kind> <id> or open <id> (auto-resolves type)")
  .action(async (kindOrId: string, id?: string) => {
    if (id) {
      // open entity|view|cell|document|proposal <id>
      const validKinds = ["entity", "view", "cell", "document", "proposal"];
      if (!validKinds.includes(kindOrId)) {
        console.error(`Unknown kind: "${kindOrId}". Use: ${validKinds.join(" | ")}`);
        process.exit(1);
      }
      const { openInBrowser } = await import("./commands/open.js");
      await openInBrowser({ kind: kindOrId as "entity" | "view" | "cell" | "document" | "proposal", id });
    } else {
      // open <id> — resolve type automatically
      const { resolveAndOpen } = await import("./commands/open.js");
      await resolveAndOpen(kindOrId);
    }
  });

// ─── doc ──────────────────────────────────────────────────────────────────────

const doc = program
  .command("doc")
  .description("Create and update markdown documents on the pod");

doc
  .command("create")
  .description("Create a new markdown document")
  .requiredOption("--title <title>", "Document title")
  .option("--content <text>", "Markdown content (inline)")
  .option("--file <path>", "Read content from a file")
  .option("--workspace <id>", "Workspace to create the document in")
  .option("--open", "Open in the Synap desktop app after creation")
  .option("--json", "JSON output")
  .option("--pod-url <url>", "Pod URL override")
  .option("--api-key <key>", "API key override")
  .addHelpText("after", `
Examples:
  synap doc create --title "My Notes" --content "# Hello"
  synap doc create --title "My Notes" --file ./notes.md --open
  echo "# Draft" | synap doc create --title "Draft"
  `)
  .action(async (opts) => {
    const { docCreate } = await import("./commands/doc.js");
    await docCreate(opts);
  });

doc
  .command("update <documentId>")
  .description("Update a document's content (full replacement, proposal-gated)")
  .option("--content <text>", "New markdown content (inline)")
  .option("--file <path>", "Read new content from a file")
  .option("--title <title>", "Update document title (requires --content too)")
  .option("--open", "Open in the Synap desktop app after update")
  .option("--json", "JSON output")
  .option("--pod-url <url>", "Pod URL override")
  .option("--api-key <key>", "API key override")
  .addHelpText("after", `
Examples:
  synap doc update <id> --content "# Updated"
  synap doc update <id> --file ./notes.md
  cat notes.md | synap doc update <id>
  `)
  .action(async (documentId: string, opts) => {
    const { docUpdate } = await import("./commands/doc.js");
    await docUpdate(documentId, opts);
  });

// ─── cell ─────────────────────────────────────────────────────────────────────

const cell = program
  .command("cell")
  .description("Define and bundle frame cells for the Synap runtime");

cell
  .command("define")
  .description("Create or update a frame cell on the pod from ESM source")
  .requiredOption("--name <name>", "Cell display name")
  .option("--file <path>", "ESM source file (or pipe stdin)")
  .option("--type-key <key>", "Explicit typeKey (default: generated:<slug>)")
  .option(
    "--deps <json>",
    'Dependency map JSON, e.g. \'{"recharts":"2.12.0"}\' (sent in payload; backend support pending)'
  )
  .option("--workspace <id>", "Workspace to scope the cell to (omit for pod-global)")
  .option("--description <text>", "Short description")
  .option("--open", "Open in the Synap desktop app after define")
  .option("--json", "JSON output")
  .option("--pod-url <url>", "Pod URL override")
  .option("--api-key <key>", "API key override")
  .addHelpText("after", `
Examples:
  synap cell define --name "Revenue Chart" --file ./chart.js
  synap cell define --name "Revenue Chart" --file ./chart.js --deps '{"recharts":"2.12.0"}'
  cat chart.js | synap cell define --name "Revenue Chart"
  `)
  .action(async (opts) => {
    const { cellDefine } = await import("./commands/cell.js");
    await cellDefine(opts);
  });

cell
  .command("build <entry>")
  .description("Bundle a multi-file cell/app into a single ESM module the runtime expects")
  .option("--out <file>", "Output file path (default: <entry>.bundle.js)")
  .option("--define", "Chain into cell define after bundling (requires --name)")
  .option("--name <name>", "Cell name (required with --define)")
  .option("--type-key <key>", "Explicit typeKey (used with --define)")
  .option(
    "--deps <json>",
    "Override dependency versions as JSON, e.g. '{\"react\":\"18.3.0\"}'"
  )
  .option("--workspace <id>", "Workspace (used with --define)")
  .option("--description <text>", "Description (used with --define)")
  .option("--open", "Open in browser after define (used with --define)")
  .option("--json", "JSON output")
  .option("--pod-url <url>", "Pod URL override")
  .option("--api-key <key>", "API key override")
  .addHelpText("after", `
Output: a single ESM file. Bare imports (react, recharts, …) are externalized
and emitted as a deps map. At runtime Synap resolves them via esm.sh importmap.

Examples:
  synap cell build ./src/chart.tsx --out ./dist/chart.js
  synap cell build ./src/chart.tsx --out ./dist/chart.js --define --name "Revenue Chart"
  `)
  .action(async (entry: string, opts) => {
    const { cellBuild } = await import("./commands/cell.js");
    await cellBuild(entry, opts);
  });

// ─── artifact ─────────────────────────────────────────────────────────────────

const artifact = program
  .command("artifact")
  .description("Create and manage HTML artifacts as Synap documents");

artifact
  .command("create")
  .description("Create an HTML artifact from a local file")
  .requiredOption("--html <file>", "HTML file to upload")
  .option("--name <name>", "Document title (default: filename)")
  .option("--workspace <id>", "Workspace context")
  .option("--open", "Open in the Synap desktop app after creation")
  .option("--json", "JSON output")
  .option("--pod-url <url>", "Pod URL override")
  .option("--api-key <key>", "API key override")
  .action(async (opts) => {
    const { artifactCreate } = await import("./commands/artifact.js");
    await artifactCreate(opts);
  });

// ─── connect (top-level shorthand) ───────────────────────────────────────────

program
  .command("connect-service [service]")
  .description("Connect an external service (Google, GitHub, Notion, Linear, Slack, …)")
  .option("--workspace <id>", "Workspace context")
  .option("--pod-url <url>", "Pod URL override")
  .option("--api-key <key>", "API key override")
  .action(async (service: string | undefined, opts) => {
    const { toolsConnect } = await import("./commands/tools.js");
    await toolsConnect(service, opts);
  });

// ─── tools ──────────────────────────────────────────────────────────────────

const tools = program
  .command("tools")
  .description("Add and manage external service tools and their credentials");

tools
  .command("list")
  .description("List available tools and their connection status")
  .option("--json", "Output as JSON")
  .option("--workspace <id>", "Workspace context")
  .action(async (opts) => {
    const { toolsList } = await import("./commands/tools.js");
    await toolsList(opts);
  });

tools
  .command("connect <service>")
  .description("Connect a credential to a tool (via Nango OAuth or vault)")
  .option("--workspace <id>", "Workspace context")
  .option("--pod-url <url>", "Pod URL override")
  .option("--api-key <key>", "API key override")
  .action(async (service: string | undefined, opts) => {
    const { toolsConnect } = await import("./commands/tools.js");
    await toolsConnect(service, opts);
  });

tools
  .command("sync <provider>")
  .description("Trigger a manual sync for a connected tool")
  .option("--workspace <id>", "Workspace context")
  .action(async (provider: string, opts) => {
    const { toolsSync } = await import("./commands/tools.js");
    await toolsSync(provider, opts);
  });

tools
  .command("disconnect <provider>")
  .description("Revoke a tool's connection")
  .option("--workspace <id>", "Workspace context")
  .option("--force", "Skip confirmation")
  .action(async (provider: string, opts) => {
    const { toolsDisconnect } = await import("./commands/tools.js");
    await toolsDisconnect(provider, opts);
  });

tools
  .command("schema")
  .description("Fetch tool schema and supported providers (AI context)")
  .option("--write-context [path]", "Write to .claude/TOOLS_CONTEXT.md")
  .option("--json", "Output raw JSON instead of formatted markdown")
  .action(async (opts) => {
    const { toolsSchema } = await import("./commands/tools.js");
    await toolsSchema(opts);
  });

// ─── capability ───────────────────────────────────────────────────────────────

const capability = program
  .command("capability")
  .alias("cap")
  .description("The one capability-first root: list, add, enable, connect, show, run a capability pack");

capability
  .command("list")
  .description("List capabilities — one row per pack, with status, connection, and verbs")
  .option("--json", "Output as JSON")
  .option("--workspace <id>", "Workspace context")
  .action(async (opts) => {
    const { capabilityList } = await import("./commands/capability.js");
    await capabilityList(opts);
  });

capability
  .command("add <name>")
  .description("Install a capability from the catalog (materialize its tools + skills)")
  .option("--workspace <id>", "Workspace context")
  .action(async (name: string, opts) => {
    const { capabilityAdd } = await import("./commands/capability.js");
    await capabilityAdd(name, opts);
  });

capability
  .command("enable <name>")
  .description("Turn on a capability — ensures its connection, then pick which verbs it can do")
  .option("--workspace <id>", "Workspace context")
  .action(async (name: string, opts) => {
    const { capabilityEnable } = await import("./commands/capability.js");
    await capabilityEnable(name, opts);
  });

capability
  .command("connect <name>")
  .description("Run just the connection sub-flow for a capability (OAuth or paste a key)")
  .option("--workspace <id>", "Workspace context")
  .action(async (name: string, opts) => {
    const { capabilityConnect } = await import("./commands/capability.js");
    await capabilityConnect(name, opts);
  });

capability
  .command("show <name>")
  .description("Show one capability's full detail: status, connection, verbs, next action")
  .option("--json", "Output as JSON")
  .option("--workspace <id>", "Workspace context")
  .action(async (name: string, opts) => {
    const { capabilityShow } = await import("./commands/capability.js");
    await capabilityShow(name, opts);
  });

capability
  .command("run <verb> [params...]")
  .description("Launch a verb — pass inputs as `--key value` flags")
  .option("--workspace <id>", "Workspace context")
  .allowUnknownOption()
  .allowExcessArguments()
  .action(async (verb: string, params: string[], opts) => {
    const { capabilityRun } = await import("./commands/capability.js");
    await capabilityRun(verb, params, opts);
  });

capability
  .command("test <verb>")
  .description("Dry-run a verb (preview side effects without executing)")
  .option("--workspace <id>", "Workspace context")
  .action(async (verb: string, opts) => {
    const { capabilityTest } = await import("./commands/capability.js");
    await capabilityTest(verb, opts);
  });

// ─── raycast ──────────────────────────────────────────────────────────────────

const raycast = program
  .command("raycast")
  .description("Generate Raycast Script Commands from your enabled capabilities");

raycast
  .command("generate")
  .description("Emit a Raycast Script Command per enabled runnable verb")
  .option("--out <dir>", "Output directory (default: ~/.synap/raycast-commands)")
  .option("--workspace <id>", "Workspace context")
  .action(async (opts) => {
    const { raycastGenerate } = await import("./commands/raycast.js");
    await raycastGenerate(opts);
  });

// ─── providers ───────────────────────────────────────────────────────────────

const providers = program
  .command("providers")
  .description("Discover AI providers from the pod and configure local tools");

providers
  .command("list", { isDefault: true })
  .description("Show enabled AI providers and their models")
  .option("--json", "Output as JSON")
  .option("--pod-url <url>", "Pod URL override")
  .option("--api-key <key>", "API key override")
  .action(async (opts: { json?: boolean; podUrl?: string; apiKey?: string }) => {
    const { providersList } = await import("./commands/providers.js");
    await providersList(opts);
  });

providers
  .command("pull")
  .description("Write pod provider config to a local AI tool (opencode, aider)")
  .option("--target <name>", "Target tool: opencode | aider")
  .option("--pod-url <url>", "Pod URL override")
  .option("--api-key <key>", "API key override")
  .action(async (opts: { target?: string; podUrl?: string; apiKey?: string }) => {
    const { providersPull } = await import("./commands/providers.js");
    await providersPull(opts);
  });

// ─── keys ────────────────────────────────────────────────────────────────────

const keys = program
  .command("keys")
  .description("Manage pod API keys");

keys
  .command("rotate")
  .description("Rotate your CLI key to pick up the latest scope set")
  .action(async () => {
    const { keysRotate } = await import("./commands/keys.js");
    await keysRotate({});
  });

program.parse();
