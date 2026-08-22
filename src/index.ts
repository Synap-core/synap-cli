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
import { bootstrapPodOverride } from "./lib/pod.js";

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
  .showSuggestionAfterError(true)
  // Global, position-independent: target a saved pod profile for THIS command
  // only (see `synap pods`). Consumed pre-parse by bootstrapPodOverride so it
  // works in any position and overrides the default/env pod for one invocation.
  .option("--pod <name>", "Run this command against a saved pod profile (overrides the default pod for this invocation only)");

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

// ── launch — nothing → a working company (project + domain workspaces) ────────
// Not a template browser: `--list` shows what's launchable (local, no pod),
// bare `synap launch` runs the guided one-per-company setup.
program
  .command("launch")
  .description("Stand up a NEW company/OS on a pod — creates a project + its core workspaces (interactive)")
  .option("--list", "List what can be launched (local templates, no pod needed) and exit")
  .option("--search <query>", "Filter --list by name/description/slug")
  .option("--type <type>", "Filter --list by package type (workspace|capability|skill|workflow|view|cell)")
  .option("--json", "Output as JSON")
  .option("--pod-url <url>", "Pod URL override")
  .option("--api-key <key>", "API key override")
  .action(async (opts) => {
    const { launch } = await import("./commands/launch.js");
    await launch(opts);
  });

// Hidden: one-shot Discord↔Synap bridge provisioning (dogfood/dev convenience).
program
  .command("bridge-setup", { hidden: true })
  .description("(hidden) One-shot Discord↔Synap bridge provisioning")
  .option("--client-id <id>", "Discord application (client) id — prints the invite URL")
  .option("--bot-token <token>", "Discord bot token — provisioned into the pod vault")
  .option("--guild-id <id>", "Discord server (guild) id — written to the bridge .env")
  .option("--bridge-dir <path>", "Path to the telegram-discord-bridge repo")
  .option("--workspace-id <uuid>", "Advanced/legacy: pin the bridge to one workspace (default: pod-wide, never prompted)")
  .option("--project-id <uuid>", "Scope the bridge to one project (default: prompt, pod-wide if declined)")
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

// Hidden: one-shot Proton Mail↔Synap bridge provisioning (dogfood/dev convenience).
// Fork of bridge-setup for the sovereign self-host Proton Bridge path — see
// synap-control-plane-api/src/seeds/capability-templates/proton.capability.json.
program
  .command("proton-setup", { hidden: true })
  .description("(hidden) One-shot Proton Mail↔Synap bridge provisioning")
  .option("--proton-email <email>", "Proton account email — provisioned into the pod vault")
  .option("--proton-password <password>", "Proton account password (not a bridge-generated value) — provisioned into the pod vault")
  .option("--proton-totp-seed <seed>", "Proton account 2FA/TOTP seed, base32 (optional) — provisioned into the pod vault")
  .option("--proton-mailbox-password <password>", "Proton mailbox password — ONLY for two-password-mode accounts (optional) — provisioned into the pod vault")
  .option("--bridge-dir <path>", "Path to the synap-proton-bridge repo")
  .option("--workspace-id <uuid>", "Advanced/legacy: pin the bridge to one workspace (default: pod-wide, never prompted)")
  .option("--project-id <uuid>", "Scope the bridge to one project (default: prompt, pod-wide if declined)")
  .option("--pod <name>", "Pod profile to connect the bridge to (default: prompt)")
  .option("--governance <mode>", "Agent governance preset: safe | normal | crazy (default: prompt)")
  .option("--pod-url <url>", "Synap pod URL (override)")
  .option("--api-key <key>", "Hub Protocol API key (override)")
  .action(async (opts) => {
    const { protonSetup } = await import("./commands/proton-setup.js");
    await protonSetup(opts);
  });

