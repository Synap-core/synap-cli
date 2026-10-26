/**
 * Synap pod connection and management utilities.
 */

import { readJsonStrict, writeFileAtomic, ensureSecretDir } from "./atomic-file.js";
import { PodMovedError, podFetch } from "./pod-moved.js";
import { classifyFetchError, classifyHttpStatus, type ReachFailure } from "./pod-reach.js";
import { execSync } from "child_process";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";


// ─── Local CLI config (persists pod connections) ──────────────────────────────
const CONFIG_DIR = path.join(os.homedir(), ".synap");
const CONFIG_FILE = path.join(CONFIG_DIR, "config.json");
const LEGACY_CONFIG_FILE = path.join(CONFIG_DIR, "pod-config.json");

export interface LocalPodConfig {
  podUrl: string;
  podId?: string;
  workspaceId: string;
  agentUserId: string;
  hubApiKey: string;
  label?: string;
  savedAt: string;
  /**
   * "computer" = `hubApiKey` is THIS machine's own key on the pod, from the
   * device flow (`device-connect.ts`); `agentUserId` is then the computer's id.
   * Absent = a pasted key or an older operator key.
   */
  credential?: "computer";
  /** When `hubApiKey` stops working (ISO), if the pod said. `synap login`/`init` renew it 7 days before. */
  keyExpiresAt?: string;
  /** The computer's name on the pod ("devbox"). */
  computerName?: string;
}

/** SSOT for every connect/surface agent identity. The type is derived from this
 *  array so the two can't drift. */
export const SURFACE_NAMES = [
  "raycast",
  "claude-code",
  "claude-desktop",
  "cursor",
  "codex",
  "chatgpt",
  "chatgpt-oauth",
  "opencode",
  "aider",
  "windsurf",
  "goose",
  "zed",
  "vscode",
  "grok",
  "discord",
  "proton",
  "generic",
] as const;
export type SurfaceName = (typeof SURFACE_NAMES)[number];

/**
 * agentTypes already owned by OTHER doors — provisioning is singleton per
 * (createdByUserId, agentType), so `agents create` deriving a slug that collides
 * with one of these would reuse that surface's agent for this user. Superset of
 * the surfaces above plus the non-surface provisioning types (generic/openwebui
 * MCP mappings; cli/memory, and the retired "openclaw", which pods may still
 * hold an agent of). Single source of truth for the collision guard.
 */
export const RESERVED_AGENT_TYPES: ReadonlySet<string> = new Set<string>([
  ...SURFACE_NAMES,
  "openwebui",
  "openclaw",
  "cli",
  "memory",
]);

export interface SurfaceAgentKey {
  hubApiKey: string;
  agentUserId: string;
  /**
   * Pod the key was provisioned against. Consumers (e.g. the Raycast extension)
   * must only use the key when this matches the pod they're talking to —
   * a surface pointed at another pod falls back to that pod's own profile key.
   */
  podUrl?: string;
}

/** Agent workspace routing — persisted by `synap connect` wizard. */
export interface AgentWorkspaceRouting {
  /** Private workspace for agent-only captures (gotchas, lessons, patterns). Auto-approved. */
  memoryWorkspaceId?: string;
  /** Shared workspaces the agent writes team-visible data to. */
  productWorkspaceIds?: string[];
}

/** The active project pinned together with the pod profile it lives on. */
export interface ActiveProjectBinding {
  projectId: string;
  podName: string;
}

/**
 * The active workspace pinned together with the pod profile it belongs to.
 *
 * A workspace exists on exactly ONE pod, but `activeWorkspaceId` is a single
 * pod-agnostic global. Recording the pod it was set against lets resolution
 * refuse to send a workspace to a pod it doesn't belong to (the cross-pod 403).
 * Peer of {@link ActiveProjectBinding}.
 */
export interface ActiveWorkspaceBinding {
  workspaceId: string;
  podName: string;
}

