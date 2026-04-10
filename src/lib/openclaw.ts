/**
 * OpenClaw detection and configuration utilities.
 * Reads/writes OpenClaw config without modifying unrelated settings.
 */

import { existsSync, readFileSync, writeFileSync, statSync } from "fs";
import { homedir } from "os";
import { join } from "path";
import { execSync } from "child_process";

export interface OpenClawInfo {
  found: boolean;
  /** How OpenClaw was detected — affects which commands can be used */
  runtime?: "local" | "docker";
  /** Docker container name, set when runtime === "docker" */
  containerName?: string;
  version?: string;
  configPath?: string;
  config?: Record<string, unknown>;
  gatewayRunning?: boolean;
  gatewayPort?: number;
  skillsDir?: string;
}

const OPENCLAW_DIR = join(homedir(), ".openclaw");
const OPENCLAW_CONFIG = join(OPENCLAW_DIR, "openclaw.json");
const OPENCLAW_SKILLS = join(OPENCLAW_DIR, "skills");

export function detectOpenClaw(): OpenClawInfo {
  // ── Path 1: Local install (npm -g or npx) ─────────────────────────────
  if (existsSync(OPENCLAW_DIR)) {
    const info: OpenClawInfo = {
      found: true,
      runtime: "local",
      configPath: OPENCLAW_CONFIG,
      skillsDir: OPENCLAW_SKILLS,
    };

    // Version
    try {
      const out = execSync("openclaw --version 2>/dev/null", {
        encoding: "utf-8",
        timeout: 5000,
      }).trim();
      const match = out.match(/\d+\.\d+\.\d+/);
      if (match) info.version = match[0];
    } catch { /* binary not in PATH */ }

    // Config
    if (existsSync(OPENCLAW_CONFIG)) {
      try {
        info.config = JSON.parse(readFileSync(OPENCLAW_CONFIG, "utf-8"));
      } catch { /* corrupted */ }
    }

    // Gateway
    const port = (info.config as Record<string, unknown> & { gateway?: { port?: number } })?.gateway?.port ?? 18789;
    info.gatewayPort = port;
    try {
      execSync(`curl -sf http://127.0.0.1:${port}/health >/dev/null 2>&1`, { timeout: 3000 });
      info.gatewayRunning = true;
    } catch {
      info.gatewayRunning = false;
    }

    return info;
  }

  // ── Path 2: Docker container ───────────────────────────────────────────
  // OpenClaw may be running in Docker (no host ~/.openclaw dir).
  // Detect by: (a) docker ps, (b) gateway health probe on port 18789.
  const dockerInfo = detectOpenClawDocker();
  if (dockerInfo) return dockerInfo;

  return { found: false };
}

function detectOpenClawDocker(): OpenClawInfo | null {
  // (a) Check for a running container with "openclaw" in the name/image
  let containerName: string | null = null;
  let version: string | undefined;

  try {
    const psOut = execSync(
      "docker ps --format '{{.Names}}\\t{{.Image}}' 2>/dev/null",
      { encoding: "utf-8", timeout: 4000 }
    );
    for (const line of psOut.split("\n")) {
      if (/openclaw/i.test(line)) {
        containerName = line.split("\t")[0]?.trim() ?? null;
        // Extract version from image tag e.g. openclaw:2026.3.31
        const verMatch = line.match(/:(\d{4}\.\d+\.\d+)/);
        if (verMatch) version = verMatch[1];
        break;
      }
    }
  } catch { /* docker not available */ }

  // (b) Gateway probe — works even if container name doesn't match pattern
  let gatewayRunning = false;
  try {
    execSync("curl -sf http://127.0.0.1:18789/health >/dev/null 2>&1", { timeout: 3000 });
    gatewayRunning = true;
  } catch { /* not responding */ }

  // Need at least one signal to claim found
  if (!containerName && !gatewayRunning) return null;

  return {
    found: true,
    runtime: "docker",
    containerName: containerName ?? "openclaw",
    version,
    gatewayRunning,
    gatewayPort: 18789,
    // No local config/skillsDir — they live inside the container volume
    configPath: undefined,
    skillsDir: undefined,
  };
}

export function readOpenClawConfig(): Record<string, unknown> | null {
  if (!existsSync(OPENCLAW_CONFIG)) return null;
  try {
    return JSON.parse(readFileSync(OPENCLAW_CONFIG, "utf-8"));
  } catch {
    return null;
  }
}

export function writeOpenClawConfig(config: Record<string, unknown>): void {
  writeFileSync(OPENCLAW_CONFIG, JSON.stringify(config, null, 2) + "\n");
}

export function getConfigPermissions(): { mode: string; safe: boolean } {
  try {
    const stat = statSync(OPENCLAW_DIR);
    const mode = (stat.mode & 0o777).toString(8);
    return { mode, safe: (stat.mode & 0o077) === 0 }; // safe = no group/world perms
  } catch {
    return { mode: "???", safe: false };
  }
}

/**
 * Get a nested config value safely.
 */
export function getConfigValue(
  config: Record<string, unknown>,
  path: string
): unknown {
  const parts = path.split(".");
  let current: unknown = config;
  for (const part of parts) {
    if (current == null || typeof current !== "object") return undefined;
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

/**
 * Set a nested config value.
 */
export function setConfigValue(
  config: Record<string, unknown>,
  path: string,
  value: unknown
): void {
  const parts = path.split(".");
  let current = config;
  for (let i = 0; i < parts.length - 1; i++) {
    if (!(parts[i] in current) || typeof current[parts[i]] !== "object") {
      current[parts[i]] = {};
    }
    current = current[parts[i]] as Record<string, unknown>;
  }
  current[parts[parts.length - 1]] = value;
}
