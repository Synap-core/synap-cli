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
import { exec, execFileSync } from "node:child_process";
import chalk from "chalk";
import ora from "ora";
import prompts from "prompts";
import { log } from "../utils/logger.js";
import { installSkills, getDeliverableSkills } from "./skills-installer.js";
import {
  resolveHubConfig,
  resolveUserId,
  hubGet,
  hubPatch,
  type HubConfig,
} from "./hub-client.js";

export type TargetName =
  | "claude-code"
  | "claude-desktop"
  | "cursor"
  | "raycast"
  | "openclaw"
  | "openwebui"
  | "codex"
  | "opencode"
  | "aider"
  | "windsurf"
  | "goose"
  | "zed"
  | "vscode"
  | "generic";

export interface TargetConnectionConfig {
  podUrl: string;
  apiKey: string;
  // Pinned lenses — set ONLY when the user explicitly pins (`--pin-workspace` /
  // `--pin-project`). Default is undefined = pod-wide: the agent connects across
  // the whole pod and scopes consciously per call. Workspace and project pins
  // are composable (both may be set for a client-dedicated agent).
  workspaceId?: string;
  projectId?: string;
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

/** Raycast app-support root (macOS only — Raycast is macOS-only). */
function raycastSupportDir(): string {
  return path.join(
    os.homedir(),
    "Library",
    "Application Support",
    "com.raycast.macos"
  );
}

/**
 * Locate Raycast's EXISTING `mcp-config.json`. Raycast stores all non-dev MCP
 * servers in ONE file inside the "Manage MCP Servers" extension's support
 * directory — an opaque UUID folder under `…/com.raycast.macos/extensions/`.
 * The folder name is only known to Raycast and the file is created lazily the
 * first time the user opens "Manage MCP Servers".
 *
 * We therefore scan the support dirs for an EXISTING `mcp-config.json` and
 * return its path (so we can merge into it). Returns `null` when none exists —
 * the caller then prints the block for the user to paste via Raycast's
 * "Show Config File in Finder" action (the only reliable first-time path).
 */
function raycastMcpConfigPath(): string | null {
  const extensionsDir = path.join(raycastSupportDir(), "extensions");
  try {
    for (const entry of fs.readdirSync(extensionsDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const candidate = path.join(extensionsDir, entry.name, "mcp-config.json");
      if (fs.existsSync(candidate)) return candidate;
    }
  } catch {
    /* extensions dir missing — Raycast not installed or never opened */
  }
  return null;
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
    description: "Native MCP server (via mcp-remote bridge) — all Synap tools in Raycast AI",
    supports: { skills: false, mcp: true },
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
  opencode: {
    name: "opencode",
    label: "opencode",
    description: "Synap IS as AI provider + Synap pod as MCP tools in ~/.config/opencode/opencode.json",
    supports: { skills: false, mcp: true },
  },
  aider: {
    name: "aider",
    label: "aider",
    description: "Write Synap IS as the OpenAI-compatible provider in ~/.aider.conf.yml",
    supports: { skills: false, mcp: false },
  },
  windsurf: {
    name: "windsurf",
    label: "Windsurf",
    description: "Codeium Windsurf editor — MCP config at ~/.codeium/windsurf/mcp_config.json",
    supports: { skills: false, mcp: true },
    mcpConfigPath: () => path.join(os.homedir(), ".codeium", "windsurf", "mcp_config.json"),
  },
  goose: {
    name: "goose",
    label: "Goose",
    description: "Block's AI agent — MCP extension in ~/.config/goose/config.yaml",
    supports: { skills: false, mcp: true },
  },
  zed: {
    name: "zed",
    label: "Zed",
    description: "Zed editor — context_servers entry in Zed settings.json (via mcp-remote)",
    supports: { skills: false, mcp: true },
  },
  vscode: {
    name: "vscode",
    label: "VS Code (Kilo Code / Cline / Continue / Copilot)",
    description: "VS Code native MCP — one config read by Kilo Code, Cline, Continue, and Copilot",
    supports: { skills: false, mcp: true },
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

// ─── Workspace helpers ────────────────────────────────────────────────────────

// Shape used by agent-template context generation. Agents are pod-wide now, so
// the connect flow no longer fetches/provisions per-agent workspaces — these
// stay typed for the (now always-empty) context inputs.
interface WorkspaceItem { id: string; name: string; role?: string }

/**
 * Build the pod's /mcp URL with optional scope lenses:
 *   ?workspaceId= — workspace lens (an app-lens of a project)
 *   ?projectId=   — project focus lens (orthogonal; narrows every tool call)
 * Both are opt-in and compose. Omitting both = pod-wide.
 */
export function buildMcpUrl(
  podUrl: string,
  workspaceId?: string,
  projectId?: string
): string {
  const podBase = podUrl.replace(/\/$/, "");
  const params = new URLSearchParams();
  if (workspaceId) params.set("workspaceId", workspaceId);
  if (projectId) params.set("projectId", projectId);
  const qs = params.toString();
  return qs ? `${podBase}/mcp?${qs}` : `${podBase}/mcp`;
}

/**
 * Shared preamble for MCP surface installers: provision a dedicated agent key,
 * enroll the agent into the caller's workspaces, and resolve the scoped MCP URL.
 */
async function prepareMcpSurface(
  cfg: TargetConnectionConfig,
  agentType: string
): Promise<{ effectiveApiKey: string; agentUserId: string; mcpUrl: string }> {
  const { hubApiKey: effectiveApiKey, agentUserId } = await provisionAgentKey(cfg.podUrl, cfg.apiKey, agentType);
  await enrollAgentIfNeeded(cfg.podUrl, cfg.apiKey, agentUserId, cfg.workspaceId);
  return { effectiveApiKey, agentUserId, mcpUrl: buildMcpUrl(cfg.podUrl, cfg.workspaceId, cfg.projectId) };
}

// ─── Agent context configuration ──────────────────────────────────────────────

async function configureAgentContext(
  podUrl: string,
  apiKey: string,
  agentType: string,
  agentUserId: string,
  info: TargetInfo
): Promise<void> {
  const { AGENT_TEMPLATES, getTemplate } = await import("./agent-templates.js");

  log.blank();
  log.heading("Configure your agent");
  // Agent scope model (mirrors the user model): an agent is a POD-WIDE actor —
  // it is NOT bound to a workspace. Its memory is automatic (the user/global/work
  // lanes), so there's no "memory workspace" to pick. It was already enrolled
  // across the pod's workspaces; focus is a runtime lens (a project), not a
  // setup-time workspace choice. So the only thing to configure is the template.
  log.dim("This agent is pod-wide. Its memory is automatic — nothing to scope here. Just pick a behaviour template.");

  // No memory/product workspace prompts anymore — the agent is global by default.
  const memoryWorkspace: WorkspaceItem | undefined = undefined;
  const productWorkspaces: WorkspaceItem[] = [];

  // ── Template ──────────────────────────────────────────────────────────────
  log.blank();
  log.info(chalk.bold("Agent template"));
  log.dim("The template sets the agent's default behaviour and routing rules.");
  log.blank();

  const { templateId } = await prompts({
    type: "select",
    name: "templateId",
    message: "Pick a template:",
    choices: AGENT_TEMPLATES.map((t) => ({
      title: `${t.label}  ${chalk.dim(t.description)}`,
      value: t.id,
    })),
  });

  const template = getTemplate(templateId as string);

  // ── Generate and write CONTEXT.md ─────────────────────────────────────────
  const content = template.generateContext({
    agentType,
    podUrl,
    memoryWorkspace,
    productWorkspaces,
  });

  // Clear any stale per-agent workspace routing from older connects. The agent
  // is pod-wide now: capture/recall default to the active workspace / pod-wide,
  // not a pre-pinned "memory" or "product" workspace.
  const { setAgentWorkspaceRouting } = await import("./pod.js");
  setAgentWorkspaceRouting({ memoryWorkspaceId: undefined, productWorkspaceIds: [] });

  // Always write to ~/.synap/contexts/<surface>.md
  const contextDir = path.join(os.homedir(), ".synap", "contexts");
  if (!fs.existsSync(contextDir)) fs.mkdirSync(contextDir, { recursive: true });
  const globalContextPath = path.join(contextDir, `${agentType}.md`);
  fs.writeFileSync(globalContextPath, content, { mode: 0o600 });

  // For skills-capable surfaces, also write alongside SKILL.md
  const skillsDir = info.skillsDir?.();
  if (skillsDir) {
    const synapSkillDir = path.join(skillsDir, "synap");
    if (!fs.existsSync(synapSkillDir)) fs.mkdirSync(synapSkillDir, { recursive: true });
    fs.writeFileSync(path.join(synapSkillDir, "CONTEXT.md"), content, { mode: 0o600 });
    log.success(`Agent context written to ${synapSkillDir}/CONTEXT.md`);
  } else {
    log.success(`Agent context written to ${globalContextPath}`);
    log.dim("For MCP-only surfaces the context is available as a reference; load it manually if needed.");
  }

  // Summary
  log.blank();
  log.info(`  Template     ${chalk.bold(template.label)}`);
  log.info(`  Scope        ${chalk.bold("pod-wide")} ${chalk.dim("· memory is automatic · focus a project at runtime")}`);
  log.blank();
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

  let result: boolean;
  switch (target) {
    case "claude-code":   result = await installClaudeCode(info, cfg); break;
    case "claude-desktop": result = await installClaudeDesktop(info, cfg); break;
    case "cursor":        result = await installCursor(info, cfg); break;
    case "raycast":       result = await installRaycast(cfg); break;
    case "openclaw":      result = await installOpenclaw(cfg); break;
    case "openwebui":     result = await installOpenWebUI(cfg); break;
    case "codex":         result = await installCodex(info, cfg); break;
    case "opencode":      result = await installOpencode(cfg); break;
    case "aider":         result = await installAider(cfg); break;
    case "windsurf":      result = await installWindsurf(info, cfg); break;
    case "goose":         result = await installGoose(cfg); break;
    case "zed":           result = await installZed(cfg); break;
    case "vscode":        result = await installVSCode(cfg); break;
    case "generic":       result = await installGeneric(cfg); break;
  }

  // Post-install: configure agent workspace context for all successful MCP installs.
  if (result && info.supports.mcp && target !== "generic") {
    const { getSurfaceAgentKey } = await import("./pod.js");
    const saved = getSurfaceAgentKey(target as import("./pod.js").SurfaceName);
    const agentUserId = saved?.agentUserId ?? "";
    try {
      await configureAgentContext(cfg.podUrl, cfg.apiKey, target, agentUserId, info);
    } catch (err) {
      log.warn(`Agent context wizard failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  return result;
}

// ─── Claude Code ─────────────────────────────────────────────────────────────

async function installClaudeCode(
  info: TargetInfo,
  cfg: TargetConnectionConfig
): Promise<boolean> {
  // ── What to install? ────────────────────────────────────────────────────
  // Claude Code is a CLI-first agent: it reads/writes Synap via `synap` shell
  // commands (capture, recall, search, create, etc.) — not via MCP tool calls.
  // Skills give it Synap knowledge; the agent key lets it call the CLI directly.
  // MCP is available as an opt-in for users who prefer the tool-call interface.
  const { mode } = await prompts({
    type: "select",
    name: "mode",
    message: "What do you want to install?",
    choices: [
      {
        title: "MCP + Skills + agent key  (recommended)",
        description: "MCP tools are always present (ambient) so the AI knows Synap on every session; skills + CLI add the rich power-user path",
        value: "both",
      },
      {
        title: "MCP server only",
        description: "Ambient tool-call interface only — skip skills and CLI setup. Best for non-terminal clients",
        value: "mcp",
      },
      {
        title: "Skills + agent key (no MCP)",
        description: "CLI-driven only — Synap is known only when the skill is loaded. Lighter, but not ambient",
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
        skills: cfg.skills ?? getDeliverableSkills(),
      });
      if (installed) {
        log.success(`Skills installed to ~/.claude/skills/`);
      }
    }
  }

  // ── Agent key + optional MCP ─────────────────────────────────────────────
  // writeClaudeCodeEnv always provisions the agent key and writes env vars.
  // writeMcp=true additionally registers the mcpServers entry.
  if (mode === "both" || mode === "mcp") {
    await writeClaudeCodeEnv(cfg);
    log.success("Agent key provisioned and MCP server registered in ~/.claude/settings.json");
  } else {
    await writeClaudeCodeEnv(cfg, { writeMcp: false });
    log.success("Agent key provisioned and pod env vars written to ~/.claude/settings.json");
    log.dim("Claude Code will use `synap` CLI commands to read/write the pod.");
  }

  log.blank();
  log.success("Claude Code configured.");
  log.dim("Open a new Claude Code window to pick up the updated env vars.");
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
  cfg: Pick<TargetConnectionConfig, "podUrl" | "apiKey" | "workspaceId" | "projectId" | "agentUserId">,
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
    signal: AbortSignal.timeout(30000),
  });
  if (!meRes.ok) {
    if (meRes.status === 401)
      throw new Error(credentialError("claude-code", 401, await meRes.text().catch(() => "")));
    throw new Error(`Could not reach pod at ${cfg.podUrl} (HTTP ${meRes.status}). Check your pod URL and API key.`);
  }
  const me = await meRes.json() as { id?: string; scopes?: string[] };
  if (!me.id) throw new Error("/api/hub/users/me returned no user ID — is the pod running?");

  const agentSetupRes = await fetch(`${podBase}/api/hub/setup/agent`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${cfg.apiKey}` },
    body: JSON.stringify({ agentType: "claude-code", idempotent: true }),
    signal: AbortSignal.timeout(30000),
  });
  if (!agentSetupRes.ok) {
    const text = await agentSetupRes.text().catch(() => agentSetupRes.statusText);
    throw new Error(credentialError("claude-code", agentSetupRes.status, text));
  }
  const agentSetup = await agentSetupRes.json() as { hubApiKey?: string; agentUserId?: string; alreadyValid?: boolean };
  if (agentSetup.alreadyValid) {
    // Idempotent path — pod says the agent key is still valid but doesn't re-transmit it.
    // Resolution priority: stored agentKey config > settings.json env var.
    // Self-heal: verify the candidate resolves to the expected agent user, not the human user.
    const { getSurfaceAgentKey: readSurfaceKey } = await import("./pod.js");
    const storedKey = readSurfaceKey("claude-code");
    const candidate =
      storedKey?.hubApiKey ??
      (settings.env as Record<string, string>)?.["SYNAP_HUB_API_KEY"] ??
      null;

    const expectedAgentUserId = agentSetup.agentUserId ?? storedKey?.agentUserId;
    let candidateIsValid = false;

    if (candidate && expectedAgentUserId) {
      try {
        // Use auth/status — it returns the key's actual owner userId.
        // For agent keys this is the agent userId, not the human userId.
        // users/me always returns the human owner regardless of key type.
        const verifyRes = await fetch(`${podBase}/api/hub/auth/status`, {
          headers: { Authorization: `Bearer ${candidate}` },
          signal: AbortSignal.timeout(30000),
        });
        if (verifyRes.ok) {
          const verifyStatus = await verifyRes.json() as { userId?: string };
          candidateIsValid = verifyStatus.userId === expectedAgentUserId;
        }
      } catch { /* reprovision below */ }
    }

    if (candidateIsValid && candidate) {
      effectiveApiKey = candidate;
    } else {
      // Self-heal: stored key is stale, wrong identity, or never persisted.
      // Reprovision without idempotent flag to get a fresh agent key.
      const reproRes = await fetch(`${podBase}/api/hub/setup/agent`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${cfg.apiKey}` },
        body: JSON.stringify({ agentType: "claude-code" }),
        signal: AbortSignal.timeout(30000),
      });
      if (reproRes.ok) {
        const repro = await reproRes.json() as { hubApiKey?: string; agentUserId?: string; alreadyValid?: boolean };
        effectiveApiKey = repro.hubApiKey ?? candidate ?? cfg.apiKey;
        if (repro.agentUserId) agentSetup.agentUserId = repro.agentUserId;
      } else {
        // Reprovision failed — fall back to whatever we have, warn clearly
        effectiveApiKey = candidate ?? cfg.apiKey;
        log.warn("Could not reprovision agent key — using fallback. Run `synap connect --target=claude-code` to fix.");
      }
    }
  } else {
    if (!agentSetup.hubApiKey) throw new Error("setup/agent succeeded but returned no hubApiKey — check pod logs.");
    effectiveApiKey = agentSetup.hubApiKey;
  }

  // Persist the provisioned key to agentKeys["claude-code"] so SYNAP_AGENT=claude-code
  // works in CLI sessions outside of this env (e.g. terminal, not just inside Claude Code).
  const { setSurfaceAgentKey: saveSurfaceKey } = await import("./pod.js");
  saveSurfaceKey("claude-code", { hubApiKey: effectiveApiKey, agentUserId: agentSetup.agentUserId ?? "" });

  // Enroll the new agent user into the caller's workspaces using the HUMAN key
  // (before switching to the agent key). Scoped to one workspace when chosen.
  await enrollAgentIfNeeded(cfg.podUrl, cfg.apiKey, agentSetup.agentUserId ?? "", cfg.workspaceId);

  // Set per-agent governance — prompt once per agent, idempotent.
  if (agentSetup.agentUserId) {
    await ensureAgentGovernance(cfg, agentSetup.agentUserId);
  }

  const env = (settings.env ?? {}) as Record<string, string>;
  env["SYNAP_POD_URL"] = cfg.podUrl;
  env["SYNAP_HUB_API_KEY"] = effectiveApiKey;
  env["SYNAP_USER_ID"] = me.id;
  delete env["SYNAP_AGENT_USER_ID"];
  if (cfg.workspaceId) env["SYNAP_WORKSPACE_ID"] = cfg.workspaceId;
  else delete env["SYNAP_WORKSPACE_ID"];
  if (me.scopes?.length) env["SYNAP_KEY_SCOPES"] = me.scopes.join(",");
  settings.env = env;

  // ── Clean up the dead settings.json mcpServers entry ─────────────────────
  // Claude Code does NOT load MCP servers from ~/.claude/settings.json — they
  // live in the `claude mcp` registry (~/.claude.json, user scope). A `synap`
  // entry written here by older CLI versions is inert (confirmed: `claude mcp
  // list` never showed it). Strip it so the only source of truth is the registry.
  if (settings.mcpServers && typeof settings.mcpServers === "object") {
    delete (settings.mcpServers as Record<string, unknown>)["synap"];
    if (Object.keys(settings.mcpServers as Record<string, unknown>).length === 0)
      delete settings.mcpServers;
  }

  if (!fs.existsSync(settingsDir)) {
    fs.mkdirSync(settingsDir, { recursive: true });
  }
  fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + "\n", { mode: 0o600 });

  // ── Register the MCP server where Claude Code actually reads it ───────────
  // The official `claude mcp add` writes to the user-scope registry that
  // `claude mcp list` + the runtime consult — unlike settings.json mcpServers,
  // which Claude Code ignores. This is what makes a relaunch actually load the
  // synap tools.
  if (writeMcp) {
    const mcpUrl = buildMcpUrl(cfg.podUrl, cfg.workspaceId, cfg.projectId);
    registerClaudeCodeMcp(mcpUrl, effectiveApiKey);
  }
}

/**
 * Register the Synap MCP server with Claude Code via the official CLI, into the
 * user-scope registry (`claude mcp list` truth). Idempotent: drops any prior
 * entry first. Best-effort: if the `claude` binary isn't on PATH, prints the
 * exact command to run by hand rather than failing the whole connect.
 */
function registerClaudeCodeMcp(mcpUrl: string, apiKey: string): void {
  const header = `Authorization: Bearer ${apiKey}`;
  try {
    try {
      execFileSync("claude", ["mcp", "remove", "synap"], { stdio: "ignore" });
    } catch {
      /* no prior entry — fine */
    }
    execFileSync(
      "claude",
      ["mcp", "add", "--transport", "http", "synap", mcpUrl, "--header", header, "--scope", "user"],
      { stdio: "ignore" }
    );
    log.success("MCP server registered with Claude Code (`claude mcp add`, user scope). Relaunch Claude Code to load the synap tools.");
  } catch {
    log.dim("Could not run `claude mcp add` (is the claude CLI on PATH?). Register it by hand:");
    log.dim(`  claude mcp add --transport http synap ${mcpUrl} --header "${header}" --scope user`);
  }
}

// ─── Agent key provisioning helper ──────────────────────────────────────────

/**
 * Build an actionable error for a failed agent-key provision. A 401 here almost
 * always means the pod key saved by `synap login` is expired or REVOKED (the
 * `/setup/agent` endpoint accepts a CP JWT, a provisioning token, or a Hub key
 * with the `setup.agent` scope) — so the fix is to re-authenticate, NOT to fiddle
 * with scopes. Don't mislead with "needs hub-protocol.write".
 */
function credentialError(agentType: string, status: number, body: string): string {
  if (status === 401) {
    return (
      `Can't provision the agent key for ${agentType} (HTTP 401): your saved pod key is invalid, expired, or revoked.\n` +
      `Fix: run \`synap login --reconnect\` to re-authenticate this pod and mint a fresh key, then retry.\n` +
      `(Plain \`synap login\` only health-checks — it won't refresh a revoked key.)\n` +
      (body ? `Server said: ${body}` : "")
    );
  }
  return (
    `Failed to provision agent key for ${agentType} (HTTP ${status}): ${body}\n` +
    `If this persists, re-authenticate with \`synap login --reconnect\`.`
  );
}

function openBrowserUrl(url: string): void {
  const safe = url.replace(/"/g, "%22");
  const cmd =
    process.platform === "darwin" ? `open "${safe}"` :
    process.platform === "win32"  ? `start "" "${safe}"` :
    `xdg-open "${safe}"`;
  exec(cmd, () => { /* best-effort */ });
}

async function waitForKeyApproval(
  podBase: string,
  humanApiKey: string,
  pendingToken: string,
  agentType: string
): Promise<void> {
  const pollUrl = `${podBase}/api/hub/setup/agent/pending/${pendingToken}`;
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 2000));
    let poll: Response;
    try {
      poll = await fetch(pollUrl, {
        headers: { Authorization: `Bearer ${humanApiKey}` },
        signal: AbortSignal.timeout(30000),
      });
    } catch { continue; }
    if (!poll.ok) continue;
    const data = await poll.json() as { status?: string };
    if (data.status === "active") return;
    if (data.status === "rejected") {
      throw new Error(`Agent key for ${agentType} was rejected in the browser. Run connect again to re-request.`);
    }
  }
  throw new Error(
    `Timed out waiting for approval of ${agentType} agent key (120s). ` +
    `Open the review URL manually or run connect again.`
  );
}

/**
 * Provision an agent-owned API key for the given surface via POST /api/hub/setup/agent.
 * When requireApproval is true the key is created inactive; the user must approve in the
 * browser before this function returns.
 * Throws on failure — callers must not silently fall back to a human key.
 */
export async function provisionAgentKey(
  podUrl: string,
  humanApiKey: string,
  agentType: string,
  { requireApproval = true }: { requireApproval?: boolean } = {}
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
      body: JSON.stringify({ agentType, idempotent: false, requireApproval }),
      signal: AbortSignal.timeout(30000),
    });
  } catch (err) {
    throw new Error(
      `Could not reach pod to provision agent key for ${agentType}: ${(err as Error).message}\n` +
      `Ensure the pod is reachable and try again.`
    );
  }
  if (!res.ok) {
    const text = await res.text().catch(() => res.statusText);
    throw new Error(credentialError(agentType, res.status, text));
  }
  const body = await res.json() as {
    hubApiKey?: string;
    agentUserId?: string;
    requiresApproval?: boolean;
    pendingToken?: string;
    reviewUrl?: string;
  };
  if (!body.hubApiKey) {
    throw new Error(
      `setup/agent succeeded but returned no hubApiKey for ${agentType}. ` +
      `This is a server-side bug — check the pod logs.`
    );
  }
  if (body.requiresApproval && body.pendingToken && body.reviewUrl) {
    log.info(`\n  Opening your pod to review this agent key request…`);
    log.dim(`  ${body.reviewUrl}`);
    openBrowserUrl(body.reviewUrl);
    process.stdout.write(chalk.dim("  Waiting for approval"));
    const ticker = setInterval(() => process.stdout.write(chalk.dim(".")), 2000);
    try {
      await waitForKeyApproval(podBase, humanApiKey, body.pendingToken, agentType);
    } finally {
      clearInterval(ticker);
      process.stdout.write("\n");
    }
    log.success(`  Approved! Writing ${agentType} agent key.`);
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
export async function enrollAgentIfNeeded(
  podUrl: string,
  callerKey: string,
  agentUserId: string,
  workspaceId?: string,
  opts?: { quiet?: boolean }
): Promise<void> {
  if (!agentUserId) return;
  const quiet = opts?.quiet === true; // suppress status logs (e.g. --json callers)
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
      signal: AbortSignal.timeout(30000),
    });
    if (res.ok) {
      const data = await res.json() as { enrolled?: string[] };
      if (data.enrolled?.length && !quiet) {
        log.dim(`  Agent enrolled in ${data.enrolled.length} workspace(s).`);
      }
    } else if (!quiet) {
      const text = await res.text().catch(() => res.statusText);
      log.warn(`  Workspace enrollment failed (HTTP ${res.status}): ${text}`);
      log.dim("  Access can be added manually via pod settings.");
    }
  } catch (err) {
    if (!quiet) {
      log.warn(`  Workspace enrollment unreachable: ${(err as Error).message}`);
      log.dim("  Access can be added manually via pod settings.");
    }
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
  const { setSurfaceAgentKey: saveDesktopKey } = await import("./pod.js");
  saveDesktopKey("claude-desktop", { hubApiKey: effectiveApiKey, agentUserId });
  await enrollAgentIfNeeded(cfg.podUrl, cfg.apiKey, agentUserId, cfg.workspaceId);
  const desktopMcpUrl = buildMcpUrl(cfg.podUrl, cfg.workspaceId, cfg.projectId);
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
      skills: cfg.skills ?? getDeliverableSkills(),
    });
    if (installed) {
      log.success(
        `Synap skills installed to ${path.relative(os.homedir(), skillsDir)}/ (${(cfg.skills ?? getDeliverableSkills()).join(", ")})`,
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
  const { setSurfaceAgentKey: saveCursorKey } = await import("./pod.js");
  saveCursorKey("cursor", { hubApiKey: effectiveApiKey, agentUserId });
  await enrollAgentIfNeeded(cfg.podUrl, cfg.apiKey, agentUserId, cfg.workspaceId);
  const cursorMcpUrl = buildMcpUrl(cfg.podUrl, cfg.workspaceId, cfg.projectId);
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
  // Raycast reads credentials from ~/.synap/config.json (Tier 0) for its native
  // extension commands, AND from mcp-config.json for the MCP server. Persist the
  // workspace choice so both paths see the right scope.
  const { setActiveWorkspaceId, clearActiveWorkspaceId } = await import("./pod.js");
  if (cfg.workspaceId) {
    setActiveWorkspaceId(cfg.workspaceId);
  } else {
    clearActiveWorkspaceId();
  }

  // Provision a dedicated "raycast" agent identity + resolve the scoped MCP URL.
  const { effectiveApiKey, agentUserId, mcpUrl } = await prepareMcpSurface(cfg, "raycast");
  const { setSurfaceAgentKey } = await import("./pod.js");
  setSurfaceAgentKey("raycast", { hubApiKey: effectiveApiKey, agentUserId });

  // ── Write the Raycast MCP server config (merge, never clobber) ─────────────
  // Raycast's native MCP is stdio-only — bridge the HTTP /mcp endpoint with the
  // `mcp-remote` npm package (npx spawns it). Same bridge as Claude Desktop/Zed.
  const synapServerEntry = {
    command: "npx",
    args: [
      "-y",
      "mcp-remote",
      mcpUrl,
      "--header",
      `Authorization: Bearer ${effectiveApiKey}`,
    ],
  };

  // The mcp-config.json lives in an opaque UUID folder Raycast creates the first
  // time "Manage MCP Servers" is opened. If it already exists we merge into it;
  // otherwise we can't know the folder, so we print the block to paste.
  const existingPath = raycastMcpConfigPath();
  let wrote = false;
  if (existingPath) {
    try {
      let mcpConfig: { mcpServers?: Record<string, unknown> } = {};
      try {
        mcpConfig = JSON.parse(fs.readFileSync(existingPath, "utf-8"));
      } catch {
        try { fs.copyFileSync(existingPath, `${existingPath}.bak`); } catch { /* best-effort */ }
      }
      mcpConfig.mcpServers = mcpConfig.mcpServers ?? {};
      mcpConfig.mcpServers["synap"] = synapServerEntry;
      fs.writeFileSync(existingPath, JSON.stringify(mcpConfig, null, 2) + "\n", { mode: 0o600 });
      wrote = true;
      log.success(`Synap MCP server added to Raycast: ${existingPath}`);
      log.dim("Reopen Raycast → 'Manage MCP Servers' → 'synap' is connected with all tools.");
      log.dim("First call spawns 'npx mcp-remote' (needs Node on PATH).");
    } catch (err) {
      log.warn(`Could not write Raycast MCP config: ${(err as Error).message}`);
    }
  }

  if (!wrote) {
    log.info("To add Synap to Raycast as an MCP server:");
    log.dim("  1. Open Raycast → run 'Manage MCP Servers'");
    log.dim("  2. Action 'Show Config File in Finder' → open mcp-config.json");
    log.dim("  3. Paste the 'synap' entry below into \"mcpServers\", then save:");
    log.blank();
    log.dim(
      JSON.stringify({ mcpServers: { synap: synapServerEntry } }, null, 2)
    );
    log.blank();
    log.dim("  (Re-running `synap connect --target=raycast` after step 2 writes it for you.)");
  }

  log.blank();
  log.dim(`   Pod: ${cfg.podUrl}`);
  log.dim(`   Scope: ${cfg.workspaceId ? `workspace ${cfg.workspaceId}` : "all workspaces (pod-wide)"}`);
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
  for (const name of cfg.skills ?? getDeliverableSkills()) {
    log.dim(`  openclaw skills install ${name}`);
  }
  return true;
}

// ─── Open WebUI ──────────────────────────────────────────────────────────────

async function installOpenWebUI(cfg: TargetConnectionConfig): Promise<boolean> {
  const mcpUrl = buildMcpUrl(cfg.podUrl, cfg.workspaceId, cfg.projectId);
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

// ─── Windsurf ────────────────────────────────────────────────────────────────

async function installWindsurf(
  info: TargetInfo,
  cfg: TargetConnectionConfig
): Promise<boolean> {
  const configPath = info.mcpConfigPath?.() ?? path.join(os.homedir(), ".codeium", "windsurf", "mcp_config.json");
  const { effectiveApiKey, agentUserId, mcpUrl } = await prepareMcpSurface(cfg, "windsurf");

  writeMcpServerEntry(configPath, "synap", { url: mcpUrl, headers: { Authorization: `Bearer ${effectiveApiKey}` } });

  const { setSurfaceAgentKey: save } = await import("./pod.js");
  save("windsurf", { hubApiKey: effectiveApiKey, agentUserId });

  log.success(`Windsurf MCP config updated: ${configPath}`);
  log.dim("Restart Windsurf to pick up the new MCP server.");
  return true;
}

// ─── Goose ───────────────────────────────────────────────────────────────────

async function installGoose(cfg: TargetConnectionConfig): Promise<boolean> {
  const configDir = path.join(os.homedir(), ".config", "goose");
  const configPath = path.join(configDir, "config.yaml");

  if (!fs.existsSync(configDir)) fs.mkdirSync(configDir, { recursive: true });

  const { effectiveApiKey, agentUserId, mcpUrl } = await prepareMcpSurface(cfg, "goose");

  const marker = "  synap:";
  const block = [
    "  synap:",
    "    name: synap",
    "    type: streamable_http",
    `    uri: "${mcpUrl}"`,
    "    env_keys: []",
    "    timeout: 300",
    `    headers:`,
    `      Authorization: "Bearer ${effectiveApiKey}"`,
  ].join("\n");

  let existing = "";
  if (fs.existsSync(configPath)) {
    try { existing = fs.readFileSync(configPath, "utf-8"); } catch { /* ignore */ }
  }

  let updated: string;
  if (existing.includes(marker)) {
    updated = existing.replace(/  synap:[\s\S]*?(?=\n  [a-zA-Z_]|\s*$)/, block);
  } else if (/^extensions:/m.test(existing)) {
    updated = existing.trimEnd() + "\n" + block + "\n";
  } else {
    updated = (existing ? existing.trimEnd() + "\n\n" : "") + "extensions:\n" + block + "\n";
  }

  fs.writeFileSync(configPath, updated, { mode: 0o600 });

  const { setSurfaceAgentKey: save } = await import("./pod.js");
  save("goose", { hubApiKey: effectiveApiKey, agentUserId });

  log.success(`Goose config updated: ${configPath}`);
  log.dim("Run `goose session` to pick up the new MCP extension.");
  return true;
}

// ─── Zed ─────────────────────────────────────────────────────────────────────

function zedSettingsPath(): string {
  switch (process.platform) {
    case "darwin": return path.join(os.homedir(), "Library", "Application Support", "Zed", "settings.json");
    case "win32":  return path.join(process.env.APPDATA ?? os.homedir(), "Zed", "settings.json");
    default:       return path.join(os.homedir(), ".config", "zed", "settings.json");
  }
}

async function installZed(cfg: TargetConnectionConfig): Promise<boolean> {
  const settingsPath = zedSettingsPath();
  const settingsDir = path.dirname(settingsPath);
  if (!fs.existsSync(settingsDir)) fs.mkdirSync(settingsDir, { recursive: true });

  const { effectiveApiKey, agentUserId, mcpUrl } = await prepareMcpSurface(cfg, "zed");

  let settings: Record<string, unknown> = {};
  if (fs.existsSync(settingsPath)) {
    try {
      const raw = fs.readFileSync(settingsPath, "utf-8");
      // Zed settings.json is JSONC — strip // line comments and /* block comments */
      // before parsing. Comments will not be preserved in the rewritten file.
      const stripped = raw
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/\/\/[^\n]*/g, "");
      settings = JSON.parse(stripped) as Record<string, unknown>;
    } catch { /* malformed — start from scratch */ }
  }

  const contextServers = (settings.context_servers ?? {}) as Record<string, unknown>;
  contextServers["synap"] = {
    source: "custom",
    command: {
      path: "npx",
      args: ["-y", "mcp-remote@latest", mcpUrl, "--header", `Authorization: Bearer ${effectiveApiKey}`],
    },
    settings: {},
  };
  settings.context_servers = contextServers;

  fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + "\n", { mode: 0o600 });

  const { setSurfaceAgentKey: save } = await import("./pod.js");
  save("zed", { hubApiKey: effectiveApiKey, agentUserId });

  log.success(`Zed settings updated: ${settingsPath}`);
  log.dim("Note: Zed settings are JSONC — any existing // comments were removed during rewrite.");
  log.dim("Reload Zed to pick up the new context server (mcp-remote bridge).");
  return true;
}

