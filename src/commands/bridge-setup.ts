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
import { resolveHubConfig, hubGet, hubPost, hubPatch, resolveUserId } from "../lib/hub-client.js";
import { checkPodHealth, getSurfaceAgentKey, setSurfaceAgentKey } from "../lib/pod.js";
import { enrollAgentIfNeeded } from "../lib/targets.js";
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
  /** Discord bot token — provisioned INTO the pod vault (not a loose env var). */
  botToken?: string;
  /** Discord server (guild) id — written to the bridge .env. */
  guildId?: string;
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
  const workspaceId = await resolveWorkspaceId(opts.workspaceId, cfg.workspaceId, cfg);
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

  // ── 3c. Provision a Discord AGENT key linked to the operator ──────────────
  // The bridge must run as a real backend agent — NOT with the operator's raw
  // key. An agent key carries linkedUserId=<operator>; the backend remaps its
  // reads to the operator's data floor (hub-protocol-rest.ts auth middleware)
  // while attributing writes to the agent for governed proposals. All the
  // operator-key work below (capability apply, vault grant) keeps using `cfg`.
  const agentKey = await provisionDiscordAgentKey(cfg.podUrl, cfg.apiKey, cfg.workspaceId);

  // ── 4. Provision the capability (vault credential + tool + skill) ─────────
  const bridgeDir = opts.bridgeDir ?? DEFAULT_BRIDGE_DIR;
  const botToken = await resolveBotToken(opts.botToken);
  const { vaultRef, secretId } = await applyBridgeCapability(
    bridgeDir,
    workspaceId,
    cfg,
    botToken
  );

  // ── 4b. Grant the bridge redeem access — token lives ONLY in the vault ─────
  let granted = false;
  if (secretId && botToken) {
    granted = await grantRedeemAccess(secretId, cfg);
  }

  // ── 5. Proactive delivery routing (optional) ─────────────────────────────
  if (opts.proactiveChannel) {
    await configureProactive(workspaceId, opts.proactiveChannel, cfg);
  }

  // ── 6. Write the bridge .env ─────────────────────────────────────────────
  const envPath = path.join(bridgeDir, ".env");
  const managed: Record<string, string> = {
    SYNAP_POD_URL: cfg.podUrl,
    // The bridge runs as the Discord AGENT (linked to the operator), not with
    // the operator's raw key. Reads remap to the operator floor; writes are
    // governed as the agent.
    SYNAP_HUB_API_KEY: agentKey,
    SYNAP_WORKSPACE_ID: workspaceId,
  };
  // The token is NEVER written to .env — it lives in the pod vault and the
  // bridge redeems it on boot via this ref. (Requires the grant below to land;
  // if it didn't, we warn loudly rather than leaking the token to env.)
  if (vaultRef) managed.SYNAP_DISCORD_TOKEN_REF = vaultRef;
  if (opts.guildId) managed.DISCORD_GUILD_ID = opts.guildId;
  if (opts.enableIngest) managed.SYNAP_INGEST_ENABLED = "true";
  if (opts.enableReact) managed.SYNAP_REACT_CAPTURE_ENABLED = "true";
  if (opts.proactiveChannel) managed.SYNAP_PROACTIVE_CHANNEL_ID = opts.proactiveChannel;

  try {
    // Once the token is in the vault, purge any stale env copy of it.
    upsertEnv(envPath, managed, vaultRef ? ["DISCORD_BOT_TOKEN"] : []);
    log.success(`Wrote pod credentials → ${envPath}`);
  } catch (err) {
    log.warn(`Could not write ${envPath}: ${(err as Error).message}`);
    log.dim("Set these manually in the bridge .env:");
    for (const [k, v] of Object.entries(managed)) {
      log.dim(`  ${k}=${k === "SYNAP_HUB_API_KEY" ? "<key>" : v}`);
    }
  }

  // ── 7. Next steps (the human-only remainder) ─────────────────────────────
  // Re-running without --guild-id is fine: the upsert preserves an existing
  // DISCORD_GUILD_ID. Treat that as "have guild" so we don't nag.
  const envHasGuild =
    fs.existsSync(envPath) &&
    /^DISCORD_GUILD_ID=.+/m.test(fs.readFileSync(envPath, "utf-8"));
  printNextSteps(opts.clientId, bridgeDir, {
    hasToken: Boolean(botToken),
    hasGuild: Boolean(opts.guildId) || envHasGuild,
    vaultRef,
    granted,
  });
}

// ── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Provision (or reuse) a Discord AGENT key linked to the operator.
 *
 * Mirrors the claude-code flow in `lib/targets.ts` (writeClaudeCodeEnv) which
 * handles the write-once-key reality of POST /api/hub/setup/agent:
 *   - First mint (idempotent:true, no prior agent) → returns { hubApiKey }.
 *   - Re-run (agent already exists)               → returns { alreadyValid:true }
 *     with NO key (the key is never re-transmitted).
 *
 * So on the idempotent path we must reuse the previously stored agent key, and
 * self-heal (reprovision) only if it's missing or no longer resolves to the
 * agent. The resulting key carries linkedUserId=<operator>, so the backend
 * remaps its reads/redeems to the operator's data floor.
 *
 * @param podUrl      Pod base URL.
 * @param operatorKey The operator's raw hub key (authorizes the provisioning).
 * @param workspaceId Workspace to enroll the agent into (omit for all).
 * @returns the Discord agent key to write as SYNAP_HUB_API_KEY.
 */
async function provisionDiscordAgentKey(
  podUrl: string,
  operatorKey: string,
  workspaceId: string | undefined
): Promise<string> {
  const spinner = ora("Provisioning Discord agent key…").start();
  const podBase = podUrl.replace(/\/$/, "");

  const setupRes = await fetch(`${podBase}/api/hub/setup/agent`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${operatorKey}` },
    body: JSON.stringify({ agentType: "discord", idempotent: true }),
    signal: AbortSignal.timeout(30000),
  });
  if (!setupRes.ok) {
    spinner.fail("Could not provision the Discord agent key");
    const text = await setupRes.text().catch(() => setupRes.statusText);
    log.error(`POST /api/hub/setup/agent failed (HTTP ${setupRes.status}): ${text.slice(0, 300)}`);
    log.dim("The operator key may be expired or missing scope. Run `synap keys rotate` or `synap init`.");
    process.exit(1);
  }
  const setup = (await setupRes.json()) as {
    hubApiKey?: string;
    agentUserId?: string;
    alreadyValid?: boolean;
  };

  let effectiveKey: string;
  let agentUserId = setup.agentUserId ?? "";

  if (setup.alreadyValid) {
    // Idempotent path — pod says the agent exists but does NOT re-transmit the
    // key. Reuse the stored Discord agent key; verify it resolves to the agent.
    const stored = getSurfaceAgentKey("discord");
    const candidate = stored?.hubApiKey ?? null;
    const expectedAgentUserId = setup.agentUserId ?? stored?.agentUserId;
    let candidateIsValid = false;

    if (candidate && expectedAgentUserId) {
      try {
        // auth/status returns the key's actual owner userId; for an agent key
        // this is the agent userId (users/me would return the operator).
        const verifyRes = await fetch(`${podBase}/api/hub/auth/status`, {
          headers: { Authorization: `Bearer ${candidate}` },
          signal: AbortSignal.timeout(30000),
        });
        if (verifyRes.ok) {
          const status = (await verifyRes.json()) as { userId?: string };
          candidateIsValid = status.userId === expectedAgentUserId;
        }
      } catch { /* reprovision below */ }
    }

    if (candidateIsValid && candidate) {
      effectiveKey = candidate;
      agentUserId = expectedAgentUserId ?? agentUserId;
      spinner.succeed("Reusing existing Discord agent key");
    } else {
      // Stored key is stale, wrong identity, or never persisted → reprovision
      // (no idempotent flag) to mint a fresh agent key.
      const reproRes = await fetch(`${podBase}/api/hub/setup/agent`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${operatorKey}` },
        body: JSON.stringify({ agentType: "discord" }),
        signal: AbortSignal.timeout(30000),
      });
      if (reproRes.ok) {
        const repro = (await reproRes.json()) as { hubApiKey?: string; agentUserId?: string };
        if (!repro.hubApiKey) {
          spinner.fail("Reprovision returned no key");
          log.error("setup/agent reprovision succeeded but returned no hubApiKey — check pod logs.");
          process.exit(1);
        }
        effectiveKey = repro.hubApiKey;
        agentUserId = repro.agentUserId ?? agentUserId;
        spinner.succeed("Reprovisioned a fresh Discord agent key (stored key was stale)");
      } else {
        spinner.fail("Could not reprovision the Discord agent key");
        const text = await reproRes.text().catch(() => reproRes.statusText);
        log.error(`POST /api/hub/setup/agent failed (HTTP ${reproRes.status}): ${text.slice(0, 300)}`);
        process.exit(1);
      }
    }
  } else {
    // First mint — the key is only ever returned here.
    if (!setup.hubApiKey) {
      spinner.fail("Provisioning returned no key");
      log.error("setup/agent succeeded but returned no hubApiKey — check pod logs.");
      process.exit(1);
    }
    effectiveKey = setup.hubApiKey;
    spinner.succeed("Discord agent key provisioned");
  }

  // Persist so a re-run can reuse it (the key is never re-transmitted).
  setSurfaceAgentKey("discord", { hubApiKey: effectiveKey, agentUserId });

  // Enroll the agent user into the operator's workspace(s) using the OPERATOR
  // key (before the bridge ever uses the agent key).
  await enrollAgentIfNeeded(podUrl, operatorKey, agentUserId, workspaceId);

  return effectiveKey;
}

