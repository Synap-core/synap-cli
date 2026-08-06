/**
 * Synap pod connection and management utilities.
 */

import { execSync } from "child_process";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const CP_URL = process.env.SYNAP_CP_URL ?? "https://api.synap.live";

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
}

/** SSOT for every connect/surface agent identity. The type is derived from this
 *  array so the two can't drift. */
export const SURFACE_NAMES = [
  "raycast",
  "claude-code",
  "claude-desktop",
  "cursor",
  "codex",
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
 * MCP mappings; openclaw/cli/memory). Single source of truth for the collision guard.
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
  /** Workspace routing set by `synap connect` wizard — drives capture/recall defaults. */
  agentWorkspaceRouting?: AgentWorkspaceRouting;
}

function ensureConfigDir(): void {
  if (!fs.existsSync(CONFIG_DIR)) {
    fs.mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 });
  }
}

function readMultiConfig(): MultiPodConfig {
  // Read new format
  try {
    if (fs.existsSync(CONFIG_FILE)) {
      const parsed = JSON.parse(fs.readFileSync(CONFIG_FILE, "utf-8")) as Partial<MultiPodConfig>;
      if (parsed.pods) return { activePod: parsed.activePod ?? "", pods: parsed.pods, activeWorkspaceId: parsed.activeWorkspaceId, activeWorkspace: parsed.activeWorkspace, activeProjectId: parsed.activeProjectId, activeProject: parsed.activeProject, surfaces: parsed.surfaces, agentKeys: parsed.agentKeys, agentKeysByPod: parsed.agentKeysByPod, agentWorkspaceRouting: parsed.agentWorkspaceRouting };
      // File exists but has old/unrecognized shape — fall through to migration
    }
  } catch { /* fall through */ }

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
  let existing: Record<string, unknown> = {};
  try {
    if (fs.existsSync(CONFIG_FILE)) {
      existing = JSON.parse(fs.readFileSync(CONFIG_FILE, "utf-8")) as Record<string, unknown>;
    }
  } catch { /* start fresh */ }
  fs.writeFileSync(CONFIG_FILE, JSON.stringify({ ...existing, ...config }, null, 2), { mode: 0o600 });
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

/** @deprecated Use addPodProfile("default", config) */
export function saveLocalPodConfig(podConfig: LocalPodConfig): void {
  const config = readMultiConfig();
  const name = config.activePod || "default";
  config.pods[name] = podConfig;
  if (!config.activePod) config.activePod = name;
  writeMultiConfig(config);
}

export interface PodStatus {
  url: string;
  healthy: boolean;
  version?: string;
  entityCount?: number;
  workspaceId?: string;
}

/**
 * Check if a Synap pod is healthy.
 */
export async function checkPodHealth(podUrl: string): Promise<PodStatus> {
  const status: PodStatus = { url: podUrl, healthy: false };

  try {
    const res = await fetch(`${podUrl}/health`, {
      signal: AbortSignal.timeout(5000),
    });
    if (res.ok) {
      status.healthy = true;
      const data = (await res.json()) as Record<string, unknown>;
      status.version = data.version as string | undefined;
    }
  } catch {
    // pod unreachable
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

/**
 * Install the synap skill into OpenClaw.
 */
/**
 * Open a Pod session for the CP-authenticated user.
 * Calls the issuer for a short-lived generic assertion, then exchanges that
 * assertion directly with the Pod. The issuer never receives a Pod session.
 *
 * Returns the Kratos session token the Pod mints after its own membership check.
 * That token authenticates subsequent pod tRPC calls (e.g.
 * `apiKeys.connectIntegration`) as the pod user, via the X-Session-Token header.
 * `sessionToken` is null only if the pod handshake returned no token (e.g. 409).
 */
export async function provisionUserOnPod(
  podUrl: string,
  cpToken: string
): Promise<{ sessionToken: string | null }> {
  // Step 1: get an issuer assertion for this Pod.
  const assertionRes = await fetch(`${CP_URL}/pods/federation/assertion`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${cpToken}`,
    },
    body: JSON.stringify({ podUrl }),
    signal: AbortSignal.timeout(10000),
  });

  if (!assertionRes.ok) {
    const body = await assertionRes.text().catch(() => "");
    throw new Error(
      `Could not get Pod issuer assertion (HTTP ${assertionRes.status}): ${body.slice(0, 200)}`,
    );
  }

  const { assertion } = (await assertionRes.json()) as { assertion?: string };
  if (!assertion) {
    throw new Error("Control Plane did not return a Pod issuer assertion");
  }

  // Step 2: exchange only with the Pod. It derives the issuer from `iss` and
  // verifies its own trusted-issuer registry and local membership.
  const exchangeRes = await fetch(`${podUrl}/api/federation/exchange`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ assertion }),
    signal: AbortSignal.timeout(15000),
  });

  if (!exchangeRes.ok) {
    const body = await exchangeRes.text().catch(() => "");
    throw new Error(
      `Pod issuer assertion exchange failed (HTTP ${exchangeRes.status}): ${body.slice(0, 200)}`,
    );
  }

  // The pod returns the Kratos session token in the handshake body (the same
  // value the browser receives as the ory_kratos_session cookie).
  let sessionToken: string | null = null;
  try {
    const data = (await exchangeRes.json()) as { session_token?: string };
    sessionToken = data.session_token ?? null;
  } catch {
    // 409 or an empty body — no token to capture.
  }
  return { sessionToken };
}

/**
 * Issue a scoped Hub Protocol API key on the pod for an authenticated user.
 *
 * Canonical path: the pod's `apiKeys.connectIntegration` tRPC procedure — the
 * same one the pod-admin `/connect` page and the browser's LocalCliRow use.
 * Auth is the Kratos session token minted by {@link provisionUserOnPod},
 * forwarded as the `X-Session-Token` header. (Replaces the removed CP relay
 * `POST /pods/setup-agent`, which now returns 410.)
 *
 * Backend tRPC uses the superjson transformer, so the input rides in a
 * `{ json: ... }` envelope and the output is unwrapped from `result.data.json`.
 */
export async function setupAgentViaPod(
  podUrl: string,
  sessionToken: string,
  integration: "cli" | "openclaw" | "raycast" | "custom" = "openclaw"
): Promise<{
  hubApiKey: string;
  agentUserId: string;
  workspaceId: string;
}> {
  const res = await fetch(`${podUrl}/trpc/apiKeys.connectIntegration`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Session-Token": sessionToken,
    },
    // strategy: "replace_existing" makes re-running `synap init` idempotent —
    // it revokes any prior key for this integration and mints a fresh one.
    body: JSON.stringify({
      json: { integration, strategy: "replace_existing" },
    }),
    signal: AbortSignal.timeout(15000),
  });

  const body = (await res.json().catch(() => null)) as {
    result?: { data?: { json?: { apiKey?: string; workspaceId?: string | null } } };
    error?: { message?: string };
  } | null;

  if (!res.ok || !body || body.error) {
    const msg = body?.error?.message ?? `HTTP ${res.status}`;
    throw new Error(`Pod key issuance failed: ${msg}`);
  }

  const data = body.result?.data?.json;
  if (!data?.apiKey) {
    throw new Error("Pod returned no API key from connectIntegration");
  }

  return {
    hubApiKey: data.apiKey,
    // The connectIntegration key is owned by the human pod user directly — there
    // is no separate agent user in this model (same as the browser flow). Left
    // empty; the hub client resolves the acting user via /users/me at runtime.
    agentUserId: "",
    workspaceId: data.workspaceId ?? "",
  };
}

/**
 * Enable OpenClaw as a free addon on a SELF-HOSTED pod.
 * Uses the PROVISIONING_TOKEN directly against the pod.
 *
 * Routes through the shared `provisionAgentKey()` wrapper (dynamic import to
 * avoid a circular pod.ts <-> targets.ts static import). `workspaceId` is no
 * longer part of the response — agents are pod-wide singletons now; scope is
 * granted separately via `enrollAgentIfNeeded()`, not returned from setup.
 */
export async function enableOpenClawAddon(
  podUrl: string,
  provisioningToken: string
): Promise<{ hubApiKey: string; agentUserId: string; workspaceId: string }> {
  const { provisionAgentKey } = await import("./targets.js");
  const { hubApiKey, agentUserId } = await provisionAgentKey(podUrl, provisioningToken, "openclaw");
  return { hubApiKey, agentUserId, workspaceId: "" };
}

/**
 * Enable OpenClaw as an addon on a MANAGED pod via the Control Plane.
 * Calls POST /openclaw/provision on the CP (requires CP session token).
 * Returns the podId so the caller can poll status if needed.
 */
export async function enableOpenClawAddonManaged(
  cpToken: string,
  podUrl: string
): Promise<{ podId: string }> {
  // Find the pod ID from the CP
  const podsRes = await fetch(`${CP_URL}/pods`, {
    headers: { Authorization: `Bearer ${cpToken}` },
    signal: AbortSignal.timeout(10000),
  });
  if (!podsRes.ok) throw new Error(`Could not fetch pods (HTTP ${podsRes.status})`);

  const { pods } = (await podsRes.json()) as { pods: Array<{ id: string; subdomain: string; customDomain: string | null }> };
  const appDomain = "synap.live";
  const pod = pods.find((p) => {
    const url = p.customDomain ? `https://${p.customDomain}` : `https://${p.subdomain}.${appDomain}`;
    return url === podUrl || podUrl.includes(p.subdomain);
  });

  // Not a local profile miss — this is a lookup against the pods the Control
  // Plane says you own, so podNotFoundError's "synap pods add" is the wrong fix.
  if (!pod) {
    const owned = pods.map((p) => p.customDomain ?? `${p.subdomain}.${appDomain}`).join(", ") || "(none)";
    throw new Error(
      `No pod matching ${podUrl} on your account. Pods on this account: ${owned}.`
    );
  }

  const provRes = await fetch(`${CP_URL}/openclaw/provision`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${cpToken}`,
    },
    body: JSON.stringify({ podId: pod.id }),
    signal: AbortSignal.timeout(15000),
  });

  if (!provRes.ok) {
    const body = await provRes.text().catch(() => "");
    throw new Error(`OpenClaw provision failed (HTTP ${provRes.status}): ${body.slice(0, 200)}`);
  }

  return { podId: pod.id };
}

/**
 * Check server resources (RAM, disk).
 */
export function checkServerResources(): {
  ramTotal: number;
  ramFree: number;
  diskFree: string;
} {
  let ramTotal = 0;
  let ramFree = 0;
  let diskFree = "unknown";

  try {
    const mem = execSync("free -m 2>/dev/null || sysctl -n hw.memsize 2>/dev/null", {
      encoding: "utf-8",
      timeout: 3000,
    });
    const lines = mem.trim().split("\n");
    if (lines.length > 1) {
      const parts = lines[1].split(/\s+/);
      ramTotal = parseInt(parts[1], 10) || 0;
      ramFree = parseInt(parts[6] || parts[3], 10) || 0;
    } else {
      const bytes = parseInt(lines[0], 10);
      if (bytes > 0) {
        ramTotal = Math.round(bytes / 1024 / 1024);
        ramFree = Math.round(ramTotal * 0.5);
      }
    }
  } catch { /* can't detect */ }

  try {
    const df = execSync("df -h / 2>/dev/null | tail -1", {
      encoding: "utf-8",
      timeout: 3000,
    });
    diskFree = df.trim().split(/\s+/)[3] || "unknown";
  } catch { /* can't detect */ }

  return { ramTotal, ramFree, diskFree };
}

/**
 * Start OpenClaw as a Docker addon on the local server.
 * Writes env vars to the pod's .env file and runs docker compose --profile openclaw.
 * Only works when the CLI is running ON the pod server.
 */
/**
 * Find the Synap deploy directory — where the .env and docker-compose files live.
 *
 * Strategy (most reliable first):
 *   1. Docker label — inspect any running synap container for
 *      com.docker.compose.project.working_dir (always accurate, zero guessing)
 *   2. Walk up from cwd — works when running from inside the repo
 *   3. Common install paths as a last resort
 */
export function findSynapDeployDir(): string | null {
  // ── 1. Ask Docker itself ───────────────────────────────────────────────
  try {
    // Find any container that belongs to a synap compose project
    const psOut = execSync(
      "docker ps --format '{{.Names}}' 2>/dev/null",
      { encoding: "utf-8", timeout: 4000 }
    );
    const synapContainer = psOut
      .split("\n")
      .map((l) => l.trim())
      .find((n) => /synap|openclaw/i.test(n));

    if (synapContainer) {
      const workDir = execSync(
        `docker inspect --format '{{index .Config.Labels "com.docker.compose.project.working_dir"}}' ${synapContainer} 2>/dev/null`,
        { encoding: "utf-8", timeout: 4000 }
      ).trim();

      if (workDir && workDir !== "<no value>" && fs.existsSync(workDir)) {
        // compose project.working_dir is the folder containing docker-compose.yml
        // but the .env may be in a "deploy" subdirectory
        if (hasSynapCompose(workDir)) return workDir;
        const deploySub = path.join(workDir, "deploy");
        if (hasSynapCompose(deploySub)) return deploySub;
        return workDir; // trust Docker even if compose check fails
      }
    }
  } catch {
    // Docker not available or no containers — fall through
  }

  // ── 2. Walk up from cwd ────────────────────────────────────────────────
  let dir = process.cwd();
  for (let i = 0; i < 6; i++) {
    if (hasSynapCompose(dir)) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }

  // ── 3. Common install paths ────────────────────────────────────────────
  const home = os.homedir();
  const fallbacks = [
    "/srv/synap",
    "/opt/synap",
    path.join(home, "synap-backend", "deploy"),
    path.join(home, "synap-backend"),
    path.join(home, "synap"),
  ];
  for (const d of fallbacks) {
    if (hasSynapCompose(d)) return d;
  }

  return null;
}

function hasSynapCompose(dir: string): boolean {
  try {
    for (const name of ["docker-compose.standalone.yml", "docker-compose.yml"]) {
      const f = path.join(dir, name);
      if (fs.existsSync(f)) {
        const content = fs.readFileSync(f, "utf-8");
        if (/ghcr\.io\/synap-core\/backend|synap-backend/i.test(content)) return true;
      }
    }
  } catch {
    // unreadable
  }
  return false;
}

/**
 * Write OpenClaw env vars into the deploy dir .env and start the container.
 * Does NOT wait for health — OpenClaw can take several minutes to initialize
 * (first run pulls ~1GB image + runs setup). Caller should tell user to run
 * `synap finish` once it's up.
 *
 * Returns the deploy dir used.
 */
export function startOpenClawOnServer(
  hubApiKey: string,
  agentUserId: string,
  workspaceId: string,
  podUrl: string,
  projectId?: string
): string {
  const deployDir = findSynapDeployDir();

  if (!deployDir) {
    throw new Error(
      "Could not find your Synap deploy directory.\n" +
        "Run from inside the synap-backend folder, or set SYNAP_DEPLOY_DIR env var."
    );
  }

  // ── Write env vars ───────────────────────────────────────────────────────
  const envFile = path.join(deployDir, ".env");
  const envVars: Record<string, string> = {
    OPENCLAW_HUB_API_KEY: hubApiKey,
    SYNAP_AGENT_USER_ID: agentUserId,
    SYNAP_WORKSPACE_ID: workspaceId,
    SYNAP_POD_URL: podUrl,
  };
  // Project is a peer lens to workspace — only injected when one is resolved.
  if (projectId) envVars.SYNAP_PROJECT_ID = projectId;

  let envContent = "";
  try {
    envContent = fs.existsSync(envFile) ? fs.readFileSync(envFile, "utf-8") : "";
  } catch { /* start fresh */ }

  for (const [key, value] of Object.entries(envVars)) {
    const regex = new RegExp(`^${key}=.*`, "m");
    const line = `${key}=${value}`;
    envContent = regex.test(envContent)
      ? envContent.replace(regex, line)
      : (envContent.endsWith("\n") || envContent === ""
          ? envContent + line + "\n"
          : envContent + "\n" + line + "\n");
  }
  fs.writeFileSync(envFile, envContent, { mode: 0o600 });

  // ── Start container ──────────────────────────────────────────────────────
  const composeFile = fs.existsSync(path.join(deployDir, "docker-compose.standalone.yml"))
    ? "docker-compose.standalone.yml"
    : "docker-compose.yml";

  // pipe stderr to /dev/null to suppress WARN lines about unset env vars
  // (those warnings are cosmetic — other services' vars not needed by openclaw)
  execSync(
    `docker compose -f ${composeFile} --profile openclaw up -d openclaw 2>/dev/null`,
    { stdio: ["ignore", "inherit", "ignore"], cwd: deployDir, timeout: 300_000 }
  );

  return deployDir;
}

/**
 * Install the synap skill into OpenClaw.
 */
const SKILL_SLUG = "synap";

/**
 * Install the synap skill into OpenClaw.
 * Automatically chooses the right execution path:
 *   - Local install: runs `openclaw skills install synap` directly
 *   - Docker container: runs `docker exec <container> openclaw skills install synap`
 */
export function installSynapSkill(containerName?: string): void {
  const cmd = containerName
    ? `docker exec ${containerName} openclaw skills install ${SKILL_SLUG}`
    : `openclaw skills install ${SKILL_SLUG}`;

  try {
    execSync(cmd, { stdio: "inherit", timeout: 60000 });
  } catch {
    if (containerName) {
      throw new Error(
        `Could not install skill via docker exec.\n` +
          `Run manually: docker exec ${containerName} openclaw skills install ${SKILL_SLUG}`
      );
    } else {
      throw new Error(
        `openclaw not found in PATH.\n` +
          `Run manually: openclaw skills install ${SKILL_SLUG}\n` +
          `Or if OpenClaw is in Docker: docker exec openclaw openclaw skills install ${SKILL_SLUG}`
      );
    }
  }
}

/**
 * Check whether the synap skill is installed inside a Docker container.
 */
export function isSynapSkillInstalledInDocker(containerName: string): boolean {
  try {
    const out = execSync(
      `docker exec ${containerName} openclaw skills list 2>/dev/null`,
      { encoding: "utf-8", timeout: 10000 }
    );
    return /synap/i.test(out);
  } catch {
    return false;
  }
}
