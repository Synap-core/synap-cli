/**
 * synap keys — Manage pod API keys
 *
 * Subcommands: rotate
 */

import chalk from "chalk";
import ora from "ora";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { resolveHubConfig, hubPost, HubError, renderHubError } from "../lib/hub-client.js";
import { log } from "../utils/logger.js";

// ── Types ─────────────────────────────────────────────────────────────────────

type HubCfg = Awaited<ReturnType<typeof resolveHubConfig>>;

interface RotateCliResponse {
  apiKey: string;
  keyId: string;
  scopes: string[];
}

// ── Helpers ───────────────────────────────────────────────────────────────────

const CONFIG_FILE = path.join(os.homedir(), ".synap", "config.json");

function updateConfigKey(newApiKey: string): void {
  const raw = fs.readFileSync(CONFIG_FILE, "utf-8");
  const config = JSON.parse(raw) as Record<string, unknown>;

  const activePod = config.activePod as string | undefined;
  const pods = config.pods as Record<string, Record<string, unknown>> | undefined;

  if (activePod && pods && pods[activePod]) {
    pods[activePod].hubApiKey = newApiKey;
    config.pods = pods;
  }

  fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2), { mode: 0o600 });
}

// ── Public: keysRotate ────────────────────────────────────────────────────────

export interface KeysRotateOpts {
  podUrl?: string;
}

export async function keysRotate(opts: KeysRotateOpts): Promise<void> {
  let cfg: HubCfg;
  try {
    cfg = await resolveHubConfig({ podUrl: opts.podUrl });
  } catch (err) {
    log.error((err as Error).message);
    process.exit(1);
  }

  const spinner = ora({ text: "Rotating CLI key…", color: "cyan" }).start();

  let result: RotateCliResponse;
  try {
    result = (await hubPost("/keys/rotate-cli", {}, cfg)) as RotateCliResponse;
    spinner.succeed(chalk.green("Key rotated"));
  } catch (err) {
    spinner.fail(chalk.red("Failed to rotate key"));
    if (err instanceof HubError && (err.status === 401 || err.status === 403)) {
      log.error("The current key is already invalid (401/403).");
      log.dim("Run `synap init` to fully re-provision your credentials.");
    } else {
      renderHubError(err);
    }
    process.exit(1);
  }

  // Update config file and current process env
  try {
    updateConfigKey(result.apiKey);
  } catch (err) {
    log.warn(`Key rotated but could not update config file: ${(err as Error).message}`);
    log.dim(`Set it manually: SYNAP_HUB_API_KEY=${result.apiKey}`);
  }

  process.env.SYNAP_HUB_API_KEY = result.apiKey;

  // Print scope table
  console.log();
  log.heading("New key details");
  console.log();
  console.log(`  ${chalk.dim("Key ID:")}  ${result.keyId}`);
  console.log();

  if (result.scopes && result.scopes.length > 0) {
    console.log(`  ${chalk.dim("Scopes:")}`);
    for (const scope of result.scopes) {
      console.log(`    ${chalk.green("✓")} ${scope}`);
    }
  } else {
    console.log(`  ${chalk.dim("Scopes: (none returned)")}`);
  }
  console.log();
}
