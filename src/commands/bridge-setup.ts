/**
 * synap bridge-setup  (HIDDEN)
 *
 * One-shot provisioning for the Discord ↔ Synap bridge — the terminal-native
 * "complete it all" flow. Automates everything that CAN be automated:
 *
 *   1. resolves a durable hub key + workspace from your saved pod profile
 *   2. sanity-checks pod reachability + key scope (GET /capabilities)
 *   3. applies the bridge's OWN capability definition (POST /capabilities/apply)
 *      — read from the bridge repo so there is ONE source of truth
 *   4. optionally routes the agent's proactive posts back to a Discord channel
 *   5. writes the bridge .env (pod creds + feature flags), preserving your
 *      existing Discord token / guild / relay settings
 *   6. prints the bot invite URL + the few steps only a human can do
 *
 * Hidden on purpose: this is a dogfood/dev convenience, not a first-class
 * surface. Not shown in `synap --help`.
 *
 * Usage:
 *   synap bridge-setup --client-id <discord-app-id> [--bridge-dir <path>]
 *     [--workspace-id <uuid>] [--proactive-channel <discord-channel-id>]
 *     [--enable-ingest] [--enable-react] [--pod-url <url>] [--api-key <key>]
 */

import path from "node:path";
import os from "node:os";
import fs from "node:fs";
import { createRequire } from "node:module";
import chalk from "chalk";
import ora from "ora";
import prompts from "prompts";
import { resolveHubConfig, hubGet, hubPost, hubPatch } from "../lib/hub-client.js";
import { checkPodHealth } from "../lib/pod.js";
import { log, banner } from "../utils/logger.js";

export interface BridgeSetupOpts {
  podUrl?: string;
  apiKey?: string;
  bridgeDir?: string;
  clientId?: string;
  workspaceId?: string;
  proactiveChannel?: string;
  enableIngest?: boolean;
  enableReact?: boolean;
}

const DEFAULT_BRIDGE_DIR = path.join(
  os.homedir(),
  "Documents",
  "Code",
  "telegram-discord-bridge"
);

// Bot invite permissions: View Channels + Send Messages + Read History + Add Reactions.
const BOT_PERMISSIONS = 68672;

export async function bridgeSetup(opts: BridgeSetupOpts): Promise<void> {
  banner();
  log.heading("Discord bridge — one-shot setup");

  // ── 1. Resolve durable pod credentials ──────────────────────────────────
  let cfg: Awaited<ReturnType<typeof resolveHubConfig>>;
  try {
    cfg = await resolveHubConfig({ podUrl: opts.podUrl, apiKey: opts.apiKey });
  } catch (err) {
    log.error((err as Error).message);
    log.dim("Run `synap init` or `synap pods add` first to save a pod + key.");
    process.exit(1);
  }
  if (!cfg.podUrl || !cfg.apiKey) {
    log.error("No pod URL / API key resolved. Run `synap init` first.");
    process.exit(1);
  }

  // ── 2. Pod health ────────────────────────────────────────────────────────
  const health = await checkPodHealth(cfg.podUrl);
  if (!health.healthy) {
    log.error(`Pod not reachable at ${cfg.podUrl}`);
    process.exit(1);
  }
  log.success(`Pod healthy: ${cfg.podUrl}`);

  // ── 3. Resolve workspace ───────────────────────────────────────────────
  const workspaceId = await resolveWorkspaceId(opts.workspaceId ?? cfg.workspaceId, cfg);
  if (!workspaceId) {
    log.error("Could not resolve a workspace. Pass --workspace-id <uuid>.");
    process.exit(1);
  }
  log.dim(`Workspace: ${workspaceId}`);

  // ── 3b. Key + scope sanity check (GET /capabilities needs hub-protocol.read) ─
  const probe = ora("Checking key scope…").start();
  try {
    await hubGet("/capabilities", { workspaceId }, cfg);
    probe.succeed("Key valid (hub-protocol scope OK)");
  } catch (err) {
    probe.fail("Key/scope check failed");
    log.error((err as Error).message);
    log.dim("The key may be expired or missing scope. Run `synap keys rotate` or `synap init`.");
    process.exit(1);
  }

  // ── 4. Apply the bridge's capability definition (single source of truth) ──
  const bridgeDir = opts.bridgeDir ?? DEFAULT_BRIDGE_DIR;
  await applyBridgeCapability(bridgeDir, workspaceId, cfg);

  // ── 5. Proactive delivery routing (optional) ─────────────────────────────
  if (opts.proactiveChannel) {
    await configureProactive(workspaceId, opts.proactiveChannel, cfg);
  }

  // ── 6. Write the bridge .env ─────────────────────────────────────────────
  const envPath = path.join(bridgeDir, ".env");
  const managed: Record<string, string> = {
    SYNAP_POD_URL: cfg.podUrl,
    SYNAP_HUB_API_KEY: cfg.apiKey,
    SYNAP_WORKSPACE_ID: workspaceId,
  };
  if (opts.enableIngest) managed.SYNAP_INGEST_ENABLED = "true";
  if (opts.enableReact) managed.SYNAP_REACT_CAPTURE_ENABLED = "true";
  if (opts.proactiveChannel) managed.SYNAP_PROACTIVE_CHANNEL_ID = opts.proactiveChannel;

  try {
    upsertEnv(envPath, managed);
    log.success(`Wrote pod credentials → ${envPath}`);
  } catch (err) {
    log.warn(`Could not write ${envPath}: ${(err as Error).message}`);
    log.dim("Set these manually in the bridge .env:");
    for (const [k, v] of Object.entries(managed)) {
      log.dim(`  ${k}=${k === "SYNAP_HUB_API_KEY" ? "<key>" : v}`);
    }
  }

  // ── 7. Next steps (the human-only remainder) ─────────────────────────────
  printNextSteps(opts.clientId, bridgeDir);
}

