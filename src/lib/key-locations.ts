/**
 * Every place on this computer that holds a Synap key for one pod.
 *
 * A key is not "configured" in one place. `synap connect claude-code` alone
 * writes three copies (the CLI config, Claude Code's env, Claude Code's MCP
 * registry), a shell rc may export a fourth, and the ambient
 * `SYNAP_HUB_API_KEY` silently beats the CLI profile. When the copies
 * disagree, the one that wins is the one nobody looked at — so the doctor reads
 * all of them, and says which FILE each one lives in.
 *
 * Read-only. Paths are derived from the `home` it is given, so tests run on a
 * temp HOME and never see the person's real files.
 */

import fs from "node:fs";
import path from "node:path";

export type KeyRole = "person" | "agent";

export type KeyLocationKind =
  | "profile"
  | "agent-key-by-pod"
  | "agent-key"
  | "pending"
  | "claude-settings-env"
  | "claude-mcp-header"
  | "shell-rc"
  | "process-env";

export interface KeyLocation {
  kind: KeyLocationKind;
  /** Human, ready to print: file + field. */
  label: string;
  /** The file it lives in (absent for the process environment). */
  file?: string;
  role: KeyRole;
  /** Agent surface the key belongs to (claude-code, codex, …). */
  surface?: string;
  key: string;
  /** Stored agent id, when the location records one. */
  agentUserId?: string;
  /** The doctor may rewrite this copy itself (shell rc files it never edits). */
  rewritable: boolean;
  /** Profile name, MCP server name, or line number — whatever names it inside the file. */
  ref?: string;
}

const norm = (u: string) => u.replace(/\/+$/, "");

function readJson(file: string): Record<string, unknown> | null {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown>;
  } catch {
    return null;
  }
}

/** `~/…` for display. */
export function tildify(file: string, home: string): string {
  return file.startsWith(home + path.sep) ? `~${file.slice(home.length)}` : file;
}

export const SHELL_RC_FILES = [".zshrc", ".zprofile", ".zshenv", ".bashrc", ".bash_profile", ".profile", ".config/fish/config.fish"];

/** `SYNAP_HUB_API_KEY=…` assignments in shell rc files (export / set -x / plain). */
export function shellRcAssignments(home: string): Array<{ file: string; line: number; key: string }> {
  const out: Array<{ file: string; line: number; key: string }> = [];
  for (const rel of SHELL_RC_FILES) {
    const file = path.join(home, rel);
    let text: string;
    try {
      text = fs.readFileSync(file, "utf8");
    } catch {
      continue;
    }
    text.split("\n").forEach((raw, i) => {
      const line = raw.trim();
      if (line.startsWith("#")) return;
      const m =
        line.match(/^(?:export\s+)?SYNAP_HUB_API_KEY=["']?([^"'\s]+)["']?/) ??
        line.match(/^set\s+-[gx]+\s+SYNAP_HUB_API_KEY\s+["']?([^"'\s]+)["']?/);
      if (m?.[1] && !m[1].startsWith("$")) out.push({ file, line: i + 1, key: m[1] });
    });
  }
  return out;
}

export interface CollectInput {
  home: string;
  podUrl: string;
  /** `process.env.SYNAP_HUB_API_KEY` as this process sees it. */
  envKey?: string;
  envPodUrl?: string;
}