program
  .command("connect")
  .description(
    "Connect an AI surface (Claude Code, Cursor, Grok, Raycast, …) to a Synap pod"
  )
  .option(
    "--target <name>",
    "AI surface: claude-code | claude-desktop | cursor | raycast | grok | codex | vscode | generic | … (synap connect --list)"
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
  .option(
    "--with-mcp",
    "Raycast only: also install the full MCP server via mcp-remote (names overlap @synap)"
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
  .option("--surface <surface>", "Only switch this surface (raycast, claude-code, claude-desktop, cursor)")
  .option("--json", "Output as JSON (incl. nextSteps for agents; full-switch only)")
  .action(async (name: string, opts: { surface?: string; json?: boolean }) => {
    const { podsUse } = await import("./commands/pods.js");
    await podsUse(name, { surface: opts.surface as import("./commands/pods.js").SurfaceName | undefined, json: opts.json });
  });

pods
  .command("update <name> [url]")
  .description("Change a saved pod's URL in place (verifies health + whether the key must be recreated)")
  .option("--url <url>", "New pod URL (alternative to the positional arg)")
  .option("--yes", "Non-interactive: skip prompts (won't recreate a rejected key)")
  .action(async (name: string, url: string | undefined, opts: { url?: string; yes?: boolean }) => {
    const { podsUpdate } = await import("./commands/pods.js");
    await podsUpdate(name, url, { url: opts.url, yes: opts.yes });
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
  .option("--json", "Dump raw status (incl. release/migration detail) as JSON")
  .action(async (opts: { json?: boolean }) => {
    const { status } = await import("./commands/status.js");
    await status({ json: opts.json });
  });

program
  .command("doctor")
  .description("Coherence preflight: pod host resolves, key authenticates, workspace/project exist on THIS pod — catches config drift in one call")
  .option("--json", "Output as JSON")
  .action(async (opts: { json?: boolean }) => {
    const { doctor } = await import("./commands/doctor.js");
    await doctor(opts);
  });

program
  .command("versions")
  .description("Show LOCAL vs NPM vs CONTROL-PLANE vs POD version drift for workspace-templates, api-types, and capabilities")
  .option("--json", "Output structured {artifacts:[...]} JSON")
  .action(async (opts: { json?: boolean }) => {
    const { versions } = await import("./commands/versions.js");
    await versions({ json: opts.json });
  });

program
  .command("whoami")
  .description("Show key owner vs EFFECTIVE user (+ isAgent), scopes/workspace, and flag env-vs-surface key divergence")
  .option("--json", "Output as JSON")
  .action(async (opts: { json?: boolean }) => {
    const { whoami } = await import("./commands/whoami.js");
    await whoami(opts);
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

mcp
  .command("connect-claude")
  .description("Print the claude.ai (web) OAuth connection steps — paste a URL, approve in the browser, done")
  .option("--cp-url <url>", "Control-plane origin override (default: derived from the pod host)")
  .option("--json", "Output as JSON")
  .option("--pod-url <url>", "Pod URL override")
  .option("--api-key <key>", "API key override")
  .action(async (opts) => {
    const { mcpConnectClaudeWeb } = await import("./commands/mcp.js");
    await mcpConnectClaudeWeb(opts);
  });

program
  .command("login")
  .description("Connect your Synap account (private templates) + your pods")
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
    }

    // ── Synap ACCOUNT (control plane) — a FIRST-CLASS half of "login" ──────
    // Pods authenticate DATA access; the ACCOUNT authenticates the control plane
    // (private templates like The Arch, hosted pods, marketplace publishing).
    // They are different credentials, and pods alone never unlock private
    // templates — so this gets its own headed section, not a footnote. `synap
    // launch`'s "private templates after 'synap login'" hint lands HERE.
    const { isLoggedIn: cpLoggedIn, login: cpLogin } = await import("./lib/auth.js");
    console.log("\n  Synap account:\n");
    const account = await cpLoggedIn();
    let accountEmail: string | undefined;
    if (account.valid) {
      accountEmail = account.email;
      console.log(
        `  ${chalk.green("●")} ${chalk.bold(account.email ?? "logged in")}  ${chalk.dim("— private templates available")}`
      );
    } else {
      console.log(
        `  ${chalk.yellow("○")} ${chalk.bold("not logged in")}  ${chalk.dim("— your private templates (e.g. The Arch) are hidden until you log in")}`
      );
      const prompts = (await import("prompts")).default;
      const { doLogin } = await prompts({
        type: "confirm",
        name: "doLogin",
        message: "Log in to your Synap account now?",
        initial: true,
      });
      if (doLogin) {
        const creds = await cpLogin();
        if (creds?.email) {
          accountEmail = creds.email;
          console.log(chalk.green(`  ✓ Logged in as ${creds.email} — private templates unlocked.`));
        }
      } else {
        console.log(chalk.dim("  Later: synap login  ·  or  synap login --token <token>  (synap.live/account/tokens)"));
      }
    }

    const { renderNextSteps, FLOW } = await import("./lib/next-steps.js");
    renderNextSteps(FLOW.afterLogin(accountEmail));
  });


// ─── orient ───────────────────────────────────────────────────────────────────

program
  .command("orient")
  .description("Show a lightweight lens map: who you are, your projects (companies/initiatives), and workspaces (operational domains)")
  .option("--json", "Output as JSON")
  .option("--details", "Include per-workspace profiles + entity counts (heavier)")
  .option("--pod-url <url>", "Pod URL override")
  .option("--api-key <key>", "API key override")
  .action(async (opts) => {
    const { orient } = await import("./commands/data.js");
    await orient(opts);
  });

// ─── digest ─────────────────────────────────────────────────────────────────
// A quick read of what's already in a workspace or project (counts + key
// entities + summary). Default = the active workspace lens.

program
  .command("digest")
  .description("Summarize what's in a workspace or project (counts + key entities)")
  .option("--workspace <id|name>", "Workspace to digest (defaults to active workspace lens)")
  .option("--project <id|name>", "Project to digest (cross-cutting lens)")
  .option("--json", "Output raw JSON")
  .option("--pod-url <url>", "Pod URL override")
  .option("--api-key <key>", "API key override")
  .action(async (opts) => {
    const { digest } = await import("./commands/digest.js");
    await digest(opts);
  });

// ─── diagnose ────────────────────────────────────────────────────────────────
// See what an AI did across flows: the unified run feed, or one run's activity
// timeline (for a capture: WHY a facet/entity dropped, with a fixHint).

program
  .command("diagnose [run]")
  .description("See what an AI did — the run feed, or one run's nodes (by id or flow name)")
  .option("--flow <automation|playbook|capture|capability|session|chat>", "Restrict the feed, or narrow the run lookup to one flow")
  .option("--flow-id <id>", "Restrict the feed to one flow's runs (automationId / playbookId)")
  .option("--limit <n>", "Max runs in the feed")
  .option("--json", "Output raw JSON")
  .option("--pod-url <url>", "Pod URL override")
  .option("--api-key <key>", "API key override")
  .action(async (runId: string | undefined, opts) => {
    const { diagnose } = await import("./commands/diagnose.js");
    await diagnose(runId, opts);
  });

// ─── use ──────────────────────────────────────────────────────────────────────

program
  .command("use <workspace>")
  .description("Set the active workspace (by ID or name) — short form of `synap workspace use`. Default scope: this directory")
  .option("--session", "Ephemeral: scope only this Claude Code session, don't persist")
  .option("--global", "Durable machine-wide default (~/.synap/config.json) instead of this directory's .synap/lens.json")
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
  .description("Manage + focus the cross-cutting project lens (a company/initiative): list, new, use, clear");
project
  .command("list", { isDefault: true })
  .description("List projects on the active pod, with the pinned one marked (bare `synap project` runs this)")
  .option("--json", "Output as JSON (incl. nextSteps for agents)")
  .option("--pod-url <url>", "Pod URL override")
  .option("--api-key <key>", "API key override")
  .action(async (opts) => {
    const { projectList } = await import("./commands/lens.js");
    await projectList(opts);
  });
project
  .command("new <name>")
  .description("Create a project (a company/initiative) on the active pod, then guide you to pin + add to it")
  .option("--description <text>", "Optional one-line description")
  .option("--json", "Output as JSON (incl. nextSteps for agents)")
  .option("--pod-url <url>", "Pod URL override")
  .option("--api-key <key>", "API key override")
  .action(async (name: string, opts) => {
    const { projectNew } = await import("./commands/lens.js");
    await projectNew(name, opts);
  });
project
  .command("use <ref>")
  .description("Pin the active project (durable, like `synap use <workspace>`). Ref = uuid, slug, or <pod>/<slug> — cross-pod refs switch the active pod too")
  .option("--session", "Ephemeral: scope only this Claude Code session, don't persist (cross-pod refs refused)")
  .option("--global", "Durable machine-wide default (~/.synap/config.json) instead of this directory's .synap/lens.json")
  .option("--json", "Output as JSON")
  .option("--pod-url <url>", "Pod URL override")
  .option("--api-key <key>", "API key override")
  .action(async (ref: string, opts) => {
    const { useProject } = await import("./commands/lens.js");
    await useProject(ref, opts);
  });
project
  .command("clear")
  .description("Clear the active project focus (durable by default)")
  .option("--session", "Ephemeral: clear only this Claude Code session's project")
  .option("--json", "Output as JSON")
  .action(async (opts) => {
    const { clearProject } = await import("./commands/lens.js");
    await clearProject(opts);
  });
project
  .command("purge <target>")
  .description("HARD teardown: delete a project + its pod-wide-exclusive entities (owner-only, irreversible)")
  .option("--confirm <name>", "Confirm non-interactively by passing the exact project name")
  .option("--yes", "Skip the interactive name prompt (uses the resolved name)")
  .option("--json", "Output raw JSON")
  .option("--pod-url <url>", "Pod URL override")
  .option("--api-key <key>", "API key override")
  .action(async (target: string, opts) => {
    const { projectPurge } = await import("./commands/purge.js");
    await projectPurge(target, opts);
  });

program
  .command("lens")
  .description("Show the effective lens (workspace + project + focus session) and WHICH rung set each one")
  .option("--json", "Output as JSON")
  .option("--pod-url <url>", "Pod URL override")
  .option("--api-key <key>", "API key override")
  .action(async (opts) => {
    const { showLens } = await import("./commands/lens.js");
    await showLens(opts);
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
  .option("--compare", "A/B diagnostic: show baseline vs Horizon rankers side-by-side (read-only, does not change the answer)")
  .option("--pod-url <url>", "Pod URL override")
  .option("--api-key <key>", "API key override")
  .action(async (query: string, opts) => {
    const { askKnowledge } = await import("./commands/data.js");
    await askKnowledge(query, opts);
  });

// ─── capture ──────────────────────────────────────────────────────────────────
// Uses the active pod from config. Work-lane knowledge does NOT default-pin
// the active workspace (omit workspaceId → server-derived / pod-wide preferred);
// pin only with --workspace or --team.

program
  .command("capture [text]")
  .description("Capture knowledge: smart `capture \"<free text>\"` (AI structures it). For canonical typed Knowledge, use `create entity --profile=knowledge --props='{\"knowledgeForm\":\"insight|caution\"}'`.")
  .option("--type <type>", "Legacy compatibility typed mode (gotcha|lesson|decision|reference); new automation should use knowledgeForm")
  .option("--claim <text>", "Typed mode: one-line assertion (required with --type)")
  .option("--content <markdown>", "Typed mode: full Markdown explanation, stored as the linked Knowledge note")
  .option("--why <text>", "Reasoning or context")
  .option("--evidence <text>", "Supporting file path, URL, or code snippet")
  .option("--tags <csv>", "Comma-separated tags e.g. repo:synap-backend,layer:migrations")
  .option("--session", "Link captured knowledge to the active session")
  .option("--pod-wide", "GLOBAL lane: pod-wide cross-cutting runbook (→ knowledge_keys), visible in every workspace")
  .option("--global", "Alias for --pod-wide")
  .option("--key <ns:slug>", "Stable key for a --pod-wide runbook (derived from --type + --claim if omitted)")
  .option("--team", "Pin to the first product workspace (default: omit workspaceId — server-derived / pod-wide preferred for knowledge)")
  .option("--workspace <id>", "Explicit workspace pin (otherwise workspaceId is omitted for knowledge)")
  .option("--project <id|name>", "Pin the capture to a project (id or name) — overrides SYNAP_PROJECT_ID / the session lens")
  .option("--yes", "Skip the y/N confirmation prompt (smart mode)")
  .option("--json", "Output as JSON")
  .action(async (text, opts) => {
    const { captureKnowledge } = await import("./commands/knowledge.js");
    await captureKnowledge({ ...opts, text });
  });

// ─── import ─────────────────────────────────────────────────────────────────
// "capture, but for files and URLs." Each input (file/folder/URL) routes through
// the SAME AI capture pipeline (/capture/structure → /capture/execute), so it
// inherits entity extraction, the relation graph, and workspace/project routing.

program
  .command("import [inputs...]")
  .description(
    "Import files, folders, or URLs into the pod (AI capture pipeline, or Superwhisper store-first)"
  )
  .option("--workspace <id|name>", "Override AI workspace routing")
  .option("--project <id|name>", "Override AI project routing")
  .option(
    "--home-map <pairs>",
    "Multi-home path map: pathSubstring=workspaceNameOrId pairs " +
      '(e.g. "Projects=Builder,Posts=Content OS"). Matched batch paths are ' +
      "rewritten with the workspace name as the first segment so placement " +
      "heuristics pin the right home. No product defaults."
  )
  .option("--dry-run", "Preview only — do not write")
  .option("--yes", "Skip confirmation / auto-confirm store-first")
  .option("--session", "Link created entities to the active session")
  .option("--json", "Output as JSON")
  .option("--pod-url <url>", "Pod URL override")
  .option("--api-key <key>", "API key override")
  .option(
    "--source <name>",
    "Adapter: superwhisper (paired meta.json+output.wav store-first)"
  )
  .option(
    "--store-first",
    "Skip AI structure; store units as pod-wide notes (+ optional audio)"
  )
  .option("--with-audio", "Upload WAV provenance (default on for --source superwhisper --store-first)")
  .option("--no-with-audio", "Transcript-only (no WAV upload)")
  .option("--limit <n>", "Max Superwhisper units to process", (v) => parseInt(v, 10))
  .option("--concurrency <n>", "Parallel unit uploads (1–4)", (v) => parseInt(v, 10))
  .option("--no-resume", "Ignore local import ledger (re-import all)")
  .option(
    "--job-status <jobId>",
    "Re-poll a background corpus import started by an earlier run (no waiting)"
  )
  .action(async (inputs: string[], opts) => {
    const mod = await import("./commands/import.js");
    if (opts.jobStatus) {
      await mod.importJobStatus(opts.jobStatus, opts);
      return;
    }
    await mod.importData(inputs ?? [], opts);
  });

// ─── upload ───────────────────────────────────────────────────────────────────
// Store a real file (arbitrary bytes) on the pod — the door an AI/CLI needs to
// persist an actual file, not just text. POSTs multipart to /api/hub/files,
// which mints a `file` entity for the bytes.

program
  .command("upload <path>")
  .description("Upload a file (≤10MB) to the pod as a file entity")
  .option("--workspace <id>", "Workspace to store the file in")
  .option("--attach <entityId>", "After upload, link the document to this entity (references relation)")
  .option("--title <title>", "Title for the created document")
  .option("--open", "Open in the Synap desktop app after upload")
  .option("--json", "Output as JSON")
  .option("--pod-url <url>", "Pod URL override")
  .option("--api-key <key>", "API key override")
  .addHelpText("after", `
Examples:
  synap upload ./report.pdf
  synap upload ./logo.png --title "Brand logo" --workspace <id>
  synap upload ./spec.pdf --attach <entityId>
  synap upload ./report.pdf --open
  `)
  .action(async (path: string, opts) => {
    const { uploadFile } = await import("./commands/upload.js");
    await uploadFile(path, opts);
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
  .option("--summary", "List profile kinds without property schemas")
  .option("--profile-slugs <slugs>", "Comma-separated profile slugs to load in full")
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
  .description("Manage + focus the workspace lens (an operational domain): list, use, clear");

// `workspace use|list|clear` mirror `project use|list|clear` so the two
// composable lenses read as siblings. ADDITIVE: the original short form
// `synap use <workspace>` and `synap list workspaces` are untouched and keep
// working exactly as before — these are aliases, not replacements.
workspace
  .command("use <workspace>")
  .description("Pin the active workspace by ID or name (durable, like `synap use <workspace>`). Default scope: this directory")
  .option("--session", "Ephemeral: scope only this Claude Code session, don't persist")
  .option("--global", "Durable machine-wide default (~/.synap/config.json) instead of this directory's .synap/lens.json")
  .option("--json", "Output as JSON")
  .option("--pod-url <url>", "Pod URL override")
  .option("--api-key <key>", "API key override")
  .action(async (ws: string, opts) => {
    const { useWorkspace } = await import("./commands/data.js");
    await useWorkspace(ws, opts);
  });

workspace
  .command("list", { isDefault: true })
  .description("List workspaces you belong to (bare `synap workspace` runs this)")
  .option("--json", "Output as JSON")
  .option("--pod-url <url>", "Pod URL override")
  .option("--api-key <key>", "API key override")
  .action(async (opts) => {
    const { listWorkspaces } = await import("./commands/data.js");
    await listWorkspaces(opts);
  });

workspace
  .command("clear")
  .description("Clear the active workspace focus (durable by default)")
  .option("--session", "Ephemeral: clear only this Claude Code session's workspace")
  .option("--json", "Output as JSON")
  .action(async (opts) => {
    const { clearWorkspace } = await import("./commands/data.js");
    await clearWorkspace(opts);
  });

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

workspace
  .command("purge <target>")
  .description("HARD teardown: delete a workspace + all its entities and blobs (owner-only, irreversible)")
  .option("--confirm <name>", "Confirm non-interactively by passing the exact workspace name")
  .option("--yes", "Skip the interactive name prompt (uses the resolved name)")
  .option("--json", "Output raw JSON")
  .option("--pod-url <url>", "Pod URL override")
  .option("--api-key <key>", "API key override")
  .action(async (target: string, opts) => {
    const { workspacePurge } = await import("./commands/purge.js");
    await workspacePurge(target, opts);
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
  .option("--role <slug>", "Filter to entities carrying this role (e.g. client, partner)")
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

// ─── facet ────────────────────────────────────────────────────────────────────
// Roles — one identity, many roles. A role-profile (client, partner, contact…)
// attached to an existing entity, never a second entity. Governed writes: an
// attach/detach may come back "proposed for review" instead of applying live.

const facet = program
  .command("facet")
  .description("Manage roles attached to an entity (client, partner, contact, …)");

facet
  .command("attach <entityId> <roleSlug>")
  .description("Attach a role to an entity")
  .option("--property <kv>", "Role property as key=value (repeatable)", collect, [] as string[])
  .option("--workspace <id>", "Role's lens (defaults to the active workspace)")
  .option("--json", "Output as JSON")
  .option("--pod-url <url>", "Pod URL override")
  .option("--api-key <key>", "API key override")
  .action(async (entityId: string, roleSlug: string, opts) => {
    const { attachFacet } = await import("./commands/facet.js");
    await attachFacet(entityId, roleSlug, opts);
  });

facet
  .command("list <entityId>")
  .description("List the roles attached to an entity")
  .option("--json", "Output as JSON")
  .option("--pod-url <url>", "Pod URL override")
  .option("--api-key <key>", "API key override")
  .action(async (entityId: string, opts) => {
    const { listFacets } = await import("./commands/facet.js");
    await listFacets(entityId, opts);
  });

facet
  .command("detach [facetId]")
  .description("Detach a role — pass the facet id, or --entity <id> --role <slug>")
  .option("--entity <id>", "Entity id (with --role, resolves the facet to detach)")
  .option("--role <slug>", "Role slug (with --entity)")
  .option("--json", "Output as JSON")
  .option("--pod-url <url>", "Pod URL override")
  .option("--api-key <key>", "API key override")
  .action(async (facetId: string | undefined, opts) => {
    if (!facetId && !(opts.entity && opts.role)) {
      console.error("Provide a facet id, or both --entity <id> and --role <slug>.");
      process.exit(1);
    }
    const { detachFacet } = await import("./commands/facet.js");
    await detachFacet(facetId ?? "", opts);
  });

// ─── proposals ────────────────────────────────────────────────────────────────
// Governance inbox — pending proposals attributed to this agent.

const proposals = program
  .command("proposals")
  .description("Review and act on governance proposals");

proposals
  .command("list", { isDefault: true })
  .description("List governance proposals (default: the pending queue)")
  .option(
    "--status <status>",
    "pending (default) | approved | auto_approved (what the agent already did) | rejected | all",
    "pending"
  )
  .option("--workspace <id>", "Scope to a specific workspace")
  .option("--session <id>", "Scope to one focus session (the agent run that filed them)")
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
  .description("Approve a pending proposal (interactive only — requires a TTY and a typed confirmation)")
  .option("--reason <text>", "Optional approval note")
  .option(
    "--yes",
    "Accepted for symmetry with other commands, but does NOT skip the typed confirmation — approval is always deliberate"
  )
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
  .description("Show details for a specific focus session (works for project-scoped sessions)")
  .option("--workspace <id>", "Workspace hint if the pod still requires it for GET")
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
  .description("Complete a focus session (proposal pack) and optionally attach a recap")
  .option("--workspace <id>", "Workspace hint (optional; not required for complete)")
  .option("--recap <text>", "Short summary of what was accomplished (maps to summary)")
  .option("--json", "Output full pack (or close result) as JSON")
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
  .description("Browse entities in the active workspace, optionally filtered by profile type or role")
  .option("--workspace <id>", "Scope to a specific workspace")
  .option("--role <slug>", "Filter to entities carrying this role (e.g. client, partner)")
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
    // `write` is the DEFAULT subcommand, so an unrecognized token lands here as
    // `text` instead of erroring — and this default WRITES. `synap observe recal`
    // therefore recorded an observation literally reading "recal" into the
    // AI-maintained user model, silently. Every other `isDefault` group in this
    // file has a zero-arg default, which commander rejects on its own; this is
    // the only one that can absorb a typo, and the only one where absorbing it
    // is a mutation.
    //
    // The guard keys off whether `write` was named EXPLICITLY, not off the text:
    // a mistyped subcommand is always a single bare token, and a real
    // observation is a sentence. Going through `observe write <text>` skips the
    // check entirely, so the escape hatch is real rather than circular.
    const argv = process.argv;
    const observeAt = argv.indexOf("observe");
    const explicitWrite = observeAt !== -1 && argv[observeAt + 1] === "write";
    if (!explicitWrite && !/\s/.test(text.trim())) {
      const siblings = observe.commands.map((c) => c.name()).filter((n) => n !== "write");
      console.error(
        `error: '${text}' looks like a subcommand, not observation text — nothing was recorded.\n` +
          `  Available: ${siblings.map((n) => `synap observe ${n}`).join(", ")}\n` +
          `  To record it as an observation anyway: synap observe write ${JSON.stringify(text)}`
      );
      process.exit(1);
    }
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
  .option("--content <markdown>", "Long-form Markdown body, stored as the entity's linked document")
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
  .description("Manage agent principals on your pod (one per type for you; local keys are a cache)");

agents
  .command("list", { isDefault: true })
  .description(
    "List your agents on this pod (one per type). Use --local for ~/.synap cache only."
  )
  .option("--json", "Output as JSON")
  .option("--local", "List only the local ~/.synap agent cache")
  .action(async (opts: { json?: boolean; local?: boolean }) => {
    const { agentsList } = await import("./commands/agents.js");
    await agentsList(opts);
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
  .description("Create or reuse an agent principal on the pod (template-aware). Replaces `add` for new agents.")
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
  .description("Rotate the Hub Protocol API key for an agent (local cache only)")
  .action(async (nameOrId: string) => {
    const { agentsRotateKey } = await import("./commands/agents.js");
    await agentsRotateKey(nameOrId);
  });

agents
  .command("remove <name>")
  .alias("rm")
  .description("Remove a named agent identity (local cache only)")
  .action(async (name: string) => {
    const { agentsRemove } = await import("./commands/agents.js");
    agentsRemove(name);
  });

agents
  .command("info <name>")
  .description("Show details for a named agent identity (local cache only)")
  .action(async (name: string) => {
    const { agentsInfo } = await import("./commands/agents.js");
    agentsInfo(name);
  });

// ─── agent (autonomous runner) ───────────────────────────────────────────────

const agent = program
  .command("agent")
  .description("Run autonomous agent loops against the IS, or schedule recurring goals");

agent
  .command("ask <message>")
  .description("Send one message to the workspace's deployed agent and print its reply (multi-turn: reuses one thread)")
  .option("--workspace <id|name>", "Workspace to talk to (uses active workspace/lens if omitted)")
  .option("--thread <id>", "Target an existing thread/channel id instead of the default CLI chat thread")
  .option("--new", "Start a fresh thread instead of continuing the persistent CLI chat thread")
  .option("--agent-type <type>", "Requested agent type hint (backend currently routes to the orchestrator)")
  .option("--timeout <seconds>", "How long to wait for the agent's reply (default: 90)")
  .option("--json", "Machine-readable output { ok, reply, threadId, workspaceId }")
  .option("--pod-url <url>", "Override pod URL")
  .option("--api-key <key>", "Override API key")
  .action(async (message: string, opts: Record<string, unknown>) => {
    const { agentAsk } = await import("./commands/agent-chat.js");
    await agentAsk({ ...opts, message } as Parameters<typeof agentAsk>[0]);
  });

agent
  .command("chat")
  .description("Interactive REPL conversation with the workspace's deployed agent")
  .option("--workspace <id|name>", "Workspace to talk to (uses active workspace/lens if omitted)")
  .option("--thread <id>", "Target an existing thread/channel id instead of the default CLI chat thread")
  .option("--new", "Start a fresh thread instead of continuing the persistent CLI chat thread")
  .option("--agent-type <type>", "Requested agent type hint (backend currently routes to the orchestrator)")
  .option("--timeout <seconds>", "How long to wait for each reply (default: 90)")
  .option("--pod-url <url>", "Override pod URL")
  .option("--api-key <key>", "Override API key")
  .action(async (opts: Record<string, unknown>) => {
    const { agentChat } = await import("./commands/agent-chat.js");
    await agentChat(opts as Parameters<typeof agentChat>[0]);
  });

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

// ─── automate ───────────────────────────────────────────────────────────────
// The natural-language automation door. It stays deliberately separate from
// `automation create`, which remains the expert, explicit-DSL path.

program
  .command("automate <instruction>")
  .description("Ask the workspace agent to prepare a governed automation proposal")
  .option("--workspace <id|name>", "Workspace to use (uses active workspace/lens if omitted)")
  .option("--thread <id>", "Continue an existing agent thread/channel")
  .option("--new", "Start a fresh agent thread")
  .option("--timeout <seconds>", "How long to wait for the agent's reply (default: 90)")
  .option("--json", "Machine-readable output { ok, reply, threadId, workspaceId }")
  .option("--pod-url <url>", "Override pod URL")
  .option("--api-key <key>", "Override API key")
  .action(async (instruction: string, opts: Record<string, unknown>) => {
    const { automate } = await import("./commands/automate.js");
    await automate(instruction, opts as Parameters<typeof automate>[1]);
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

// ─── centrality ────────────────────────────────────────────────────────────────
// Window onto the Phase-3 PageRank centrality signal (entity_centrality):
// see if it has populated, and trigger a recompute on demand.

const centrality = program
  .command("centrality")
  .description("Inspect PageRank centrality (entity_centrality) and trigger a recompute");

centrality
  .command("status", { isDefault: true })
  .description("Show whether PageRank centrality has populated + the top central entities")
  .option("--json", "Output as JSON")
  .option("--pod-url <url>", "Pod URL override")
  .option("--api-key <key>", "API key override")
  .action(async (opts) => {
    const { centralityStatus } = await import("./commands/centrality.js");
    await centralityStatus(opts);
  });

centrality
  .command("recompute")
  .description("Enqueue a PageRank centrality recompute (runs in the background)")
  .option("--json", "Output as JSON")
  .option("--pod-url <url>", "Pod URL override")
  .option("--api-key <key>", "API key override")
  .action(async (opts) => {
    const { centralityRecompute } = await import("./commands/centrality.js");
    await centralityRecompute(opts);
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

doc
  .command("reference <url>")
  .description("Create an external reference document (points at a URL — no bytes stored)")
  .requiredOption("--title <title>", "Document title")
  .option("--workspace <id>", "Workspace to create the reference in")
  .option("--open", "Open in the Synap desktop app after creation")
  .option("--json", "JSON output")
  .option("--pod-url <url>", "Pod URL override")
  .option("--api-key <key>", "API key override")
  .addHelpText("after", `
Examples:
  synap doc reference https://example.com/spec --title "Vendor spec"
  `)
  .action(async (url: string, opts) => {
    const { docReference } = await import("./commands/doc.js");
    await docReference(url, opts);
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
  .option("--workspace <id>", "Workspace to scope the cell to (omit for pod-wide)")
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

// ─── pod — unified pod-configuration view ─────────────────────────────────────
// `market installed` shows what packages are installed; `pod` answers the
// bigger question: what does the WHOLE pod look like — every workspace with
// its provenance (marketplace/composed/ad-hoc/orphan), pod-wide vs
// per-workspace capabilities/automations/playbooks, and the give/need feed
// links between workspaces. Read surface for GET /api/hub/pod/config.
const podCmd = program
  .command("pod")
  .description("Show the whole configured pod — workspaces (with provenance), capabilities/automations/playbooks, and feed links")
  .option("--json", "Output the full structured graph as JSON")
  .option("--orphans", "Only show orphan/ad-hoc workspaces and their template-match suggestions")
  .option("--pod-url <url>", "Pod URL override")
  .option("--api-key <key>", "API key override")
  .action(async (opts) => {
    const { pod } = await import("./commands/pod.js");
    await pod(opts);
  });

podCmd
  .command("adopt <workspaceNameOrId>")
  .description("Link an orphan/ad-hoc workspace (by name or id) to a matching template — makes it version-tracked")
  .requiredOption("--template <slug>", "The template slug to adopt this workspace into")
  .option("--json", "Output as JSON")
  .option("--pod-url <url>", "Pod URL override")
  .option("--api-key <key>", "API key override")
  .action(async (workspaceNameOrId: string, _opts, cmd) => {
    // `--json` collides with the parent `pod` command's own `--json` — same
    // gap `market install` has (see its comment). Merge across the chain.
    const opts = cmd.optsWithGlobals();
    const { podAdopt } = await import("./commands/pod.js");
    await podAdopt(workspaceNameOrId, opts);
  });

// ─── market — discover + install ANY package type ────────────────────────────
// launch is workspace-first (bundled, offline); market reaches every CP package
// type (capability/skill/workflow/view/cell/workspace), public or private.
const market = program
  .command("market")
  .description("Browse + install packages (workspaces, capabilities, skills, workflows, views, cells) into a project")
  .option("--list", "List and exit (the default action)")
  .option("--search <query>", "Filter by name/description/slug")
  .option("--type <type>", "Filter by package type (workspace|capability|skill|workflow|view|cell)")
  .option("--json", "Output as JSON")
  .action(async (opts) => {
    const { market: marketBrowse } = await import("./commands/market.js");
    await marketBrowse(opts);
  });

market
  .command("install <slug>")
  .description("Install a package by slug into a project — workspaces install now; other types route you to the right surface")
  .option("--project <id>", "Optionally tag the seeded entities to a project (installs are pod-wide by default)")
  .option("--onto <workspaceId>", "Reconcile this template ONTO an existing workspace (additive) instead of creating a new one")
  .option("--dry-run", "Preview the create path write-free — report would-create / reuse / conflicts, install nothing")
  .option("--timeout <seconds>", "How long to wait for the apply to finish (default: 120)")
  .option("--json", "Output as JSON")
  .option("--pod-url <url>", "Pod URL override")
  .option("--api-key <key>", "API key override")
  .action(async (slug: string, _opts, cmd) => {
    // `--json` collides with the parent `market` command's own `--json` —
    // commander then attributes the flag's VALUE to the parent's
    // `_optionValues`, leaving this action's own `opts` argument `{}` for it
    // (a real, pre-existing gap: `market install <slug> --json` silently fell
    // back to human output). `optsWithGlobals()` walks the whole command
    // chain and merges regardless of which level actually captured the flag.
    const opts = cmd.optsWithGlobals();
    const { marketInstall } = await import("./commands/market.js");
    await marketInstall(slug, opts);
  });

market
  .command("update [slugs...]")
  .description(
    "Check installed packages for drift against the catalog, and re-apply the ones that are stale (all with --yes, specific ones with explicit slugs)"
  )
  .option("--yes", "Apply every available update without prompting (no slugs required)")
  .option("--dry-run", "Force the preview path — never apply, even with --yes")
  .option("--timeout <seconds>", "How long to wait for each package's apply to finish (default: 120)")
  .option("--json", "Output as JSON")
  .option("--pod-url <url>", "Pod URL override")
  .option("--api-key <key>", "API key override")
  .action(async (slugs: string[] | undefined, _opts, cmd) => {
    // Same parent/child `--json` collision as `market install` — see its comment.
    const opts = cmd.optsWithGlobals();
    const { marketUpdate } = await import("./commands/market.js");
    await marketUpdate(slugs && slugs.length > 0 ? slugs : undefined, opts);
  });

market
  .command("installed")
  .description("List packages installed on this pod — a pure read, no writes (pairs with 'market update' to check drift)")
  .option("--outdated", "Only show packages with an update available")
  .option("--tree", "Show the composition graph — package → templates → resulting workspaces, marking shared nodes")
  .option("--layers", "Show the composition graph as a flat DAG — one row per slug, bedrock-first, with true fan-in counts")
  .option("--json", "Output as JSON")
  .action(async (_opts, cmd) => {
    // Same parent/child `--json` collision as `market install` — see its comment.
    const opts = cmd.optsWithGlobals();
    const { marketInstalled } = await import("./commands/market.js");
    await marketInstalled(opts);
  });

market
  .command("workspaces")
  .description("List your workspaces with their template-attachment status — find the one that isn't attached yet (pure read)")
  .option("--unattached", "Only show workspaces that need attention (unattached or missing a version stamp)")
  .option("--json", "Output as JSON")
  .action(async (_opts, cmd) => {
    // Same parent/child `--json` collision as `market install` — see its comment.
    const opts = cmd.optsWithGlobals();
    const { marketWorkspaces } = await import("./commands/market.js");
    await marketWorkspaces(opts);
  });

market
  .command("attach <workspaceId>")
  .description("Reconcile a marketplace template onto an existing workspace + version-stamp it — how you relink a workspace installed before the marketplace")
  .option("--slug <slug>", "Template to attach (inferred from the workspace's existing attachment or domain when omitted)")
  .option("--project <id>", "Optionally tag the reconciled entities to a project")
  .option("--timeout <seconds>", "How long to wait for the apply to finish (default: 120)")
  .option("--json", "Output as JSON")
  .option("--pod-url <url>", "Pod URL override")
  .option("--api-key <key>", "API key override")
  .action(async (workspaceId: string, _opts, cmd) => {
    // Same parent/child `--json` collision as `market install` — see its comment.
    const opts = cmd.optsWithGlobals();
    const { marketAttach } = await import("./commands/market.js");
    await marketAttach(workspaceId, opts);
  });

// ── `synap templates` — the ONE home for workspace ↔ template health ─────────
// Consolidates `market update`/`workspaces`/`installed`: one grouped, action-
// ranked view where an UNATTACHED workspace is visible (it wasn't in `update`),
// with a suggested template and a one-word attach. The `market *` subcommands
// still work — this is the front door, not a breaking rename.
const templates = program
  .command("templates")
  .description("See every workspace's template status (attached, drifted, or unattached) and connect them — the one home for template health")
  .option("--needs-attention", "Show only workspaces that need action (drifted / unstamped / unattached-with-suggestion)")
  .option("--json", "Output as JSON")
  .option("--pod-url <url>", "Pod URL override")
  .option("--api-key <key>", "API key override")
  .action(async (_opts, cmd) => {
    const opts = cmd.optsWithGlobals();
    const { marketTemplates } = await import("./commands/market.js");
    await marketTemplates(opts);
  });

templates
  .command("attach <workspace>")
  .description("Connect a workspace (by NAME or id) to a template — suggests the right one so you don't guess a slug")
  .option("--slug <slug>", "Force a specific template instead of the suggestion")
  .option("--yes", "Accept a confident (domain-match) suggestion without prompting — for scripts")
  .option("--project <id>", "Optionally tag the reconciled entities to a project")
  .option("--timeout <seconds>", "How long to wait for the apply to finish (default: 120)")
  .option("--json", "Output as JSON")
  .option("--pod-url <url>", "Pod URL override")
  .option("--api-key <key>", "API key override")
  .action(async (workspace: string, _opts, cmd) => {
    const opts = cmd.optsWithGlobals();
    const { templatesAttach } = await import("./commands/market.js");
    await templatesAttach(workspace, opts);
  });

templates
  .command("update [slugs...]")
  .alias("updates")
  .description("Apply template updates — 'update all' (or --yes) for every drifted workspace, or name specific slugs. Bare 'update' previews what's available.")
  .option("--yes", "Apply every available update without prompting (same as 'update all')")
  .option("--dry-run", "Preview only — never apply")
  .option("--timeout <seconds>", "How long to wait for each apply (default: 120)")
  .option("--json", "Output as JSON")
  .option("--pod-url <url>", "Pod URL override")
  .option("--api-key <key>", "API key override")
  .action(async (slugs: string[] | undefined, _opts, cmd) => {
    const opts = cmd.optsWithGlobals();
    // `update all` reads more naturally than `--yes` and is what people type —
    // treat the literal word "all" as "apply every available update".
    const wantsAll = !!slugs?.some((s) => s.toLowerCase() === "all");
    const explicit = (slugs ?? []).filter((s) => s.toLowerCase() !== "all");
    const { marketUpdate } = await import("./commands/market.js");
    await marketUpdate(
      explicit.length > 0 ? explicit : undefined,
      wantsAll ? { ...opts, yes: true } : opts
    );
  });

// ── Authoring loop: scaffold → validate → publish → unpublish ────────────────

market
  .command("scaffold <slug>")
  .description("Write a minimal valid <slug>.template.yaml to edit in place (refuses to overwrite)")
  .option("--kind <kind>", "Scaffold a standalone package instead of a workspace template: cell, view, or skill")
  .option("--json", "Output as JSON")
  .action(async (slug: string, _opts, cmd) => {
    // Same parent/child `--json` collision as `market install` — see its comment.
    const opts = cmd.optsWithGlobals();
    const { marketScaffold } = await import("./commands/market-authoring.js");
    await marketScaffold(slug, opts);
  });

market
  .command("validate <file>")
  .description("Validate a local template file against the shared template validator — fast author feedback")
  .option("--json", "Output the validator result as JSON")
  .action(async (file: string, _opts, cmd) => {
    // Same parent/child `--json` collision as `market install` — see its comment.
    const opts = cmd.optsWithGlobals();
    const { marketValidate } = await import("./commands/market-authoring.js");
    await marketValidate(file, opts);
  });

market
  .command("publish [file]")
  .description("Validate then publish a template (or a standalone cell/view package) to the marketplace (private by default) — pass a file, or --from-workspace <id>")
  .option("--public", "Publish as PUBLIC (default is private)")
  .option("--private", "Publish as private (the default — stated explicitly)")
  .option("--from-workspace <id>", "Serialize a live workspace into a template and publish it (instead of a file)")
  .option("--json", "Output as JSON")
  .option("--pod-url <url>", "Pod URL override (for --from-workspace)")
  .option("--api-key <key>", "API key override (for --from-workspace)")
  .action(async (file: string | undefined, _opts, cmd) => {
    // Same parent/child `--json` collision as `market install` — see its comment.
    const opts = cmd.optsWithGlobals();
    const { marketPublish } = await import("./commands/market-authoring.js");
    await marketPublish(file, opts);
  });

market
  .command("unpublish <slug>")
  .description("Flip a published package back to private (owner only)")
  .option("--json", "Output as JSON")
  .action(async (slug: string, _opts, cmd) => {
    // Same parent/child `--json` collision as `market install` — see its comment.
    const opts = cmd.optsWithGlobals();
    const { marketUnpublish } = await import("./commands/market-authoring.js");
    await marketUnpublish(slug, opts);
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
  .command("add [name]")
  .description("Install a capability from the catalog — omit the name to pick from a list")
  .option("--workspace <id>", "Workspace context")
  .action(async (name: string | undefined, opts) => {
    const { capabilityAdd } = await import("./commands/capability.js");
    await capabilityAdd(name, opts);
  });

capability
  .command("create [file]")
  .description("Create a capability from a JSON definition (file path, or pipe JSON via stdin)")
  .option("--workspace <id>", "Workspace context")
  .action(async (file: string | undefined, opts) => {
    const { capabilityCreate } = await import("./commands/capability.js");
    await capabilityCreate(file, opts);
  });

capability
  .command("rm <ids...>")
  .alias("remove")
  .description("Remove capability container(s) by id or name — member tools/skills untouched")
  .option("--workspace <id>", "Workspace context")
  .option("--force", "Skip the confirmation prompt")
  .action(async (ids: string[], opts) => {
    const { capabilityRemove } = await import("./commands/capability.js");
    await capabilityRemove(ids, opts);
  });

capability
  .command("enable [name]")
  .description("Turn on a capability — omit the name to pick from a list; ensures its connection, then pick which verbs it can do")
  .option("--workspace <id>", "Workspace context")
  .action(async (name: string | undefined, opts) => {
    const { capabilityEnable } = await import("./commands/capability.js");
    await capabilityEnable(name, opts);
  });

capability
  .command("connect [name]")
  .description("Connect a service — omit the name to pick from connectable services")
  .option("--workspace <id>", "Workspace context")
  .option(
    "--reconnect",
    "Force a fresh sign-in even if a connection already exists — fixes an expired or revoked token"
  )
  .action(async (name: string | undefined, opts) => {
    const { capabilityConnect } = await import("./commands/capability.js");
    await capabilityConnect(name, opts);
  });

capability
  .command("disconnect <name>")
  .description("Disconnect a capability's service — accepts a capability name or a provider id")
  .option("--workspace <id>", "Workspace context")
  .option("--force", "Skip confirmation")
  .action(async (name: string, opts) => {
    const { capabilityDisconnect } = await import("./commands/capability.js");
    await capabilityDisconnect(name, opts);
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
  .option("--connection <id>", "Run against a specific stored connection id")
  .option("--for <objId>", "Run against the connection bound to this context object id")
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

// ─── cap connections ──────────────────────────────────────────────────────────
// Manage a capability's stored connections (credentials / OAuth accounts /
// context bindings). Nested under `cap` — distinct from the top-level
// `synap connections`, which shows agent-surface → pod wiring.

const capConnections = capability
  .command("connections")
  .alias("conn")
  .description("Manage a capability's connections: list, add, update, rm");

capConnections
  .command("list <capability>")
  .description("List a capability's connections (label, kind, default, context, id)")
  .option("--workspace <id>", "Workspace context")
  .action(async (capability: string, opts) => {
    const { capabilityConnectionsList } = await import("./commands/cap-connections.js");
    await capabilityConnectionsList(capability, opts);
  });

capConnections
  .command("add <capability>")
  .description("Add a connection — prompts for label + masked value unless provided as flags")
  .option("--label <label>", "Connection label")
  .option("--value <value>", "Secret / credential value (else prompted, masked)")
  .option("--context-type <type>", "Context type this connection binds to")
  .option("--context-id <id>", "Context object id this connection binds to")
  .option("--account-hint <hint>", "Human-readable account hint (e.g. an email)")
  .option("--default", "Mark this connection as the capability's default")
  .option("--workspace <id>", "Workspace context")
  .action(async (capability: string, opts) => {
    const { capabilityConnectionsAdd } = await import("./commands/cap-connections.js");
    await capabilityConnectionsAdd(capability, opts);
  });

capConnections
  .command("update <capability> <connectionId>")
  .description("Update a connection's fields; --rotate (or --value) rotates its secret")
  .option("--label <label>", "New connection label")
  .option("--value <value>", "New secret / credential value")
  .option("--rotate", "Prompt (masked) for a new secret value")
  .option("--context-type <type>", "New context type")
  .option("--context-id <id>", "New context object id")
  .option("--account-hint <hint>", "New account hint")
  .option("--default", "Mark this connection as the capability's default")
  .option("--workspace <id>", "Workspace context")
  .action(async (capability: string, connectionId: string, opts) => {
    const { capabilityConnectionsUpdate } = await import("./commands/cap-connections.js");
    await capabilityConnectionsUpdate(capability, connectionId, opts);
  });

capConnections
  .command("rm <capability> <connectionId>")
  .alias("remove")
  .description("Remove a connection by id (confirms first)")
  .option("--workspace <id>", "Workspace context")
  .action(async (capability: string, connectionId: string, opts) => {
    const { capabilityConnectionsRemove } = await import("./commands/cap-connections.js");
    await capabilityConnectionsRemove(capability, connectionId, opts);
  });

// ─── raycast ──────────────────────────────────────────────────────────────────

const raycast = program
  .command("raycast", { hidden: true })
  .description(
    "(hidden) Power-user escape: generate Raycast Script Commands per capability verb"
  );

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

// Resolve a global `--pod <name>` before commander parses (it isn't registered
// per-command). Fails fast with a clear message on an unknown profile name.
try {
  bootstrapPodOverride(process.argv);
} catch (err) {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
}

// Last-resort net. Commander does not await async .action() handlers, so a
// command that throws without its own catch becomes an unhandled rejection and
// Node dumps a raw stack trace with dist/ paths at the user — e.g.
// `synap digest --workspace <inaccessible>` printed the HubError constructor
// frame. Render it through the one door instead. Commands that already catch
// and render are unaffected: this only fires when nothing else handled it.
process.on("unhandledRejection", (err: unknown) => {
  void (async () => {
    try {
      const { renderHubError } = await import("./lib/hub-client.js");
      renderHubError(err);
    } catch {
      console.error(err instanceof Error ? err.message : String(err));
    }
    process.exit(1);
  })();
});

program.parse();
