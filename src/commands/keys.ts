/**
 * synap keys — Manage pod API keys
 *
 * Subcommands: rotate, templates, create, list, revoke
 *
 * `create` never mints: it files a key request the person approves on
 * pod-admin, then collects the key once (`lib/key-request.ts`). `list` and
 * `revoke` reach only the keys this computer requested.
 */

import { writeFileAtomic, writeSecretFile, ensureSecretDir } from "../lib/atomic-file.js";
import { redactKey } from "../lib/mcp-snippets.js";
import chalk from "chalk";
import ora from "ora";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { resolveHubConfig, hubPost, HubError, renderHubError } from "../lib/hub-client.js";
import {
  collectRequestedKey,
  listKeyTemplates,
  listRequestedKeys,
  parseKeyTtl,
  revokeRequestedKey,
  startKeyRequest,
  type CollectKeyDeps,
  type RequestedKey,
  type RequestedKeySecret,
} from "../lib/key-request.js";
import { openPodPage, podAdminOrigin } from "../lib/safe-open.js";
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

  writeFileAtomic(CONFIG_FILE, JSON.stringify(config, null, 2), { mode: 0o600 });
}

// ── Public: keysRotate ────────────────────────────────────────────────────────

export interface KeysRotateOpts {
  podUrl?: string;
  showKey?: boolean;
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
    if (opts.showKey) {
      log.dim(`Set it manually: SYNAP_HUB_API_KEY=${result.apiKey}`);
    } else {
      // The old key is already revoked, so the new one must not be lost — keep it
      // in a 0600 file instead of the terminal scrollback.
      const dir = path.join(os.homedir(), ".synap");
      const file = path.join(dir, "rotated-key.env");
      ensureSecretDir(dir);
      writeSecretFile(file, `SYNAP_HUB_API_KEY=${result.apiKey}\n`, { mode: 0o600 });
      log.dim(`New key ${redactKey(result.apiKey)} saved to ${file} (0600). Use --show-key to print it.`);
    }
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

// ── Key requests (keys plan §3.6) ─────────────────────────────────────────────

/** The variable a saved key is written as, unless `--env-name` says otherwise. */
export const DEFAULT_KEY_ENV_NAME = "SYNAP_API_KEY";

async function hubConfigOrExit(): Promise<HubCfg | null> {
  try {
    return await resolveHubConfig();
  } catch (err) {
    log.error((err as Error).message);
    process.exitCode = 1;
    return null;
  }
}

const day = (iso: string | null): string => (iso ? iso.slice(0, 10) : "never");

/**
 * Write `NAME=key` into `file` (0600), keeping its other lines and replacing
 * an earlier `NAME=` / `export NAME=` line.
 */
export function writeKeyEnvFile(file: string, envName: string, apiKey: string): void {
  const earlier = new RegExp(`^(export\\s+)?${envName}=`);
  const text = fs.existsSync(file) ? fs.readFileSync(file, "utf-8").replace(/\n+$/, "") : "";
  const kept = text ? text.split("\n").filter((l) => !earlier.test(l)) : [];
  fs.mkdirSync(path.dirname(file), { recursive: true });
  writeSecretFile(file, [...kept, `${envName}=${apiKey}`].join("\n") + "\n", { mode: 0o600 });
}

export interface KeysTemplatesOpts {
  json?: boolean;
}

export async function keysTemplates(opts: KeysTemplatesOpts = {}): Promise<void> {
  const cfg = await hubConfigOrExit();
  if (!cfg) return;
  try {
    const templates = await listKeyTemplates(cfg);
    if (opts.json) {
      console.log(JSON.stringify(templates, null, 2));
      return;
    }
    log.heading("Key templates");
    for (const t of templates) {
      const lifetime =
        t.expiresInDays === null ? "never expires" : t.expiresInDays ? `${t.expiresInDays} days` : "pod default lifetime";
      console.log(`  ${chalk.bold(t.id)}  ${t.name}${t.stored ? chalk.dim(" (yours)") : ""}`);
      console.log(`    ${chalk.dim(`${t.description} · ${lifetime}`)}`);
    }
    log.blank();
    log.dim("Ask for one: synap keys create --template <id>");
  } catch (err) {
    renderHubError(err);
    process.exitCode = 1;
  }
}

export interface KeysCreateOpts {
  template: string;
  name?: string;
  ttl?: string;
  space?: string;
  /** Write the key into this file (0600) instead of ~/.synap/keys/. */
  envFile?: string;
  envName?: string;
  /** Print the key once instead of saving it. */
  showKey?: boolean;
  json?: boolean;
}

export interface KeysCreateDeps extends CollectKeyDeps {
  /** Opens the review page; default the system browser. */
  openUrl?: (url: string) => void;
}

export async function keysCreate(opts: KeysCreateOpts, deps: KeysCreateDeps = {}): Promise<void> {
  let expiresInDays: number | null | undefined;
  try {
    expiresInDays = parseKeyTtl(opts.ttl);
  } catch (err) {
    log.error((err as Error).message);
    process.exitCode = 1;
    return;
  }
  const envName = opts.envName ?? DEFAULT_KEY_ENV_NAME;
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(envName)) {
    log.error(`--env-name must be a variable name (letters, digits, _), not "${envName}".`);
    process.exitCode = 1;
    return;
  }
  const cfg = await hubConfigOrExit();
  if (!cfg) return;