export interface MultiPodConfig {
  activePod: string;
  /** Per-surface pod overrides. When set, takes priority over activePod for that surface. */
  surfaces?: Partial<Record<SurfaceName, string>>;
  pods: Record<string, LocalPodConfig>;
  /** Active workspace override — set by `synap use <workspaceId>`. Takes priority over the pod's default workspaceId. */
  activeWorkspaceId?: string;
  /** Pod-aware binding of the active workspace — records which pod `activeWorkspaceId` was set against, so cross-pod resolution can ignore it for other pods. */
  activeWorkspace?: ActiveWorkspaceBinding;
  /** Active project override — set by `synap project use <projectId>`. Peer of activeWorkspaceId; independent (composable). */
  activeProjectId?: string;
  /** Pod-aware binding of the active project — set by cross-pod `synap project use <ref>` so later drift (active pod changed under the pin) can warn. */
  activeProject?: ActiveProjectBinding;
  /** Per-surface dedicated agent keys (provisioned with named agentType). Separate from pod profile keys. */
  agentKeys?: Partial<Record<SurfaceName, SurfaceAgentKey>>;
  /**
   * Multi-pod surface keys: surface → normalized podUrl → key.
   * `agentKeys[surface]` remains the last-written default for backward compat;
   * this map is the source of truth when a consumer knows which pod it is talking to.
   */
  agentKeysByPod?: Partial<Record<SurfaceName, Record<string, SurfaceAgentKey>>>;
  /**
   * Keys minted but NOT yet approved: surface → normalized podUrl → key. Never
   * read for authentication. Kept so the next `connect` / `doctor --fix`
   * resumes the SAME request instead of minting another (one approval, one key),
   * and moved into `agentKeysByPod` only once the pod says it is live.
   */
  pendingAgentKeys?: Record<string, Record<string, PendingAgentKey>>;
  /** Workspace routing set by `synap connect` wizard — drives capture/recall defaults. */
  agentWorkspaceRouting?: AgentWorkspaceRouting;
}

function ensureConfigDir(): void {
  ensureSecretDir(CONFIG_DIR);
}

function readMultiConfig(): MultiPodConfig {
  // Read new format. A file that exists but does not parse THROWS
  // (`ConfigUnreadableError`): read as "no pods", the next write would have
  // persisted that and wiped every profile.
  {
    const parsed = readJsonStrict<Partial<MultiPodConfig>>(CONFIG_FILE);
    if (parsed) {
      if (parsed.pods) return { activePod: parsed.activePod ?? "", pods: parsed.pods, activeWorkspaceId: parsed.activeWorkspaceId, activeWorkspace: parsed.activeWorkspace, activeProjectId: parsed.activeProjectId, activeProject: parsed.activeProject, surfaces: parsed.surfaces, agentKeys: parsed.agentKeys, agentKeysByPod: parsed.agentKeysByPod, pendingAgentKeys: parsed.pendingAgentKeys, agentWorkspaceRouting: parsed.agentWorkspaceRouting };
      // File exists but has old/unrecognized shape — fall through to migration
    }
  }

  // Migrate from legacy flat format
  try {
    if (fs.existsSync(LEGACY_CONFIG_FILE)) {
      const legacy = JSON.parse(fs.readFileSync(LEGACY_CONFIG_FILE, "utf-8")) as LocalPodConfig;
      if (legacy.podUrl) {
        const migrated: MultiPodConfig = { activePod: "default", pods: { default: legacy } };
        writeMultiConfig(migrated);
        return migrated;
      }
    }
  } catch { /* fall through */ }

  return { activePod: "", pods: {} };
}

