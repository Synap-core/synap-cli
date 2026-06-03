import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const CONFIG_FILE = path.join(os.homedir(), ".synap", "config.json");

export interface AgentProfile {
  podName: string;      // which pod profile to use (maps to pods.<name>)
  apiKey: string;       // dedicated Hub Protocol API key for this agent
  workspaceId?: string; // optional workspace scope
  label?: string;       // human-readable name
  createdAt: string;
  /** Template used to create this agent: twin | assistant | custom */
  template?: "twin" | "assistant" | "custom";
  /** The agent user ID on the pod (from agentUsers.create) */
  agentUserId?: string;
}

interface ConfigWithAgents {
  activePod?: string;
  pods?: Record<string, unknown>;
  surfaces?: Record<string, unknown>;
  agents?: Record<string, AgentProfile>;
}

function readConfig(): ConfigWithAgents {
  try {
    if (fs.existsSync(CONFIG_FILE)) {
      return JSON.parse(fs.readFileSync(CONFIG_FILE, "utf-8")) as ConfigWithAgents;
    }
  } catch { /* ignore */ }
  return {};
}

function writeConfig(cfg: ConfigWithAgents): void {
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2), { mode: 0o600 });
}

export function listAgents(): Array<{ name: string; profile: AgentProfile }> {
  const cfg = readConfig();
  return Object.entries(cfg.agents ?? {}).map(([name, profile]) => ({ name, profile }));
}

export function getAgent(name: string): AgentProfile | null {
  const cfg = readConfig();
  return cfg.agents?.[name] ?? null;
}

export function addAgent(name: string, profile: AgentProfile): void {
  const cfg = readConfig();
  cfg.agents = cfg.agents ?? {};
  cfg.agents[name] = profile;
  writeConfig(cfg);
}

export function removeAgent(name: string): void {
  const cfg = readConfig();
  if (!cfg.agents?.[name]) throw new Error(`Agent '${name}' not found`);
  delete cfg.agents[name];
  writeConfig(cfg);
}

/** Resolve agent config from SYNAP_AGENT env var. Returns null if not set. */
export function resolveAgentOverride(): AgentProfile | null {
  const name = process.env.SYNAP_AGENT;
  if (!name) return null;
  return getAgent(name);
}
