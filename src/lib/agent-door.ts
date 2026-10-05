/**
 * The ONE door for bringing an agent into a pod.
 *
 * `synap agents add`, `synap connect`, `synap init` and the deprecated
 * `synap agents create` all land here, so there is one answer to every
 * question they used to answer differently:
 *
 *   - Scope: POD-WIDE by default. `--workspace` / `--project` narrow it, and
 *     they compose. (`agents create` used to force a workspace — that broke the
 *     2026-08-04 decision that a workspace is a lens, not a container.)
 *   - Approval: every new agent key goes through the pod's approval page.
 *     (`agents create` used to mint with `requireApproval: false`.)
 *   - Proof: every path ends with a check against the pod's `/mcp` using the
 *     AGENT key — the key the client will actually hold.
 *
 * Three ways in, picked by `planAgentAdd`:
 *   known   — a client we can wire (claude-code, cursor, codex, …): mint, write
 *             its config, verify. Same installer as before (`installForTarget`).
 *   custom  — anything else: mint, print the URL + key + paste-ready snippets,
 *             verify.
 *   detect  — nothing named: find the agents on this machine, pick, plus a
 *             "something else" row that falls through to custom.
 * And one way to bring a key you already hold (`--api-key`), which only
 * registers it locally — handled by the caller, never here.
 */

import chalk from "chalk";
import ora from "ora";
import prompts from "prompts";
import { log } from "../utils/logger.js";
import {
  checkPodHealth,
  getPodOverride,
  listPodProfiles,
  podNotFoundMessage,
  RESERVED_AGENT_TYPES,
  type LocalPodConfig,
} from "./pod.js";
import {
  buildMcpUrl,
  configureAgentContext,
  enrollAgentIfNeeded,
  installForTarget,
  isTargetName,
  provisionAgentKey,
  TARGETS,
  verifyMcpConnection,
  type TargetName,
} from "./targets.js";
import { addAgent, type AgentProfile } from "./agents-config.js";
import { printMcpConnection } from "./mcp-snippets.js";

// ─── Plan (pure) ──────────────────────────────────────────────────────────────

export type AgentTemplate = "twin" | "assistant" | "custom";
export type AgentRole = "admin" | "editor" | "viewer";
export const AGENT_TEMPLATES: readonly AgentTemplate[] = ["twin", "assistant", "custom"];
export const AGENT_ROLES: readonly AgentRole[] = ["admin", "editor", "viewer"];

/** Where the agent looks. Both unset = pod-wide. */
export interface AgentScope {
  workspaceId?: string;
  projectId?: string;
}

export type AgentAddPlan =
  | { mode: "existing-key" }
  | { mode: "known"; target: TargetName }
  | { mode: "custom"; name?: string }
  | { mode: "detect" };

/**
 * Decide which way in from what the user typed. `kind` is the positional
 * (`synap agents add <kind>`).
 *
 *   --api-key            → existing-key (wins: the user already holds a key)
 *   <kind> = a client    → known
 *   <kind> = "custom"    → custom, name from --name (or prompted)
 *   <kind> = other word  → custom, named after it
 *   --name / --template  → custom
 *   nothing              → detect
 */
export function planAgentAdd(
  kind: string | undefined,
  opts: { apiKey?: string; name?: string; template?: string }
): AgentAddPlan {
  if (opts.apiKey) return { mode: "existing-key" };
  const k = kind?.trim();
  if (k && isTargetName(k)) return { mode: "known", target: k };
  if (k && k !== "custom") return { mode: "custom", name: opts.name ?? k };
  if (k === "custom" || opts.name || (opts.template && opts.template !== "custom")) {
    return { mode: "custom", name: opts.name };
  }
  return { mode: "detect" };
}

/**
 * The agent type a custom agent is minted under. The pod keeps ONE agent per
 * (human, agentType), so two differently-named agents need two types: the
 * slug of the name, unless `--type` was given. A twin is always `twin`.
 */
export function customAgentType(
  name: string,
  template: AgentTemplate,
  explicitType?: string
): { agentType: string; localName: string } {
  const localName =
    name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || template;
  const agentType = explicitType ?? (template === "twin" ? "twin" : localName);
  return { agentType, localName };
}

// ─── Pod ──────────────────────────────────────────────────────────────────────

export interface AgentPod {
  podUrl: string;
  /** The HUMAN key that mints agent keys. Never written into a client config. */
  apiKey: string;
  podName?: string;
}

/**
 * Which pod the agent joins. In order: explicit --pod-url + --api-key, the
 * global `--pod <name>` override, `profileName` (connect's `--name`), the only
 * profile, a pick. With no profile at all, offers to add one inline.
 */
