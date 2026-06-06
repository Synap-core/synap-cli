/**
 * Connect targets — where `synap connect --target=X` can drop credentials,
 * skills, and MCP configs for each supported AI surface.
 *
 * Each target knows:
 *   - how to describe itself to the user
 *   - where its skills directory lives (if it reads Agent Skills)
 *   - where its MCP config lives (if it supports MCP)
 *   - how to render a one-shot install for the given pod + API key
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import chalk from "chalk";
import ora from "ora";
import prompts from "prompts";
import { log } from "../utils/logger.js";
import { installSkills, SKILL_NAMES } from "./skills-installer.js";

export type TargetName =
  | "claude-code"
  | "claude-desktop"
  | "cursor"
  | "raycast"
  | "openclaw"
  | "openwebui"
  | "codex"
  | "generic";

export interface TargetConnectionConfig {
  podUrl: string;
  apiKey: string;
  workspaceId?: string;
  agentUserId?: string;
  skills?: string[]; // defaults to all three
}

export interface TargetInfo {
  name: TargetName;
  label: string;
  description?: string;
  supports: { skills: boolean; mcp: boolean };
  skillsDir?: () => string;
  mcpConfigPath?: () => string;
}

const CLAUDE_DESKTOP_MACOS = path.join(
  os.homedir(),
  "Library",
  "Application Support",
  "Claude"
);

const CLAUDE_DESKTOP_WINDOWS = path.join(
  process.env.APPDATA ?? path.join(os.homedir(), "AppData", "Roaming"),
  "Claude"
);

const CLAUDE_DESKTOP_LINUX = path.join(os.homedir(), ".config", "Claude");

function claudeDesktopBaseDir(): string {
  switch (process.platform) {
    case "darwin":
      return CLAUDE_DESKTOP_MACOS;
    case "win32":
      return CLAUDE_DESKTOP_WINDOWS;
    default:
      return CLAUDE_DESKTOP_LINUX;
  }
}

export const TARGETS: Record<TargetName, TargetInfo> = {
  "claude-code": {
    name: "claude-code",
    label: "Claude Code",
    supports: { skills: true, mcp: true },
    skillsDir: () => path.join(os.homedir(), ".claude", "skills"),
    mcpConfigPath: () => path.join(os.homedir(), ".claude", "settings.json"),
  },
  "claude-desktop": {
    name: "claude-desktop",
    label: "Claude Desktop",
    // Claude Desktop reads Agent Skills from its app-support skills/ dir
    // (alongside claude_desktop_config.json). The "upload via claude.ai" path
    // is still valid for cross-device sync, but local drop-in works and is
    // what `synap connect` automates here. Path layout matches Claude Code's
    // `~/.claude/skills/<skill>/SKILL.md` — same `installSkills` helper.
    supports: { skills: true, mcp: true },
    mcpConfigPath: () =>
      path.join(claudeDesktopBaseDir(), "claude_desktop_config.json"),
    skillsDir: () => path.join(claudeDesktopBaseDir(), "skills"),
  },
  cursor: {
    name: "cursor",
    label: "Cursor",
    supports: { skills: false, mcp: true },
    mcpConfigPath: () => path.join(os.homedir(), ".cursor", "mcp.json"),
  },
  raycast: {
    name: "raycast",
    label: "Raycast",
    description: "Native extension with 9 AI tools + commands (credentials auto-read from CLI config)",
    supports: { skills: false, mcp: false },
  },
  openclaw: {
    name: "openclaw",
    label: "OpenClaw",
    supports: { skills: true, mcp: false },
  },
  openwebui: {
    name: "openwebui",
    label: "Open WebUI",
    description: "Register Synap as a model source and tool server in Open WebUI",
    supports: { skills: false, mcp: true },
  },
  codex: {
    name: "codex",
    label: "OpenAI Codex",
    description: "OpenAI Codex CLI — MCP server + instructions",
    supports: { skills: true, mcp: true },
    mcpConfigPath: () => path.join(os.homedir(), ".codex", "config.yaml"),
    skillsDir: () => path.join(os.homedir(), ".codex"),
  },
  generic: {
    name: "generic",
    label: "Generic MCP Client",
    description: "Output MCP connection config for any MCP-compatible client",
    supports: { skills: false, mcp: true },
  },
};

export function isTargetName(value: string): value is TargetName {
  return value in TARGETS;
}

export function listTargets(): void {
  log.heading("Supported targets");
  for (const t of Object.values(TARGETS)) {
    const caps: string[] = [];
    if (t.supports.skills) caps.push("skills");
    if (t.supports.mcp) caps.push("mcp");
    log.info(`${chalk.bold(t.name.padEnd(16))} ${t.label}  ${chalk.dim(`(${caps.join(", ") || "—"})`)}`);
  }
}

/**
 * Run the install flow for a target. Returns true on success.
 * Throws only on unexpected errors — recoverable failures are logged + return false.
 */
