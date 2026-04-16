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
  .description("Connect OpenClaw to an existing Synap pod")
  .option("--pod-url <url>", "Synap pod URL")
  .option("--api-key <key>", "Hub Protocol API key")
  .action(async (opts) => {
    const { connect } = await import("./commands/connect.js");
    await connect(opts);
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

program.parse();
