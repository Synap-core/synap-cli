/**
 * synap pods — manage multiple pod profiles and switch between them
 *
 *   synap pods list              list all configured pods
 *   synap pods add [name]        connect a new pod and save as a named profile
 *   synap pods use <name>        switch active pod and propagate to all surfaces
 *   synap pods remove <name>     remove a pod profile
 */

import prompts from "prompts";
import ora from "ora";
import chalk from "chalk";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { log } from "../utils/logger.js";
import {
  checkPodHealth,
  addPodProfile,
  setActivePod,
  setSurfacePod,
  removePodProfile,
  listPodProfiles,
  podNotFoundMessage,
  SURFACE_NAMES,
  type SurfaceName,
} from "../lib/pod.js";
import {
  TARGETS,
  writeMcpServerEntry,
  writeClaudeCodeEnv,
  provisionAgentKey,
  configureAgentContext,
} from "../lib/targets.js";
import { runBrowserAuth } from "../lib/browser-auth.js";


// ─── list ─────────────────────────────────────────────────────────────────────

export async function podsList(): Promise<void> {
  const profiles = listPodProfiles();

  if (profiles.length === 0) {
    log.info("No pods configured. Run: synap pods add");
    return;
  }

  log.heading("Configured pods");

  const checks = await Promise.all(
    profiles.map(async (p) => {
      const health = await checkPodHealth(p.config.podUrl).catch(() => ({ healthy: false }));
      return { ...p, healthy: health.healthy };
    })
  );

  for (const p of checks) {
    const active = p.active ? chalk.green(" ● active") : chalk.dim(" ○");
    const health = p.healthy ? chalk.green("healthy") : chalk.red("unreachable");
    const label = p.config.label ? chalk.dim(` (${p.config.label})`) : "";
    console.log(`  ${chalk.bold(p.name.padEnd(14))}${active}  ${health}  ${chalk.dim(p.config.podUrl)}${label}`);
  }

  log.blank();
  log.dim("synap pods use <name>  — switch active pod");
  log.dim("synap pods add [name]  — connect another pod");
}

// ─── add ──────────────────────────────────────────────────────────────────────

