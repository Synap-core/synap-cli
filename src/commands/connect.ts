/**
 * synap connect
 *
 * Wire an AI surface to a configured Synap pod. Credentials come from stored
 * pod profiles (synap pods add) — no re-authentication needed.
 *
 * Usage:
 *   synap connect                              (interactive: pick surface + pod)
 *   synap connect --target=claude-code
 *   synap connect --target=claude-desktop
 *   synap connect --target=cursor
 *   synap connect --target=raycast
 *   synap connect --target=openclaw
 *   synap connect --target=claude-code --name=team   (use specific pod profile)
 *
 * Escape hatch for scripting:
 *   synap connect --pod-url <url> --api-key <key>    (bypass stored profiles)
 */

import prompts from "prompts";
import ora from "ora";
import chalk from "chalk";
import { log, banner } from "../utils/logger.js";
import { checkPodHealth, listPodProfiles, type LocalPodConfig } from "../lib/pod.js";
import {
  installForTarget,
  isTargetName,
  listTargets,
  TARGETS,
  type TargetName,
} from "../lib/targets.js";
import { podsAdd } from "./pods.js";

interface ConnectOptions {
  podUrl?: string;
  apiKey?: string;
  target?: string;
  list?: boolean;
  name?: string;
  manualKey?: boolean;
}

export async function connect(opts: ConnectOptions): Promise<void> {
  banner();

  if (opts.list) {
    listTargets();
    return;
  }

  // ── Step 1: Pod (data source) ───────────────────────────────────────────
  // Resolve pod first — the surface config depends on which pod to point at.
  let podUrl = opts.podUrl;
  let apiKey = opts.apiKey;
  let workspaceId: string | undefined;
  let agentUserId: string | undefined;

  if (!podUrl || !apiKey) {
    const resolved = await resolvePodFromProfiles(opts.name);
    if (!resolved) return;
    podUrl = resolved.podUrl;
    apiKey = resolved.hubApiKey;
    workspaceId = resolved.workspaceId || undefined;
    agentUserId = resolved.agentUserId || undefined;
  }

  // ── Step 2: Health check ────────────────────────────────────────────────
  const spinner = ora("Checking pod health...").start();
  const health = await checkPodHealth(podUrl);
  if (!health.healthy) {
    spinner.fail(`Pod not reachable at ${podUrl}`);
    return;
  }
  spinner.succeed(`Pod healthy at ${podUrl}`);

  // ── Step 3: Target (AI surface) ─────────────────────────────────────────
  const target = await resolveTarget(opts.target);
  if (!target) return;

  // ── Step 4: Install ─────────────────────────────────────────────────────
  log.heading(`Connecting ${TARGETS[target].label} → ${podUrl}`);

  const ok = await installForTarget(target, { podUrl, apiKey, workspaceId, agentUserId });

  log.blank();
  if (ok) {
    log.success(`${TARGETS[target].label} connected to ${podUrl}`);
    // For MCP targets, surface the provider pull option — lets users get real
    // AI provider credentials from the pod vault into their local tool config.
    if (TARGETS[target].supports.mcp) {
      log.blank();
      log.dim("To also configure an AI provider (opencode, aider, etc.) from the pod:");
      log.dim("  synap providers pull");
    }
    log.dim("Run 'synap connections' to see all surface connections.");
  } else {
    log.warn(`${TARGETS[target].label} install did not complete — see above.`);
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

async function resolvePodFromProfiles(preferredName?: string): Promise<LocalPodConfig | null> {
  let profiles = listPodProfiles();

  // No pods yet — offer to add one inline instead of dead-ending
  if (profiles.length === 0) {
    log.blank();
    log.info("No pods configured yet.");
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

  // --name flag: use that profile directly
  if (preferredName) {
    const match = profiles.find((p) => p.name === preferredName);
    if (!match) {
      log.error(`Pod profile '${preferredName}' not found.`);
      log.dim("Available: " + profiles.map((p) => p.name).join(", "));
      return null;
    }
    log.info(`Using pod: ${chalk.bold(match.name)}  ${chalk.dim(match.config.podUrl)}`);
    return match.config;
  }

  // Single profile: show it so the user knows what they're connecting to
  if (profiles.length === 1) {
    const p = profiles[0];
    log.info(`Pod: ${chalk.bold(p.name)}  ${chalk.dim(p.config.podUrl)}`);
    return p.config;
  }

  // Multiple profiles: let user pick
  const active = profiles.find((p) => p.active);
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
    const updated = listPodProfiles();
    // Return the most recently added profile (last in list)
    const newest = updated.filter((p) => !profiles.some((o) => o.name === p.name));
    if (newest.length > 0) {
      log.info(`Using pod: ${chalk.bold(newest[0].name)}  ${chalk.dim(newest[0].config.podUrl)}`);
      return newest[0].config;
    }
    return null;
  }

  return profiles.find((p) => p.name === profileName)!.config;
}

async function resolveTarget(raw?: string): Promise<TargetName | null> {
  if (raw) {
    if (!isTargetName(raw)) {
      log.error(`Unknown target: ${raw}`);
      log.dim("Run `synap connect --list` to see supported targets.");
      return null;
    }
    return raw;
  }

  const { target } = await prompts({
    type: "select",
    name: "target",
    message: "Which AI surface are you connecting?",
    choices: Object.values(TARGETS).map((t) => ({
      title: `${t.label}${describeCaps(t.supports)}`,
      value: t.name,
    })),
  });

  if (!target || !isTargetName(target)) return null;
  return target;
}

function describeCaps(supports: { skills: boolean; mcp: boolean }): string {
  const parts: string[] = [];
  if (supports.skills) parts.push("skills");
  if (supports.mcp) parts.push("MCP");
  return parts.length ? `  ${chalk.dim(`(${parts.join(" + ")})`)}` : "";
}

// (detectAndSaveAgentWorkspaceRouting removed — agents are pod-wide now; there
// is no "memory workspace" to auto-detect and pin. Memory is automatic.)
