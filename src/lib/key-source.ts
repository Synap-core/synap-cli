/**
 * Which path supplied the winning API key — report-only mirror of
 * `resolveHubConfig`'s ladder (hub-client.ts). Does NOT resolve the key itself;
 * callers still go through `resolveHubConfig`. This module answers "why did we
 * get THIS key" so doctor/whoami can name the source without re-deriving
 * precedence (and without diverging from it).
 *
 * The claude-code surface-over-env preference also lives here so hub-client and
 * whoami cannot drift on that rule.
 */

import { getActivePodConfig, getPodOverride, getSurfaceAgentKey, listPodProfiles } from "./pod.js";
import { resolveAgentOverride } from "./agents-config.js";

/** Rungs of the key ladder, highest precedence first — matches resolveHubConfig steps. */
export type KeySource = "flag" | "agent" | "env-surface" | "env" | "profile";

export interface KeySourceInfo {
  source: KeySource;
  /** Concrete origin: env var name, agent name, profile name, "--pod", etc. */
  detail?: string;
}

/** Human wording for each key source — used verbatim in doctor/whoami. */
export const KEY_SOURCE_LABEL: Record<KeySource, string> = {
  flag: "explicit flag",
  agent: "agent override",
  "env-surface": "claude-code surface key",
  env: "environment variable",
  profile: "pod profile",
};

/** Ready-to-print origin, parallel to `LensFieldProvenance.origin`. */
export function formatKeySource(info: KeySourceInfo): string {
  return info.detail
    ? `${KEY_SOURCE_LABEL[info.source]}: ${info.detail}`
    : KEY_SOURCE_LABEL[info.source];
}

/**
 * Prefer the claude-code surface key when it is pinned to the same pod and
 * differs from the ambient env key. Pure — no stderr, no IO. Callers that need
 * the swap warning (hub-client) write it themselves when `usedSurface` is true.
 *
 * Mirrors hub-client resolveHubConfig step 3 surface guard exactly.
 */
export function preferClaudeCodeSurfaceKey(input: {
  envPod: string;
  envKey: string;
  envUser: string;
  surface: { podUrl?: string; hubApiKey: string; agentUserId?: string } | null | undefined;
}): { apiKey: string; userId: string; usedSurface: boolean } {
  const s = input.surface;
  // Trailing-slash-tolerant: surface keys and env pods are often saved with
  // slightly different URL shapes after multi-pod connect.
  const norm = (u: string) => u.replace(/\/+$/, "");
  if (
    s &&
    s.podUrl &&
    norm(s.podUrl) === norm(input.envPod) &&
    s.hubApiKey &&
    s.hubApiKey !== input.envKey
  ) {
    return {
      apiKey: s.hubApiKey,
      userId: s.agentUserId || input.envUser,
      usedSurface: true,
    };
  }
  return { apiKey: input.envKey, userId: input.envUser, usedSurface: false };
}

/**
 * Classify the winning key path given pre-read inputs. Pure and order-driven —
 * first match wins, same ladder as `resolveHubConfig` steps 0–4.
 */
export function classifyKeySource(input: {
  podOverride?: boolean;
  /** Explicit command flags supplied both podUrl and apiKey. */
  flagApiKey?: boolean;
  agentName?: string | null;
  envPod?: string;
  envKey?: string;
  envUser?: string;
  /** True when preferClaudeCodeSurfaceKey would swap in the surface key. */
  surfacePrefersOverEnv?: boolean;
  profileName?: string | null;
}): KeySourceInfo {
  if (input.podOverride) return { source: "flag", detail: "--pod" };
  if (input.flagApiKey) return { source: "flag" };
  if (input.agentName) return { source: "agent", detail: input.agentName };
  if (input.envPod && input.envKey && input.envUser) {
    if (input.surfacePrefersOverEnv) {
      return { source: "env-surface", detail: "claude-code" };
    }
    return { source: "env", detail: "SYNAP_HUB_API_KEY" };
  }
  return {
    source: "profile",
    detail: input.profileName ?? undefined,
  };
}

/**
 * Report which path would supply the API key for this invocation.
 * Reads the same doors as resolveHubConfig; never returns the secret.
 */
export function resolveKeySource(opts?: { podUrl?: string; apiKey?: string }): KeySourceInfo {
  const envPod = process.env.SYNAP_POD_URL;
  const envKey = process.env.SYNAP_HUB_API_KEY;
  const envUser = process.env.SYNAP_USER_ID;
  // Pod-qualified lookup so a surface key for another pod never shadows env.
  const surface = getSurfaceAgentKey("claude-code", envPod);
  const surfacePrefersOverEnv = Boolean(
    envPod &&
      envKey &&
      envUser &&
      preferClaudeCodeSurfaceKey({
        envPod,
        envKey,
        envUser,
        surface,
      }).usedSurface
  );
  const activeName = listPodProfiles().find((p) => p.active)?.name ?? null;

  return classifyKeySource({
    podOverride: Boolean(getPodOverride()),
    flagApiKey: Boolean(opts?.podUrl && opts?.apiKey),
    agentName: resolveAgentOverride() ? process.env.SYNAP_AGENT ?? null : null,
    envPod,
    envKey,
    envUser,
    surfacePrefersOverEnv,
    // Only meaningful when the profile rung wins; still pass for completeness.
    profileName: activeName ?? (getActivePodConfig() ? "default" : null),
  });
}