export async function podsAdd(name?: string, podUrlArg?: string): Promise<void> {
  // Resolve profile name
  let profileName = name;
  if (!profileName) {
    const existing = listPodProfiles().map((p) => p.name);
    const { inputName } = await prompts({
      type: "text",
      name: "inputName",
      message: "Profile name for this pod:",
      initial: existing.includes("personal") ? "team" : existing.includes("default") ? "personal" : "default",
      validate: (v: string) => v.trim().length > 0 || "Name is required",
    });
    if (!inputName) return;
    profileName = (inputName as string).trim().toLowerCase().replace(/\s+/g, "-");
  }

  // Pod URL — pre-filled if passed as positional arg
  const { url } = await prompts({
    type: "text",
    name: "url",
    message: "Pod URL:",
    initial: podUrlArg ?? "https://",
    validate: (v: string) => v.startsWith("http") || "Must be a valid URL",
  });
  if (!url) return;

  const spinner = ora("Checking pod health...").start();
  const health = await checkPodHealth(url as string);
  if (!health.healthy) {
    spinner.fail(`Pod not reachable at ${url}`);
    return;
  }
  spinner.succeed(`Pod healthy at ${url}`);

  // Optional label
  const { label } = await prompts({
    type: "text",
    name: "label",
    message: "Label (optional, e.g. 'Personal' or 'Team'):",
  });

  // API key
  const { method } = await prompts({
    type: "select",
    name: "method",
    message: "Authentication:",
    choices: [
      { title: "Open browser to approve (recommended)", value: "browser" },
      { title: "Paste existing API key", value: "paste" },
      { title: "Generate via PROVISIONING_TOKEN (self-hosted admin)", value: "provisioning" },
    ],
  });
  if (!method) return;

  let apiKey: string | undefined;
  let workspaceId: string | undefined;
  let agentUserId: string | undefined;
  const podUrl = url as string;

  if (method === "browser") {
    const browserSpinner = ora("Opening browser to approve...").start();
    try {
      const result = await runBrowserAuth({
        podUrl,
        integration: "cli",
        onUrlReady: (authUrl) => {
          browserSpinner.stop();
          log.info(`Opening ${chalk.cyan(authUrl)}`);
          log.dim("Sign in and click Generate & connect.");
        },
      });
      apiKey = result.apiKey;
      workspaceId = result.workspaceId;
    } catch (err) {
      browserSpinner.stop();
      log.error(err instanceof Error ? err.message : "Browser flow failed");
      return;
    }
  } else if (method === "paste") {
    const { key } = await prompts({ type: "password", name: "key", message: "Hub Protocol API key:" });
    apiKey = key as string | undefined;
  } else if (method === "provisioning") {
    const { token } = await prompts({ type: "password", name: "token", message: "PROVISIONING_TOKEN:" });
    if (!token) return;
    const genSpinner = ora("Creating agent credentials...").start();
    try {
      // Agents are pod-wide singletons now — no per-agent workspaceId comes back
      // from setup (the old setupAgent() never passed one either, so this was
      // already always null/"" in practice). Provision via the shared wrapper.
      // No enrollAgentIfNeeded here: a PROVISIONING_TOKEN isn't a Hub Protocol
      // API key, so it can't authorize /workspaces/enroll-agent (hub-protocol.write
      // scope) — same as before this consolidation.
      const result = await provisionAgentKey(podUrl, token as string, "cli");
      apiKey = result.hubApiKey;
      agentUserId = result.agentUserId;
      genSpinner.succeed("Credentials created");
    } catch (err) {
      genSpinner.fail(err instanceof Error ? err.message : "Failed");
      return;
    }
  }

  if (!apiKey) return;

  addPodProfile(profileName, {
    podUrl,
    workspaceId: workspaceId ?? "",
    agentUserId: agentUserId ?? "",
    hubApiKey: apiKey,
    label: (label as string | undefined) || undefined,
    savedAt: new Date().toISOString(),
  });

  if (agentUserId) {
    try {
      await configureAgentContext(podUrl, apiKey, "cli", agentUserId);
    } catch (err) {
      log.warn(`Agent context wizard failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  log.blank();
  log.success(`Pod '${profileName}' saved.`);
  log.dim(`Run: synap pods use ${profileName}  — to make it active`);
}

// ─── use ──────────────────────────────────────────────────────────────────────

export type { SurfaceName };

const SURFACE_LABELS: Record<string, string> = {
  raycast: "Raycast",
  "claude-code": "Claude Code",
  "claude-desktop": "Claude Desktop",
  cursor: "Cursor",
  opencode: "opencode",
  goose: "Goose",
};

/**
 * The surfaces `applySurfaceConfig` can actually write. SURFACE_NAMES is much
 * wider (it is the SSOT for every connect/agent identity), and `pods use
 * --surface <one of the others>` used to print success and do nothing.
 *
 * Typing applySurfaceConfig to this narrow union makes its switch exhaustive, so
 * adding a surface here without a writer is a COMPILE error, not a silent no-op.
 */
const SUPPORTED_USE_SURFACES = ["claude-desktop", "cursor", "claude-code", "raycast"] as const;
type SupportedUseSurface = (typeof SUPPORTED_USE_SURFACES)[number];

function isSupportedUseSurface(s: SurfaceName): s is SupportedUseSurface {
  return (SUPPORTED_USE_SURFACES as readonly string[]).includes(s);
}

/**
 * Raycast's support dir — its presence is our "is Raycast installed" gate.
 * Mirrors `raycastSupportDir()` in lib/targets.ts, which is private to that file.
 */
function raycastSupportDir(): string {
  return path.join(os.homedir(), "Library", "Application Support", "com.raycast.macos");
}

export async function podsUse(name: string, opts: { surface?: SurfaceName } = {}): Promise<void> {
  const profiles = listPodProfiles();
  const profile = profiles.find((p) => p.name === name);
  if (!profile) {
    log.error(podNotFoundMessage(name));
    return;
  }
  const podConfig = profile.config;

  if (opts.surface) {
    if (!isSupportedUseSurface(opts.surface)) {
      log.error(`'${opts.surface}' is not a surface \`pods use\` can configure.`);
      log.dim(`Supported: ${SUPPORTED_USE_SURFACES.join(", ")}`);
      log.dim(
        `Other surfaces (${SURFACE_NAMES.filter((s) => !isSupportedUseSurface(s)).join(", ")}) are configured via: synap connect --target=<surface>`
      );
      return;
    }
    // Per-surface switch — only update that surface's config
    try {
      setSurfacePod(opts.surface, name);
    } catch (err) {
      log.error(err instanceof Error ? err.message : String(err));
      return;
    }
    log.info(`${SURFACE_LABELS[opts.surface]} → pod '${name}' (${podConfig.podUrl})`);
    await applySurfaceConfig(opts.surface, podConfig);
    log.blank();
    log.dim("Other surfaces are unchanged. Run without --surface to switch all.");
    return;
  }

  // Global switch — update activePod + propagate to all surfaces
  setActivePod(name);
  log.info(`Switching all surfaces to pod '${name}' (${podConfig.podUrl})`);
  log.blank();

  const updated: string[] = [];

  // Claude Desktop
  const desktopPath = TARGETS["claude-desktop"].mcpConfigPath?.();
  if (desktopPath && fs.existsSync(desktopPath)) {
    writeMcpServerEntry(desktopPath, "synap", {
      command: "npx",
      args: ["-y", "mcp-remote", `${podConfig.podUrl.replace(/\/$/, "")}/mcp`, "--header", `Authorization: Bearer ${podConfig.hubApiKey}`],
    });
    updated.push("Claude Desktop");
  }

  // Cursor
  const cursorPath = TARGETS["cursor"].mcpConfigPath?.();
  if (cursorPath && fs.existsSync(cursorPath)) {
    writeMcpServerEntry(cursorPath, "synap", {
      url: `${podConfig.podUrl}/mcp`,
      headers: { Authorization: `Bearer ${podConfig.hubApiKey}` },
    });
    updated.push("Cursor");
  }

  // Claude Code
  const claudeSettings = path.join(os.homedir(), ".claude", "settings.json");
  if (fs.existsSync(claudeSettings)) {
    // Pod-wide: a workspace is a lens, not a container — don't weld the profile's
    // workspace into the MCP URL (matches the Desktop/Cursor entries above and
    // the `synap connect` default). Pins are set only via `synap connect --pin-*`.
    await writeClaudeCodeEnv({ podUrl: podConfig.podUrl, apiKey: podConfig.hubApiKey, agentUserId: podConfig.agentUserId });
    updated.push("Claude Code");
  }

  // Raycast reads ~/.synap/config.json directly — the activePod update above is
  // sufficient. Still gate on Raycast being installed: claiming we updated it on
  // a machine that has never run Raycast is a lie (same existsSync gate as above).
  if (fs.existsSync(raycastSupportDir())) {
    updated.push("Raycast");
  }

  if (updated.length === 0) {
    log.warn("Active pod switched, but no agent surface is configured on this machine.");
    log.dim("Connect one with: synap connect --target=<surface>");
    return;
  }

  log.success(`Updated: ${updated.join(", ")}`);
  log.dim("Restart any open agents to apply the new pod.");
  log.blank();
  log.dim("Tip: synap pods use <name> --surface <surface>  — switch only one surface");
}