export async function installForTarget(
  target: TargetName,
  cfg: TargetConnectionConfig
): Promise<boolean> {
  const info = TARGETS[target];
  if (!info) {
    log.error(`Unknown target: ${target}`);
    return false;
  }

  log.heading(`Installing for ${info.label}`);

  switch (target) {
    case "claude-code":
      return installClaudeCode(info, cfg);
    case "claude-desktop":
      return installClaudeDesktop(info, cfg);
    case "cursor":
      return installCursor(info, cfg);
    case "raycast":
      return installRaycast(cfg);
    case "openclaw":
      return installOpenclaw(cfg);
    case "openwebui":
      return installOpenWebUI(cfg);
    case "codex":
      return installCodex(info, cfg);
    case "generic":
      return installGeneric(cfg);
  }
}

// ─── Claude Code ─────────────────────────────────────────────────────────────

async function installClaudeCode(
  info: TargetInfo,
  cfg: TargetConnectionConfig
): Promise<boolean> {
  // ── What to install? ────────────────────────────────────────────────────
  // Skills = CLAUDE.md context files (instructions, schema, UI patterns)
  // MCP    = live tool server (read/write entities, search, memory, etc.)
  // Both is the recommended default — skills give the model Synap knowledge,
  // MCP gives it the actual tools to act on data.
  const { mode } = await prompts({
    type: "select",
    name: "mode",
    message: "What do you want to install?",
    choices: [
      {
        title: "Both — Skills + MCP tools  (recommended)",
        description: "Skills give Claude context about Synap; MCP tools let it read & write data",
        value: "both",
      },
      {
        title: "MCP tools only",
        description: "Live tool server — search, create, update entities, memory, channels",
        value: "mcp",
      },
      {
        title: "Skills only",
        description: "Context files (CLAUDE.md) — no live data access",
        value: "skills",
      },
    ],
    initial: 0,
  });
  if (!mode) return false;

  // ── Skills ──────────────────────────────────────────────────────────────
  if (mode === "both" || mode === "skills") {
    const dir = info.skillsDir?.();
    if (dir) {
      const installed = await installSkills({
        destDir: dir,
        skills: cfg.skills ?? SKILL_NAMES,
      });
      if (installed) {
        log.success(`Skills installed to ~/.claude/skills/`);
      }
    }
  }

  // ── MCP ─────────────────────────────────────────────────────────────────
  if (mode === "both" || mode === "mcp") {
    await writeClaudeCodeEnv(cfg);
    log.success("MCP server 'synap' added to ~/.claude/settings.json");
    if (cfg.workspaceId) {
      log.dim(`Scoped to workspace: ${cfg.workspaceId}`);
    } else {
      log.dim("Not scoped — all workspaces accessible.");
    }
  } else {
    // Skills-only: still write env vars (pod URL useful for skills referencing
    // SYNAP_POD_URL) but don't add the mcpServers entry
    await writeClaudeCodeEnv({ ...cfg, workspaceId: cfg.workspaceId }, { writeMcp: false });
  }

  log.blank();
  log.success("Claude Code config updated.");
  log.dim("Restart Claude Code (or open a new window) to pick up the MCP server and env vars.");
  return true;
}

/**
 * Fetch the pod's accessible workspaces and prompt the user to pick one for
 * MCP URL scoping. Falls back silently to the workspaceId already in cfg
 * if the fetch fails or the user skips.
 */