async function resolveWorkspaceId(
  explicit: string | undefined,
  defaultWs: string | undefined,
  cfg: Awaited<ReturnType<typeof resolveHubConfig>>
): Promise<string | undefined> {
  // An explicit --workspace-id wins outright. Otherwise ALWAYS ask (with the
  // saved profile workspace pre-selected) — the operator must consciously pick
  // the workspace every channel + entity the bridge creates will live in (e.g.
  // your CRM workspace), instead of silently inheriting the saved default.
  if (explicit) return explicit;
  let list: Array<{ id: string; name?: string }> = [];
  try {
    const res = (await hubGet("/workspaces", {}, cfg)) as unknown;
    const arr = Array.isArray(res)
      ? res
      : ((res as { workspaces?: unknown[] })?.workspaces ?? []);
    list = (arr as Array<{ id: string; name?: string }>).filter((w) => w?.id);
  } catch {
    return defaultWs;
  }
  if (list.length === 0) return defaultWs;
  if (list.length === 1) return list[0].id;
  const defaultIdx = defaultWs ? list.findIndex((w) => w.id === defaultWs) : -1;
  const { ws } = await prompts({
    type: "select",
    name: "ws",
    message: "Which workspace should the bridge write into? (channels + entities land here)",
    choices: list.map((w) => ({ title: `${w.name ?? "(unnamed)"}  ${chalk.dim(w.id)}`, value: w.id })),
    initial: defaultIdx >= 0 ? defaultIdx : 0,
  });
  return (ws as string) || defaultWs;
}

async function resolveBotToken(provided?: string): Promise<string | undefined> {
  if (provided) return provided;
  const { token } = await prompts({
    type: "password",
    name: "token",
    message: "Discord bot token (stored in the pod vault; leave blank to skip):",
  });
  return (token as string) || undefined;
}

