/**
 * synap agents — manage agent principals on your pod
 *
 *   synap agents list              list your agents on this pod (default) or --local cache
 *   synap agents add [kind]        THE door: a client (claude-code, cursor…), a custom
 *                                  agent (--name), or what's on this machine (no kind).
 *                                  --api-key registers a key you already hold.
 *   synap agents create            deprecated alias of `add`
 *   synap agents remove <name>     remove from local cache only
 *   synap agents info <name>       show local cache details only
 *   synap agents rotate-key <n>    re-mint an agent's key through the agent door
 */

import chalk from "chalk";
import ora from "ora";
import prompts from "prompts";
import { log } from "../utils/logger.js";
import {
  listAgents,
  getAgent,
  addAgent,
  removeAgent,
  type AgentProfile,
} from "../lib/agents-config.js";
import { getActivePodConfig, getPodOverride, findPodNameByUrl, listPodProfiles, podNotFoundMessage } from "../lib/pod.js";
import { resolveHubConfig, hubGet, hubPost, renderHubError } from "../lib/hub-client.js";
import { unwrapList } from "../lib/unwrapList.js";
import {
  addDetectedAgents,
  connectKnownAgent,
  createCustomAgent,
  planAgentAdd,
  resolveAgentPod,
} from "../lib/agent-door.js";
import { provisionAgentKey } from "../lib/targets.js";
import { redactKey } from "../lib/mcp-snippets.js";
import { connectionLines, type PodConnection } from "../lib/agent-connections.js";
import { thisComputerInstanceIds } from "../lib/machine-instance.js";

function maskKey(key: string): string {
  if (key.length <= 12) return key.slice(0, 4) + "...";
  return key.slice(0, 12) + "...";
}

function resolveGovernance(profile: AgentProfile): string {
  const template = profile.template;
  if (template === "twin") return "inherited";
  if (template === "assistant") return "strict";
  return "standard";
}

// ─── list ─────────────────────────────────────────────────────────────────────

type PodAgentRow = {
  id: string;
  /** Live connections, one per computer (absent from an older pod). */
  connections?: PodConnection[];
  name: string | null;
  agentType: string | null;
  agentTemplate?: string | null;
  createdByUserId?: string | null;
  createdVia?: string | null;
  createdAt?: string | null;
  focusWorkspaceId?: string | null;
};

/**
 * List agent principals.
 * Default: pod roster (`GET /agent-users?mine=1`) — one row per (you, agentType).
 * `--local`: only ~/.synap config cache (legacy surface keys / named profiles).
 */