export async function resolveWorkspaceId(cfg: TargetConnectionConfig): Promise<string | undefined> {
  let workspaceList: Array<{ id: string; name: string }> = [];
  const wsSpinner = ora("Fetching workspaces...").start();
  try {
    const res = await fetch(`${cfg.podUrl.replace(/\/$/, "")}/api/hub/workspaces`, {
      headers: { Authorization: `Bearer ${cfg.apiKey}` },
    });
    if (res.ok) {
      const body = await res.json() as { workspaces?: Array<{ id: string; name: string }> };
      workspaceList = body.workspaces ?? [];
      wsSpinner.succeed(`Found ${workspaceList.length} workspace(s).`);
    } else {
      wsSpinner.warn(`Could not fetch workspaces (HTTP ${res.status}) — proceeding without scoping.`);
    }
  } catch (err) {
    wsSpinner.warn(`Could not reach pod to fetch workspaces: ${(err as Error).message}`);
  }

  // Single workspace or no workspaces — no need to prompt
  if (workspaceList.length <= 1) {
    return workspaceList[0]?.id ?? cfg.workspaceId;
  }

  log.blank();
  log.info(`Found ${workspaceList.length} workspaces on this pod.`);
  log.dim("Pinning a workspace scopes the MCP so Claude Code sees only that workspace.");

  const defaultIdx = cfg.workspaceId
    ? workspaceList.findIndex((w) => w.id === cfg.workspaceId)
    : -1;

  const { selected } = await prompts({
    type: "select",
    name: "selected",
    message: "Scope MCP to one workspace?",
    choices: [
      { title: chalk.dim("All workspaces (no scoping)"), value: "" },
      ...workspaceList.map((w) => ({
        title: `${chalk.bold(w.name)}  ${chalk.dim(w.id)}`,
        value: w.id,
      })),
    ],
    initial: defaultIdx >= 0 ? defaultIdx + 1 : 0, // +1 because "All" is first
  });

  return (selected as string | undefined) || undefined;
}

/**
 * Write (or update) Synap env vars AND optionally the MCP server entry in ~/.claude/settings.json.
 * Called both by installClaudeCode and by `synap pods use` to propagate switches.
 *
 * Claude Code reads mcpServers natively from settings.json using the HTTP transport
 * format: { url, headers }. The URL optionally carries ?workspaceId= so all tool
 * calls are pre-scoped to one workspace without the model having to pass it.
 *
 * @param writeMcp — set false to skip the mcpServers entry (skills-only installs)
 */
