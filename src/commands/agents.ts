/**
 * synap agents — manage named agent identities
 *
 *   synap agents list              list all configured agent identities
 *   synap agents add               add a named agent identity (legacy — use create for new agents)
 *   synap agents create            create a new agent on the pod with template support
 *   synap agents remove <name>     remove an agent identity
 *   synap agents info <name>       show details for an agent identity
 *   synap agents rotate-key <n>    rotate the API key for an agent
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
import { getActivePodConfig, listPodProfiles } from "../lib/pod.js";
import { resolveHubConfig, hubGet, hubPost } from "../lib/hub-client.js";

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

export function agentsList(opts: { json?: boolean } = {}): void {
  const agents = listAgents();

  if (opts.json) {
    console.log(
      JSON.stringify(
        agents.map(({ name, profile }) => ({
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
    log.info("No agent identities configured. Use: synap agents create --template=assistant --name <n>");
    return;
  }

  log.heading("Configured agent identities");

  for (const { name, profile } of agents) {
    const workspace = profile.workspaceId ? chalk.dim(` ws:${profile.workspaceId.slice(0, 8)}…`) : "";
    const label = profile.label ? chalk.dim(` (${profile.label})`) : "";
    const template = chalk.dim((profile.template ?? "—").padEnd(10));
    const governance = chalk.dim(resolveGovernance(profile).padEnd(10));
    console.log(
      `  ${chalk.bold(name.padEnd(16))}` +
        `  pod:${chalk.cyan(profile.podName.padEnd(12))}` +
        `  key:${chalk.dim(maskKey(profile.apiKey))}` +
        `  tmpl:${template}` +
        `  gov:${governance}` +
        workspace +
        label
    );
  }

  log.blank();
  log.dim("synap agents create    — create a new agent on the pod");
  log.dim("synap agents info <n>  — show full details");
}

// ─── add (legacy) ─────────────────────────────────────────────────────────────
// Deprecated: Use `synap agents create` for new agents.
// `add` is for registering pre-existing agent credentials.

export async function agentsAdd(opts: {
  name?: string;
  apiKey?: string;
  pod?: string;
  workspace?: string;
  label?: string;
} = {}): Promise<void> {
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
  let podName = opts.pod;
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
    log.error(`Pod profile '${podName}' not found.`);
    if (allProfiles.length > 0) log.dim("Available: " + allProfiles.map((p) => p.name).join(", "));
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

export function agentsInfo(name: string): void {
  const profile = getAgent(name);

  if (!profile) {
    log.error(`Agent '${name}' not found.`);
    const all = listAgents();
    if (all.length > 0) log.dim("Available: " + all.map((a) => a.name).join(", "));
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
}

// ─── create ───────────────────────────────────────────────────────────────────

type AgentTemplate = "twin" | "assistant" | "custom";
type AgentRole = "admin" | "editor" | "viewer";

interface TrpcResponse<T> {
  result?: { data?: T };
  error?: { message: string; code?: string };
}

async function trpcMutation<T>(
  podUrl: string,
  apiKey: string,
  procedure: string,
  input: unknown
): Promise<T> {
  const url = `${podUrl}/trpc/${procedure}`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ json: input }),
    signal: AbortSignal.timeout(15_000),
  });
  const body = (await res.json()) as TrpcResponse<T>;
  if (!res.ok || body.error) {
    throw new Error(body.error?.message ?? `HTTP ${res.status}`);
  }
  if (!body.result?.data) throw new Error("Unexpected empty response from tRPC");
  return body.result.data;
}

async function resolveWorkspace(
  cfg: Awaited<ReturnType<typeof resolveHubConfig>>,
  preferredWorkspaceId?: string
): Promise<string> {
  if (preferredWorkspaceId) return preferredWorkspaceId;

  const result = await hubGet("/workspaces", {}, cfg) as { workspaces?: Array<{ id: string; name: string }> };
  const workspaceList = result.workspaces ?? (result as unknown as Array<{ id: string; name: string }>);
  const list = Array.isArray(workspaceList) ? workspaceList : [];

  if (list.length === 0) throw new Error("No workspaces found on this pod.");
  if (list.length === 1) return list[0].id;

  if (!process.stdin.isTTY) return list[0].id;

  const { picked } = await prompts({
    type: "select",
    name: "picked",
    message: "Which workspace should this agent belong to?",
    choices: list.map((ws) => ({ title: `${ws.name} (${ws.id.slice(0, 8)}…)`, value: ws.id })),
  });
  if (!picked) throw new Error("Workspace selection cancelled.");
  return picked as string;
}

export async function agentsCreate(opts: {
  template?: string;
  name?: string;
  type?: string;
  role?: string;
  workspace?: string;
  pod?: string;
} = {}): Promise<void> {
  const template = (opts.template ?? "custom") as AgentTemplate;
  if (!["twin", "assistant", "custom"].includes(template)) {
    log.error(`Unknown template '${template}'. Use: twin | assistant | custom`);
    return;
  }

  // Resolve pod profile
  const allProfiles = listPodProfiles();
  if (allProfiles.length === 0) {
    log.error("No pod profiles configured. Run: synap pods add");
    return;
  }
  const activePod = opts.pod
    ? allProfiles.find((p) => p.name === opts.pod)
    : allProfiles.find((p) => p.active) ?? allProfiles[0];

  if (!activePod) {
    log.error(`Pod profile '${opts.pod}' not found.`);
    return;
  }

  const cfg = await resolveHubConfig();

  // Resolve workspace
  let workspaceId: string;
  try {
    workspaceId = await resolveWorkspace(cfg, opts.workspace);
  } catch (err) {
    log.error(err instanceof Error ? err.message : String(err));
    return;
  }

  // Resolve name
  let agentName = opts.name;
  if (template === "twin") {
    // Fetch the caller's display name for a generated twin name
    try {
      const me = await hubGet("/users/me", {}, cfg) as { name?: string; email?: string };
      agentName = agentName ?? `${me.name ?? me.email ?? "User"}'s Twin`;
    } catch {
      agentName = agentName ?? "My Twin";
    }
  } else if (!agentName) {
    if (!process.stdin.isTTY) {
      log.error("--name is required for assistant/custom templates in non-interactive mode");
      return;
    }
    const { inputName } = await prompts({
      type: "text",
      name: "inputName",
      message: `Agent name (template: ${template}):`,
      validate: (v: string) => v.trim().length > 0 || "Name is required",
    });
    if (!inputName) return;
    agentName = (inputName as string).trim();
  }

  // Resolve agentType
  let agentType = opts.type;
  if (!agentType) {
    agentType = template === "twin" ? "twin" : template === "assistant" ? "assistant" : "custom";
  }

  // Resolve role — twin inherits, others default to editor
  const role = template === "twin"
    ? "editor"
    : ((opts.role as AgentRole | undefined) ?? "editor") as AgentRole;

  const spinner = ora(`Creating ${template} agent on pod...`).start();

  try {
    // Step 1: create agent user on the pod via tRPC
    const created = await trpcMutation<{
      id: string;
      email: string;
      name: string;
      agentType: string;
      role: string;
    }>(
      activePod.config.podUrl,
      cfg.apiKey,
      "agentUsers.create",
      {
        workspaceId,
        agentType,
        name: agentName,
        role,
        description: `Created via synap CLI (template: ${template})`,
        capabilities: [template],
      }
    );

    // Step 2: mint a Hub Protocol API key for the new agent
    const keyResult = await trpcMutation<{
      id: string;
      key: string;
      keyPrefix: string;
      status: string;
    }>(
      activePod.config.podUrl,
      cfg.apiKey,
      "apiKeys.create",
      {
        keyName: `${agentName} — CLI (${template})`,
        scope: ["hub-protocol.read", "hub-protocol.write"],
        workspaceId,
      }
    );

    spinner.succeed(`Agent created: ${chalk.bold(agentName)}`);
    log.blank();
    console.log(`  ${"ID".padEnd(12)}  ${chalk.dim(created.id)}`);
    console.log(`  ${"Name".padEnd(12)}  ${chalk.bold(created.name)}`);
    console.log(`  ${"Template".padEnd(12)}  ${template}`);
    console.log(`  ${"Role".padEnd(12)}  ${role}`);
    console.log(`  ${"Workspace".padEnd(12)}  ${workspaceId.slice(0, 8)}…`);
    log.blank();

    if (keyResult.key) {
      console.log(chalk.yellow("  *** Save this API key — it will not be shown again ***"));
      console.log();
      console.log(`  ${chalk.bold("API key:")}  ${chalk.green(keyResult.key)}`);
      console.log();
      console.log(chalk.yellow("  *** End of key — store it securely now ***"));
      log.blank();
    }

    // Determine a safe local name for this agent identity
    const localName = agentName
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "");

    // Store locally in agents config
    const profile: AgentProfile = {
      podName: activePod.name,
      apiKey: keyResult.key,
      workspaceId,
      label: agentName,
      createdAt: new Date().toISOString(),
      template,
      agentUserId: created.id,
    };
    addAgent(localName, profile);

    log.success(`Agent identity '${localName}' saved locally.`);
    log.dim(`Use SYNAP_AGENT=${localName} to activate this identity.`);
  } catch (err) {
    spinner.fail("Agent creation failed.");
    log.error(err instanceof Error ? err.message : String(err));
  }
}

// ─── rotate-key ───────────────────────────────────────────────────────────────

export async function agentsRotateKey(nameOrId: string): Promise<void> {
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
    log.error(`Pod profile '${profile.podName}' not found.`);
    return;
  }

  const spinner = ora("Finding active key and rotating...").start();

  try {
    // Find the active API key for this agent user
    // We list keys owned by the caller and find one matching the agent
    // The key was created with the agent's userId — but we minted it as the
    // caller, so it's under the caller's keys. We look up by prefix match.
    const keysResult = await fetch(`${podProfile.config.podUrl}/trpc/apiKeys.list`, {
      method: "GET",
      headers: { Authorization: `Bearer ${cfg.apiKey}` },
      signal: AbortSignal.timeout(10_000),
    });

    let activeKeyId: string | undefined;

    if (keysResult.ok) {
      const keysBody = (await keysResult.json()) as TrpcResponse<Array<{ id: string; keyPrefix: string; keyName: string; isActive: boolean }>>;
      const keys = keysBody.result?.data ?? [];
      // Match by keyName pattern used in agentsCreate
      const agentKeyName = profile.label ?? name;
      const match = keys.find(
        (k) => k.isActive && k.keyName.startsWith(agentKeyName)
      );
      activeKeyId = match?.id;
    }

    if (!activeKeyId) {
      spinner.warn("Could not find an active key record — will create a fresh key instead.");

      // Create a new key directly
      const newKeyResult = await trpcMutation<{ id: string; key: string; keyPrefix: string }>(
        podProfile.config.podUrl,
        cfg.apiKey,
        "apiKeys.create",
        {
          keyName: `${profile.label ?? name} — CLI (rotated ${new Date().toISOString().slice(0, 10)})`,
          scope: ["hub-protocol.read", "hub-protocol.write"],
          workspaceId: profile.workspaceId,
        }
      );

      spinner.succeed("New key minted.");
      displayNewKey(newKeyResult.key);
      updateLocalKey(name, profile, newKeyResult.key);
      return;
    }

    // Rotate the found key
    const rotated = await trpcMutation<{ id: string; key: string; status: string }>(
      podProfile.config.podUrl,
      cfg.apiKey,
      "apiKeys.rotate",
      { keyId: activeKeyId }
    );

    spinner.succeed("Key rotated successfully.");
    displayNewKey(rotated.key);
    updateLocalKey(name, profile, rotated.key);
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
