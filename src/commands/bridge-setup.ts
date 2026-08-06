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
 * The bridge lands data POD-WIDE by default. An OPTIONAL project scope can be
 * picked interactively (or via --project-id); --workspace-id remains an
 * advanced/legacy escape hatch to pin a single workspace, never prompted.
 *
 * Usage:
 *   synap bridge-setup --client-id <discord-app-id> [--bridge-dir <path>]
 *     [--pod <profile-name>] [--workspace-id <uuid>] [--project-id <uuid>]
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
import { unwrapList } from "../lib/unwrapList.js";
import { fetchProjects } from "../lib/project.js";
import { discoverSkillDirs, parseSkillDir, importSkill } from "../lib/skill-import.js";
import {
  checkPodHealth,
  getSurfaceAgentKey,
  setSurfaceAgentKey,
  listPodProfiles,
  getSurfacePodName,
  setSurfacePod,
  podNotFoundError,
} from "../lib/pod.js";
import {
  enrollAgentIfNeeded,
  ensureAgentGovernance,
  provisionAgentKey,
  configureAgentContext,
  type GovernancePreset,
} from "../lib/targets.js";
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
  /** Advanced/legacy escape hatch — pins the bridge to one workspace instead of pod-wide. */
  workspaceId?: string;
  /** Scopes the bridge to one project (peer lens to workspace). Skips the project prompt. */
  projectId?: string;
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
  MANAGE_EVENTS: 1n << 33n, // create native Discord scheduled events (calendar → events sync)
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
    if (!chosen) throw podNotFoundError(opts.pod);
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

  // ── 3. Resolve scope — pod-wide by default, workspace/project optional ───
  const { workspaceId, projectId } = await resolveScope(opts, cfg);
  log.dim(workspaceId ? `Workspace: ${workspaceId} (explicit pin)` : "Workspace: pod-wide (no pin)");
  if (projectId) log.dim(`Project: ${projectId}`);

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

  // ── 4b. Seed the bundled instruction skills FIRST, then the capabilities ────
  // Order matters: the `stellar-scf-grants-advisor` skill now ALSO ships embedded
  // in the stellar-grant-client capability (so a plain `packages/apply` install
  // stands it up with NO bridge-setup). Seeding the bundled SKILL.md dir first
  // attaches its full reference-doc corpus; the capability apply below then
  // REUSES that same pod-scoped skill row by name (create-from-definition is
  // idempotent) instead of creating a docless instruction-only copy.
  await applyAgencySkills(cfg);

  // ── 4c. Apply the agency capability templates (idempotent, self-healing) ────
  await applyAgencyCapabilities(cfg, workspaceId);

  // ── 4e. Seed the GENERIC automation templates (idempotent, event-driven) ────
  // Only the domain-agnostic automations live in templates/automations/ now
  // (mail-feed, url/bookmark capture). The grant-specific automations
  // (stellar-grant-provision + proactive-grant-review) SHIP INSIDE the
  // stellar-grant-client capability's automations[] (seeded above via
  // applyAgencyCapabilities), so any install door — including a plain
  // packages/apply with no bridge-setup — stands them up. Thread the operator's
  // chosen proactive channel through — output nodes pin their post target with it
  // when it's a Synap channels.id (see the note in applyAutomationTemplates).
  await applyAutomationTemplates(cfg, workspaceId, opts.proactiveChannel);

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
  // Delivery preferences live ON a workspace — pod-wide has none to route to.
  if (opts.proactiveChannel && workspaceId) {
    await configureProactive(workspaceId, opts.proactiveChannel, cfg);
  } else if (opts.proactiveChannel) {
    log.warn("Proactive routing needs a workspace — pass --workspace-id to enable it.");
  }

  // ── 6. Write the bridge .env ─────────────────────────────────────────────
  const envPath = path.join(bridgeDir, ".env");
  const managed: Record<string, string> = {
    SYNAP_POD_URL: cfg.podUrl,
    // The bridge runs as the Discord AGENT (linked to the operator), not with
    // the operator's raw key. Reads remap to the operator floor; writes are
    // governed as the agent.
    SYNAP_HUB_API_KEY: agentKey,
  };
  // Pod-wide by default: SYNAP_WORKSPACE_ID/SYNAP_PROJECT_ID are only written
  // when the operator explicitly pinned a workspace (--workspace-id) or chose
  // a project in the picker. Neither is required.
  if (workspaceId) managed.SYNAP_WORKSPACE_ID = workspaceId;
  if (projectId) managed.SYNAP_PROJECT_ID = projectId;
  // The token is NEVER written to .env — it lives in the pod vault and the
  // bridge redeems it on boot via this ref. (Requires the grant below to land;
  // if it didn't, we warn loudly rather than leaking the token to env.)
  if (vaultRef) managed.SYNAP_DISCORD_TOKEN_REF = vaultRef;
  if (opts.guildId) managed.DISCORD_GUILD_ID = opts.guildId;
  if (opts.proactiveChannel) managed.SYNAP_PROACTIVE_CHANNEL_ID = opts.proactiveChannel;

  try {
    // Once the token is in the vault, purge any stale env copy of it. Also
    // purge a stale scope pin from a prior run — re-running pod-wide (no
    // --workspace-id / no project picked) must actually clear an old pin.
    const removeKeys = [
      ...(vaultRef ? ["DISCORD_BOT_TOKEN"] : []),
      ...(workspaceId ? [] : ["SYNAP_WORKSPACE_ID"]),
      ...(projectId ? [] : ["SYNAP_PROJECT_ID"]),
    ];
    upsertEnv(envPath, managed, removeKeys);
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

  await printSynapNextSteps(cfg, workspaceId);
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
  { key: "nango-google",        needs: null,         params: {}, workspaceScoped: false },
  { key: "agency-skills",       needs: null,         params: {}, workspaceScoped: true  },
  // stellar-grant-client bundles the grant PLAYBOOK, all four grant AUTOMATIONS
  // (including stellar-grant-provision + proactive-grant-review, moved here from
  // templates/automations/), and the stellar-scf-grants-advisor SKILL — so one
  // capability apply stands up the whole grant operation on ANY install door.
  { key: "stellar-grant-client", needs: null,        params: {}, workspaceScoped: true  },
  // Cal.com scheduling connector — requires a `calApiKey` param (a `cal_live_...`
  // token), so gate it like the other keyed connectors: skip gracefully unless
  // CALCOM_API_KEY is set. Seeds the `cal_com` tool + booking skills + vault key,
  // which the Cal.com booking→CRM webhook/backfill pipeline depends on.
  { key: "cal-com",             needs: "CALCOM_API_KEY", params: { calApiKey: process.env.CALCOM_API_KEY }, workspaceScoped: false },
  // Generic API-key connector — requires an `apiKey` param, so gate it like the
  // other keyed connectors: skip gracefully unless GENERIC_API_KEY is set (else
  // the applier 500s with "requires parameter apiKey").
  { key: "generic-apikey",      needs: "GENERIC_API_KEY", params: { apiKey: process.env.GENERIC_API_KEY }, workspaceScoped: false },
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
 * Resolve the automations templates directory — CLI-BUNDLED (like the skills at
 * templates/skills). The backend stays agnostic: it ships no feature templates;
 * automation config is bundled with the CLI that seeds it.
 *
 * Resolution order:
 *   1. AUTOMATION_TEMPLATES_DIR env var (override for CI / custom installs)
 *   2. CLI-bundled default: <cli-package-root>/templates/automations
 */
function resolveAutomationsTemplatesDir(): string | null {
  if (process.env.AUTOMATION_TEMPLATES_DIR) {
    const override = process.env.AUTOMATION_TEMPLATES_DIR;
    return fs.existsSync(override) ? override : null;
  }
  const thisFile = fileURLToPath(import.meta.url);
  const cliRoot = path.resolve(path.dirname(thisFile), "..", "..");
  const candidate = path.resolve(cliRoot, "templates", "automations");
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
  workspaceId: string | undefined
): Promise<void> {
  log.dim("Seeding agency capabilities from the Control Plane catalog…");

  for (const item of AGENCY_CAPABILITY_PLAN) {
    if (item.needs && !process.env[item.needs]) {
      log.dim(`  [skip] ${item.key} — set ${item.needs} to seed it`);
      continue;
    }
    // Playbook-bundling capabilities require a workspace to land in — pod-wide
    // (no --workspace-id) has none, so skip rather than round-trip a known 4xx.
    if (item.workspaceScoped && !workspaceId) {
      log.dim(`  [skip] ${item.key} — bundles playbooks; pass --workspace-id to seed it`);
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
  /** Per-automation persistent config — seeded into the automation's `state`. */
  state?: Record<string, unknown>;
}

/**
 * Static structural validation of an automation flow, run at seed time. Catches
 * the silent-failure class the engine can't warn about at runtime: a template
 * reference to a step that doesn't exist (resolves to ""), a condition node
 * whose out-edges carry no sourceHandle (the branch prune becomes a no-op — both
 * branches run, the exact link-gate bug), and a cycle (throws at runtime).
 * Returns human-readable issue strings; the caller logs them warn-only.
 */
export function validateFlowStructure(flow: {
  nodes: Array<{ id: string; type: string; data: Record<string, unknown> }>;
  edges: Array<Record<string, unknown>>;
}): string[] {
  const issues: string[] = [];
  const nodeIds = new Set(flow.nodes.map((n) => n.id));
  const ROOTS = new Set(["trigger", "steps", "automation", "loop", "item"]);

  // 1. Every {{ ... }} reference has a known root, and steps.<id> targets a real node.
  const collect = (v: unknown, acc: string[]): void => {
    if (typeof v === "string") {
      for (const m of v.matchAll(/\{\{([^}]+)\}\}/g)) acc.push(m[1].trim());
    } else if (Array.isArray(v)) {
      for (const x of v) collect(x, acc);
    } else if (v && typeof v === "object") {
      for (const x of Object.values(v as Record<string, unknown>)) collect(x, acc);
    }
  };
  for (const node of flow.nodes) {
    const refs: string[] = [];
    collect(node.data, refs);
    // condition/switch expressions use BARE paths (no {{ }}), e.g.
    // `steps.detect.output.x === true` — scan them for step refs too.
    if (node.type === "condition" || node.type === "switch") {
      const expr = (node.data as { expression?: string }).expression;
      if (typeof expr === "string") {
        for (const m of expr.matchAll(/\b(steps\.[\w-]+(?:\.[\w-]+)*)/g)) refs.push(m[1]);
      }
    }
    for (const ref of refs) {
      const [root, stepId] = ref.split(".");
      if (!ROOTS.has(root)) {
        issues.push(
          `node "${node.id}" references unknown root {{${ref}}} (expected ${[...ROOTS].join("/")})`,
        );
      } else if (root === "steps" && stepId && !nodeIds.has(stepId)) {
        issues.push(`node "${node.id}" references missing step "${ref}" — no node "${stepId}"`);
      }
    }
  }

  // 2. Condition out-edges must carry a sourceHandle, else pruning is a silent no-op.
  for (const node of flow.nodes) {
    if (node.type !== "condition") continue;
    const out = flow.edges.filter((e) => (e as { source?: string }).source === node.id);
    const handled = out.filter((e) => typeof (e as { sourceHandle?: string }).sourceHandle === "string");
    if (out.length > 0 && handled.length === 0) {
      issues.push(
        `condition node "${node.id}" has out-edges but none carry a sourceHandle ("yes"/"no") — the branch prune is a silent no-op (both branches run)`,
      );
    }
  }

  // 3. Cycle detection (Kahn) — a cycle throws at runtime.
  const inDeg = new Map<string, number>();
  const adj = new Map<string, string[]>();
  for (const n of flow.nodes) {
    inDeg.set(n.id, 0);
    adj.set(n.id, []);
  }
  for (const e of flow.edges) {
    const s = (e as { source?: string }).source;
    const t = (e as { target?: string }).target;
    if (s && t && adj.has(s) && inDeg.has(t)) {
      adj.get(s)!.push(t);
      inDeg.set(t, (inDeg.get(t) ?? 0) + 1);
    }
  }
  const queue = [...inDeg.entries()].filter(([, d]) => d === 0).map(([id]) => id);
  let visited = 0;
  while (queue.length) {
    const id = queue.shift()!;
    visited++;
    for (const t of adj.get(id) ?? []) {
      inDeg.set(t, inDeg.get(t)! - 1);
      if (inDeg.get(t) === 0) queue.push(t);
    }
  }
  if (visited < flow.nodes.length) {
    issues.push(
      `flow has a cycle — ${flow.nodes.length - visited} node(s) cannot be ordered (would throw at runtime)`,
    );
  }

  return issues;
}

/**
 * Set behavioral config on the `discord` tool's metadata (the pod-resident config
 * home — read back by the bridge at runtime). Idempotent: merges into the existing
 * metadata.discord. Best-effort — never throws (setup continues if the tool isn't
 * found yet). Uses PATCH /tools/:id which does NOT reset tool approval for metadata.
 */
async function setDiscordToolConfig(
  cfg: Awaited<ReturnType<typeof resolveHubConfig>>,
  workspaceId: string | undefined,
  patch: Record<string, unknown>
): Promise<void> {
  try {
    const res = (await hubGet("/tools", { workspaceId }, cfg)) as {
      tools?: Array<{ id: string; name?: string; metadata?: Record<string, unknown> }>;
    };
    const tool = unwrapList<{ id: string; name?: string; metadata?: Record<string, unknown> }>(res, ["tools"]).find((t) => t?.name === "discord");
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

/** Matches a Synap channels.id / connection id (a UUID) — distinct from a raw
 *  Discord snowflake, which is a numeric string. */
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Best-effort: resolve the pod's Google/Nango connection id — the `secrets` row
 * id the automation executor expects in `connectionSelector.connectionId` (it
 * verifies the id belongs to the nango-google capability + the acting user).
 *
 * Finds the nango-google capability container (by name) then its default (or
 * first) connection. Returns null when Google isn't connected yet or the door
 * isn't deployed — capability nodes then fall back to default-connection
 * resolution at runtime. Never throws.
 */
async function resolveGoogleConnectionId(
  cfg: Awaited<ReturnType<typeof resolveHubConfig>>,
  workspaceId: string | undefined
): Promise<string | null> {
  try {
    const res = await hubGet("/capabilities/containers", { workspaceId }, cfg);
    const containers = unwrapList<{ id: string; name?: string }>(res, ["capabilities"]);
    const google = containers.find((c) => /google/i.test(c.name ?? ""));
    if (!google?.id) return null;
    const connRes = await hubGet(`/capabilities/${google.id}/connections`, {}, cfg);
    const conns = unwrapList<{ id: string; isDefault?: boolean }>(connRes, ["connections"]);
    if (conns.length === 0) return null;
    return (conns.find((c) => c.isDefault) ?? conns[0]).id;
  } catch {
    return null;
  }
}

/**
 * Apply automation templates from the CLI-bundled templates/automations/*.automation.json.
 *
 * For each file:
 *  - Fill placeholders + validate references in the flowDefinition:
 *      · `skill`      node → resolve data.skillId by data.skillName (GET /skills).
 *      · `capability` node → validate data.verbId against the seeded skills (a verb
 *        IS a skill name); fill an empty/placeholder connectionSelector.connectionId
 *        with the pod's Google connection id (dropped when Google isn't connected).
 *      · `output`     node → fill config.channelId only with a Synap channels.id
 *        (UUID); the Discord snowflake goes elsewhere, so a non-UUID drops the
 *        placeholder for the channelType fallback.
 *    A required skill or verb that isn't seeded → WARN + skip that automation (a
 *    dangling reference would fail at runtime), mirroring the skill-node handling.
 *  - UPSERT by name: PATCH /automations/:id when it already exists, else
 *    POST /automations/create. Idempotent — re-running updates in place.
 *  - Aborts (never partial) if the prerequisite skills/automations fetch fails.
 */
async function applyAutomationTemplates(
  cfg: Awaited<ReturnType<typeof resolveHubConfig>>,
  workspaceId: string | undefined,
  feedChannelId?: string
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
    existingAutos = unwrapList<{ id: string; name: string }>(res, ["automations"]);
  } catch (err) {
    // Abort rather than proceed on an empty list: a transient fetch error would
    // make every template take the create path → duplicate automations on re-run.
    log.warn(
      `Could not fetch existing automations — aborting seeding: ${(err as Error).message}`
    );
    return;
  }

  // Fetch existing skills once — needed for skill-node injection.
  let existingSkills: Array<{ id: string; name: string }> = [];
  try {
    const res: unknown = await hubGet("/skills", { userId, workspaceId }, cfg);
    existingSkills = unwrapList<{ id: string; name: string }>(res, ["skills"]);
  } catch (err) {
    // Abort rather than proceed on an empty list: every skill/verb reference would
    // resolve to "missing" and ALL automations would be wrongly skipped.
    log.warn(
      `Could not fetch existing skills — aborting seeding: ${(err as Error).message}`
    );
    return;
  }

  // Resolve the Google/Nango connection id once — capability nodes pin their
  // mailbox/drive with it. Null when Google isn't connected yet (nodes then use
  // the default connection at runtime).
  const googleConnectionId = await resolveGoogleConnectionId(cfg, workspaceId);

  for (const file of files) {
    const filePath = path.join(templatesDir, file);
    let tpl: AutomationTemplate;
    try {
      tpl = JSON.parse(fs.readFileSync(filePath, "utf-8")) as AutomationTemplate;
    } catch (err) {
      log.warn(`  [error] ${file} — could not parse: ${(err as Error).message}`);
      continue;
    }

    // ── Fill placeholders + validate references ──────────────────────────────
    // A "placeholder" is an empty string or an <angle-bracket> token. Skill/verb
    // references are seeded BEFORE this runs (applyAgencySkills / applyAgency-
    // Capabilities), so a missing one means seeding failed — a dangling reference
    // would fail at runtime, so we skip that automation loudly instead of seeding
    // a dead one (mirrors the original skill-node handling).
    const flow = tpl.flowDefinition;
    const isPlaceholder = (v: unknown): boolean =>
      typeof v === "string" && (v.trim() === "" || /^<.*>$/.test(v.trim()));
    let missing: string | null = null;

    for (const node of flow.nodes) {
      // `skill` node → resolve skillId by name.
      if (node.type === "skill") {
        const skillName = (node.data as { skillName?: string }).skillName;
        if (skillName) {
          const match = existingSkills.find((s) => s.name === skillName);
          if (match) node.data = { ...node.data, skillId: match.id };
          else missing ??= `skill "${skillName}"`;
        }
      }

      // `capability` node → validate verbId (a verb IS a seeded skill NAME) and
      // fill an empty/placeholder connection id with the Google/Nango connection.
      if (node.type === "capability") {
        const data = node.data as {
          verbId?: string;
          connectionSelector?: { connectionId?: string };
        };
        if (data.verbId && !existingSkills.some((s) => s.name === data.verbId)) {
          missing ??= `verb "${data.verbId}"`;
        }
        const sel = data.connectionSelector;
        if (sel && isPlaceholder(sel.connectionId)) {
          if (googleConnectionId) {
            node.data = {
              ...node.data,
              connectionSelector: { ...sel, connectionId: googleConnectionId },
            };
          } else {
            // No Google connected yet — DROP the placeholder key so the executor's
            // default-connection resolution kicks in. Leaving a `<...>` literal
            // would be treated as a real id and rejected. Symmetric with channelId.
            const { connectionId: _drop, ...restSel } = sel;
            node.data = { ...node.data, connectionSelector: restSel };
          }
        }
      }

      // `output` node → fill an empty/placeholder config.channelId. NOTE: the
      // executor treats config.channelId as a Synap `channels.id` (UUID), NOT a
      // Discord snowflake — so only a UUID `feedChannelId` is pinned here. When
      // it isn't one, drop the placeholder so the node's `channelType` fallback
      // ('proactive'/'personal_thread') auto-resolves the user's feed channel,
      // which mirrors out to the bound Discord channel. Keeps the automation LIVE.
      if (node.type === "output") {
        const data = node.data as {
          config?: { channelId?: string; channelType?: string };
        };
        const config = data.config;
        if (config && isPlaceholder(config.channelId)) {
          if (feedChannelId && UUID_RE.test(feedChannelId)) {
            node.data = { ...node.data, config: { ...config, channelId: feedChannelId } };
          } else if (config.channelType) {
            const { channelId: _drop, ...restConfig } = config;
            node.data = { ...node.data, config: restConfig };
          } else {
            log.warn(
              `  [warn]  ${tpl.name} — output node "${node.id}" has a placeholder ` +
              "channelId and no channelType fallback; its post target is unresolved.",
            );
          }
        }
      }
    }

    if (missing) {
      log.warn(
        `  [skip]  ${tpl.name} — required ${missing} not seeded; skipping ` +
        "(re-run after it exists, else the automation would fail at runtime).",
      );
      continue;
    }

    // Structural validation (warn-only): surface silent-failure footguns the
    // runtime can't warn about — dangling step refs, handle-less condition
    // edges, cycles. Warn (don't skip) so a valid-but-imperfect template still
    // seeds; a genuinely broken one is now visible at seed time, not silently.
    for (const issue of validateFlowStructure(flow)) {
      log.warn(`  [warn]  ${tpl.name} — ${issue}`);
    }

    // ── UPSERT by name (idempotent — re-running updates in place) ─────────────
    const body = {
      userId,
      workspaceId,
      name: tpl.name,
      triggerType: tpl.triggerType,
      status: tpl.status,
      triggerConfig: tpl.triggerConfig,
      flowDefinition: flow,
      metadata: { ...(tpl.metadata ?? {}), source: "bridge-setup" },
      ...(tpl.state ? { state: tpl.state } : {}),
    };

    const existing = existingAutos.find((a) => a.name === tpl.name);
    if (existing) {
      try {
        await hubPatch(`/automations/${existing.id}`, body, cfg);
        log.dim(`  [ok]    ${tpl.name} — updated (id=${existing.id})`);
        log.dim(
          `           ${tpl.status === "draft" ? "review + activate" : "open"} → ${cfg.podUrl}/open/${existing.id}`
        );
      } catch (err) {
        log.warn(`  [error] ${tpl.name} — update failed: ${(err as Error).message}`);
      }
      continue;
    }

    try {
      const newAuto: unknown = await hubPost("/automations/create", body, cfg);
      const autoId = (newAuto as { id?: string })?.id;
      if (autoId) {
        log.dim(`  [ok]    ${tpl.name} — created (id=${autoId})`);
        log.dim(
          `           ${tpl.status === "draft" ? "review + activate" : "open"} → ${cfg.podUrl}/open/${autoId}`
        );
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
 * Provision a Discord AGENT key linked to the operator, via the shared
 * `provisionAgentKey()` wrapper (same door every target in `lib/targets.ts`
 * uses). The resulting key carries linkedUserId=<operator>, so the backend
 * remaps its reads/redeems to the operator's data floor.
 *
 * NOTE — behavior change from the previous hand-rolled version: this always
 * mints a FRESH key (provisionAgentKey sends `idempotent: false`), whereas the
 * old code reused the stored key across re-runs (`idempotent: true`) and only
 * reprovisioned when it no longer validated. Re-running `bridge-setup` now
 * rotates the Discord agent's key every time — a running bridge process must
 * be restarted to pick up the new key. `requireApproval: false` (mirroring
 * `mcp.ts`'s `mcp url` provisioning) keeps this a one-shot, non-interactive
 * mint rather than opening a browser approval wait on every run.
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

  let hubApiKey: string;
  let agentUserId: string;
  try {
    // idempotent: true — REUSE the existing valid key rather than rotate it. A live
    // bridge holds this key in its .env; minting fresh would revoke it and 401 the
    // bridge until it's redeployed. provisionAgentKey now handles the pod's
    // { alreadyValid: true } reuse response by recovering the plaintext from local
    // storage (verified), so re-running bridge-setup does NOT force a redeploy. It
    // only mints fresh when there's no valid local key to reuse (new machine).
    const result = await provisionAgentKey(podUrl, operatorKey, "discord", {
      requireApproval: false,
      idempotent: true,
    });
    hubApiKey = result.hubApiKey;
    agentUserId = result.agentUserId;
    spinner.succeed(
      result.reused
        ? "Discord agent key reused (same key — no rotation, no bridge restart needed)"
        : "Discord agent key minted (new key — redeploy the bridge to pick it up)"
    );
  } catch (err) {
    spinner.fail("Could not provision the Discord agent key");
    log.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }

  // Persist so downstream steps (governance lookup, .env write) can read it back.
  setSurfaceAgentKey("discord", { hubApiKey, agentUserId });

  // Enroll the agent user into the operator's workspace(s) using the OPERATOR
  // key (before the bridge ever uses the agent key).
  await enrollAgentIfNeeded(podUrl, operatorKey, agentUserId, workspaceId);

  // Same CONTEXT.md routing file every other provisioned agent gets.
  try {
    await configureAgentContext(podUrl, operatorKey, "discord", agentUserId);
  } catch (err) {
    log.warn(`Agent context wizard failed: ${err instanceof Error ? err.message : String(err)}`);
  }

  return hubApiKey;
}

/**
 * Resolve the OPTIONAL scope the bridge writes into — pod-wide by default.
 *
 * Workspace: an explicit --workspace-id is the only way to pin one (advanced/
 * legacy escape hatch) — never prompted, never required.
 *
 * Project: a peer, independent lens. --project-id skips the prompt; otherwise
 * offer a picker with "Pod-wide (no project)" as the default alongside the
 * operator's existing projects. No projects on the pod → skip the prompt.
 */
async function resolveScope(
  opts: { workspaceId?: string; projectId?: string },
  cfg: Awaited<ReturnType<typeof resolveHubConfig>>
): Promise<{ workspaceId?: string; projectId?: string }> {
  const workspaceId = opts.workspaceId;

  let projectId = opts.projectId;
  if (!projectId) {
    const projects = await fetchProjects(cfg);
    if (projects.length > 0) {
      const { picked } = await prompts({
        type: "select",
        name: "picked",
        message: "Which project should the bridge write into? (optional — pod-wide by default)",
        initial: 0,
        choices: [
          { title: "Pod-wide (no project)", value: "" },
          ...projects.map((p) => ({ title: p.name, description: p.id, value: p.id })),
        ],
      });
      projectId = (picked as string) || undefined;
    }
  }

  return { workspaceId, projectId };
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
  workspaceId: string | undefined,
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

/**
 * Data-aware "what you must do next INSIDE Synap" — the discoverability layer:
 * setup seeds everything it can, but a few things are the operator's call
 * (approving proposals, activating drafts, turning on feeds). Surface them
 * explicitly so nothing is silently waiting. Best-effort: never throws.
 */
async function printSynapNextSteps(
  cfg: Awaited<ReturnType<typeof resolveHubConfig>>,
  workspaceId: string | undefined
): Promise<void> {
  log.blank();
  log.heading("Next in Synap — review + activate (nothing else auto-runs until you do)");
  log.blank();

  // 1. Pending proposals awaiting the operator's approval.
  let pending = 0;
  try {
    const res = await hubGet(
      "/proposals",
      { workspaceId, status: "pending" },
      cfg
    );
    pending = unwrapList<{ id: string }>(res, ["proposals"]).length;
  } catch {
    /* best-effort — fall through to the generic pointer */
  }
  if (pending > 0) {
    console.log(
      `  ${chalk.bold("1.")} ${chalk.yellow(`${pending} proposal(s) await your approval`)} — approve them in the app:`
    );
  } else {
    console.log(`  ${chalk.bold("1.")} Approve any pending proposals in the app:`);
  }
  console.log(`     ${chalk.cyan(`${cfg.podUrl}/proposals`)}`);

  console.log(
    `  ${chalk.bold("2.")} Automations seed as ${chalk.bold("draft")} — open each ${chalk.dim("review + activate")} link above to turn on the ones you want.`
  );
  console.log(
    `  ${chalk.bold("3.")} Feeds are ${chalk.bold("OFF by default")} — turn them on ${chalk.bold("in Discord")} (the bridge hot-reloads, no restart):`
  );
  console.log(
    `     mail feed → ${chalk.green("/mail-feed enable:true channel:#your-channel")} · Discord events → ${chalk.green("/events enable:true")}`
  );
  console.log(
    `  ${chalk.bold("4.")} Connect Google if you haven't: ${chalk.green(`synap cap enable "Nango — Google Workspace"`)}`
  );
  log.blank();
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
