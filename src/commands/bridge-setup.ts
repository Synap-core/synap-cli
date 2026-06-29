/**
 * synap bridge-setup  (HIDDEN)
 *
 * One-shot provisioning for the Discord ↔ Synap bridge — the terminal-native
 * "complete it all" flow. Automates everything that CAN be automated:
 *
 *   1. lets you CHOOSE which saved pod the bridge connects to (kept separate
 *      from your global CLI pod via the "discord" surface override), then
 *      resolves a durable hub key + workspace from it
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
 *     [--pod <profile-name>] [--workspace-id <uuid>]
 *     [--proactive-channel <discord-channel-id>] [--enable-react]
 *     [--pod-url <url>] [--api-key <key>]
 */

import path from "node:path";
import os from "node:os";
import fs from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import chalk from "chalk";
import ora from "ora";
import prompts from "prompts";
import { resolveHubConfig, hubGet, hubPost, hubPatch, resolveUserId, type HubConfig } from "../lib/hub-client.js";
import { discoverSkillDirs, parseSkillDir, importSkill } from "../lib/skill-import.js";
import {
  checkPodHealth,
  getSurfaceAgentKey,
  setSurfaceAgentKey,
  listPodProfiles,
  getSurfacePodName,
  setSurfacePod,
} from "../lib/pod.js";
import { enrollAgentIfNeeded, ensureAgentGovernance, type GovernancePreset } from "../lib/targets.js";
import { log, banner } from "../utils/logger.js";