async function applyBridgeCapability(
  bridgeDir: string,
  workspaceId: string,
  cfg: Awaited<ReturnType<typeof resolveHubConfig>>,
  botToken: string | undefined
): Promise<{ vaultRef?: string; secretId?: string }> {
  const spinner = ora("Provisioning capability…").start();
  // Read the capability definition from the bridge repo — ONE source of truth.
  const capPath = path.join(bridgeDir, "src", "synapCapabilities.js");
  let rawDef: unknown;
  try {
    const require = createRequire(import.meta.url);
    const resolved = require.resolve(capPath);
    if (require.cache && require.cache[resolved]) delete require.cache[resolved];
    const mod = require(capPath) as { CAPABILITY_DEFINITION?: unknown };
    rawDef = mod.CAPABILITY_DEFINITION;
  } catch (err) {
    spinner.fail("Capability definition not found");
    log.dim(`  Looked in: ${capPath}`);
    log.dim(`  ${(err as Error).message}`);
    return {};
  }
  if (!rawDef) {
    spinner.fail("No CAPABILITY_DEFINITION export in the bridge");
    return {};
  }

  // Deep-clone + inject the bot token into the vault credential. With no token,
  // drop the vault + credentialRef so we never store an empty/placeholder secret.
  const def = JSON.parse(JSON.stringify(rawDef)) as {
    vault?: Array<{ ref?: string; value?: string }>;
    tools?: Array<{ credentialRef?: string }>;
  };
  if (botToken) {
    for (const v of def.vault ?? []) {
      if (typeof v.value === "string") {
        v.value = v.value.replace("{{botToken}}", botToken);
      }
    }
  } else {
    // No token → drop the vault and any tool credentialRef that referenced it
    // (a bare template-local ref or a vault:// string), so we never store a
    // placeholder secret or leave a dangling reference.
    const vaultRefs = new Set(
      (def.vault ?? []).map((v) => v.ref).filter((r): r is string => Boolean(r))
    );
    delete def.vault;
    for (const t of def.tools ?? []) {
      if (
        t.credentialRef &&
        (vaultRefs.has(t.credentialRef) || t.credentialRef.startsWith("vault://"))
      ) {
        delete t.credentialRef;
      }
    }
    spinner.text = "Provisioning capability (no token → structure only)…";
  }

  try {
    const res = (await hubPost(
      "/capabilities/apply",
      { definition: def, workspaceId },
      cfg
    )) as {
      capabilityKey?: string;
      created?: {
        vault?: Array<{ vaultRef?: string; secretId?: string }>;
        tools?: unknown[];
        skills?: unknown[];
      };
    };
    const tools = res.created?.tools?.length ?? 0;
    const skills = res.created?.skills?.length ?? 0;
    const vaultRef = res.created?.vault?.[0]?.vaultRef;
    const secretId = res.created?.vault?.[0]?.secretId;
    spinner.succeed(
      `Capability provisioned: ${res.capabilityKey ?? "?"} (${vaultRef ? "vault + " : ""}${tools} tool, ${skills} skill)`
    );
    return { vaultRef, secretId };
  } catch (err) {
    spinner.fail("Capability apply failed (pod creds still written below)");
    log.dim(`  ${(err as Error).message}`);
    return {};
  }
}

/**
 * Grant the bridge principal redeem access to the bot-token secret — the headless
 * equivalent of the UI "grant access" flow, using the user's own credentials.
 * After this, the token lives ONLY in the vault; the bridge redeems it on boot.
 */