export async function agentsList(
  opts: { json?: boolean; local?: boolean; pod?: string } = {}
): Promise<void> {
  if (opts.local) {
    const agents = listAgents();
    if (opts.json) {
      console.log(
        JSON.stringify(
          agents.map(({ name, profile }) => ({
            source: "local-cache",
            name,
            pod: profile.podName,
            workspaceId: profile.workspaceId ?? null,
            label: profile.label ?? null,
            template: profile.template ?? null,
            governance: resolveGovernance(profile),
            createdAt: profile.createdAt,
          })),
          null,
          2
        )
      );
      return;
    }
    if (agents.length === 0) {
      log.info(
        "No local agent cache. Use: synap agents add  (or omit --local for pod roster)"
      );
      return;
    }
    log.heading("Local agent cache (~/.synap)");
    log.dim("Local keys only — not the pod roster. Default list: synap agents list");
    for (const { name, profile } of agents) {
      const workspace = profile.workspaceId
        ? chalk.dim(` ws:${profile.workspaceId.slice(0, 8)}…`)
        : "";
      const label = profile.label ? chalk.dim(` (${profile.label})`) : "";
      console.log(
        `  ${chalk.bold(name.padEnd(16))}` +
          `  pod:${chalk.cyan(profile.podName.padEnd(12))}` +
          `  key:${chalk.dim(maskKey(profile.apiKey))}` +
          workspace +
          label
      );
    }
    log.blank();
    return;
  }

  // ── Pod roster ────────────────────────────────────────────────────────────
  let cfg;
  try {
    // resolveHubConfig is async — missing await ships a Promise as HubConfig
    // and every default list falls into the catch (pod roster never works).
    cfg = await resolveHubConfig();
  } catch (err) {
    log.error(err instanceof Error ? err.message : String(err));
    log.dim("Fall back to local cache: synap agents list --local");
    return;
  }

  let rows: PodAgentRow[] = [];
  try {
    const raw = await hubGet("/agent-users?mine=1", {}, cfg);
    rows = unwrapList<PodAgentRow>(raw);
  } catch (err) {
    renderHubError(err);
    log.dim("Fall back to local cache: synap agents list --local");
    return;
  }

  if (opts.json) {
    console.log(
      JSON.stringify(
        {
          source: "pod",
          singleton: "(createdByUserId, agentType)",
          agents: rows,
        },
        null,
        2
      )
    );
    return;
  }

  if (rows.length === 0) {
    log.info(
      "No agents on this pod for you yet. Use: synap agents add  (a client, --name <n> for your own, or pick from this machine)"
    );
    log.dim("You get one agent per type; multi-machine reuses the same principal.");
    return;
  }

  log.heading("Your agents on this pod");
  log.dim("One agent per type for you · local keys are just a cache");
  log.blank();

  for (const row of rows) {
    const type = (row.agentType ?? "—").padEnd(14);
    const id = row.id.slice(0, 8);
    const focus = row.focusWorkspaceId
      ? chalk.dim(` pin-ws:${row.focusWorkspaceId.slice(0, 8)}…`)
      : "";
    const via = row.createdVia ? chalk.dim(` via:${row.createdVia}`) : "";
    console.log(
      `  ${chalk.bold(type)}  ${chalk.cyan(row.name ?? "—")}  id:${chalk.dim(id)}…${via}${focus}`
    );
    // One line per computer it is connected from (an older pod cannot say).
    // Keys are minted with the SURFACE's hash; compare against every surface
    // minting under this agentType, and only when the pod named the type.
    const mine = row.agentType ? thisComputerInstanceIds(row.agentType) : null;
    const lines = connectionLines(row.connections, { isThisComputer: (id) => !!mine?.has(id) });
    if (lines === null) continue;
    if (lines.length === 0) log.dim("      no live connection");
    for (const line of lines) log.dim(`      ${line}`);
  }

  log.blank();
  log.dim("synap agents add  — create or reuse (you × type)");
  log.dim("synap agents list --local            — ~/.synap cache only");
  log.dim("synap whoami                        — current agent principal");
}

// ─── add --api-key ────────────────────────────────────────────────────────────

/**
 * `synap agents add --api-key <key>`: register a key you already hold, on THIS
 * machine only. Mints nothing — the agent already exists on the pod.
 */
