/**
 * synap proton-setup  (HIDDEN)
 *
 * One-shot provisioning for the Proton Mail ↔ Synap bridge — a fork of
 * `bridge-setup` (the Discord bridge) for the SOVEREIGN self-host Proton path:
 * a locally-run, headless Proton Bridge decrypts Proton's end-to-end-encrypted
 * mail and exposes it as plain IMAP/SMTP on localhost; this command wires that
 * bridge up to a Synap pod. See `synap-control-plane-api/src/seeds/
 * capability-templates/proton.capability.json` for the CP-side template
 * (vault ref `proton-account`, tool `proton`) and its documented
 * MUTUAL-EXCLUSIVITY rule against the `mailgun` template's Proton-forward path
 * — do not run both for the same mailbox (double-ingest).
 *
 * CREDENTIAL MODEL: the operator enters their Proton ACCOUNT credentials
 * (email + password + optional TOTP seed + optional mailbox password for
 * two-password-mode accounts) ONCE, here — NOT a Bridge-generated password.
 * They are assembled into one JSON secret
 * (`{"email","password","totpSeed","mailboxPassword"}`, last two optional) and
 * stored in the pod vault under ref `proton-account`. The headless bridge redeems
 * that secret and auto-logs-in with it on boot (implemented in the
 * synap-proton-bridge repo); no manual `protonmail-bridge login` step remains. If
 * Proton throws a one-time human-verification challenge (more likely on
 * datacenter/VPS IPs), a URL appears in the bridge logs to click once — see
 * `printNextSteps`.
 *
 * Automates everything that CAN be automated:
 *
 *   1. lets you CHOOSE which saved pod the bridge connects to (kept separate
 *      from your global CLI pod via the "proton" surface override), then
 *      resolves a durable hub key + workspace from it
 *   2. sanity-checks pod reachability + key scope (GET /capabilities)
 *   3. applies the bridge's OWN capability definition (POST /capabilities/apply)
 *      — read from the bridge repo so there is ONE source of truth
 *   4. writes the bridge .env (pod creds + vault ref), preserving any other
 *      existing keys, and purges any raw Proton env credentials once vaulted
 *   5. prints the one-time human-verification note (only a human can click it)
 *
 * Hidden on purpose: this is a dogfood/dev convenience, not a first-class
 * surface. Not shown in `synap --help`.
 *
 * The bridge lands data POD-WIDE by default. An OPTIONAL project scope can be
 * picked interactively (or via --project-id); --workspace-id remains an
 * advanced/legacy escape hatch to pin a single workspace, never prompted.
 *
 * Usage:
 *   synap proton-setup [--bridge-dir <path>] [--pod <profile-name>]
 *     [--workspace-id <uuid>] [--project-id <uuid>] [--pod-url <url>] [--api-key <key>]
 *     [--proton-email <email>] [--proton-password <password>]
 *     [--proton-totp-seed <seed>] [--proton-mailbox-password <password>]
 */

import path from "node:path";
import os from "node:os";
import fs from "node:fs";
import { createRequire } from "node:module";
import chalk from "chalk";
import ora from "ora";
import prompts from "prompts";
import { resolveHubConfig, hubGet, hubPost, resolveUserId, type HubConfig } from "../lib/hub-client.js";
import { fetchProjects } from "../lib/project.js";
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

export interface ProtonSetupOpts {
  /** Saved pod profile to connect the bridge to (separate from the global CLI pod). */
  pod?: string;
  /** Governance preset for the agent — skips the interactive prompt when set. */
  governance?: GovernancePreset;
  podUrl?: string;
  apiKey?: string;
  bridgeDir?: string;
  /** Advanced/legacy escape hatch — pins the bridge to one workspace instead of pod-wide. */
  workspaceId?: string;
  /** Scopes the bridge to one project (peer lens to workspace). Skips the project prompt. */
  projectId?: string;
  /** Proton ACCOUNT email — the account the bridge auto-logs-in as. */
  protonEmail?: string;
  /** Proton ACCOUNT password (not a bridge-generated value) — provisioned into the pod vault. */
  protonPassword?: string;
  /** Proton ACCOUNT 2FA/TOTP seed (base32), optional — provisioned into the pod vault. */
  protonTotpSeed?: string;
  /** Proton mailbox password (two-password-mode accounts only), optional — provisioned into the pod vault. */
  protonMailboxPassword?: string;
}