export async function resolveAgentPod(opts: {
  podUrl?: string;
  apiKey?: string;
  profileName?: string;
}): Promise<AgentPod | null> {
  if (opts.podUrl && opts.apiKey) return { podUrl: opts.podUrl, apiKey: opts.apiKey };

  const override = getPodOverride();
  if (override && !opts.profileName) {
    const name = listPodProfiles().find((p) => p.config.podUrl === override.podUrl)?.name;
    log.info(`Pod: ${chalk.bold(name ?? override.podUrl)}  ${chalk.dim(override.podUrl)}`);
    return { podUrl: override.podUrl, apiKey: override.hubApiKey, podName: name };
  }

  const picked = await pickPodProfile(opts.profileName);
  return picked ? { podUrl: picked.config.podUrl, apiKey: picked.config.hubApiKey, podName: picked.name } : null;
}

async function pickPodProfile(
  preferredName?: string
): Promise<{ name: string; config: LocalPodConfig } | null> {
  const { podsAdd } = await import("../commands/pods.js");
  let profiles = listPodProfiles();

  // No pods yet — offer to add one inline instead of dead-ending.
  if (profiles.length === 0) {
    log.blank();
    log.info("No pods configured yet.");
    if (!process.stdin.isTTY) {
      log.dim("Add one first: synap pods add <name> <url>");
      return null;
    }
    const { shouldAdd } = await prompts({
      type: "confirm",
      name: "shouldAdd",
      message: "Add a pod now?",
      initial: true,
    });
    if (!shouldAdd) return null;
    log.blank();
    await podsAdd();
    profiles = listPodProfiles();
    if (profiles.length === 0) return null; // user bailed out of add flow
  }

  if (preferredName) {
    const match = profiles.find((p) => p.name === preferredName);
    if (!match) {
      log.error(podNotFoundMessage(preferredName));
      return null;
    }
    log.info(`Pod: ${chalk.bold(match.name)}  ${chalk.dim(match.config.podUrl)}`);
    return match;
  }

  const active = profiles.find((p) => p.active);
  if (profiles.length === 1 || !process.stdin.isTTY) {
    const p = active ?? profiles[0];
    log.info(`Pod: ${chalk.bold(p.name)}  ${chalk.dim(p.config.podUrl)}`);
    return p;
  }

  const { profileName } = await prompts({
    type: "select",
    name: "profileName",
    message: "Which pod?",
    choices: [
      ...profiles.map((p) => ({
        title: `${chalk.bold(p.name)}${p.active ? chalk.green("  ← active") : ""}  ${chalk.dim(p.config.podUrl)}`,
        value: p.name,
      })),
      { title: chalk.dim("Add a new pod…"), value: "__add__" },
    ],
    initial: active ? profiles.indexOf(active) : 0,
  });
  if (!profileName) return null;

  if (profileName === "__add__") {
    log.blank();
    await podsAdd();
    const newest = listPodProfiles().filter((p) => !profiles.some((o) => o.name === p.name));
    if (newest.length === 0) return null;
    log.info(`Pod: ${chalk.bold(newest[0].name)}  ${chalk.dim(newest[0].config.podUrl)}`);
    return newest[0];
  }
  return profiles.find((p) => p.name === profileName) ?? null;
}

async function podIsHealthy(podUrl: string): Promise<boolean> {
  const spinner = ora("Checking pod health...").start();
  const health = await checkPodHealth(podUrl);
  if (!health.healthy) {
    spinner.fail(`Pod not reachable at ${podUrl}`);
    return false;
  }
  spinner.succeed(`Pod healthy at ${podUrl}`);
  return true;
}

function describeScope(scope: AgentScope): string {
  const parts: string[] = [];
  if (scope.workspaceId) parts.push(`workspace ${scope.workspaceId}`);
  if (scope.projectId) parts.push(`project ${scope.projectId}`);
  return parts.length ? parts.join(" · ") : "pod-wide";
}

// ─── Known client ─────────────────────────────────────────────────────────────

/** Mint → write the client's config → verify. Returns whether it connected. */
export async function connectKnownAgent(
  target: TargetName,
  pod: AgentPod,
  scope: AgentScope,
  opts: { withMcp?: boolean } = {}
): Promise<boolean> {
  if (!(await podIsHealthy(pod.podUrl))) return false;
  if (opts.withMcp && target !== "raycast") {
    log.warn("--with-mcp is Raycast-only; ignored for this target.");
  }

  log.heading(`Connecting ${TARGETS[target].label} → ${pod.podUrl}  ${chalk.dim(`(${describeScope(scope)})`)}`);
  const ok = await installForTarget(target, {
    podUrl: pod.podUrl,
    apiKey: pod.apiKey,
    workspaceId: scope.workspaceId,
    projectId: scope.projectId,
    withMcp: opts.withMcp,
  });

  log.blank();
  if (ok) {
    log.success(`${TARGETS[target].label} connected to ${pod.podUrl}`);
    log.dim("Run 'synap connections' to see everything connected.");
  } else {
    log.warn(`${TARGETS[target].label} install did not complete — see above.`);
  }
  return ok;
}