async function registerAgentKey(opts: {
  name?: string;
  apiKey?: string;
  pod?: string;
  workspace?: string;
  label?: string;
}): Promise<void> {
  const isTTY = process.stdin.isTTY;

  // ── name ──────────────────────────────────────────────────────────────────
  let agentName = opts.name;
  if (!agentName) {
    if (!isTTY) {
      log.error("--name is required in non-interactive mode");
      return;
    }
    const { inputName } = await prompts({
      type: "text",
      name: "inputName",
      message: "Identifier for this agent (e.g. researcher, builder):",
      validate: (v: string) => v.trim().length > 0 || "Name is required",
    });
    if (!inputName) return;
    agentName = (inputName as string).trim().toLowerCase().replace(/\s+/g, "-");
  }

  // ── apiKey ────────────────────────────────────────────────────────────────
  let apiKey = opts.apiKey;
  if (!apiKey) {
    if (!isTTY) {
      log.error("--api-key is required in non-interactive mode");
      return;
    }
    const { key } = await prompts({
      type: "password",
      name: "key",
      message: "Hub Protocol API key for this agent:",
      validate: (v: string) => v.trim().length > 0 || "API key is required",
    });
    if (!key) return;
    apiKey = (key as string).trim();
  }

  // ── pod ───────────────────────────────────────────────────────────────────
  // `--pod <name>` never arrives as `opts.pod`: `bootstrapPodOverride` consumes
  // it from argv before commander parses (pod.ts:255 — `agents` is deliberately
  // NOT in NATIVE_POD_FLAG_COMMANDS, so the override reaches resolveHubConfig
  // like every other command). But this block decides which pod the agent is
  // LINKED to, and reading only `opts.pod` meant the flag was silently dropped
  // here: non-TTY fell through to the ACTIVE profile and validated the key
  // against the wrong pod URL below → "Key validation failed (HTTP 401)".
  // Read the override that actually holds the flag's value.
  const override = getPodOverride();
  let podName = opts.pod ?? (override ? findPodNameByUrl(override.podUrl) : undefined);
  if (!podName) {
    const profiles = listPodProfiles();
    if (profiles.length === 0) {
      log.error("No pod profiles configured. Run: synap pods add");
      return;
    }

    const activePod = profiles.find((p) => p.active);
    const defaultPod = activePod?.name ?? profiles[0].name;

    if (!isTTY) {
      podName = defaultPod;
    } else {
      const { picked } = await prompts({
        type: "select",
        name: "picked",
        message: "Which pod profile should this agent use?",
        choices: profiles.map((p) => ({
          title: `${chalk.bold(p.name)}${p.active ? chalk.green("  ← active") : ""}  ${chalk.dim(p.config.podUrl)}`,
          value: p.name,
        })),
        initial: profiles.indexOf(activePod ?? profiles[0]),
      });
      if (!picked) return;
      podName = picked as string;
    }
  }

  // Validate pod profile exists
  const allProfiles = listPodProfiles();
  if (!allProfiles.find((p) => p.name === podName)) {
    log.error(podNotFoundMessage(podName));
    return;
  }

  // Validate the key works before storing
  const spinner = ora("Validating API key...").start();
  try {
    const podProfile = listPodProfiles().find(p => p.name === podName);
    const podUrl = podProfile?.config.podUrl ?? "";
    if (podUrl) {
      const res = await fetch(`${podUrl}/api/hub/users/me`, {
        headers: { Authorization: `Bearer ${apiKey}` },
        signal: AbortSignal.timeout(8000),
      });
      if (!res.ok) {
        spinner.fail(`Key validation failed (HTTP ${res.status}) — key not stored.`);
        return;
      }
      const me = await res.json() as { id?: string };
      spinner.succeed(`Key valid — identity: ${me.id?.slice(0, 8) ?? "unknown"}...`);
    } else {
      spinner.warn("No pod URL to validate against — storing anyway.");
    }
  } catch {
    spinner.warn("Could not validate key (pod unreachable) — storing anyway.");
  }

  const profile: AgentProfile = {
    podName,
    apiKey,
    createdAt: new Date().toISOString(),
  };

  if (opts.workspace) profile.workspaceId = opts.workspace;
  if (opts.label) profile.label = opts.label;

  addAgent(agentName, profile);

  log.blank();
  log.success(`Agent '${agentName}' saved.`);
  log.dim(`Use SYNAP_AGENT=${agentName} to activate this identity.`);
}

// ─── remove ───────────────────────────────────────────────────────────────────

export function agentsRemove(name: string): void {
  try {
    removeAgent(name);
    log.success(`Removed agent '${name}'.`);
  } catch (err) {
    log.error(err instanceof Error ? err.message : String(err));
  }
}

// ─── info ─────────────────────────────────────────────────────────────────────