// ── Helpers ─────────────────────────────────────────────────────────────────

async function resolveWorkspaceId(
  known: string | undefined,
  cfg: Awaited<ReturnType<typeof resolveHubConfig>>
): Promise<string | undefined> {
  if (known) return known;
  let list: Array<{ id: string; name?: string }> = [];
  try {
    const res = (await hubGet("/workspaces", {}, cfg)) as unknown;
    const arr = Array.isArray(res)
      ? res
      : ((res as { workspaces?: unknown[] })?.workspaces ?? []);
    list = (arr as Array<{ id: string; name?: string }>).filter((w) => w?.id);
  } catch {
    return undefined;
  }
  if (list.length === 0) return undefined;
  if (list.length === 1) return list[0].id;
  const { ws } = await prompts({
    type: "select",
    name: "ws",
    message: "Which workspace should the bridge write into?",
    choices: list.map((w) => ({ title: `${w.name ?? "(unnamed)"}  ${chalk.dim(w.id)}`, value: w.id })),
  });
  return ws || undefined;
}

async function applyBridgeCapability(
  bridgeDir: string,
  workspaceId: string,
  cfg: Awaited<ReturnType<typeof resolveHubConfig>>
): Promise<void> {
  const spinner = ora("Applying bridge capability…").start();
  // Read the capability definition from the bridge repo — ONE source of truth.
  const capPath = path.join(bridgeDir, "src", "synapCapabilities.js");
  let definition: unknown;
  try {
    const require = createRequire(import.meta.url);
    // Bust any stale module cache so re-runs pick up edits.
    const resolved = require.resolve(capPath);
    if (require.cache && require.cache[resolved]) delete require.cache[resolved];
    const mod = require(capPath) as { CAPABILITY_DEFINITION?: unknown };
    definition = mod.CAPABILITY_DEFINITION;
  } catch (err) {
    spinner.warn("Skipped capability apply (bridge definition not found)");
    log.dim(`  Looked in: ${capPath}`);
    log.dim(`  ${(err as Error).message}`);
    log.dim("  The bridge also applies it automatically on first boot.");
    return;
  }
  if (!definition) {
    spinner.warn("Skipped capability apply (no CAPABILITY_DEFINITION export)");
    return;
  }
  try {
    const res = (await hubPost(
      "/capabilities/apply",
      { definition, workspaceId },
      cfg
    )) as { capabilityKey?: string; created?: { tools?: unknown[]; skills?: unknown[] } };
    const tools = res.created?.tools?.length ?? 0;
    const skills = res.created?.skills?.length ?? 0;
    spinner.succeed(
      `Capability applied: ${res.capabilityKey ?? "?"} (${tools} tool, ${skills} skill)`
    );
  } catch (err) {
    spinner.warn("Capability apply did not complete (the bridge will retry on boot)");
    log.dim(`  ${(err as Error).message}`);
  }
}