export async function writeClaudeCodeEnv(
  cfg: Pick<TargetConnectionConfig, "podUrl" | "apiKey" | "workspaceId" | "agentUserId">,
  { writeMcp = true }: { writeMcp?: boolean } = {}
): Promise<void> {
  const settingsPath = path.join(os.homedir(), ".claude", "settings.json");
  const settingsDir = path.dirname(settingsPath);

  let settings: Record<string, unknown> = {};
  if (fs.existsSync(settingsPath)) {
    try {
      settings = JSON.parse(fs.readFileSync(settingsPath, "utf-8")) as Record<string, unknown>;
    } catch { /* start fresh */ }
  }

  // ── Resolve human user ID and provision an agent-owned API key ──────────
  // SYNAP_USER_ID = human user (for entity attribution)
  // SYNAP_HUB_API_KEY = agent-owned key (identity encoded in the key itself)
  const podBase = cfg.podUrl.replace(/\/$/, "");
  let effectiveApiKey = cfg.apiKey;

  // Resolve human user ID, then provision an agent-owned key.
  // Both steps are required — fail loudly if either is unreachable.
  const meRes = await fetch(`${podBase}/api/hub/users/me`, {
    headers: { Authorization: `Bearer ${cfg.apiKey}` },
    signal: AbortSignal.timeout(5000),
  });
  if (!meRes.ok) {
    throw new Error(`Could not reach pod at ${cfg.podUrl} (HTTP ${meRes.status}). Check your pod URL and API key.`);
  }
  const me = await meRes.json() as { id?: string; scopes?: string[] };
  if (!me.id) throw new Error("/api/hub/users/me returned no user ID — is the pod running?");

  const agentSetupRes = await fetch(`${podBase}/api/hub/setup/agent`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${cfg.apiKey}` },
    body: JSON.stringify({ agentType: "claude-code", idempotent: false }),
    signal: AbortSignal.timeout(10000),
  });
  if (!agentSetupRes.ok) {
    const text = await agentSetupRes.text().catch(() => agentSetupRes.statusText);
    throw new Error(`Failed to provision agent key for claude-code (HTTP ${agentSetupRes.status}): ${text}\nEnsure your API key has hub-protocol.write scope.`);
  }
  const agentSetup = await agentSetupRes.json() as { hubApiKey?: string; agentUserId?: string };
  if (!agentSetup.hubApiKey) throw new Error("setup/agent succeeded but returned no hubApiKey — check pod logs.");
  effectiveApiKey = agentSetup.hubApiKey;

  // Enroll the new agent user into the caller's workspaces using the HUMAN key
  // (before switching to the agent key). Scoped to one workspace when chosen.
  await enrollAgentIfNeeded(cfg.podUrl, cfg.apiKey, agentSetup.agentUserId ?? "", cfg.workspaceId);

  const env = (settings.env ?? {}) as Record<string, string>;
  env["SYNAP_POD_URL"] = cfg.podUrl;
  env["SYNAP_HUB_API_KEY"] = effectiveApiKey;
  env["SYNAP_USER_ID"] = me.id;
  delete env["SYNAP_AGENT_USER_ID"];
  if (cfg.workspaceId) env["SYNAP_WORKSPACE_ID"] = cfg.workspaceId;
  else delete env["SYNAP_WORKSPACE_ID"];
  if (me.scopes?.length) env["SYNAP_KEY_SCOPES"] = me.scopes.join(",");
  settings.env = env;

  // ── MCP server entry (HTTP transport, native Claude Code format) ─────────
  if (writeMcp) {
    // Append ?workspaceId= when one is set so every tool call is pre-scoped.
    const mcpUrl = cfg.workspaceId
      ? `${podBase}/mcp?workspaceId=${encodeURIComponent(cfg.workspaceId)}`
      : `${podBase}/mcp`;

    const mcpServers = (settings.mcpServers ?? {}) as Record<string, unknown>;
    mcpServers["synap"] = {
      url: mcpUrl,
      headers: { Authorization: `Bearer ${effectiveApiKey}` },
    };
    settings.mcpServers = mcpServers;
  }

  if (!fs.existsSync(settingsDir)) {
    fs.mkdirSync(settingsDir, { recursive: true });
  }
  fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + "\n", { mode: 0o600 });
}

// ─── Agent key provisioning helper ──────────────────────────────────────────

/**
 * Provision an agent-owned API key for the given surface via POST /api/hub/setup/agent.
 * Returns both the key and the new agent's userId so callers can enroll it in workspaces.
 * Throws on failure — callers must not silently fall back to a human key.
 */
async function provisionAgentKey(
  podUrl: string,
  humanApiKey: string,
  agentType: string
): Promise<{ hubApiKey: string; agentUserId: string }> {
  const podBase = podUrl.replace(/\/$/, "");
  let res: Response;
  try {
    res = await fetch(`${podBase}/api/hub/setup/agent`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${humanApiKey}`,
      },
      body: JSON.stringify({ agentType, idempotent: false }),
      signal: AbortSignal.timeout(10000),
    });
  } catch (err) {
    throw new Error(
      `Could not reach pod to provision agent key for ${agentType}: ${(err as Error).message}\n` +
      `Ensure the pod is reachable and try again.`
    );
  }
  if (!res.ok) {
    const text = await res.text().catch(() => res.statusText);
    throw new Error(
      `Failed to provision agent key for ${agentType} (HTTP ${res.status}): ${text}\n` +
      `Ensure your API key has hub-protocol.write scope.`
    );
  }
  const body = await res.json() as { hubApiKey?: string; agentUserId?: string };
  if (!body.hubApiKey) {
    throw new Error(
      `setup/agent succeeded but returned no hubApiKey for ${agentType}. ` +
      `This is a server-side bug — check the pod logs.`
    );
  }
  return { hubApiKey: body.hubApiKey, agentUserId: body.agentUserId ?? "" };
}

/**
 * Enroll an agent user into the caller's workspaces via POST /api/hub/workspaces/enroll-agent.
 * Non-fatal — logs on failure so connect flow is never blocked by enrollment errors.
 *
 * @param callerKey  The key of the user whose workspaces to enroll into (pod profile key).
 * @param agentUserId  The agent user to enroll.
 * @param workspaceId  When set, enroll in that one workspace only; omit for all.
 */
