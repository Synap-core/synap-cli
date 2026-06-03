/**
 * synap connections
 *
 * Show which Synap pod each agent surface is currently pointing at,
 * and which stored profile it matches.
 *
 *   synap connections
 */

import chalk from "chalk";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { log } from "../utils/logger.js";
import { listPodProfiles } from "../lib/pod.js";
import { TARGETS } from "../lib/targets.js";
import { readOpenClawConfig } from "../lib/openclaw.js";

interface SurfaceStatus {
  label: string;
  configured: boolean;
  podUrl?: string;
  profile?: string;
  configPath?: string;
}

export async function connections(): Promise<void> {
  const profiles = listPodProfiles();

  // URL → profile name lookup (normalise trailing slash)
  const urlToProfile: Record<string, string> = {};
  for (const p of profiles) {
    urlToProfile[p.config.podUrl.replace(/\/$/, "")] = p.name;
  }

  const surfaces: SurfaceStatus[] = [
    detectClaudeCode(urlToProfile),
    detectClaudeDesktop(urlToProfile),
    detectCursor(urlToProfile),
    detectOpenClaw(urlToProfile),
    detectRaycast(urlToProfile),
  ];

  const configured = surfaces.filter((s) => s.configured);
  const unconfigured = surfaces.filter((s) => !s.configured);

  log.heading("Agent surface connections");

  if (configured.length === 0 && unconfigured.length === surfaces.length) {
    log.dim("No surfaces connected yet.");
    log.blank();
    log.info("Connect a surface:  synap connect");
    return;
  }

  // Widths for alignment
  const labelW = Math.max(...surfaces.map((s) => s.label.length)) + 2;
  const profileW = Math.max(10, ...configured.map((s) => (s.profile ?? "(unknown)").length)) + 2;

  for (const s of configured) {
    const icon = s.profile ? chalk.green("●") : chalk.yellow("●");
    const label = s.label.padEnd(labelW);
    const profileStr = s.profile
      ? chalk.bold(s.profile.padEnd(profileW))
      : chalk.yellow("(unknown pod)".padEnd(profileW));
    const url = chalk.dim(s.podUrl ?? "");
    console.log(`  ${icon} ${label} ${profileStr} ${url}`);
  }

  for (const s of unconfigured) {
    console.log(`  ${chalk.dim("○")} ${chalk.dim(s.label.padEnd(labelW))} ${chalk.dim("not configured")}`);
  }

  log.blank();

  if (profiles.length > 1) {
    log.dim("synap pods use <name>      — switch ALL surfaces to a pod");
  }
  log.dim("synap connect              — wire a surface to a specific pod");
  log.dim("synap pods list            — show configured pods");
}

// ─── Surface detectors ────────────────────────────────────────────────────────

function detectClaudeCode(urlToProfile: Record<string, string>): SurfaceStatus {
  const settingsPath = path.join(os.homedir(), ".claude", "settings.json");
  try {
    if (!fs.existsSync(settingsPath)) return { label: "Claude Code", configured: false, configPath: settingsPath };
    const settings = JSON.parse(fs.readFileSync(settingsPath, "utf-8")) as { env?: Record<string, string> };
    const podUrl = settings.env?.SYNAP_POD_URL;
    if (!podUrl) return { label: "Claude Code", configured: false, configPath: settingsPath };
    const profile = urlToProfile[podUrl.replace(/\/$/, "")];
    return { label: "Claude Code", configured: true, podUrl, profile, configPath: settingsPath };
  } catch {
    return { label: "Claude Code", configured: false, configPath: settingsPath };
  }
}

function detectClaudeDesktop(urlToProfile: Record<string, string>): SurfaceStatus {
  const configPath = TARGETS["claude-desktop"].mcpConfigPath?.();
  if (!configPath) return { label: "Claude Desktop", configured: false };
  try {
    if (!fs.existsSync(configPath)) return { label: "Claude Desktop", configured: false, configPath };
    const config = JSON.parse(fs.readFileSync(configPath, "utf-8")) as {
      mcpServers?: Record<string, { args?: string[]; url?: string }>;
    };
    const synap = config.mcpServers?.["synap"];
    if (!synap) return { label: "Claude Desktop", configured: false, configPath };

    // stdio bridge: args = ["-y", "mcp-remote", "<podUrl>/mcp", "--header", "..."]
    const rawUrl = synap.args?.[2] ?? synap.url;
    const podUrl = rawUrl?.replace(/\/mcp$/, "");
    if (!podUrl) return { label: "Claude Desktop", configured: false, configPath };
    const profile = urlToProfile[podUrl.replace(/\/$/, "")];
    return { label: "Claude Desktop", configured: true, podUrl, profile, configPath };
  } catch {
    return { label: "Claude Desktop", configured: false, configPath };
  }
}

function detectCursor(urlToProfile: Record<string, string>): SurfaceStatus {
  const configPath = TARGETS["cursor"].mcpConfigPath?.();
  if (!configPath) return { label: "Cursor", configured: false };
  try {
    if (!fs.existsSync(configPath)) return { label: "Cursor", configured: false, configPath };
    const config = JSON.parse(fs.readFileSync(configPath, "utf-8")) as {
      mcpServers?: Record<string, { url?: string }>;
    };
    const synap = config.mcpServers?.["synap"];
    const rawUrl = synap?.url;
    const podUrl = rawUrl?.replace(/\/mcp$/, "");
    if (!podUrl) return { label: "Cursor", configured: false, configPath };
    const profile = urlToProfile[podUrl.replace(/\/$/, "")];
    return { label: "Cursor", configured: true, podUrl, profile, configPath };
  } catch {
    return { label: "Cursor", configured: false, configPath };
  }
}

function detectOpenClaw(urlToProfile: Record<string, string>): SurfaceStatus {
  try {
    const ocConfig = readOpenClawConfig();
    const podUrl = (ocConfig as Record<string, unknown> | null)?.["synap"] as Record<string, unknown> | undefined;
    const url = podUrl?.["podUrl"] as string | undefined;
    if (!url) return { label: "OpenClaw", configured: false };
    const profile = urlToProfile[url.replace(/\/$/, "")];
    return { label: "OpenClaw", configured: true, podUrl: url, profile };
  } catch {
    return { label: "OpenClaw", configured: false };
  }
}

// Raycast reads ~/.synap/config.json directly. It can have a per-surface pod
// override (surfaces.raycast); falls back to activePod if not set.
function detectRaycast(urlToProfile: Record<string, string>): SurfaceStatus {
  try {
    const configPath = path.join(os.homedir(), ".synap", "config.json");
    if (!fs.existsSync(configPath)) return { label: "Raycast", configured: false };
    const raw = JSON.parse(fs.readFileSync(configPath, "utf-8")) as {
      activePod?: string;
      surfaces?: Record<string, string>;
      pods?: Record<string, { podUrl: string }>;
    };
    const podName = raw.surfaces?.["raycast"] ?? raw.activePod;
    const podUrl = podName && raw.pods?.[podName]?.podUrl;
    if (!podUrl || !podName) return { label: "Raycast", configured: false };
    const profile = urlToProfile[podUrl.replace(/\/$/, "")] ?? podName;
    const hasOverride = Boolean(raw.surfaces?.["raycast"]);
    return {
      label: hasOverride ? "Raycast (own pod)" : "Raycast",
      configured: true,
      podUrl,
      profile,
    };
  } catch {
    return { label: "Raycast", configured: false };
  }
}