export function collectKeyLocations(input: CollectInput): KeyLocation[] {
  const { home } = input;
  const pod = norm(input.podUrl);
  const out: KeyLocation[] = [];
  const configFile = path.join(home, ".synap", "config.json");
  const cfg = readJson(configFile) ?? {};
  const cfgLabel = tildify(configFile, home);

  // 1. Pod profiles (the person's / this computer's own key) for this pod.
  const pods = (cfg.pods ?? {}) as Record<string, { podUrl?: string; hubApiKey?: string }>;
  for (const [name, p] of Object.entries(pods)) {
    if (p?.podUrl && norm(p.podUrl) === pod && p.hubApiKey)
      out.push({ kind: "profile", label: `${cfgLabel} → pods.${name}`, file: configFile, role: "person", key: p.hubApiKey, rewritable: false, ref: name });
  }

  // 2. Agent keys per surface: by pod (truth), legacy last-write, pending requests.
  type Stored = { hubApiKey?: string; agentUserId?: string; podUrl?: string };
  const byPod = (cfg.agentKeysByPod ?? {}) as Record<string, Record<string, Stored>>;
  for (const [surface, map] of Object.entries(byPod)) {
    const hit = map?.[pod] ?? Object.entries(map ?? {}).find(([u]) => norm(u) === pod)?.[1];
    if (hit?.hubApiKey)
      out.push({ kind: "agent-key-by-pod", label: `${cfgLabel} → agentKeysByPod.${surface}`, file: configFile, role: "agent", surface, key: hit.hubApiKey, agentUserId: hit.agentUserId, rewritable: true });
  }
  const legacy = (cfg.agentKeys ?? {}) as Record<string, Stored>;
  for (const [surface, k] of Object.entries(legacy)) {
    if (!k?.hubApiKey) continue;
    if (k.podUrl && norm(k.podUrl) !== pod) continue;
    out.push({ kind: "agent-key", label: `${cfgLabel} → agentKeys.${surface}`, file: configFile, role: "agent", surface, key: k.hubApiKey, agentUserId: k.agentUserId, rewritable: true });
  }
  const pending = (cfg.pendingAgentKeys ?? {}) as Record<string, Record<string, Stored>>;
  for (const [surface, map] of Object.entries(pending)) {
    const hit = map?.[pod];
    if (hit?.hubApiKey)
      out.push({ kind: "pending", label: `${cfgLabel} → pendingAgentKeys.${surface}`, file: configFile, role: "agent", surface, key: hit.hubApiKey, agentUserId: hit.agentUserId, rewritable: true });
  }

  // 3. Claude Code: its env block (the ambient SYNAP_HUB_API_KEY inside every
  //    Claude session) and its MCP registry headers.
  const settingsFile = path.join(home, ".claude", "settings.json");
  const settings = readJson(settingsFile);
  const env = (settings?.env ?? {}) as Record<string, string>;
  if (env.SYNAP_HUB_API_KEY && (!env.SYNAP_POD_URL || norm(env.SYNAP_POD_URL) === pod))
    out.push({ kind: "claude-settings-env", label: `${tildify(settingsFile, home)} → env.SYNAP_HUB_API_KEY`, file: settingsFile, role: "agent", surface: "claude-code", key: env.SYNAP_HUB_API_KEY, rewritable: true });

  const claudeJsonFile = path.join(home, ".claude.json");
  const claudeJson = readJson(claudeJsonFile);
  const servers = (claudeJson?.mcpServers ?? {}) as Record<string, { url?: string; headers?: Record<string, string> }>;
  for (const [name, s] of Object.entries(servers)) {
    if (!s?.url || !norm(s.url).startsWith(`${pod}/mcp`)) continue;
    const auth = s.headers?.Authorization ?? s.headers?.authorization;
    const m = auth?.match(/^Bearer\s+(.+)$/i);
    if (m?.[1])
      out.push({ kind: "claude-mcp-header", label: `${tildify(claudeJsonFile, home)} → mcpServers.${name}`, file: claudeJsonFile, role: "agent", surface: "claude-code", key: m[1].trim(), rewritable: true, ref: name });
  }

  // 4. Shell rc exports, and the process environment itself.
  for (const a of shellRcAssignments(home))
    out.push({ kind: "shell-rc", label: `${tildify(a.file, home)}:${a.line}`, file: a.file, role: "agent", key: a.key, rewritable: false, ref: String(a.line) });
  if (input.envKey && (!input.envPodUrl || norm(input.envPodUrl) === pod))
    out.push({ kind: "process-env", label: "SYNAP_HUB_API_KEY (this shell)", role: "agent", key: input.envKey, rewritable: false });

  return out;
}

/**
 * Which file(s) put the process env key there — the settings env Claude Code
 * injects, or a shell rc. Empty = set by something the doctor cannot see.
 */
export function envKeySetBy(locations: KeyLocation[], envKey: string): KeyLocation[] {
  return locations.filter((l) => (l.kind === "claude-settings-env" || l.kind === "shell-rc") && l.key === envKey);
}