function writeMultiConfig(config: MultiPodConfig): void {
  ensureConfigDir();
  // Merge with existing file so fields managed by other modules (e.g. `agents`)
  // are preserved when pod.ts only updates its own subset.
  // An unreadable file throws here — never "start fresh" over someone's profiles.
  const existing = readJsonStrict(CONFIG_FILE) ?? {};
  // temp + fsync + rename: a crash mid-write never leaves a truncated config.
  writeFileAtomic(CONFIG_FILE, JSON.stringify({ ...existing, ...config }, null, 2), { mode: 0o600 });
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * The ONE "pod profile not found" message.
 *
 * Names the profile that missed, the pods that DO exist, and the command that
 * adds one. Every site that fails to resolve a profile name renders through
 * this — a bare `not found` leaves the user with no next move, and the known-pods
 * list is usually the whole answer (a typo).
 */
export function podNotFoundMessage(name: string): string {
  const known = Object.keys(readMultiConfig().pods).join(", ") || "(none configured)";
  return `Pod profile '${name}' not found. Known pods: ${known}. Add one with: synap pods add`;
}

/** Throwing form of {@link podNotFoundMessage}. */
export function podNotFoundError(name: string): Error {
  return new Error(podNotFoundMessage(name));
}

/** Get the pod config for a specific surface, falling back to the global activePod. */
export function getSurfacePod(surface: SurfaceName): LocalPodConfig | null {
  const config = readMultiConfig();
  const podName = config.surfaces?.[surface] ?? config.activePod;
  if (!podName || !config.pods[podName]) return null;
  return config.pods[podName];
}

/** Get the name of the pod assigned to a surface (or the global active pod name). */
export function getSurfacePodName(surface: SurfaceName): string | null {
  const config = readMultiConfig();
  return config.surfaces?.[surface] ?? config.activePod ?? null;
}

/** Assign a pod to a specific surface without changing the global activePod. */
export function setSurfacePod(surface: SurfaceName, podName: string): LocalPodConfig {
  const config = readMultiConfig();
  if (!config.pods[podName]) throw podNotFoundError(podName);
  config.surfaces = config.surfaces ?? {};
  config.surfaces[surface] = podName;
  writeMultiConfig(config);
  return config.pods[podName];
}

export function getActivePodConfig(surface?: SurfaceName): LocalPodConfig | null {
  if (surface) return getSurfacePod(surface);
  const config = readMultiConfig();
  if (!config.activePod || !config.pods[config.activePod]) return null;
  return config.pods[config.activePod];
}

/** @deprecated Use getActivePodConfig() */
export function getLocalPodConfig(): LocalPodConfig | null {
  return getActivePodConfig();
}

export function listPodProfiles(): Array<{ name: string; config: LocalPodConfig; active: boolean }> {
  const config = readMultiConfig();
  return Object.entries(config.pods).map(([name, podConfig]) => ({
    name,
    config: podConfig,
    active: name === config.activePod,
  }));
}

// ─── Per-invocation pod override (the global `--pod <name>` flag) ──────────────
// Lets a SINGLE command target another saved pod without mutating any config
// file or affecting other agents/shells. Highest precedence in resolveHubConfig,
// so it beats even the env vars that pin an agent session to its default pod.
let _podOverride: LocalPodConfig | null = null;

export function getPodOverride(): LocalPodConfig | null {
  return _podOverride;
}

/** Resolve a saved pod profile by name and set it as this invocation's override. */
export function setPodOverrideByName(name: string): LocalPodConfig {
  const config = readMultiConfig();
  const pod = config.pods[name];
  if (!pod) throw podNotFoundError(name);
  _podOverride = pod;
  return pod;
}

/** Top-level commands that declare their OWN `--pod <name>` — their native handling must win. */
// bridge-setup owns a command-local --pod with custom prompt UX — leave it alone.
// agents used to be here too, but commander root also registers --pod and the
// flag never reached `agents create` (opts.pod stayed undefined), so create
// fell through to env agent keys → SURFACE_AGENT_TYPE_REQUIRED. Agents now
// rely on this bootstrap override like every other command.
const NATIVE_POD_FLAG_COMMANDS = new Set(["bridge-setup"]);

/**
 * Consume a position-independent `--pod <name>` (or `--pod=<name>`) from argv and
 * register it as the per-invocation override. Mutates `argv` in place so commander
 * never sees the flag (it isn't registered per-command). No-op when the argv
 * targets a command that owns `--pod` itself (bridge-setup). Throws with a
 * helpful message when the named profile is unknown.
 */
export function bootstrapPodOverride(argv: string[]): void {
  for (const c of NATIVE_POD_FLAG_COMMANDS) {
    if (argv.includes(c)) return;
  }
  let name: string | undefined;
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--") break; // end-of-options marker
    if (a === "--pod") {
      name = argv[i + 1];
      if (name) argv.splice(i, 2);
      break;
    }
    if (a.startsWith("--pod=")) {
      name = a.slice("--pod=".length);
      argv.splice(i, 1);
      break;
    }
  }
  if (name) setPodOverrideByName(name);
}

export function addPodProfile(name: string, podConfig: LocalPodConfig): void {
  const config = readMultiConfig();
  config.pods[name] = podConfig;
  if (!config.activePod) config.activePod = name;
  writeMultiConfig(config);
}

