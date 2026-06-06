import { getActivePodConfig, getActiveWorkspaceId, listPodProfiles } from "./pod.js";
import { resolveAgentOverride } from "./agents-config.js";
import { HubRestClient } from "@synap/hub-rest-client";

export interface HubConfig {
  podUrl: string;
  apiKey: string;
  userId: string;
  /** Active workspace — from `synap use`, pod default, or env var. Undefined if none configured. */
  workspaceId?: string;
  scopes?: string[];
}

const userIdCache = new Map<string, string>();

export async function resolveUserId(cfg: HubConfig): Promise<string> {
  if (cfg.userId && cfg.userId !== "cli") return cfg.userId;
  const cached = userIdCache.get(cfg.apiKey);
  if (cached) return cached;
  const me = await hubGet("/users/me", {}, cfg);
  const id = String((me as Record<string, unknown>).id ?? cfg.userId);
  userIdCache.set(cfg.apiKey, id);
  return id;
}

export function assertScope(cfg: HubConfig, required: string): void {
  // scopes are on the HubConfig only if we fetched them; skip check if unknown
  if (!cfg.scopes) return;
  if (!cfg.scopes.includes(required)) {
    throw new Error(
      `API key is missing required scope: ${required}\n` +
      `Re-run: synap connect --target=<surface>  to get a key with the right scopes.`
    );
  }
}

export async function resolveHubConfig(opts?: { podUrl?: string; apiKey?: string }): Promise<HubConfig> {
  // 1. Explicit flags (escape hatch)
  if (opts?.podUrl && opts?.apiKey) {
    return {
      podUrl: opts.podUrl,
      apiKey: opts.apiKey,
      userId: process.env.SYNAP_USER_ID ?? "cli",
    };
  }
  // 2. Agent override: SYNAP_AGENT env var selects a named identity
  const agentOverride = resolveAgentOverride();
  if (agentOverride) {
    const profiles = listPodProfiles();
    const podProfile = profiles.find(p => p.name === agentOverride.podName);
    const podUrl = podProfile?.config.podUrl ?? getActivePodConfig()?.podUrl ?? "";
    const envScopes = process.env.SYNAP_KEY_SCOPES;
    return {
      podUrl,
      apiKey: agentOverride.apiKey,
      userId: agentOverride.podName ?? "agent",
      scopes: envScopes ? envScopes.split(",") : undefined,
    };
  }
  // 3. Env vars — set by `synap connect --target=claude-code`
  const envPod = process.env.SYNAP_POD_URL;
  const envKey = process.env.SYNAP_HUB_API_KEY;
  const envUser = process.env.SYNAP_USER_ID;
  const envScopes = process.env.SYNAP_KEY_SCOPES;
  const envWorkspace = process.env.SYNAP_WORKSPACE_ID;
  if (envPod && envKey && envUser) {
    return {
      podUrl: envPod,
      apiKey: envKey,
      userId: envUser,
      workspaceId: envWorkspace || getActiveWorkspaceId(),
      scopes: envScopes ? envScopes.split(",") : undefined,
    };
  }
  // 4. Active CLI pod profile
  const config = getActivePodConfig();
  if (!config) throw new Error("No pod configured. Run: synap pods add");
  return {
    podUrl: config.podUrl,
    apiKey: config.hubApiKey,
    userId: config.agentUserId,
    workspaceId: getActiveWorkspaceId(),
  };
}

export async function hubGet(
  path: string,
  params: Record<string, string | number | undefined>,
  cfg: HubConfig
): Promise<unknown> {
  const url = new URL(`${cfg.podUrl}/api/hub${path}`);
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined) url.searchParams.set(k, String(v));
  }
  const res = await fetch(url.toString(), {
    headers: { Authorization: `Bearer ${cfg.apiKey}` },
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Hub API error (HTTP ${res.status}): ${body.slice(0, 300)}`);
  }
  return res.json();
}

export async function hubPost(path: string, body: unknown, cfg: HubConfig): Promise<unknown> {
  const res = await fetch(`${cfg.podUrl}/api/hub${path}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${cfg.apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) {
    const bodyText = await res.text().catch(() => "");
    throw new Error(`Hub API error (HTTP ${res.status}): ${bodyText.slice(0, 300)}`);
  }
  return res.json();
}

export async function hubPatch(path: string, body: unknown, cfg: HubConfig): Promise<unknown> {
  const res = await fetch(`${cfg.podUrl}/api/hub${path}`, {
    method: "PATCH",
    headers: { Authorization: `Bearer ${cfg.apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) {
    const bodyText = await res.text().catch(() => "");
    throw new Error(`Hub API error (HTTP ${res.status}): ${bodyText.slice(0, 300)}`);
  }
  return res.json();
}

/**
 * Create a typed HubRestClient from a resolved HubConfig.
 * Use this in new code and shared surfaces (e.g. Raycast) to get full
 * Hub Protocol coverage with a shared client contract — eliminating drift.
 */
export function makeHubClient(cfg: HubConfig): HubRestClient {
  return new HubRestClient({
    podUrl: cfg.podUrl,
    apiKey: cfg.apiKey,
    workspaceId: cfg.workspaceId,
  });
}

export { HubRestClient } from "@synap/hub-rest-client";