async function enrollAgentIfNeeded(
  podUrl: string,
  callerKey: string,
  agentUserId: string,
  workspaceId?: string
): Promise<void> {
  if (!agentUserId) return;
  const podBase = podUrl.replace(/\/$/, "");
  try {
    const res = await fetch(`${podBase}/api/hub/workspaces/enroll-agent`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${callerKey}` },
      body: JSON.stringify({
        agentUserId,
        ...(workspaceId ? { workspaceId } : {}),
        role: "editor",
      }),
      signal: AbortSignal.timeout(10000),
    });
    if (res.ok) {
      const data = await res.json() as { enrolled?: string[] };
      if (data.enrolled?.length) {
        log.dim(`  Agent enrolled in ${data.enrolled.length} workspace(s).`);
      }
    } else {
      const text = await res.text().catch(() => res.statusText);
      log.warn(`  Workspace enrollment failed (HTTP ${res.status}): ${text}`);
      log.dim("  Access can be added manually via pod settings.");
    }
  } catch (err) {
    log.warn(`  Workspace enrollment unreachable: ${(err as Error).message}`);
    log.dim("  Access can be added manually via pod settings.");
  }
}

// ─── Claude Desktop ──────────────────────────────────────────────────────────

async function installClaudeDesktop(
  info: TargetInfo,
  cfg: TargetConnectionConfig
): Promise<boolean> {
  const mcpPath = info.mcpConfigPath?.();
  if (!mcpPath) return false;

  // Claude Desktop's claude_desktop_config.json is STDIO-ONLY — the HTTP
  // `{ url, headers }` format is silently ignored. We write a stdio bridge
  // via the community-maintained `mcp-remote` npm package, which translates
  // stdio MCP messages into HTTPS calls against the pod's /mcp endpoint.
  //
  // Reference: https://www.npmjs.com/package/mcp-remote
  const { hubApiKey: effectiveApiKey, agentUserId } = await provisionAgentKey(cfg.podUrl, cfg.apiKey, "claude-desktop");
  await enrollAgentIfNeeded(cfg.podUrl, cfg.apiKey, agentUserId, cfg.workspaceId);
  const desktopMcpUrl = cfg.workspaceId
    ? `${cfg.podUrl.replace(/\/$/, "")}/mcp?workspaceId=${encodeURIComponent(cfg.workspaceId)}`
    : `${cfg.podUrl.replace(/\/$/, "")}/mcp`;
  writeMcpServerEntry(mcpPath, "synap", {
    command: "npx",
    args: ["-y", "mcp-remote", desktopMcpUrl, "--header", `Authorization: Bearer ${effectiveApiKey}`],
  });

  log.blank();
  log.success(
    `MCP server 'synap' added to ${path.relative(os.homedir(), mcpPath)}`,
  );
  log.dim(
    "The entry uses 'npx mcp-remote' as a stdio bridge — Claude Desktop spawns it.",
  );

  // Drop the three synap skill packages directly into Claude Desktop's
  // app-support skills/ dir. Same on-disk layout as Claude Code
  // (skills/<name>/SKILL.md), discovered on app launch.
  const skillsDir = info.skillsDir?.();
  if (skillsDir) {
    const installed = await installSkills({
      destDir: skillsDir,
      skills: cfg.skills ?? SKILL_NAMES,
    });
    if (installed) {
      log.success(
        `Synap skills installed to ${path.relative(os.homedir(), skillsDir)}/ (${(cfg.skills ?? SKILL_NAMES).join(", ")})`,
      );
    } else {
      log.warn(
        "Skill install reported no files written — verify ~/Library/Application Support/Claude/skills/ exists after relaunch.",
      );
    }
  }

  log.blank();
  log.info("Next steps:");
  log.dim("  1. Fully quit Claude Desktop (Cmd+Q), then relaunch.");
  log.dim("  2. Look for the MCP tools icon under the input box — 'synap' should appear.");
  log.dim("  3. Skills auto-load on launch from the app-support skills/ dir.");
  log.dim("  4. If tools don't load, check ~/Library/Logs/Claude/mcp*.log");
  log.blank();
  log.dim(
    "Tip: to sync skills across devices via your Claude account, also upload them at https://claude.ai → Settings → Skills.",
  );

  return true;
}

// ─── Cursor ──────────────────────────────────────────────────────────────────

async function installCursor(
  info: TargetInfo,
  cfg: TargetConnectionConfig
): Promise<boolean> {
  const mcpPath = info.mcpConfigPath?.();
  if (!mcpPath) return false;

  const { hubApiKey: effectiveApiKey, agentUserId } = await provisionAgentKey(cfg.podUrl, cfg.apiKey, "cursor");
  await enrollAgentIfNeeded(cfg.podUrl, cfg.apiKey, agentUserId, cfg.workspaceId);
  const cursorMcpUrl = cfg.workspaceId
    ? `${cfg.podUrl.replace(/\/$/, "")}/mcp?workspaceId=${encodeURIComponent(cfg.workspaceId)}`
    : `${cfg.podUrl.replace(/\/$/, "")}/mcp`;
  writeMcpServerEntry(mcpPath, "synap", {
    url: cursorMcpUrl,
    headers: { Authorization: `Bearer ${effectiveApiKey}` },
  });

  log.blank();
  log.success(`MCP server 'synap' added to ${path.relative(os.homedir(), mcpPath)}`);
  if (cfg.workspaceId) log.dim(`Scoped to workspace: ${cfg.workspaceId}`);
  log.dim("Restart Cursor. The synap tool set will appear in agent mode.");
  log.blank();
  log.info("Cursor reads Claude-format skills from ~/.claude/skills/ too.");
  log.dim("Run `synap connect --target=claude-code` additionally to install skills.");
  return true;
}

// ─── Raycast ─────────────────────────────────────────────────────────────────

async function installRaycast(cfg: TargetConnectionConfig): Promise<boolean> {
  // Raycast reads credentials from ~/.synap/config.json (Tier 0 — highest priority).
  // Persist the workspace choice so Raycast immediately sees the right scope.
  const { setActiveWorkspaceId, clearActiveWorkspaceId, setSurfaceAgentKey } = await import("./pod.js");
  if (cfg.workspaceId) {
    setActiveWorkspaceId(cfg.workspaceId);
  } else {
    clearActiveWorkspaceId();
  }

  // Provision a dedicated named agent key for Raycast so its AI tools run as
  // "raycast" agent identity (separate from the human user key used by UI commands).
  const provisionSpinner = ora("Provisioning Raycast agent identity...").start();
  try {
    const agentKey = await provisionAgentKey(cfg.podUrl, cfg.apiKey, "raycast");
    setSurfaceAgentKey("raycast", agentKey);
    provisionSpinner.text = "Enrolling agent in workspaces...";
    await enrollAgentIfNeeded(cfg.podUrl, cfg.apiKey, agentKey.agentUserId, cfg.workspaceId);
    provisionSpinner.succeed("Raycast agent identity provisioned.");
  } catch (err) {
    // Non-fatal: Raycast still works with the human key, agent provisioning is best-effort.
    provisionSpinner.warn(`Could not provision dedicated Raycast agent key: ${(err as Error).message}`);
  }

  log.success("Credentials and workspace written to ~/.synap/config.json — Raycast picks them up automatically.");
  log.blank();
  log.info("1. Install the Synap extension from the Raycast Store:");
  log.dim("   Open Raycast → search 'Raycast Store' → search 'Synap' → Install");
  log.blank();
  log.info("2. Commands available immediately after install:");
  log.dim("   Search Synap          — search your knowledge graph");
  log.dim("   Quick Capture         — capture selected text or clipboard as an entity");
  log.dim("   Capture Browser Tab   — save current browser tab");
  log.dim("   Create Task           — create a task directly");
  log.dim("   Synap Status          — menu bar: pending tasks + proposals");
  log.blank();
  log.info("3. Raycast AI has 9 native Synap tools (no MCP, no extra setup):");
  log.dim("   search-entities · get-tasks · create-entity · update-entity · get-entity");
  log.dim("   store-memory · recall-memory · send-to-channel · get-recent");
  log.blank();
  log.info("4. Behavioral guidance is built into the extension.");
  log.dim("   Raycast AI knows how to use Synap — search before answering,");
  log.dim("   save proactively, link entities, persist facts to memory.");
  log.dim("   No system prompt to paste.");
  log.blank();
  log.dim(`   Pod: ${cfg.podUrl}`);
  if (cfg.workspaceId) {
    log.dim(`   Workspace: ${cfg.workspaceId}`);
  } else {
    log.dim("   Workspace: all workspaces");
  }
  log.dim("   To switch later: synap use <workspace-id>  or  synap pods use <profile>");
  return true;
}

// ─── OpenClaw (wraps existing flow with saved pod config) ───────────────────

async function installOpenclaw(cfg: TargetConnectionConfig): Promise<boolean> {
  const { detectOpenClaw, readOpenClawConfig, writeOpenClawConfig, setConfigValue } =
    await import("./openclaw.js");

  const oc = detectOpenClaw();
  if (!oc.found) {
    log.warn("OpenClaw not detected on this machine.");
    log.dim("  Install it first: https://openclaw.dev");
    log.dim("  Or run `synap init` to set up from scratch.");
    return false;
  }

  const ocConfig = readOpenClawConfig() ?? {};
  setConfigValue(ocConfig, "synap.podUrl", cfg.podUrl);
  setConfigValue(ocConfig, "synap.hubApiKey", cfg.apiKey);
  if (cfg.workspaceId) setConfigValue(ocConfig, "synap.workspaceId", cfg.workspaceId);
  if (cfg.agentUserId) setConfigValue(ocConfig, "synap.agentUserId", cfg.agentUserId);
  writeOpenClawConfig(ocConfig);

  if (cfg.agentUserId) {
    await enrollAgentIfNeeded(cfg.podUrl, cfg.apiKey, cfg.agentUserId, cfg.workspaceId);
  }

  log.success("Wrote OpenClaw config");
  log.blank();
  log.info("Install the skills:");
  for (const name of cfg.skills ?? SKILL_NAMES) {
    log.dim(`  openclaw skills install ${name}`);
  }
  return true;
}

// ─── Open WebUI ──────────────────────────────────────────────────────────────

async function installOpenWebUI(cfg: TargetConnectionConfig): Promise<boolean> {
  const podBase = cfg.podUrl.replace(/\/$/, "");
  const mcpUrl = cfg.workspaceId
    ? `${podBase}/mcp?workspaceId=${encodeURIComponent(cfg.workspaceId)}`
    : `${podBase}/mcp`;
  const podHost = new URL(cfg.podUrl).host;

  log.info("Open WebUI connects to Synap in two ways:");
  log.blank();
  log.info("1. Model source (configured by Eve at install time):");
  log.dim(`   Base URL: http://${podHost}/v1`);
  log.blank();
  log.info("2. MCP tool server:");
  log.dim("   Admin → Tools → Add Tool Server");
  log.dim(`   URL:     ${mcpUrl}`);
  log.dim(`   Header:  Authorization: Bearer ${cfg.apiKey}`);
  log.blank();

  const synapDir = path.join(os.homedir(), ".synap");
  if (!fs.existsSync(synapDir)) {
    fs.mkdirSync(synapDir, { recursive: true });
  }

  const refFile = path.join(synapDir, "openwebui-mcp.json");
  const refData = {
    modelSource: { baseUrl: `http://${podHost}/v1` },
    mcpToolServer: {
      url: mcpUrl,
      headers: { Authorization: `Bearer ${cfg.apiKey}` },
    },
  };
  fs.writeFileSync(refFile, JSON.stringify(refData, null, 2) + "\n", { mode: 0o600 });

  log.success(`Connection details saved to ~/.synap/openwebui-mcp.json`);
  return true;
}

// ─── Generic MCP client ───────────────────────────────────────────────────────

async function installGeneric(cfg: TargetConnectionConfig): Promise<boolean> {
  const podBase = cfg.podUrl.replace(/\/$/, "");
  const mcpUrl = cfg.workspaceId
    ? `${podBase}/mcp?workspaceId=${encodeURIComponent(cfg.workspaceId)}`
    : `${podBase}/mcp`;

  const httpConfig = {
    synap: {
      url: mcpUrl,
      transport: "http",
      headers: { Authorization: `Bearer ${cfg.apiKey}` },
    },
  };

  log.info("Universal MCP connection config:");
  log.blank();
  log.info("HTTP direct:");
  log.dim(JSON.stringify(httpConfig, null, 2));
  log.blank();
  log.info("stdio bridge (mcp-remote):");
  log.dim(`  command: npx -y mcp-remote ${mcpUrl} --header "Authorization: Bearer ${cfg.apiKey}"`);
  log.blank();
  log.info("Environment variable form:");
  log.dim(`  MCP_SERVER_URL=${mcpUrl}`);
  log.dim(`  MCP_API_KEY=${cfg.apiKey}`);
  log.blank();

  const synapDir = path.join(os.homedir(), ".synap");
  if (!fs.existsSync(synapDir)) {
    fs.mkdirSync(synapDir, { recursive: true });
  }

  const configFile = path.join(synapDir, "mcp-config.json");
  fs.writeFileSync(configFile, JSON.stringify(httpConfig, null, 2) + "\n", { mode: 0o600 });

  log.success(`MCP config written to ~/.synap/mcp-config.json`);
  return true;
}

// ─── Codex ───────────────────────────────────────────────────────────────────

async function installCodex(
  info: TargetInfo,
  cfg: TargetConnectionConfig
): Promise<boolean> {
  const configPath = info.mcpConfigPath?.() ?? path.join(os.homedir(), ".codex", "config.yaml");
  const configDir = path.dirname(configPath);

  if (!fs.existsSync(configDir)) {
    fs.mkdirSync(configDir, { recursive: true, mode: 0o700 });
  }

  // Read existing config or start fresh
  let existing = "";
  if (fs.existsSync(configPath)) {
    try { existing = fs.readFileSync(configPath, "utf-8"); } catch { /* ignore */ }
  }

  // Build MCP server entry
  const { hubApiKey: effectiveApiKey, agentUserId } = await provisionAgentKey(cfg.podUrl, cfg.apiKey, "codex");
  await enrollAgentIfNeeded(cfg.podUrl, cfg.apiKey, agentUserId, cfg.workspaceId);
  const podBase = cfg.podUrl.replace(/\/$/, "");
  const mcpUrl = cfg.workspaceId
    ? `${podBase}/mcp?workspaceId=${encodeURIComponent(cfg.workspaceId)}`
    : `${podBase}/mcp`;

  // Inject/replace the synap mcpServers block using simple string manipulation
  // (avoid requiring a YAML parser dependency)
  const mcpBlock = [
    "mcpServers:",
    `  - name: synap`,
    `    url: "${mcpUrl}"`,
    `    headers:`,
    `      Authorization: "Bearer ${effectiveApiKey}"`,
  ].join("\n");

  let updated: string;
  if (/^mcpServers:/m.test(existing)) {
    // Replace existing mcpServers block (everything from mcpServers: to the next top-level key or EOF)
    updated = existing.replace(/^mcpServers:[\s\S]*?(?=\n[a-zA-Z]|\s*$)/m, mcpBlock);
  } else {
    updated = existing ? `${existing.trimEnd()}\n\n${mcpBlock}\n` : `${mcpBlock}\n`;
  }

  fs.writeFileSync(configPath, updated, { mode: 0o600 });

  // Skills → append synap context to ~/.codex/instructions.md
  const instructionsPath = path.join(configDir, "instructions.md");
  const marker = "<!-- synap-skill -->";
  let instructions = "";
  if (fs.existsSync(instructionsPath)) {
    try { instructions = fs.readFileSync(instructionsPath, "utf-8"); } catch { /* ignore */ }
  }

  if (!instructions.includes(marker)) {
    const snippet = [
      "",
      marker,
      "## Synap pod access",
      `You have access to a Synap data pod via MCP tools (server: synap).`,
      `Pod: ${cfg.podUrl}`,
      cfg.workspaceId ? `Default workspace: ${cfg.workspaceId}` : "Access: pod-wide",
      "Use the synap MCP tools to search, read, and write entities, memory, and documents.",
      "Always call orient (or list workspaces) first to discover workspace IDs.",
      "",
    ].join("\n");
    fs.writeFileSync(
      instructionsPath,
      (instructions.trimEnd() + snippet).trimStart() + "\n",
      { mode: 0o600 }
    );
  }

  log.success(`Codex config updated: ${configPath}`);
  if (cfg.workspaceId) {
    log.dim(`Scoped to workspace: ${cfg.workspaceId}`);
  } else {
    log.dim("Not scoped — all workspaces accessible.");
  }
  log.blank();
  log.dim("Restart Codex CLI to pick up the new MCP server.");
  return true;
}

// ─── MCP config writer ───────────────────────────────────────────────────────

interface McpServerConfig {
  url?: string;
  command?: string;
  args?: string[];
  headers?: Record<string, string>;
  env?: Record<string, string>;
}

export function writeMcpServerEntry(
  configPath: string,
  serverName: string,
  server: McpServerConfig
): void {
  const dir = path.dirname(configPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  let config: { mcpServers?: Record<string, McpServerConfig> } = {};
  if (fs.existsSync(configPath)) {
    try {
      config = JSON.parse(fs.readFileSync(configPath, "utf-8")) as typeof config;
    } catch {
      // corrupt or unreadable — back up and start fresh
      const backup = `${configPath}.bak-${Date.now()}`;
      fs.copyFileSync(configPath, backup);
      log.warn(`Existing config unreadable; backed up to ${path.basename(backup)}`);
    }
  }

  config.mcpServers = config.mcpServers ?? {};
  config.mcpServers[serverName] = server;

  fs.writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n", {
    mode: 0o600,
  });
}