export async function agentsInfo(
  name: string,
  opts: { showKey?: boolean; snippets?: boolean } = {}
): Promise<void> {
  const profile = getAgent(name);

  if (!profile) {
    log.error(`Agent '${name}' not found.`);
    const all = listAgents();
    if (all.length > 0) log.dim("Available: " + all.map((a) => a.name).join(", "));
    return;
  }

  if (opts.showKey || opts.snippets) {
    const podUrl = listPodProfiles().find((p) => p.name === profile.podName)?.config.podUrl;
    if (!podUrl) {
      log.error(podNotFoundMessage(profile.podName));
      return;
    }
    const { buildMcpUrl } = await import("../lib/targets.js");
    const url = buildMcpUrl(podUrl, profile.workspaceId, profile.projectId);
    if (opts.snippets) {
      const { printMcpConnection } = await import("../lib/mcp-snippets.js");
      printMcpConnection({
        url,
        hubApiKey: profile.apiKey,
        agentUserId: profile.agentUserId ?? "",
        workspaceId: profile.workspaceId,
        projectId: profile.projectId,
      });
      return;
    }
    const { printAgentCard } = await import("../lib/agent-door.js");
    printAgentCard({
      name: profile.label ?? name,
      localName: name,
      url,
      hubApiKey: profile.apiKey,
      scope: { workspaceId: profile.workspaceId, projectId: profile.projectId },
    });
    return;
  }

  log.heading(`Agent: ${name}`);
  console.log(`  ${"Pod".padEnd(12)}  ${chalk.cyan(profile.podName)}`);
  console.log(`  ${"API key".padEnd(12)}  ${chalk.dim(maskKey(profile.apiKey))}`);
  if (profile.workspaceId) console.log(`  ${"Workspace".padEnd(12)}  ${profile.workspaceId}`);
  if (profile.label) console.log(`  ${"Label".padEnd(12)}  ${profile.label}`);
  if (profile.template) console.log(`  ${"Template".padEnd(12)}  ${profile.template}`);
  if (profile.template) console.log(`  ${"Governance".padEnd(12)}  ${resolveGovernance(profile)}`);
  if (profile.agentUserId) console.log(`  ${"Agent ID".padEnd(12)}  ${profile.agentUserId}`);
  console.log(`  ${"Created".padEnd(12)}  ${chalk.dim(profile.createdAt)}`);
  log.blank();
  log.dim(`Usage: SYNAP_AGENT=${name} synap <command>`);
  log.dim(`URL + full key: synap agents info ${name} --show-key`);
}

// ─── add (the one door) ──────────────────────────────────────────────────────

export interface AgentsAddOpts {
  name?: string;
  template?: string;
  type?: string;
  role?: string;
  workspace?: string;
  project?: string;
  apiKey?: string;
  label?: string;
  pod?: string;
}

/**
 * `synap agents add [kind]` — bring an agent into the pod. See
 * `lib/agent-door.ts` for the three ways in; this only dispatches.
 */
export async function agentsAdd(kind: string | undefined, opts: AgentsAddOpts = {}): Promise<void> {
  const plan = planAgentAdd(kind, opts);
  if (plan.mode === "existing-key") {
    await registerAgentKey({ ...opts, name: opts.name ?? kind });
    return;
  }

  const pod = await resolveAgentPod({});
  if (!pod) return;
  const scope = { workspaceId: opts.workspace, projectId: opts.project };

  let ok: boolean;
  if (plan.mode === "known") {
    ok = await connectKnownAgent(plan.target, pod, scope);
  } else if (plan.mode === "custom") {
    ok = await createCustomAgent(
      pod,
      { name: plan.name, template: opts.template, type: opts.type, role: opts.role, label: opts.label },
      scope
    );
  } else {
    ok = await addDetectedAgents(pod, scope);
  }
  if (!ok) process.exitCode = 1;
}