  let start;
  try {
    start = await startKeyRequest(cfg, {
      template: opts.template,
      ...(opts.name ? { name: opts.name } : {}),
      ...(expiresInDays !== undefined ? { expiresInDays } : {}),
      ...(opts.space ? { workspaceId: opts.space } : {}),
    });
  } catch (err) {
    renderHubError(err);
    process.exitCode = 1;
    return;
  }

  // The link is always printed (a headless box opens it elsewhere) and opened
  // only when it is on this pod or its pod-admin (`openPodPage`).
  const say = opts.json ? (m: string) => console.error(m) : (m: string) => console.log(m);
  say(`\n  Approve the key on your pod:`);
  say(`    ${start.review_url}`);
  openPodPage(start.review_url, cfg.podUrl, deps.openUrl);
  process.stderr.write(chalk.dim("  Waiting for approval"));
  const ticker = setInterval(() => process.stderr.write(chalk.dim(".")), 2000);
  let outcome;
  try {
    outcome = await collectRequestedKey(cfg, start, deps);
  } finally {
    clearInterval(ticker);
    process.stderr.write("\n");
  }

  if (outcome.status === "denied") {
    log.error("The key was denied on the review page. Nothing was made.");
    process.exitCode = 1;
    return;
  }
  if (outcome.status === "expired") {
    log.error("The request expired before it was approved. Run the command again.");
    process.exitCode = 1;
    return;
  }

  const key: RequestedKeySecret = outcome.key;
  let savedTo: string | undefined;
  if (opts.envFile || !opts.showKey) {
    savedTo = opts.envFile ? path.resolve(opts.envFile) : path.join(os.homedir(), ".synap", "keys", `${key.keyId}.env`);
    try {
      if (!opts.envFile) ensureSecretDir(path.dirname(savedTo));
      writeKeyEnvFile(savedTo, envName, key.apiKey);
    } catch (err) {
      // The key exists now and cannot be shown again: never lose it silently.
      log.error(`The key was made but could not be saved to ${savedTo}: ${(err as Error).message}`);
      log.hint(`Revoke it with: synap keys revoke ${key.keyId}   then run the command again.`);
      process.exitCode = 1;
      return;
    }
  }

  if (opts.json) {
    console.log(
      JSON.stringify(
        {
          keyId: key.keyId,
          keyPrefix: key.keyPrefix,
          name: key.name,
          scopes: key.scopes,
          expiresAt: key.expiresAt,
          ...(savedTo ? { savedTo, envName } : { apiKey: key.apiKey }),
        },
        null,
        2
      )
    );
    return;
  }
  log.success(`Key "${key.name}" made: ${redactKey(key.apiKey)}, expires ${day(key.expiresAt)}.`);
  if (savedTo) {
    log.dim(`Saved to ${savedTo} (0600) as ${envName}. The full key is not printed here.`);
  } else {
    console.log();
    console.log(chalk.yellow("  This is the only time the key is shown:"));
    console.log(`  ${key.apiKey}`);
    console.log();
  }
  log.dim(`Revoke it with: synap keys revoke ${key.keyId}`);
}

export interface KeysListOpts {
  json?: boolean;
}

function keyState(k: RequestedKey, now = Date.now()): string {
  if (k.revokedAt) return "revoked";
  if (k.expiresAt && Date.parse(k.expiresAt) <= now) return "expired";
  return "active";
}

export async function keysList(opts: KeysListOpts = {}): Promise<void> {
  const cfg = await hubConfigOrExit();
  if (!cfg) return;
  let keys: RequestedKey[];
  try {
    keys = await listRequestedKeys(cfg);
  } catch (err) {
    renderHubError(err);
    process.exitCode = 1;
    return;
  }
  if (opts.json) {
    console.log(JSON.stringify(keys, null, 2));
    return;
  }
  const admin = podAdminOrigin(cfg.podUrl);
  if (keys.length === 0) {
    log.info("This computer has not requested any key yet. Ask for one: synap keys create --template <id>");
  } else {
    log.heading("Keys this computer requested");
    for (const k of keys) {
      const state = keyState(k);
      const mark = state === "active" ? chalk.green(state) : chalk.dim(state);
      console.log(`  ${chalk.bold(k.name)}  ${chalk.dim(`${k.keyPrefix}…`)}  ${mark}`);
      console.log(
        `    ${chalk.dim(`id ${k.keyId} · from ${k.templateId} · made ${day(k.createdAt)} · expires ${day(k.expiresAt)} · last used ${k.lastUsedAt ? day(k.lastUsedAt) : "never"}`)}`
      );
    }
  }
  if (admin) log.dim(`Your other keys are on ${admin}/keys`);
}

export async function keysRevoke(keyId: string): Promise<void> {
  const cfg = await hubConfigOrExit();
  if (!cfg) return;
  try {
    await revokeRequestedKey(cfg, keyId);
    log.success(`Key ${keyId} revoked.`);
  } catch (err) {
    if (err instanceof HubError && err.status === 404) {
      const admin = podAdminOrigin(cfg.podUrl);
      log.error(`Key ${keyId} is not one this computer requested.`);
      log.hint(admin ? `Your other keys are on ${admin}/keys` : "Revoke your other keys on your pod's keys page.");
    } else {
      renderHubError(err);
    }
    process.exitCode = 1;
  }
}