export function setActivePod(name: string): LocalPodConfig {
  const config = readMultiConfig();
  if (!config.pods[name]) throw podNotFoundError(name);
  config.activePod = name;
  writeMultiConfig(config);
  return config.pods[name];
}

/** The active pod's profile NAME (not its config), or undefined if none is set. */
export function getActivePodName(): string | undefined {
  const config = readMultiConfig();
  return config.activePod && config.pods[config.activePod] ? config.activePod : undefined;
}

/** Find a saved pod profile NAME by its URL (trailing slashes ignored). */
export function findPodNameByUrl(url: string): string | undefined {
  if (!url) return undefined;
  const norm = (u: string) => u.replace(/\/+$/, "");
  const target = norm(url);
  const config = readMultiConfig();
  for (const [name, p] of Object.entries(config.pods)) {
    if (norm(p.podUrl) === target) return name;
  }
  return undefined;
}

/**
 * Resolve the workspace to use for a specific pod — PURE (no disk, no network),
 * so the cross-pod rule is unit-testable.
 *
 * A workspace lives on exactly one pod, but `activeWorkspaceId` is a single
 * pod-agnostic global. Sending it to the wrong pod is the "Access denied to
 * workspace" 403. The rule: only honor the global override for the pod it
 * actually belongs to; otherwise fall back to THAT pod's own default workspace.
 *
 *   1. No override set → the target pod's own default.
 *   2. Override has a pod binding → honor it only for its bound pod; for any
 *      other pod, use that pod's default.
 *   3. Legacy override (no binding) that equals ANOTHER saved pod's default →
 *      it clearly belongs to that pod → use the target's default.
 *   4. Otherwise no evidence it's foreign → assume it's the target pod's (the
 *      legacy `synap use <custom-ws-on-this-pod>` case) → honor it.
 */
export function resolveWorkspaceForPod(
  config: MultiPodConfig,
  podName: string | undefined
): string | undefined {
  const targetPod = podName ? config.pods[podName] : undefined;
  const override = config.activeWorkspaceId;
  const binding = config.activeWorkspace;

  // Prefer a binding that matches the target pod even when activeWorkspaceId
  // drifted to a foreign UUID (common after dual-pod work).
  if (binding && binding.podName === podName) {
    return binding.workspaceId;
  }
  if (binding && binding.podName !== podName) {
    // Binding is for another pod — never use its workspace; only the target
    // profile default if it doesn't look stolen from another profile.
    return safePodDefaultWorkspace(config, podName, targetPod?.workspaceId);
  }

  if (!override) {
    return safePodDefaultWorkspace(config, podName, targetPod?.workspaceId);
  }

  const belongsToAnotherPod = Object.entries(config.pods).some(
    ([name, p]) => name !== podName && p.workspaceId === override
  );
  if (belongsToAnotherPod) {
    return safePodDefaultWorkspace(config, podName, targetPod?.workspaceId);
  }

  return override;
}

/**
 * Profile `workspaceId` can drift to a UUID that belongs on another pod
 * (dual-pod dogfood). Never return a default that is another profile's
 * configured workspaceId. If the default is still suspect and differs from
 * every other profile default, we cannot prove it's foreign without the
 * server — return it only when unique among profile defaults.
 */
function safePodDefaultWorkspace(
  config: MultiPodConfig,
  podName: string | undefined,
  defaultWs: string | undefined
): string | undefined {
  if (!defaultWs || !podName) return defaultWs || undefined;
  const stolenAsOtherDefault = Object.entries(config.pods).some(
    ([name, p]) => name !== podName && p.workspaceId === defaultWs
  );
  if (stolenAsOtherDefault) return undefined;
  return defaultWs;
}

/**
 * Get the active workspace ID for a pod (by profile NAME). Applies the cross-pod
 * rule in {@link resolveWorkspaceForPod}. Omit `podName` for the active pod.
 */
export function getActiveWorkspaceIdForPod(podName?: string): string | undefined {
  const config = readMultiConfig();
  return resolveWorkspaceForPod(config, podName ?? (config.activePod || undefined));
}

/**
 * Get the active workspace ID for the ACTIVE pod: explicit override first (only
 * if it belongs to this pod), then the pod default. Cross-pod-safe: a global
 * override left over from another pod is ignored rather than sent (avoids the
 * "Access denied to workspace" 403).
 */