export interface BridgeSetupOpts {
  /** Saved pod profile to connect the bridge to (separate from the global CLI pod). */
  pod?: string;
  /** Governance preset for the agent — skips the interactive prompt when set. */
  governance?: GovernancePreset;
  podUrl?: string;
  apiKey?: string;
  bridgeDir?: string;
  clientId?: string;
  workspaceId?: string;
  proactiveChannel?: string;
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

// Bot invite permissions — the full set the bridge's features actually use.
// Bits per Discord's permission reference (https://discord.com/developers/docs/topics/permissions).
// BigInt because thread permissions exceed 2^31. Least-privilege *within* what we
// need: NO Administrator / Manage Server / Manage Roles / Kick / Ban / Mention-Everyone.
// (The privileged MESSAGE CONTENT gateway intent is enabled in the Developer Portal,
//  NOT here — invite permissions and gateway intents are separate systems.)
const BOT_PERMISSION_BITS: Record<string, bigint> = {
  VIEW_CHANNEL: 1n << 10n, // see channels/threads
  SEND_MESSAGES: 1n << 11n, // reply in channels
  SEND_MESSAGES_IN_THREADS: 1n << 38n, // reply inside threads (client-comms / team)
  CREATE_PUBLIC_THREADS: 1n << 35n, // /link-client creates the per-client threads
  CREATE_PRIVATE_THREADS: 1n << 36n, // private team threads
  MANAGE_THREADS: 1n << 34n, // archive / rename / reuse threads
  MANAGE_CHANNELS: 1n << 4n, // /link-client creates the per-client room (the missing one)
  MANAGE_MESSAGES: 1n << 13n, // pin context (Google Drive links, key messages)
  READ_MESSAGE_HISTORY: 1n << 16n, // read channel context for the agent
  ADD_REACTIONS: 1n << 6n, // react-capture
  EMBED_LINKS: 1n << 14n, // rich link/button embeds (open-in-browser deep links)
  ATTACH_FILES: 1n << 15n, // attachments (skill-from-file, exports)
  USE_EXTERNAL_EMOJIS: 1n << 18n, // richer reactions
};
const BOT_PERMISSIONS = Object.values(BOT_PERMISSION_BITS)
  .reduce((acc, bit) => acc | bit, 0n)
  .toString();

/**
 * Pick the pod the BRIDGE connects to — independent of the global CLI pod.
 *
 * The bridge is the "discord" surface, so we resolve/persist its pod via the
 * per-surface override (setSurfacePod) and NEVER touch the global activePod.
 * That lets the operator keep a personal pod as their CLI default while the
 * Discord bridge points at a different (e.g. team / client) pod.
 *
 * Order: explicit --pod-url/--api-key escape hatch → --pod <name> →
 * single saved profile (auto) → interactive picker (default = the pod already
 * assigned to the discord surface, else the CLI-active one).
 */
async function resolveBridgePod(
  opts: BridgeSetupOpts,
): Promise<{ cfg: HubConfig; podName: string | null }> {
  // 1. Raw URL+key escape hatch — bypasses profiles entirely.
  if (opts.podUrl && opts.apiKey) {
    return {
      cfg: { podUrl: opts.podUrl, apiKey: opts.apiKey, userId: process.env.SYNAP_USER_ID ?? "cli" },
      podName: null,
    };
  }

  const profiles = listPodProfiles();
  if (profiles.length === 0) {
    throw new Error(
      "No pod profiles saved. Run `synap pods add` first, or pass --pod-url and --api-key.",
    );
  }

  // 2. Resolve which profile to use.
  let chosen: { name: string; config: typeof profiles[number]["config"] } | undefined;
  if (opts.pod) {
    chosen = profiles.find((p) => p.name === opts.pod);
    if (!chosen) {
      throw new Error(
        `Pod profile '${opts.pod}' not found. Saved profiles: ${profiles.map((p) => p.name).join(", ")}`,
      );
    }
  } else if (profiles.length === 1) {
    chosen = profiles[0];
    log.dim(`Using your only saved pod profile: ${chosen.name}`);
  } else {
    const defaultName =
      getSurfacePodName("discord") ?? profiles.find((p) => p.active)?.name ?? profiles[0].name;
    const initial = Math.max(0, profiles.findIndex((p) => p.name === defaultName));
    const { picked } = await prompts({
      type: "select",
      name: "picked",
      message: "Which data pod should the bridge connect to?",
      initial,
      choices: profiles.map((p) => ({
        title: `${p.name}${p.active ? " (CLI default)" : ""}`,
        description: p.config.podUrl,
        value: p.name,
      })),
    });
    if (!picked) throw new Error("No pod selected — aborting.");
    chosen = profiles.find((p) => p.name === picked)!;
  }

  // Remember the choice for the discord surface — without changing the CLI default.
  setSurfacePod("discord", chosen.name);

  const c = chosen.config;
  return {
    cfg: {
      podUrl: c.podUrl,
      apiKey: c.hubApiKey,
      userId: c.agentUserId,
      workspaceId: c.workspaceId || undefined,
    },
    podName: chosen.name,
  };
}

export async function bridgeSetup(opts: BridgeSetupOpts): Promise<void> {
  banner();
  log.heading("Discord bridge — one-shot setup");

  // ── 1. Choose the pod the BRIDGE connects to (independent of the CLI pod) ──
  let cfg: HubConfig;
  let bridgePodName: string | null = null;
  try {
    const resolved = await resolveBridgePod(opts);
    cfg = resolved.cfg;
    bridgePodName = resolved.podName;
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
  log.success(`Pod healthy: ${cfg.podUrl}${bridgePodName ? ` (profile: ${bridgePodName})` : ""}`);

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

  // ── 4. Choose agent governance mode ──────────────────────────────────
  const discordAgentUserId = getSurfaceAgentKey("discord")?.agentUserId;
  if (discordAgentUserId) {
    await ensureAgentGovernance(cfg, discordAgentUserId, opts.governance);
  }

  // ── 4b. Apply the agency capability templates (idempotent, self-healing) ────
  await applyAgencyCapabilities(cfg, workspaceId);

  await applyAgencySkills(cfg);

  // ── 4e. Seed automation templates (idempotent, event-driven) ────────────────
  await applyAutomationTemplates(cfg, workspaceId);

  // ── 4f. React-capture is POD CONFIG now (discord tool metadata), not an env
  //        var. When --enable-react is passed, set it on the tool so the bridge
  //        reads it back from the pod — changeable later in Studio / /configure.
  if (opts.enableReact) {
    await setDiscordToolConfig(cfg, workspaceId, { reactCapture: true });
  }

  // ── 4d. Grant the bridge redeem access — token lives ONLY in the vault ─────
  let granted = false;
  if (secretId && botToken) {
    // Grant to the AGENT (the bridge's redeem identity), not the operator.
    const agentUserId = getSurfaceAgentKey("discord")?.agentUserId;
    granted = await grantRedeemAccess(secretId, cfg, agentUserId);
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

// ── Agency capability seeding ────────────────────────────────────────────────

/**
 * Secret-gating plan for agency capability templates.
 *
 * Each entry:
 *   key            — CP catalog templateKey (the pod loads the definition from there)
 *   needs          — env var that must be present to apply (null = unconditional)
 *   params         — values to pass as the `params` body field
 *   workspaceScoped — true if the capability bundles PLAYBOOKS (which require a
 *                     workspaceId); false seeds pod-wide tools/skills.
 *
 * Google is ONE capability — `nango-google` (Gmail + Calendar + Drive through a
 * single OAuth connection). discord-bot is intentionally absent: applyBridgeCapability
 * already handles it from the live bridge repo (ONE source of truth) — don't double-apply.
 */
const AGENCY_CAPABILITY_PLAN: Array<{
  key: string;
  needs: string | null;
  params: Record<string, string | undefined>;
  workspaceScoped: boolean;
}> = [
  { key: "nango-google",   needs: null,              params: {}, workspaceScoped: false },
  { key: "agency-skills",  needs: null,              params: {}, workspaceScoped: true  },
  { key: "generic-apikey", needs: null,              params: {}, workspaceScoped: false },
  {
    key: "unipile-linkedin",
    needs: "UNIPILE_API_KEY",
    params: {
      unipileApiKey:    process.env.UNIPILE_API_KEY,
      ...(process.env.UNIPILE_BASE_URL    && { unipileBaseUrl:    process.env.UNIPILE_BASE_URL }),
      ...(process.env.UNIPILE_ACCOUNT_ID  && { unipileAccountId:  process.env.UNIPILE_ACCOUNT_ID }),
    },
    workspaceScoped: false,
  },
  {
    key: "telegram-bridge",
    needs: "TELEGRAM_BOT_TOKEN",
    params: { telegramBotToken: process.env.TELEGRAM_BOT_TOKEN },
    workspaceScoped: false,
  },
];

/**
 * Resolve the automations templates directory.
 *
 * Resolution order:
 *   1. AUTOMATION_TEMPLATES_DIR env var (override for CI / custom installs)
 *   2. Monorepo-relative default: <cli-package-root>/../../synap-backend/templates/automations
 *
 * Returns null when the directory is absent (e.g. published npx with no monorepo),
 * or the backend hasn't created the templates yet — caller skips and warns.
 */
function resolveAutomationsTemplatesDir(): string | null {
  if (process.env.AUTOMATION_TEMPLATES_DIR) {
    const override = process.env.AUTOMATION_TEMPLATES_DIR;
    return fs.existsSync(override) ? override : null;
  }
  const thisFile = fileURLToPath(import.meta.url);
  const cliRoot = path.resolve(path.dirname(thisFile), "..", "..");
  const candidate = path.resolve(cliRoot, "..", "synap-backend", "templates", "automations");
  return fs.existsSync(candidate) ? candidate : null;
}

/**
 * Apply the agency capability templates idempotently via the Control Plane catalog.
 *
 * - POSTs to /capabilities/apply with { templateKey, params, workspaceId? }; the
 *   pod loads the definition from the CP catalog (the single source of truth — no
 *   local template files anymore).
 * - workspaceScoped capabilities (those bundling PLAYBOOKS, which the backend
 *   rejects pod-wide with "playbooks require a workspaceId") pass workspaceId so
 *   the playbooks land in the chosen workspace. Pod-wide tools/skills omit it so
 *   the browser's capabilities view and the agent see them everywhere.
 * - Skips secret-backed templates when the required env var is absent.
 * - Skips discord-bot (already applied via applyBridgeCapability).
 * - Logs a concise per-template result line (applied / reused / skipped).
 * - NEVER throws — errors are warned so the overall setup continues.
 */
async function applyAgencyCapabilities(
  cfg: Awaited<ReturnType<typeof resolveHubConfig>>,
  workspaceId: string
): Promise<void> {
  log.dim("Seeding agency capabilities from the Control Plane catalog…");

  for (const item of AGENCY_CAPABILITY_PLAN) {
    if (item.needs && !process.env[item.needs]) {
      log.dim(`  [skip] ${item.key} — set ${item.needs} to seed it`);
      continue;
    }

    try {
      const res = (await hubPost(
        "/capabilities/apply",
        item.workspaceScoped
          ? { templateKey: item.key, params: item.params, workspaceId }
          : { templateKey: item.key, params: item.params },
        cfg
      )) as {
        capabilityKey?: string;
        created?: {
          container?: { name?: string; status?: string };
          tools?: Array<{ name?: string; status?: string }>;
          skills?: Array<{ name?: string; status?: string }>;
        };
      };
      const container = res.created?.container;
      const tools = res.created?.tools?.length ?? 0;
      const skills = res.created?.skills?.length ?? 0;
      const containerLabel = container
        ? `${container.name}(${container.status})`
        : "—";
      log.dim(
        `  [ok]   ${item.key.padEnd(18)} container=${containerLabel} tools=${tools} skills=${skills}`
      );
    } catch (err) {
      log.warn(`  [error] ${item.key} — ${(err as Error).message}`);
    }
  }
}

// ── Agency skill seeding (instruction skills) ──────────────────────────────

/**
 * Resolve the bundled skills templates directory (standard SKILL.md dirs).
 * Shared with `synap skill add --bundled` via resolveBundledSkillsDir.
 */
export function resolveBundledSkillsDir(): string | null {
  const thisFile = fileURLToPath(import.meta.url);
  const cliRoot = path.resolve(path.dirname(thisFile), "..", "..");
  const candidate = path.resolve(cliRoot, "templates", "skills");
  return fs.existsSync(candidate) ? candidate : null;
}

/**
 * Seed the bundled Synap-native skills from templates/skills/ (standard SKILL.md
 * directories). Each becomes a pod-wide instruction skill via /agent-skills/import;
 * references/ files become linked documents. Idempotent (slug-unique guard).
 */
async function applyAgencySkills(
  cfg: Awaited<ReturnType<typeof resolveHubConfig>>
): Promise<void> {
  const skillsDir = resolveBundledSkillsDir();
  if (!skillsDir) { log.warn("Bundled skill templates not found — skipping."); return; }

  const userId = await resolveUserId(cfg);
  const dirs = discoverSkillDirs(skillsDir);
  log.dim(`Seeding ${dirs.length} bundled skill(s) from ${skillsDir}…`);

  for (const dir of dirs) {
    const parsed = parseSkillDir(dir);
    if (!parsed) continue;
    const res = await importSkill(parsed, userId, cfg);
    const marker =
      res.status === "error" ? "!!" : res.status === "exists" ? "skip" : "ok";
    const tag =
      res.status === "exists" ? "already seeded"
      : res.status === "error" ? `[error] ${res.error}`
      : `imported${res.docs ? ` · ${res.docs} docs` : ""}`;
    const line = `  [${marker}]${" ".repeat(Math.max(1, 5 - marker.length))}${parsed.slug.padEnd(34)} ${tag}`;
    if (res.status === "error") log.warn(line);
    else log.dim(line);
  }
}

// ── Automation template seeding ─────────────────────────────────────────────

/**
 * Automation template shape expected in each *.automation.json file.
 */
interface AutomationTemplate {
  name: string;
  triggerType: string;
  status: string;
  triggerConfig: Record<string, unknown>;
  flowDefinition: {
    nodes: Array<{ id: string; type: string; data: Record<string, unknown>; [k: string]: unknown }>;
    edges: Array<Record<string, unknown>>;
  };
  metadata?: Record<string, unknown>;
}

/**
 * Apply automation templates from synap-backend/templates/automations/*.automation.json.
 *
 * For each file:
 *  - Find existing automation by name (GET /automations); skip if already present.
 *  - If the flowDefinition contains a `skill` node, resolve its skillId by name
 *    (GET /skills) and inject it into the node's data.skillId before POSTing.
 *    If the skill is not found, logs a warning but still creates the automation.
 *  - Never throws — errors are warned so setup continues.
 */
/**
 * Set behavioral config on the `discord` tool's metadata (the pod-resident config
 * home — read back by the bridge at runtime). Idempotent: merges into the existing
 * metadata.discord. Best-effort — never throws (setup continues if the tool isn't
 * found yet). Uses PATCH /tools/:id which does NOT reset tool approval for metadata.
 */
async function setDiscordToolConfig(
  cfg: Awaited<ReturnType<typeof resolveHubConfig>>,
  workspaceId: string,
  patch: Record<string, unknown>
): Promise<void> {
  try {
    const res = (await hubGet("/tools", { workspaceId }, cfg)) as {
      tools?: Array<{ id: string; name?: string; metadata?: Record<string, unknown> }>;
    };
    const tool = (res?.tools ?? []).find((t) => t?.name === "discord");
    if (!tool?.id) {
      log.dim("  [skip] discord tool not found — config will use defaults");
      return;
    }
    const meta = (tool.metadata ?? {}) as Record<string, unknown>;
    const discord = (meta.discord ?? {}) as Record<string, unknown>;
    const nextMeta = { ...meta, discord: { ...discord, ...patch } };
    await hubPatch(`/tools/${tool.id}`, { metadata: nextMeta }, cfg);
    log.success(`Discord config updated (${Object.keys(patch).join(", ")})`);
  } catch (err) {
    log.warn(`Could not set discord tool config: ${(err as Error).message}`);
  }
}

async function applyAutomationTemplates(
  cfg: Awaited<ReturnType<typeof resolveHubConfig>>,
  workspaceId: string
): Promise<void> {
  const templatesDir = resolveAutomationsTemplatesDir();
  if (!templatesDir) {
    log.warn(
      "Automation templates dir not found — skipping. " +
      "Set AUTOMATION_TEMPLATES_DIR=<path> to seed from a custom location."
    );
    return;
  }

  const files = fs.readdirSync(templatesDir).filter((f) => f.endsWith(".automation.json"));
  if (files.length === 0) {
    log.dim("No *.automation.json templates found — skipping automation seeding.");
    return;
  }

  log.dim(`Seeding ${files.length} automation template(s) from ${templatesDir}…`);

  const userId = await resolveUserId(cfg);

  // Fetch existing automations once (avoid N+1 round-trips).
  let existingAutos: Array<{ id: string; name: string }> = [];
  try {
    const res: unknown = await hubGet("/automations", { userId, workspaceId }, cfg);
    existingAutos = Array.isArray(res) ? res : ((res as { automations?: typeof existingAutos })?.automations ?? []);
  } catch (err) {
    log.warn(`Could not fetch existing automations: ${(err as Error).message}`);
  }

  // Fetch existing skills once — needed for skill-node injection.
  let existingSkills: Array<{ id: string; name: string }> = [];
  try {
    const res: unknown = await hubGet("/skills", { userId, workspaceId }, cfg);
    existingSkills = Array.isArray(res) ? res : ((res as { skills?: typeof existingSkills })?.skills ?? []);
  } catch (err) {
    log.warn(`Could not fetch existing skills: ${(err as Error).message}`);
  }

  for (const file of files) {
    const filePath = path.join(templatesDir, file);
    let tpl: AutomationTemplate;
    try {
      tpl = JSON.parse(fs.readFileSync(filePath, "utf-8")) as AutomationTemplate;
    } catch (err) {
      log.warn(`  [error] ${file} — could not parse: ${(err as Error).message}`);
      continue;
    }

    // Idempotent: skip if already exists by name.
    const existing = existingAutos.find((a) => a.name === tpl.name);
    if (existing) {
      log.dim(`  [skip]  ${tpl.name} — already seeded (id=${existing.id})`);
      continue;
    }

    // Inject skillId into any skill nodes that reference a skill by name.
    // Skills are seeded by applyAgencySkills() BEFORE this runs, so a missing
    // skill means seeding failed — creating a skill-less automation would be a
    // silent runtime failure. Skip the automation loudly instead.
    const flow = tpl.flowDefinition;
    let missingSkill: string | null = null;
    for (const node of flow.nodes) {
      if (node.type === "skill") {
        const skillName = (node.data as { skillName?: string }).skillName;
        if (skillName) {
          const match = existingSkills.find((s) => s.name === skillName);
          if (match) {
            node.data = { ...node.data, skillId: match.id };
          } else {
            missingSkill = skillName;
          }
        }
      }
    }
    if (missingSkill) {
      log.warn(
        `  [skip]  ${tpl.name} — required skill "${missingSkill}" not seeded; ` +
        "skipping (re-run after the skill is created, else the automation would fail at runtime).",
      );
      continue;
    }

    try {
      const newAuto: unknown = await hubPost("/automations/create", {
        userId,
        workspaceId,
        name: tpl.name,
        triggerType: tpl.triggerType,
        status: tpl.status,
        triggerConfig: tpl.triggerConfig,
        flowDefinition: flow,
        metadata: { ...(tpl.metadata ?? {}), source: "bridge-setup" },
      }, cfg);
      const autoId = (newAuto as { id?: string })?.id;
      if (autoId) {
        log.dim(`  [ok]    ${tpl.name} — created (id=${autoId})`);
      } else if ((newAuto as { status?: string })?.status === "proposed") {
        // These are operator-installed TEMPLATES, not AI-authored automations —
        // so apply them directly as the user instead of leaving a proposal. The
        // operator is the one running bridge-setup, so we approve their own
        // template-install proposal (POST /proposals/:id/approve runs as the
        // caller = the operator), materializing the automation attributed to them.
        const proposalId = (newAuto as { proposalId?: string }).proposalId;
        if (proposalId) {
          try {
            await hubPost(`/proposals/${proposalId}/approve`, {}, cfg);
            log.dim(`  [ok]    ${tpl.name} — applied (template)`);
          } catch (approveErr) {
            log.warn(
              `  [proposed] ${tpl.name} (${proposalId}) — auto-approve failed ` +
              `(${(approveErr as Error).message}); approve it in Synap Studio.`,
            );
          }
        } else {
          log.warn(`  [proposed] ${tpl.name} — no proposalId returned; approve it in Synap Studio.`);
        }
      } else {
        log.warn(`  [warn]  ${tpl.name} — unexpected response: ${JSON.stringify(newAuto)}`);
      }
    } catch (err) {
      log.warn(`  [error] ${tpl.name} — ${(err as Error).message}`);
    }
  }
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
    const msg = (err as Error).message;
    spinner.fail("Capability apply failed");
    log.error(`  ${msg}`);
    if (botToken) {
      // The bot token MUST be vaulted for the bridge to run — continuing to write
      // a .env and printing "Done" would leave a crash-looping bridge (redeem
      // 404). A frequent cause is a missing/empty VAULT_SERVER_KEY on the target
      // pod's backend (the vault can't encrypt). Fail loud at SETUP time instead.
      if (/VAULT_SERVER_KEY/i.test(msg)) {
        log.dim("  The target pod's secret vault is not configured.");
        log.dim("  Set a durable VAULT_SERVER_KEY (openssl rand -hex 32) in the pod's");
        log.dim("  deploy/.env, redeploy the backend, then re-run bridge-setup.");
      }
      process.exit(1);
    }
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
  cfg: Awaited<ReturnType<typeof resolveHubConfig>>,
  agentUserId?: string
): Promise<boolean> {
  const spinner = ora("Granting the bridge redeem access…").start();
  try {
    // The bridge redeems AS the agent: the backend binds redemption to the
    // agent key's userId (linkedUserId remap → vault_grants.granted_to must be
    // the AGENT, not the operator). Granting to the operator leaves the bridge
    // with no_grant. Fall back to the operator only if the agent id is unknown.
    const principal = agentUserId || (await resolveUserId(cfg));
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