async function configureProactive(
  workspaceId: string,
  channelRef: string,
  cfg: Awaited<ReturnType<typeof resolveHubConfig>>
): Promise<void> {
  const spinner = ora("Routing proactive posts to Discord…").start();
  const rule = {
    surfaces: [{ kind: "external", provider: "discord", channelRef }],
  };
  try {
    await hubPatch(
      `/workspaces/${workspaceId}/delivery-preferences`,
      { deliveryPreferences: { ai_insight: rule, proactive: rule } },
      cfg
    );
    spinner.succeed(`Proactive posts → Discord channel ${channelRef}`);
    log.dim("  (Pod also needs DISCORD_BOT_TOKEN set for outbound to send.)");
  } catch (err) {
    const msg = (err as Error).message;
    if (msg.includes("404")) {
      spinner.warn("Proactive routing needs a backend deploy (door not live yet)");
    } else {
      spinner.warn(`Proactive routing skipped: ${msg}`);
    }
  }
}

/**
 * Upsert KEY=value lines into a dotenv file, preserving comments and any other
 * keys. Existing managed keys are replaced in place; new ones are appended.
 */
function upsertEnv(filePath: string, kv: Record<string, string>): void {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) {
    throw new Error(`bridge dir not found: ${dir}`);
  }
  const existing = fs.existsSync(filePath)
    ? fs.readFileSync(filePath, "utf-8")
    : "";
  const lines = existing.length ? existing.split("\n") : [];
  const remaining = new Map(Object.entries(kv));

  const out = lines.map((line) => {
    const m = line.match(/^([A-Z0-9_]+)=/);
    if (m && remaining.has(m[1])) {
      const key = m[1];
      const val = remaining.get(key)!;
      remaining.delete(key);
      return `${key}=${val}`;
    }
    return line;
  });

  if (remaining.size) {
    if (out.length && out[out.length - 1] !== "") out.push("");
    out.push("# --- Synap pod (written by `synap bridge-setup`) ---");
    for (const [k, v] of remaining) out.push(`${k}=${v}`);
  }

  fs.writeFileSync(filePath, out.join("\n"), { mode: 0o600 });
}

function printNextSteps(clientId: string | undefined, bridgeDir: string): void {
  log.blank();
  log.heading("Remaining manual steps (Discord side)");
  log.blank();
  if (clientId) {
    const url = `https://discord.com/oauth2/authorize?client_id=${clientId}&permissions=${BOT_PERMISSIONS}&scope=bot+applications.commands`;
    console.log(`  ${chalk.bold("1.")} Invite the bot (open this, pick your server):`);
    console.log(`     ${chalk.cyan(url)}`);
  } else {
    console.log(`  ${chalk.bold("1.")} Create the bot invite URL — pass ${chalk.cyan("--client-id <app-id>")} to print it.`);
  }
  console.log(`  ${chalk.bold("2.")} Developer Portal → Bot → Reset Token → put in ${chalk.dim(".env DISCORD_BOT_TOKEN")}`);
  console.log(`  ${chalk.bold("3.")} Bot → Privileged Intents → enable ${chalk.bold("MESSAGE CONTENT")}`);
  console.log(`  ${chalk.bold("4.")} Right-click server → Copy Server ID → ${chalk.dim(".env DISCORD_GUILD_ID")}`);
  console.log(`  ${chalk.bold("5.")} For proactive/agent posts: set ${chalk.dim("DISCORD_BOT_TOKEN")} on the POD too`);
  log.blank();
  console.log(`  Then: ${chalk.green(`cd ${bridgeDir} && npm run smoke && npm start`)}`);
  log.blank();
}