const DEFAULT_BRIDGE_DIR = path.join(
  os.homedir(),
  "Documents",
  "Code",
  "synap-proton-bridge"
);

/**
 * Pick the pod the BRIDGE connects to — independent of the global CLI pod.
 *
 * The bridge is the "proton" surface, so we resolve/persist its pod via the
 * per-surface override (setSurfacePod) and NEVER touch the global activePod.
 * That lets the operator keep a personal pod as their CLI default while the
 * Proton bridge points at a different (e.g. team / client) pod.
 *
 * Order: explicit --pod-url/--api-key escape hatch → --pod <name> →
 * single saved profile (auto) → interactive picker (default = the pod already
 * assigned to the proton surface, else the CLI-active one).
 */
async function resolveBridgePod(
  opts: ProtonSetupOpts,
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
      getSurfacePodName("proton") ?? profiles.find((p) => p.active)?.name ?? profiles[0].name;
    const initial = Math.max(0, profiles.findIndex((p) => p.name === defaultName));
    const { picked } = await prompts({
      type: "select",
      name: "picked",
      message: "Which data pod should the Proton bridge connect to?",
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

  // Remember the choice for the proton surface — without changing the CLI default.
  setSurfacePod("proton", chosen.name);

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

export async function protonSetup(opts: ProtonSetupOpts): Promise<void> {
  banner();
  log.heading("Proton Mail bridge — one-shot setup");

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

  // ── 3c. Provision a Proton AGENT key linked to the operator ──────────────
  // The bridge must run as a real backend agent — NOT with the operator's raw
  // key. An agent key carries linkedUserId=<operator>; the backend remaps its
  // reads to the operator's data floor (hub-protocol-rest.ts auth middleware)
  // while attributing writes to the agent for governed proposals. All the
  // operator-key work below (capability apply, vault grant) keeps using `cfg`.
  const agentKey = await provisionProtonAgentKey(cfg.podUrl, cfg.apiKey, cfg.workspaceId);

  // ── 4. Provision the capability (vault credential + tool) ────────────────
  const bridgeDir = opts.bridgeDir ?? DEFAULT_BRIDGE_DIR;
  const protonCredentials = await resolveProtonCredentials(opts);
  const protonCredentialsJson = protonCredentials
    ? JSON.stringify(protonCredentials)
    : undefined;
  const { vaultRef, secretId } = await applyBridgeCapability(
    bridgeDir,
    workspaceId,
    cfg,
    protonCredentialsJson
  );

  // ── 5. Choose agent governance mode ──────────────────────────────────
  const protonAgentUserId = getSurfaceAgentKey("proton")?.agentUserId;
  if (protonAgentUserId) {
    await ensureAgentGovernance(cfg, protonAgentUserId, opts.governance);
  }

  // ── 6. Grant the bridge redeem access — credentials live ONLY in the vault ─
  let granted = false;
  if (secretId && protonCredentialsJson) {
    // Grant to the AGENT (the bridge's redeem identity), not the operator.
    const agentUserId = getSurfaceAgentKey("proton")?.agentUserId;
    granted = await grantRedeemAccess(secretId, cfg, agentUserId);
  }

  // ── 7. Write the bridge .env ─────────────────────────────────────────────
  const envPath = path.join(bridgeDir, ".env");
  const managed: Record<string, string> = {
    SYNAP_POD_URL: cfg.podUrl,
    // The bridge runs as the Proton AGENT (linked to the operator), not with
    // the operator's raw key. Reads remap to the operator floor; writes are
    // governed as the agent.
    SYNAP_HUB_API_KEY: agentKey,
  };
  // Pod-wide by default: SYNAP_WORKSPACE_ID/SYNAP_PROJECT_ID are only written
  // when the operator explicitly pinned a workspace (--workspace-id) or chose
  // a project in the picker. Neither is required.
  if (workspaceId) managed.SYNAP_WORKSPACE_ID = workspaceId;
  if (projectId) managed.SYNAP_PROJECT_ID = projectId;
  // The account credentials are NEVER written to .env — they live in the pod
  // vault (one JSON secret: email/password/totpSeed) and the bridge redeems
  // them on boot via this ref to auto-log-in. (Requires the grant below to
  // land; if it didn't, we warn loudly rather than leaking creds to env.)
  // The bridge reads SYNAP_PROTON_CREDENTIALS_REF (see
  // synap-proton-bridge/src/synapCapabilities.js).
  if (vaultRef) managed.SYNAP_PROTON_CREDENTIALS_REF = vaultRef;

  try {
    // Once the credentials are in the vault, purge any stale raw env copies.
    // Also purge a stale scope pin from a prior run — re-running pod-wide (no
    // --workspace-id / no project picked) must actually clear an old pin, not
    // leave it dangling since managed only WRITES the keys it resolves.
    const removeKeys = [
      ...(vaultRef
        ? [
            "PROTON_BRIDGE_PASSWORD",
            "SYNAP_PROTON_PASSWORD_REF",
            "PROTON_EMAIL",
            "PROTON_PASSWORD",
            "PROTON_TOTP_SEED",
          ]
        : []),
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

  // ── 8. Next steps (the human-only remainder) ─────────────────────────────
  printNextSteps(bridgeDir, {
    hasCredentials: Boolean(protonCredentialsJson),
    vaultRef,
    granted,
  });
}

// ── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Provision a Proton AGENT key linked to the operator, via the shared
 * `provisionAgentKey()` wrapper (same door every target in `lib/targets.ts`
 * uses). The resulting key carries linkedUserId=<operator>, so the backend
 * remaps its reads/redeems to the operator's data floor.
 *
 * idempotent: true — REUSE the existing valid key rather than rotate it. A
 * live bridge holds this key in its .env; minting fresh would revoke it and
 * 401 the bridge until it's redeployed. `requireApproval: false` keeps this a
 * one-shot, non-interactive mint rather than opening a browser approval wait.
 *
 * @param podUrl      Pod base URL.
 * @param operatorKey The operator's raw hub key (authorizes the provisioning).
 * @param workspaceId Workspace to enroll the agent into (omit for all).
 * @returns the Proton agent key to write as SYNAP_HUB_API_KEY.
 */
async function provisionProtonAgentKey(
  podUrl: string,
  operatorKey: string,
  workspaceId: string | undefined
): Promise<string> {
  const spinner = ora("Provisioning Proton agent key…").start();

  let hubApiKey: string;
  let agentUserId: string;
  try {
    const result = await provisionAgentKey(podUrl, operatorKey, "proton", {
      requireApproval: false,
      idempotent: true,
    });
    hubApiKey = result.hubApiKey;
    agentUserId = result.agentUserId;
    spinner.succeed(
      result.reused
        ? "Proton agent key reused (same key — no rotation, no bridge restart needed)"
        : "Proton agent key minted (new key — redeploy the bridge to pick it up)"
    );
  } catch (err) {
    spinner.fail("Could not provision the Proton agent key");
    log.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }

  // Persist so downstream steps (governance lookup, .env write) can read it back.
  setSurfaceAgentKey("proton", { hubApiKey, agentUserId });

  // Enroll the agent user into the operator's workspace(s) using the OPERATOR
  // key (before the bridge ever uses the agent key).
  await enrollAgentIfNeeded(podUrl, operatorKey, agentUserId, workspaceId);

  // Same CONTEXT.md routing file every other provisioned agent gets.
  try {
    await configureAgentContext(podUrl, operatorKey, "proton", agentUserId);
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

/**
 * Prompt for the Proton ACCOUNT credentials (email/password/optional TOTP
 * seed/optional mailbox password) — the same credentials you sign in to
 * proton.me with. These are NOT a Bridge-generated password: the headless
 * bridge uses them to auto-log-in on boot (implemented in the synap-proton-bridge
 * repo). The password, TOTP seed, and mailbox password are secrets —
 * prompted with `type: "password"` (never echoed) and stored ONLY in the pod
 * vault; the email may be shown/passed as a flag.
 */
async function resolveProtonCredentials(
  opts: ProtonSetupOpts
): Promise<
  { email: string; password: string; totpSeed: string; mailboxPassword: string } | undefined
> {
  let email = opts.protonEmail;
  if (!email) {
    const { value } = await prompts({
      type: "text",
      name: "value",
      message: "Proton account email — Settings → Account and password (proton.me sign-in):",
    });
    email = (value as string) || undefined;
  }

  let password = opts.protonPassword;
  if (!password) {
    const { value } = await prompts({
      type: "password",
      name: "value",
      message:
        "Proton account password — this is your normal proton.me sign-in password, NOT the Organization key/password (leave blank to skip):",
    });
    password = (value as string) || undefined;
  }

  if (!email || !password) return undefined;

  let totpSeed = opts.protonTotpSeed;
  if (totpSeed === undefined) {
    const { value } = await prompts({
      type: "password",
      name: "value",
      message:
        "(optional) Proton 2FA/TOTP seed — Settings → Account and password → Two-factor authentication, base32 (leave blank if 2FA is off):",
    });
    totpSeed = (value as string) || "";
  }

  let mailboxPassword = opts.protonMailboxPassword;
  if (mailboxPassword === undefined) {
    const { value } = await prompts({
      type: "password",
      name: "value",
      message:
        "(optional) Proton mailbox password — ONLY if two-password mode is on (Settings → Account and password); leave blank otherwise:",
    });
    mailboxPassword = (value as string) || "";
  }

  return { email, password, totpSeed: totpSeed || "", mailboxPassword: mailboxPassword || "" };
}

async function applyBridgeCapability(
  bridgeDir: string,
  workspaceId: string | undefined,
  cfg: Awaited<ReturnType<typeof resolveHubConfig>>,
  protonCredentialsJson: string | undefined
): Promise<{ vaultRef?: string; secretId?: string }> {
  const spinner = ora("Provisioning capability…").start();
  // Read the capability definition from the bridge repo — ONE source of truth.
  // Documented shape (see proton.capability.json): vault ref "proton-account"
  // (JSON-encoded Proton account credentials), tool "proton". Mirrors
  // bridge-setup.ts's discord-bot read from synapCapabilities.js's
  // CAPABILITY_DEFINITION export.
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
    log.dim(
      "  NOTE: this reads the fork's own synapCapabilities.js (Wave C, built in " +
        "parallel) — if it doesn't exist yet, the bridge repo isn't ready."
    );
    return {};
  }
  if (!rawDef) {
    spinner.fail("No CAPABILITY_DEFINITION export in the bridge");
    return {};
  }

  // Deep-clone + inject the Proton account credentials JSON into the vault
  // credential. With none provided, drop the vault + credentialRef so we
  // never store an empty/placeholder secret.
  const def = JSON.parse(JSON.stringify(rawDef)) as {
    vault?: Array<{ ref?: string; value?: string }>;
    tools?: Array<{ credentialRef?: string }>;
  };
  if (protonCredentialsJson) {
    for (const v of def.vault ?? []) {
      if (typeof v.value === "string") {
        v.value = v.value.replace("{{protonCredentialsJson}}", protonCredentialsJson);
      }
    }
  } else {
    // No credentials → drop the vault and any tool credentialRef that
    // referenced it (a bare template-local ref or a vault:// string), so we
    // never store a placeholder secret or leave a dangling reference.
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
    spinner.text = "Provisioning capability (no credentials → structure only)…";
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
    if (protonCredentialsJson) {
      // The Proton account credentials MUST be vaulted for the bridge to run
      // — continuing to write a .env and printing "Done" would leave a
      // crash-looping bridge (redeem 404). A frequent cause is a missing/
      // empty VAULT_SERVER_KEY on the target pod's backend (the vault can't
      // encrypt). Fail loud here.
      if (/VAULT_SERVER_KEY/i.test(msg)) {
        log.dim("  The target pod's secret vault is not configured.");
        log.dim("  Set a durable VAULT_SERVER_KEY (openssl rand -hex 32) in the pod's");
        log.dim("  deploy/.env, redeploy the backend, then re-run proton-setup.");
      }
      process.exit(1);
    }
    return {};
  }
}

/**
 * Grant the bridge principal redeem access to the Proton account credentials
 * secret — the headless equivalent of the UI "grant access" flow, using the
 * user's own credentials. After this, the credentials live ONLY in the
 * vault; the bridge redeems them on boot to auto-log-in.
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
      `Redeem access granted${res.reused ? " (existing)" : ""} — password stays in the vault`
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
    out.push("# --- Synap pod (written by `synap proton-setup`) ---");
    for (const [k, v] of remaining) out.push(`${k}=${v}`);
  }

  fs.writeFileSync(filePath, out.join("\n"), { mode: 0o600 });
}

function printNextSteps(
  bridgeDir: string,
  state: { hasCredentials: boolean; vaultRef?: string; granted: boolean }
): void {
  log.blank();
  log.heading("Done");
  log.blank();
  if (state.vaultRef && state.granted) {
    console.log(`  ${chalk.green("✓")} Proton account credentials in the pod vault, bridge granted redeem access — no env password  ${chalk.dim(state.vaultRef)}`);
  } else if (state.vaultRef && state.hasCredentials) {
    console.log(`  ${chalk.yellow("⚠")} Credentials stored in the vault (${chalk.dim(state.vaultRef)}) but the redeem GRANT did not land.`);
    console.log(`     Deploy the backend (grant door) and re-run — the bridge can't log in until the grant exists.`);
  }
  console.log(`  ${chalk.green("✓")} Bridge .env written (pod creds; account credentials stay in the vault)`);
  log.blank();
  log.heading("Remaining (Proton Bridge — human only, one-time)");
  log.blank();
  console.log(`  ${chalk.bold("•")} The bridge auto-logs-in from the vault-stored Proton account credentials on next deploy —`);
  console.log(`     no manual ${chalk.bold("protonmail-bridge login")} step needed.`);
  console.log(`  ${chalk.bold("•")} If Proton demands a one-time human-verification challenge (more likely on datacenter/VPS IPs),`);
  console.log(`     its URL appears in ${chalk.cyan("pm2 logs proton-bridge")} — click it once in a browser; it typically won't ask again.`);
  console.log(`  ${chalk.bold("•")} IMAP: ${chalk.dim("127.0.0.1:1143")}  ·  SMTP: ${chalk.dim("127.0.0.1:1025")} (StartTLS, self-signed cert)`);
  if (!state.hasCredentials) {
    console.log(`  ${chalk.bold("•")} Proton account credentials not provisioned — re-run with ${chalk.cyan("--proton-email/--proton-password")} (stores them in the vault)`);
  }
  log.blank();
  console.log(`  Then: ${chalk.green(`cd ${bridgeDir} && npm start`)}`);
  log.blank();
}
