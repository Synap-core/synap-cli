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
  const info: OpenClawInfo = { found: false };

  // Check if OpenClaw directory exists
  if (!existsSync(OPENCLAW_DIR)) return info;

  info.found = true;
  info.configPath = OPENCLAW_CONFIG;
  info.skillsDir = OPENCLAW_SKILLS;

  // Try to get version
  try {
    const out = execSync("openclaw --version 2>/dev/null", {
      encoding: "utf-8",
      timeout: 5000,
    }).trim();
    const match = out.match(/\d+\.\d+\.\d+/);
    if (match) info.version = match[0];
  } catch {
    // openclaw binary not in PATH — might still be installed via npx
  }

  // Read config
  if (existsSync(OPENCLAW_CONFIG)) {
    try {
      info.config = JSON.parse(readFileSync(OPENCLAW_CONFIG, "utf-8"));
    } catch {
      // corrupted config
    }
  }

  // Check if gateway is running
  try {
    const port = (info.config as any)?.gateway?.port ?? 18789;
    info.gatewayPort = port;
    execSync(`curl -sf http://127.0.0.1:${port}/health >/dev/null 2>&1`, {
      timeout: 3000,
    });
    info.gatewayRunning = true;
  } catch {
    info.gatewayRunning = false;
  }

  return info;
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