// ─── VS Code (Kilo Code / Cline / Continue / Copilot) ────────────────────────

function vsCodeUserDataDir(): string {
  switch (process.platform) {
    case "darwin": return path.join(os.homedir(), "Library", "Application Support", "Code", "User");
    case "win32":  return path.join(process.env.APPDATA ?? os.homedir(), "Code", "User");
    default:       return path.join(os.homedir(), ".config", "Code", "User");
  }
}

async function installVSCode(cfg: TargetConnectionConfig): Promise<boolean> {
  const mcpJsonPath = path.join(vsCodeUserDataDir(), "mcp.json");
  const mcpDir = path.dirname(mcpJsonPath);
  if (!fs.existsSync(mcpDir)) fs.mkdirSync(mcpDir, { recursive: true });

  const { effectiveApiKey, agentUserId, mcpUrl } = await prepareMcpSurface(cfg, "vscode");

  // VS Code 1.99+ global MCP format uses "servers" (not "mcpServers")
  let existing: { servers?: Record<string, unknown> } = {};
  if (fs.existsSync(mcpJsonPath)) {
    try { existing = JSON.parse(fs.readFileSync(mcpJsonPath, "utf-8")) as typeof existing; } catch { /* ignore */ }
  }

  existing.servers = existing.servers ?? {};
  existing.servers["synap"] = {
    type: "http",
    url: mcpUrl,
    headers: { Authorization: `Bearer ${effectiveApiKey}` },
  };

  fs.writeFileSync(mcpJsonPath, JSON.stringify(existing, null, 2) + "\n", { mode: 0o600 });

  const { setSurfaceAgentKey: save } = await import("./pod.js");
  save("vscode", { hubApiKey: effectiveApiKey, agentUserId });

  log.success(`VS Code MCP config updated: ${mcpJsonPath}`);
  log.dim("Picked up automatically by Kilo Code, Cline, Continue, and GitHub Copilot.");
  log.dim("Reload VS Code (or open the MCP panel) to activate.");
  return true;
}