// ─── Custom agent ─────────────────────────────────────────────────────────────

export interface CustomAgentRequest {
  name?: string;
  template?: string;
  /** Explicit agent type (rare). Default: a slug of the name. */
  type?: string;
  role?: string;
  label?: string;
}

/** Mint → print URL + key + snippets → verify → remember locally. */
export async function createCustomAgent(
  pod: AgentPod,
  req: CustomAgentRequest,
  scope: AgentScope
): Promise<boolean> {
  const template = (req.template ?? "custom") as AgentTemplate;
  if (!AGENT_TEMPLATES.includes(template)) {
    log.error(`Unknown template '${template}'. Use: ${AGENT_TEMPLATES.join(" | ")}`);
    return false;
  }
  // Validate up front: the pod treats an unknown role as a non-fatal warning,
  // so a typo would otherwise print as applied.
  if (req.role && !AGENT_ROLES.includes(req.role as AgentRole)) {
    log.error(`Invalid --role "${req.role}". Valid roles: ${AGENT_ROLES.join(", ")}.`);
    return false;
  }
  const role: AgentRole = template === "twin" ? "editor" : ((req.role as AgentRole | undefined) ?? "editor");

  if (!(await podIsHealthy(pod.podUrl))) return false;

  let agentName = req.name?.trim();
  if (!agentName && template === "twin") {
    agentName = await twinName(pod);
  }
  if (!agentName) {
    if (!process.stdin.isTTY) {
      log.error("--name is required for a custom agent in non-interactive mode");
      return false;
    }
    const { inputName } = await prompts({
      type: "text",
      name: "inputName",
      message: "Name this agent (e.g. researcher, support-bot):",
      validate: (v: string) => v.trim().length > 0 || "Name is required",
    });
    if (!inputName) return false;
    agentName = (inputName as string).trim();
  }

  const { agentType, localName } = customAgentType(agentName, template, req.type);
  // A name that slugs to a client's type (claude-code, cursor, …) would reuse
  // THAT client's agent and rotate its key. An explicit --type is deliberate.
  if (!req.type && RESERVED_AGENT_TYPES.has(agentType)) {
    log.error(`The name "${agentName}" maps to the client type "${agentType}".`);
    log.dim(
      `To connect that client, run \`synap agents add ${agentType}\`. ` +
        `Otherwise pick another --name, or pass an explicit --type.`
    );
    return false;
  }

  log.heading(`Adding ${chalk.bold(agentName)} → ${pod.podUrl}  ${chalk.dim(`(${describeScope(scope)})`)}`);

  let hubApiKey: string;
  let agentUserId: string;
  try {
    // Approval is required (the default) — the same trust step every client
    // connect goes through. Idempotent: re-running for the same name reuses
    // the agent rather than minting a parallel one.
    ({ hubApiKey, agentUserId } = await provisionAgentKey(pod.podUrl, pod.apiKey, agentType, {
      idempotent: true,
    }));
  } catch (err) {
    log.error(err instanceof Error ? err.message : String(err));
    return false;
  }

  // No workspace = enrolled across every workspace (pod-wide).
  await enrollAgentIfNeeded(pod.podUrl, pod.apiKey, agentUserId, scope.workspaceId, { role });

  const url = buildMcpUrl(pod.podUrl, scope.workspaceId, scope.projectId);
  printMcpConnection({ url, hubApiKey, agentUserId, ...scope });
  log.blank();
  console.log(chalk.yellow("  Save this key now — the pod never shows it again."));

  const verifySpinner = ora(`Verifying ${agentName} can reach Synap…`).start();
  const v = await verifyMcpConnection(pod.podUrl, hubApiKey, { timeoutMs: 20_000 }).catch(
    (err: Error) => ({ ok: false as const, error: err.message })
  );
  if (v.ok) {
    verifySpinner.succeed(`${agentName} verified — ${v.toolCount} Synap tool(s) reachable at ${pod.podUrl}/mcp`);
  } else {
    verifySpinner.warn(`${agentName} was created but verification FAILED.`);
    log.warn(`  ${v.error}`);
  }

  const profile: AgentProfile = {
    podName: pod.podName ?? "default",
    apiKey: hubApiKey,
    label: req.label ?? agentName,
    createdAt: new Date().toISOString(),
    template,
    agentUserId,
  };
  if (scope.workspaceId) profile.workspaceId = scope.workspaceId;
  addAgent(localName, profile);
  log.dim(`Saved locally as '${localName}' — SYNAP_AGENT=${localName} acts as this agent.`);

  try {
    await configureAgentContext(pod.podUrl, hubApiKey, agentType, agentUserId);
  } catch (err) {
    log.warn(`Agent context wizard failed: ${err instanceof Error ? err.message : String(err)}`);
  }
  return v.ok;
}