/** Deprecated: `synap agents create` → `synap agents add`. */
export async function agentsCreate(opts: Omit<AgentsAddOpts, "apiKey"> = {}): Promise<void> {
  log.dim("`synap agents create` is now `synap agents add` — same flags.");
  await agentsAdd(opts.template && opts.template !== "custom" ? undefined : "custom", opts);
}

// ─── rotate-key ───────────────────────────────────────────────────────────────

export async function agentsRotateKey(nameOrId: string, opts: { showKey?: boolean } = {}): Promise<void> {
  // Look up agent locally by name or agentUserId
  const all = listAgents();
  const match = all.find(
    (a) => a.name === nameOrId || a.profile.agentUserId === nameOrId
  );

  if (!match) {
    log.error(`Agent '${nameOrId}' not found in local config.`);
    if (all.length > 0) log.dim("Available: " + all.map((a) => a.name).join(", "));
    return;
  }

  const { name, profile } = match;

  log.heading(`Rotate key for agent: ${name}`);
  console.log(`  ${"Pod".padEnd(12)}  ${chalk.cyan(profile.podName)}`);
  console.log(`  ${"Template".padEnd(12)}  ${profile.template ?? "—"}`);
  console.log(`  ${"Role".padEnd(12)}  ${profile.template ? resolveGovernance(profile) : "—"}`);
  console.log(`  ${"Current key".padEnd(12)}  ${chalk.dim(maskKey(profile.apiKey))}`);
  log.blank();

  if (!process.stdin.isTTY) {
    log.error("rotate-key requires interactive mode (stdin must be a TTY).");
    return;
  }

  const { confirmed } = await prompts({
    type: "confirm",
    name: "confirmed",
    message: "This will invalidate the current API key. Continue?",
    initial: false,
  });

  if (!confirmed) {
    log.info("Cancelled.");
    return;
  }

  const cfg = await resolveHubConfig();
  const allProfiles = listPodProfiles();
  const podProfile = allProfiles.find((p) => p.name === profile.podName);
  if (!podProfile) {
    log.error(podNotFoundMessage(profile.podName));
    return;
  }

  // The agent's key belongs to the agent principal, so it is re-minted through
  // the agent door, which replaces this computer's earlier key once approved.
  // Never `/trpc` (keys plan D-7): it needs a person's session, so a Bearer key
  // is 401 there, and its key list is the PERSON's keys, not the agent's.
  const spinner = ora("Re-minting the agent's key...").start();

  try {
    const agentType = profile.agentUserId
      ? unwrapList<PodAgentRow>(await hubGet("/agent-users?mine=1", {}, cfg)).find(
          (row) => row.id === profile.agentUserId
        )?.agentType
      : undefined;
    if (!agentType) {
      spinner.fail("Could not find this agent on the pod.");
      log.dim(`Add it again: synap agents add --name "${profile.label ?? name}"`);
      return;
    }
    spinner.stop();
    const { hubApiKey } = await provisionAgentKey(
      podProfile.config.podUrl,
      cfg.apiKey,
      agentType
    );
    log.success(`New key ${redactKey(hubApiKey)} minted for ${profile.label ?? name}.`);
    if (opts.showKey) displayNewKey(hubApiKey);
    updateLocalKey(name, profile, hubApiKey);
  } catch (err) {
    spinner.fail("Key rotation failed.");
    log.error(err instanceof Error ? err.message : String(err));
  }
}

function displayNewKey(key: string): void {
  log.blank();
  console.log(chalk.yellow("  *** Save this new API key — it will not be shown again ***"));
  console.log();
  console.log(`  ${chalk.bold("New API key:")}  ${chalk.green(key)}`);
  console.log();
  console.log(chalk.yellow("  *** End of key — store it securely now ***"));
  log.blank();
}

function updateLocalKey(name: string, profile: AgentProfile, newKey: string): void {
  addAgent(name, { ...profile, apiKey: newKey });
  log.success(`Local agent config updated with new key.`);
}