/** Apply a pod config to a single surface's external config file. */
async function applySurfaceConfig(surface: SupportedUseSurface, podConfig: import("../lib/pod.js").LocalPodConfig): Promise<void> {
  switch (surface) {
    case "claude-desktop": {
      const p = TARGETS["claude-desktop"].mcpConfigPath?.();
      if (p && fs.existsSync(p)) {
        writeMcpServerEntry(p, "synap", {
          command: "npx",
          args: ["-y", "mcp-remote", `${podConfig.podUrl.replace(/\/$/, "")}/mcp`, "--header", `Authorization: Bearer ${podConfig.hubApiKey}`],
        });
        log.success("Claude Desktop MCP config updated.");
        log.dim("Quit + relaunch Claude Desktop to apply.");
      } else {
        log.dim("Claude Desktop config not found — run `synap connect --target=claude-desktop` first.");
      }
      break;
    }
    case "cursor": {
      const p = TARGETS["cursor"].mcpConfigPath?.();
      if (p && fs.existsSync(p)) {
        writeMcpServerEntry(p, "synap", {
          url: `${podConfig.podUrl}/mcp`,
          headers: { Authorization: `Bearer ${podConfig.hubApiKey}` },
        });
        log.success("Cursor MCP config updated.");
      } else {
        log.dim("Cursor config not found — run `synap connect --target=cursor` first.");
      }
      break;
    }
    case "claude-code": {
      const p = path.join(os.homedir(), ".claude", "settings.json");
      if (fs.existsSync(p)) {
        // Pod-wide: don't weld the profile's workspace into the MCP URL (see note
        // in `podsUse` above and the `synap connect` default).
        await writeClaudeCodeEnv({ podUrl: podConfig.podUrl, apiKey: podConfig.hubApiKey, agentUserId: podConfig.agentUserId });
        log.success("Claude Code env updated (~/.claude/settings.json).");
      } else {
        log.dim("Claude Code settings not found — run `synap connect --target=claude-code` first.");
      }
      break;
    }
    case "raycast":
      // Raycast reads ~/.synap/config.json directly — surfaces entry is enough.
      log.success("Raycast surface preference saved.");
      break;
    default: {
      // Exhaustiveness guard: widening SUPPORTED_USE_SURFACES without adding a
      // writer above fails to compile here, instead of silently doing nothing.
      const _exhaustive: never = surface;
      return _exhaustive;
    }
  }
}

// ─── switch (interactive) ─────────────────────────────────────────────────────