async function installGeneric(cfg: TargetConnectionConfig): Promise<boolean> {
  const mcpUrl = buildMcpUrl(cfg.podUrl, cfg.workspaceId, cfg.projectId);

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
  const mcpUrl = buildMcpUrl(cfg.podUrl, cfg.workspaceId, cfg.projectId);

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

// ─── Shared MCP config types ─────────────────────────────────────────────────

interface McpServerConfig {
  url?: string;
  command?: string;
  args?: string[];
  headers?: Record<string, string>;
  env?: Record<string, string>;
}

// ─── opencode ────────────────────────────────────────────────────────────────

export interface ProviderInfo {
  providerId: string;
  name: string;
  models: Array<{ id: string; contextWindow?: number }>;
}

export interface ProviderInstallConfig {
  podUrl: string;
  apiKey: string;
}

type ProviderWithKey = ProviderInfo & { apiKey: string | null; baseUrl: string };

async function fetchCredentials(podUrl: string, apiKey: string): Promise<ProviderWithKey[]> {
  const { fetchPodCredentials } = await import("../commands/providers.js");
  return fetchPodCredentials(podUrl, apiKey) as Promise<ProviderWithKey[]>;
}

/** Prompt the user to pick a provider from the pod and return it with its resolved key. */
async function pickProvider(
  podUrl: string,
  apiKey: string
): Promise<ProviderWithKey | null> {
  const spinner = ora("Fetching providers from pod vault...").start();
  let providers: ProviderWithKey[];
  try {
    providers = await fetchCredentials(podUrl, apiKey);
    spinner.stop();
  } catch (err) {
    spinner.fail(`Could not fetch providers: ${(err as Error).message}`);
    return null;
  }
  const withKeys = providers.filter((p) => p.apiKey);

  if (withKeys.length === 0) {
    log.warn("No providers with API keys found on this pod.");
    log.dim("Add providers and keys in pod admin → Intelligence → Providers.");
    return null;
  }

  if (withKeys.length === 1) return withKeys[0];

  const { choice } = await prompts({
    type: "select",
    name: "choice",
    message: "Which AI provider do you want to use?",
    choices: withKeys.map((p) => ({
      title: `${p.name}  ${chalk.dim(p.providerId)}`,
      value: p.providerId,
    })),
  });

  return withKeys.find((p) => p.providerId === choice) ?? null;
}

export async function installOpencode(cfg: ProviderInstallConfig & { workspaceId?: string; projectId?: string }): Promise<boolean> {
  const provider = await pickProvider(cfg.podUrl, cfg.apiKey);
  if (!provider || !provider.apiKey) return false;

  // Build model map from the chosen provider
  if (provider.models.length === 0) {
    log.warn(`No model IDs found for ${provider.name} — configure models in pod admin → Intelligence → Providers`);
    return false;
  }

  const models: Record<string, { name: string; contextLength?: number }> = {};
  let defaultModel = "";
  for (const m of provider.models) {
    const key = `${provider.providerId}/${m.id}`;
    models[key] = {
      name: m.id,
      ...(m.contextWindow ? { contextLength: m.contextWindow } : {}),
    };
    if (!defaultModel) defaultModel = key;
  }

  const configDir = path.join(os.homedir(), ".config", "opencode");
  const configPath = path.join(configDir, "opencode.json");

  if (!fs.existsSync(configDir)) {
    fs.mkdirSync(configDir, { recursive: true });
  }

  let existing: Record<string, unknown> = {};
  if (fs.existsSync(configPath)) {
    try {
      existing = JSON.parse(fs.readFileSync(configPath, "utf-8")) as Record<string, unknown>;
    } catch {
      fs.copyFileSync(configPath, `${configPath}.bak`);
      log.warn("Existing opencode.json unreadable — backed up to opencode.json.bak");
    }
  }

  const providerBlock = (existing.provider ?? {}) as Record<string, unknown>;
  providerBlock[provider.providerId] = {
    npm: "@ai-sdk/openai-compatible",
    name: provider.name,
    options: { baseURL: provider.baseUrl, apiKey: provider.apiKey },
    models,
  };

  // Provision an agent key so the MCP server runs under its own identity
  const { hubApiKey: agentKey, agentUserId } = await provisionAgentKey(cfg.podUrl, cfg.apiKey, "opencode");
  await enrollAgentIfNeeded(cfg.podUrl, cfg.apiKey, agentUserId, cfg.workspaceId);
  const podBase = cfg.podUrl.replace(/\/$/, "");
  const mcpUrl = buildMcpUrl(cfg.podUrl, cfg.workspaceId, cfg.projectId);

  const mcpBlock = (existing.mcp ?? {}) as Record<string, unknown>;
  mcpBlock["synap"] = { type: "remote", url: mcpUrl, headers: { Authorization: `Bearer ${agentKey}` } };

  const updated = {
    $schema: "https://opencode.ai/config.json",
    ...existing,
    provider: providerBlock,
    mcp: mcpBlock,
    ...(existing.model ? {} : { model: defaultModel }),
  };

  fs.writeFileSync(configPath, JSON.stringify(updated, null, 2) + "\n", { mode: 0o600 });

  const { setSurfaceAgentKey: save } = await import("./pod.js");
  save("opencode", { hubApiKey: agentKey, agentUserId });

  log.success(`opencode configured: ~/.config/opencode/opencode.json`);
  log.dim(`  AI provider: ${provider.name}  (${Object.keys(models).length} model(s))`);
  log.dim(`  MCP tools:   synap pod at ${podBase}`);
  log.blank();
  log.dim("Restart opencode to pick up the new provider and MCP server.");
  return true;
}

// ─── aider ───────────────────────────────────────────────────────────────────

export async function installAider(cfg: ProviderInstallConfig): Promise<boolean> {
  const provider = await pickProvider(cfg.podUrl, cfg.apiKey);
  if (!provider || !provider.apiKey) return false;

  const defaultModel = provider.models[0]?.id ?? "default";
  const confPath = path.join(os.homedir(), ".aider.conf.yml");

  let existing = "";
  if (fs.existsSync(confPath)) {
    try { existing = fs.readFileSync(confPath, "utf-8"); } catch { /* ignore */ }
  }

  const marker = "# synap-provider";
  const block = [
    marker,
    `openai-api-base: ${provider.baseUrl}`,
    `openai-api-key: ${provider.apiKey}`,
    `model: openai/${defaultModel}`,
    "",
  ].join("\n");

  const updated = existing.includes(marker)
    ? existing.replace(/# synap-provider[\s\S]*?(?=\n[a-zA-Z#]|\s*$)/, block.trimEnd())
    : existing ? `${existing.trimEnd()}\n\n${block}` : block;

  fs.writeFileSync(confPath, updated.trimEnd() + "\n", { mode: 0o600 });

  log.success(`${provider.name} configured in ~/.aider.conf.yml`);
  log.dim(`  Base URL: ${provider.baseUrl}`);
  log.dim(`  Model:    openai/${defaultModel}`);
  log.blank();
  log.dim("Aider picks up ~/.aider.conf.yml automatically.");
  return true;
}

// ─── MCP config writer ───────────────────────────────────────────────────────

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

/**
 * Idempotent workspace governance prompt. Checks if the workspace already has
 * aiGovernance configured — skips if set. Otherwise prompts for safe/normal/crazy
 * and applies via PATCH /workspaces/:id/governance.
 */
export type GovernancePreset = "safe" | "normal" | "crazy";

// Governance presets — MUST stay in sync with GOVERNANCE_MODES in the backend
// `@synap/governance-policy`. (Single-source TODO: have the backend resolve a
// mode NAME so the CLI never re-states the autoApproveFor list — until then,
// this is the one place to mirror when the backend presets change.)
const GOVERNANCE_PRESETS: Record<
  GovernancePreset,
  { autoApproveFor: string[]; writesRequireProposal: boolean }
> = {
  safe: {
    autoApproveFor: [
      "search.*", "memory.recall", "entity.read", "document.read",
      "context.*", "filesystem.read", "bento.arrange",
    ],
    writesRequireProposal: true,
  },
  normal: {
    autoApproveFor: [
      "search.*", "memory.recall", "entity.read", "document.read",
      "context.*", "filesystem.read", "bento.arrange",
      "entity.create", "document.create", "relation.create",
      "view.create", "profile.create", "property_def.create",
      "channel.create",
      // Capability-substrate creates — "creates are instant" (mirrors backend).
      "automation.create", "playbook.create", "link.create",
      "tool.create", "skill.create",
      "playbook.read", "tool.read", "link.read", "capability.read",
      "terminal.read_logs", "filesystem.write_workspace",
    ],
    writesRequireProposal: false,
  },
  crazy: {
    autoApproveFor: ["*"],
    writesRequireProposal: false,
  },
};

export async function ensureAgentGovernance(
  cfg: { podUrl: string; apiKey: string },
  agentUserId: string,
  presetMode?: GovernancePreset
): Promise<void> {
  const userId = await resolveUserId(cfg as HubConfig);
  const hubCfg: HubConfig = { ...cfg, userId };

  // Non-interactive when a preset is passed (e.g. `--governance normal`);
  // otherwise prompt (Normal pre-selected, Enter = <1s).
  let mode = presetMode;
  if (!mode) {
    const res = await prompts({
      type: "select",
      name: "mode",
      message: "Governance — how should this agent's actions be gated?",
      choices: [
        {
          title: "Safe — every change requires your approval in Synap Studio",
          description:
            "Creates, updates, and deletes all go through proposals. Maximum control.",
          value: "safe",
        },
        {
          title: "Normal — creates are instant, updates & deletes need approval (recommended)",
          description:
            "Agents create things immediately — you approve changes to existing data.",
          value: "normal",
        },
        {
          title: "Crazy — everything is instant; revert in Studio if needed",
          description:
            "All actions auto-execute. You can revert anything in Synap Studio.",
          value: "crazy",
        },
      ],
      initial: 1,
    });
    if (!res.mode) return;
    mode = res.mode as GovernancePreset;
  }

  const profile = GOVERNANCE_PRESETS[mode] ?? GOVERNANCE_PRESETS.normal;
  try {
    await hubPatch(
      `/agent-users/${agentUserId}/governance`,
      {
        autoApproveFor: profile.autoApproveFor,
        writesRequireProposal: profile.writesRequireProposal,
      },
      hubCfg
    );
    log.success(`Agent governance set to "${mode}"`);
  } catch (err) {
    log.warn(`Could not apply agent governance: ${(err as Error).message}`);
  }
}