async function twinName(pod: AgentPod): Promise<string> {
  try {
    const res = await fetch(`${pod.podUrl.replace(/\/$/, "")}/api/hub/users/me`, {
      headers: { Authorization: `Bearer ${pod.apiKey}` },
      signal: AbortSignal.timeout(8000),
    });
    if (res.ok) {
      const me = (await res.json()) as { name?: string; email?: string };
      if (me.name || me.email) return `${me.name ?? me.email}'s Twin`;
    }
  } catch {
    // The twin still gets a name; this read only personalises it.
  }
  return "My Twin";
}

// ─── Detect ───────────────────────────────────────────────────────────────────

const CUSTOM_CHOICE = "__custom__";

/**
 * Bare `synap agents add`: the agents found on this machine, preselected, plus
 * a "something else" row. Known picks connect together (one approval page);
 * "something else" then runs the custom path.
 */
export async function addDetectedAgents(pod: AgentPod, scope: AgentScope): Promise<boolean> {
  if (!process.stdin.isTTY) {
    log.error("Name the agent in non-interactive mode: synap agents add <client>  or  --name <name>");
    return false;
  }
  if (!(await podIsHealthy(pod.podUrl))) return false;

  const { detectAgents } = await import("./agent-detect.js");
  const rows = detectAgents();
  const found = rows.filter((r) => r.found);
  log.info(
    found.length > 0
      ? `Found on this machine: ${found.map((r) => r.label).join(", ")}.`
      : "No agent found on this machine."
  );
  const { picked } = await prompts({
    type: "multiselect",
    name: "picked",
    message: "Connect:",
    choices: [
      ...rows.map((r) => ({
        title: r.label,
        description: r.found ? r.evidence : "not found on this machine",
        value: r.target,
        selected: r.found,
      })),
      {
        title: "Something else",
        description: "any other agent — you get a URL + key to paste",
        value: CUSTOM_CHOICE,
      },
    ],
    hint: "space to toggle, enter to confirm",
    instructions: false,
  });
  const values = (picked ?? []) as string[];
  if (values.length === 0) {
    log.dim("Nothing picked.");
    return false;
  }

  const targets = values.filter((v): v is TargetName => v !== CUSTOM_CHOICE && isTargetName(v));
  let ok = true;
  if (targets.length > 0) {
    const outcome = await connectAgentsBatch(pod, targets, scope);
    ok = outcome.notApproved.length === 0 && outcome.failed.length === 0;
  }
  if (values.includes(CUSTOM_CHOICE)) {
    ok = (await createCustomAgent(pod, {}, scope)) && ok;
  }
  return ok;
}

/**
 * Several known clients at once: every key approved on ONE page first, then
 * each installed, one line per client. `synap init` connects through here too.
 */
export async function connectAgentsBatch<T extends TargetName>(
  pod: AgentPod,
  targets: readonly T[],
  scope: AgentScope,
  opts: { after?: (target: T) => Promise<void>; labelOf?: (target: T) => string } = {}
): Promise<{ connected: T[]; notApproved: T[]; failed: T[] }> {
  const { connectAgents } = await import("./init-connect.js");
  const { approveAgentKeysAtOnce } = await import("./batch-approval.js");
  const { withHeldOutput } = await import("./init-output.js");
  const labelOf = opts.labelOf ?? ((t: T) => TARGETS[t]?.label ?? t);
  return connectAgents(targets, {
    approve: (ts) => approveAgentKeysAtOnce(pod.podUrl, pod.apiKey, ts),
    install: async (target) => {
      const run = await withHeldOutput(() =>
        installForTarget(target, {
          podUrl: pod.podUrl,
          apiKey: pod.apiKey,
          workspaceId: scope.workspaceId,
          projectId: scope.projectId,
          unattended: true,
        })
      );
      return {
        ok: run.value === true,
        output: run.held,
        error:
          run.error === undefined
            ? undefined
            : run.error instanceof Error
              ? run.error.message
              : String(run.error),
      };
    },
    after: opts.after,
    labelOf,
  });
}