async function grantRedeemAccess(
  secretId: string,
  cfg: Awaited<ReturnType<typeof resolveHubConfig>>
): Promise<boolean> {
  const spinner = ora("Granting the bridge redeem access…").start();
  try {
    const principal = await resolveUserId(cfg);
    const res = (await hubPost(
      `/vault/secrets/${secretId}/grant`,
      { grantedTo: principal, scope: "permanent" },
      cfg
    )) as { grantId?: string; reused?: boolean };
    spinner.succeed(
      `Redeem access granted${res.reused ? " (existing)" : ""} — token stays in the vault`
    );
    return Boolean(res.grantId);
  } catch (err) {
    const msg = (err as Error).message;
    if (msg.includes("404")) {
      spinner.warn("Grant door not deployed yet — deploy the backend, then re-run this command");
    } else {
      spinner.warn(`Grant skipped: ${msg}`);
    }
    return false;
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
function upsertEnv(
  filePath: string,
  kv: Record<string, string>,
  remove: string[] = []
): void {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) {
    throw new Error(`bridge dir not found: ${dir}`);
  }
  const existing = fs.existsSync(filePath)
    ? fs.readFileSync(filePath, "utf-8")
    : "";
  const lines = existing.length ? existing.split("\n") : [];
  const remaining = new Map(Object.entries(kv));
  const removeSet = new Set(remove);

  const out: string[] = [];
  for (const line of lines) {
    const m = line.match(/^([A-Z0-9_]+)=/);
    if (m && removeSet.has(m[1])) continue; // drop purged keys entirely
    if (m && remaining.has(m[1])) {
      const key = m[1];
      out.push(`${key}=${remaining.get(key)!}`);
      remaining.delete(key);
    } else {
      out.push(line);
    }
  }

  if (remaining.size) {
    if (out.length && out[out.length - 1] !== "") out.push("");
    out.push("# --- Synap pod (written by `synap bridge-setup`) ---");
    for (const [k, v] of remaining) out.push(`${k}=${v}`);
  }

  fs.writeFileSync(filePath, out.join("\n"), { mode: 0o600 });
}

function printNextSteps(
  clientId: string | undefined,
  bridgeDir: string,
  state: { hasToken: boolean; hasGuild: boolean; vaultRef?: string; granted: boolean }
): void {
  log.blank();
  log.heading("Done");
  log.blank();
  if (state.vaultRef && state.granted) {
    console.log(`  ${chalk.green("✓")} Bot token in the pod vault, bridge granted redeem access — no env token  ${chalk.dim(state.vaultRef)}`);
  } else if (state.vaultRef && state.hasToken) {
    console.log(`  ${chalk.yellow("⚠")} Token stored in the vault (${chalk.dim(state.vaultRef)}) but the redeem GRANT did not land.`);
    console.log(`     Deploy the backend (grant door) and re-run — the bridge can't log in until the grant exists.`);
  }
  console.log(
    `  ${chalk.green("✓")} Bridge .env written (pod creds${state.hasGuild ? " + guild" : ""}; token stays in the vault)`
  );
  log.blank();
  log.heading("Remaining (Discord portal — human only)");
  log.blank();
  if (clientId) {
    const url = `https://discord.com/oauth2/authorize?client_id=${clientId}&permissions=${BOT_PERMISSIONS}&scope=bot+applications.commands`;
    console.log(`  ${chalk.bold("•")} Invite the bot (open, pick your server):`);
    console.log(`     ${chalk.cyan(url)}`);
  } else {
    console.log(`  ${chalk.bold("•")} Invite URL — re-run with ${chalk.cyan("--client-id <app-id>")} to print it.`);
  }
  console.log(`  ${chalk.bold("•")} Bot → Privileged Intents → enable ${chalk.bold("MESSAGE CONTENT")}`);
  if (!state.hasToken) {
    console.log(`  ${chalk.bold("•")} Token not provisioned — re-run with ${chalk.cyan("--bot-token <token>")} (stores it in the vault)`);
  }
  if (!state.hasGuild) {
    console.log(`  ${chalk.bold("•")} Server ID — re-run with ${chalk.cyan("--guild-id <id>")} (or set DISCORD_GUILD_ID)`);
  }
  log.blank();
  console.log(`  Then: ${chalk.green(`cd ${bridgeDir} && npm run smoke && npm start`)}`);
  log.blank();
}