export function getActiveWorkspaceId(): string | undefined {
  return getActiveWorkspaceIdForPod();
}

/**
 * Persist a workspace as the active context for all subsequent commands.
 * Records the pod the workspace belongs to (defaults to the active pod) so
 * later cross-pod resolution can tell whether the override applies.
 */
export function setActiveWorkspaceId(workspaceId: string, podName?: string): void {
  const config = readMultiConfig();
  config.activeWorkspaceId = workspaceId;
  const boundPod = podName ?? config.activePod;
  if (boundPod && config.pods[boundPod]) {
    config.activeWorkspace = { workspaceId, podName: boundPod };
  } else {
    delete config.activeWorkspace;
  }
  writeMultiConfig(config);
}

/** Get the active project ID: durable override set by `synap project use`. */
export function getActiveProjectId(): string | undefined {
  const config = readMultiConfig();
  return config.activeProjectId || undefined;
}

/**
 * Persist a project as the active context for all subsequent commands.
 * Records the pod it was set against (defaults to the active pod) so
 * {@link resolveHubConfig} can refuse to send it to a foreign pod.
 * Peer of {@link setActiveWorkspaceId}.
 */
export function setActiveProjectId(projectId: string, podName?: string): void {
  const config = readMultiConfig();
  config.activeProjectId = projectId;
  const boundPod = podName ?? config.activePod;
  if (boundPod && config.pods[boundPod]) {
    config.activeProject = { projectId, podName: boundPod };
  } else {
    delete config.activeProject;
  }
  writeMultiConfig(config);
}

/**
 * Pin project AND the pod it lives on together — the cross-pod `project use`
 * door. Stores the binding so later drift (active pod switched away from the
 * pinned project's pod) can warn.
 */
export function setActiveProjectBinding(binding: ActiveProjectBinding): void {
  const config = readMultiConfig();
  config.activeProjectId = binding.projectId;
  config.activeProject = binding;
  writeMultiConfig(config);
}

/** The pod-aware active-project binding, when set by cross-pod `project use`. */
export function getActiveProjectBinding(): ActiveProjectBinding | undefined {
  return readMultiConfig().activeProject;
}

/** Remove the active project override — subsequent commands see all projects. */
export function clearActiveProjectId(): void {
  const config = readMultiConfig();
  delete config.activeProjectId;
  delete config.activeProject;
  writeMultiConfig(config);
}

// ─── Surface agent keys ───────────────────────────────────────────────────────

/** Normalize a pod URL for map keys (strip trailing slashes). */
function normalizePodUrl(url: string): string {
  return url.replace(/\/+$/, "");
}

/**
 * Store a dedicated agent key for a specific surface (e.g. "raycast", "claude-code").
 * Always writes `agentKeys[surface]` (last-write, backward compat). When `key.podUrl`
 * is set, also stores under `agentKeysByPod[surface][normalizedPodUrl]` so multi-pod
 * surfaces can look up the key for the pod they are actually talking to.
 */
export function setSurfaceAgentKey(surface: SurfaceName, key: SurfaceAgentKey): void {
  const config = readMultiConfig();
  config.agentKeys = config.agentKeys ?? {};
  config.agentKeys[surface] = key; // last write for backward compat
  if (key.podUrl) {
    config.agentKeysByPod = config.agentKeysByPod ?? {};
    const bySurface = config.agentKeysByPod[surface] ?? {};
    bySurface[normalizePodUrl(key.podUrl)] = key;
    config.agentKeysByPod[surface] = bySurface;
  }
  writeMultiConfig(config);
}

/**
 * Read back the stored agent key for a surface.
 * When `podUrl` is provided, prefer `agentKeysByPod` for that pod; if only a legacy
 * `agentKeys[surface]` entry exists, return it only when its podUrl matches (or is
 * unset). Never return a key known to belong to a different pod.
 */
export function getSurfaceAgentKey(surface: SurfaceName, podUrl?: string): SurfaceAgentKey | null {
  const config = readMultiConfig();
  if (podUrl && config.agentKeysByPod?.[surface]) {
    const hit = config.agentKeysByPod[surface][normalizePodUrl(podUrl)];
    if (hit) return hit;
  }
  const legacy = config.agentKeys?.[surface] ?? null;
  if (podUrl && legacy?.podUrl && normalizePodUrl(legacy.podUrl) !== normalizePodUrl(podUrl)) {
    return null; // do not return wrong-pod key
  }
  return legacy;
}