export async function podsSwitch(name?: string): Promise<void> {
  const profiles = listPodProfiles();

  if (profiles.length === 0) {
    log.info("No pods configured. Run: synap pods add");
    return;
  }

  let targetName = name;

  if (!targetName) {
    if (profiles.length === 1) {
      log.info(`Only one pod configured: ${chalk.bold(profiles[0].name)}`);
      targetName = profiles[0].name;
    } else {
      const active = profiles.find((p) => p.active);
      const { picked } = await prompts({
        type: "select",
        name: "picked",
        message: "Switch to which pod?",
        choices: profiles.map((p) => ({
          title: `${chalk.bold(p.name)}${p.active ? chalk.green("  ← active") : ""}  ${chalk.dim(p.config.podUrl)}`,
          value: p.name,
        })),
        initial: active ? profiles.indexOf(active) : 0,
      });
      if (!picked) return;
      targetName = picked as string;
    }
  }

  await podsUse(targetName);
}

// ─── remove ───────────────────────────────────────────────────────────────────

export async function podsRemove(name: string): Promise<void> {
  const profiles = listPodProfiles();
  const profile = profiles.find((p) => p.name === name);

  if (!profile) {
    log.error(podNotFoundMessage(name));
    return;
  }

  if (profile.active) {
    log.warn(`'${name}' is the active pod.`);
    const remaining = profiles.filter((p) => p.name !== name);
    if (remaining.length > 0) {
      log.dim(`Will switch to '${remaining[0].name}' after removal.`);
    }
  }

  const { confirm } = await prompts({
    type: "confirm",
    name: "confirm",
    message: `Remove pod profile '${name}' (${profile.config.podUrl})?`,
    initial: false,
  });
  if (!confirm) return;

  removePodProfile(name);
  log.success(`Removed '${name}'.`);

  const after = listPodProfiles();
  if (after.length > 0 && profile.active) {
    log.dim(`Active pod is now '${after[0].name}'.`);
  }
}

// ─── reconnect ────────────────────────────────────────────────────────────────

/**
 * Re-run the browser auth flow against an already-saved pod URL.
 * Lets users refresh a broken/expired API key without re-entering the pod URL.
 */
export async function podsReconnect(name?: string): Promise<void> {
  const profiles = listPodProfiles();

  if (profiles.length === 0) {
    log.info("No pods configured. Run: synap pods add");
    return;
  }

  let targetName = name;

  if (!targetName) {
    if (profiles.length === 1) {
      targetName = profiles[0].name;
    } else {
      const active = profiles.find((p) => p.active);
      const { picked } = await prompts({
        type: "select",
        name: "picked",
        message: "Which pod do you want to reconnect?",
        choices: profiles.map((p) => ({
          title: `${chalk.bold(p.name)}${p.active ? chalk.green("  ← active") : ""}  ${chalk.dim(p.config.podUrl)}`,
          value: p.name,
        })),
        initial: active ? profiles.indexOf(active) : 0,
      });
      if (!picked) return;
      targetName = picked as string;
    }
  }

  const profile = profiles.find((p) => p.name === targetName);
  if (!profile) {
    log.error(podNotFoundMessage(targetName));
    return;
  }

  const podUrl = profile.config.podUrl;
  log.info(`Reconnecting to ${chalk.cyan(podUrl)}`);

  const spinner = ora("Checking pod health...").start();
  const health = await checkPodHealth(podUrl);
  if (!health.healthy) {
    spinner.fail(`Pod not reachable at ${podUrl}. Check that it is running.`);
    return;
  }
  spinner.succeed("Pod is reachable");

  let apiKey: string | undefined;
  let workspaceId: string | undefined;

  const browserSpinner = ora("Opening browser to approve new credentials...").start();
  try {
    const result = await runBrowserAuth({
      podUrl,
      integration: "cli",
      onUrlReady: (authUrl) => {
        browserSpinner.stop();
        log.info(`Opening ${chalk.cyan(authUrl)}`);
        log.dim("Sign in and click Generate & connect.");
      },
    });
    apiKey = result.apiKey;
    workspaceId = result.workspaceId;
  } catch (err) {
    browserSpinner.stop();
    log.error(err instanceof Error ? err.message : "Browser flow failed");
    return;
  }

  if (!apiKey) {
    log.error("No API key received. Reconnect cancelled.");
    return;
  }

  // Update the saved profile in place — preserve everything except credentials
  addPodProfile(targetName, {
    ...profile.config,
    hubApiKey: apiKey,
    ...(workspaceId ? { workspaceId } : {}),
    savedAt: new Date().toISOString(),
  });

  log.success(`Pod '${targetName}' credentials refreshed.`);

  // Propagate the new key to connected surfaces (same as podsUse)
  await podsUse(targetName);
}
