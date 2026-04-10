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
  .description("Complete setup after OpenClaw finishes provisioning")
  .action(async () => {
    const { finish } = await import("./commands/finish.js");
    await finish();
  });

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
  .action(async () => {
    const { update } = await import("./commands/update.js");
    await update();
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