/** A minted agent key waiting for its owner's approval (see `pendingAgentKeys`). */
export interface PendingAgentKey {
  hubApiKey: string;
  agentUserId: string;
  podUrl: string;
  /** The key's id on the pod (the approval page names it). */
  keyId: string;
  approvalUrl: string;
  /** This computer's instance label the key was minted with. */
  instanceId?: string;
  createdAt: string;
}

export function getPendingAgentKey(surface: string, podUrl: string): PendingAgentKey | null {
  return readMultiConfig().pendingAgentKeys?.[surface]?.[normalizePodUrl(podUrl)] ?? null;
}

export function setPendingAgentKey(surface: string, key: PendingAgentKey): void {
  const config = readMultiConfig();
  config.pendingAgentKeys = config.pendingAgentKeys ?? {};
  const bySurface = config.pendingAgentKeys[surface] ?? {};
  bySurface[normalizePodUrl(key.podUrl)] = key;
  config.pendingAgentKeys[surface] = bySurface;
  writeMultiConfig(config);
}

export function clearPendingAgentKey(surface: string, podUrl: string): void {
  const config = readMultiConfig();
  const bySurface = config.pendingAgentKeys?.[surface];
  if (!bySurface || !(normalizePodUrl(podUrl) in bySurface)) return;
  delete bySurface[normalizePodUrl(podUrl)];
  if (Object.keys(bySurface).length === 0) delete config.pendingAgentKeys![surface];
  // writeMultiConfig MERGES over the file, so an emptied map must be written
  // as an empty object, never dropped (a dropped key would keep the old value).
  config.pendingAgentKeys = config.pendingAgentKeys ?? {};
  writeMultiConfig(config);
}

export function setAgentWorkspaceRouting(routing: AgentWorkspaceRouting): void {
  const config = readMultiConfig();
  config.agentWorkspaceRouting = routing;
  writeMultiConfig(config);
}

export function getAgentWorkspaceRouting(): AgentWorkspaceRouting | undefined {
  return readMultiConfig().agentWorkspaceRouting;
}

/** Remove the active workspace override — subsequent commands see all workspaces. */
export function clearActiveWorkspaceId(): void {
  const config = readMultiConfig();
  delete config.activeWorkspaceId;
  delete config.activeWorkspace;
  writeMultiConfig(config);
}

export function removePodProfile(name: string): void {
  const config = readMultiConfig();
  if (!config.pods[name]) throw podNotFoundError(name);
  delete config.pods[name];
  if (config.activePod === name) {
    const remaining = Object.keys(config.pods);
    config.activePod = remaining[0] ?? "";
  }
  writeMultiConfig(config);
}

export interface PodStatus {
  url: string;
  healthy: boolean;
  version?: string;
  entityCount?: number;
  workspaceId?: string;
  /**
   * The address redirects to ANOTHER host — the pod has most likely moved
   * (pod-moved.ts). Never followed; `synap doctor` asks the Control Plane.
   */
  moved?: boolean;
  /** Why the probe failed, when it did (network / proxy / pod). Absent when healthy or moved. */
  failure?: ReachFailure;
}

/**
 * Check if a Synap pod is healthy.
 */
export async function checkPodHealth(podUrl: string): Promise<PodStatus> {
  const status: PodStatus = { url: podUrl, healthy: false };

  try {
    const res = await podFetch(`${podUrl}/health`, {
      signal: AbortSignal.timeout(5000),
    });
    if (res.ok) {
      status.healthy = true;
      const data = (await res.json()) as Record<string, unknown>;
      status.version = data.version as string | undefined;
    } else {
      status.failure = classifyHttpStatus(res.status, podUrl);
    }
  } catch (err) {
    // pod unreachable — or it answered with a redirect to another host
    if (err instanceof PodMovedError) status.moved = true;
    else status.failure = classifyFetchError(err, podUrl);
  }

  return status;
}

/**
 * Install Docker and start a self-hosted Synap pod.
 */
export function startSelfHostedPod(): void {
  execSync(
    'curl -fsSL https://raw.githubusercontent.com/Synap-core/backend/main/install.sh | bash',
    { stdio: "inherit" }
  );
}
