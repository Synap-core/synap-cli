/**
 * Pure key-source helpers — report which path would win without resolving the
 * secret. Precedence must stay locked to resolveHubConfig's ladder.
 */
import { describe, it, expect } from "vitest";
import {
  preferClaudeCodeSurfaceKey,
  classifyKeySource,
  formatKeySource,
  KEY_SOURCE_LABEL,
} from "../src/lib/key-source.js";

describe("preferClaudeCodeSurfaceKey", () => {
  const base = {
    envPod: "https://pod.example",
    envKey: "env-key-aaaaaa",
    envUser: "env-user",
  };

  it("keeps the env key when no surface key is pinned", () => {
    const r = preferClaudeCodeSurfaceKey({ ...base, surface: null });
    expect(r.usedSurface).toBe(false);
    expect(r.apiKey).toBe("env-key-aaaaaa");
    expect(r.userId).toBe("env-user");
  });

  it("keeps the env key when surface is pinned to a different pod", () => {
    const r = preferClaudeCodeSurfaceKey({
      ...base,
      surface: {
        podUrl: "https://other.example",
        hubApiKey: "surface-key-bbbbbb",
        agentUserId: "surface-user",
      },
    });
    expect(r.usedSurface).toBe(false);
    expect(r.apiKey).toBe("env-key-aaaaaa");
  });

  it("keeps the env key when surface matches env (no divergence)", () => {
    const r = preferClaudeCodeSurfaceKey({
      ...base,
      surface: {
        podUrl: base.envPod,
        hubApiKey: base.envKey,
        agentUserId: "surface-user",
      },
    });
    expect(r.usedSurface).toBe(false);
    expect(r.apiKey).toBe(base.envKey);
  });

  it("swaps in the surface key when pinned to the same pod and keys differ", () => {
    const r = preferClaudeCodeSurfaceKey({
      ...base,
      surface: {
        podUrl: base.envPod,
        hubApiKey: "surface-key-bbbbbb",
        agentUserId: "surface-user",
      },
    });
    expect(r.usedSurface).toBe(true);
    expect(r.apiKey).toBe("surface-key-bbbbbb");
    // The agent id is never the acting user (the pod 403s it for a linked key).
    expect(r.userId).toBe("env-user");
    expect(r.agentUserId).toBe("surface-user");
  });

  it("with no SYNAP_USER_ID the user is asked of the pod (\"cli\")", () => {
    const r = preferClaudeCodeSurfaceKey({ ...base, envUser: undefined, surface: null });
    expect(r.userId).toBe("cli");
  });

  it("falls back to envUser when surface has no agentUserId", () => {
    const r = preferClaudeCodeSurfaceKey({
      ...base,
      surface: { podUrl: base.envPod, hubApiKey: "surface-key-bbbbbb" },
    });
    expect(r.userId).toBe("env-user");
  });
});

describe("classifyKeySource", () => {
  it("ranks --pod override as flag", () => {
    expect(classifyKeySource({ podOverride: true, envPod: "p", envKey: "k", envUser: "u" })).toEqual({
      source: "flag",
      detail: "--pod",
    });
  });

  it("ranks explicit flags next", () => {
    expect(classifyKeySource({ flagApiKey: true })).toEqual({ source: "flag" });
  });

  it("ranks SYNAP_AGENT next", () => {
    expect(classifyKeySource({ agentName: "claude-code" })).toEqual({
      source: "agent",
      detail: "claude-code",
    });
  });

  it("reports env-surface when surface preference would swap", () => {
    expect(
      classifyKeySource({
        envPod: "https://pod.example",
        envKey: "k",
        envUser: "u",
        surfacePrefersOverEnv: true,
      })
    ).toEqual({ source: "env-surface", detail: "claude-code" });
  });

  it("reports env when ambient env triple is set and surface does not swap", () => {
    expect(
      classifyKeySource({
        envPod: "https://pod.example",
        envKey: "k",
        envUser: "u",
        surfacePrefersOverEnv: false,
      })
    ).toEqual({ source: "env", detail: "SYNAP_HUB_API_KEY" });
  });

  it("falls through to profile", () => {
    expect(classifyKeySource({ profileName: "perso" })).toEqual({
      source: "profile",
      detail: "perso",
    });
  });

  it("pod + key claim env without SYNAP_USER_ID (same as resolveHubConfig)", () => {
    expect(
      classifyKeySource({
        envPod: "https://pod.example",
        envKey: "k",
        envUser: undefined,
        profileName: "perso",
      })
    ).toEqual({ source: "env", detail: "SYNAP_HUB_API_KEY" });
  });

  it("a pod URL without a key is not the env rung", () => {
    expect(
      classifyKeySource({ envPod: "https://pod.example", envUser: "u", profileName: "perso" })
    ).toEqual({ source: "profile", detail: "perso" });
  });
});

describe("formatKeySource", () => {
  it("joins label and detail like lens origins", () => {
    expect(formatKeySource({ source: "env", detail: "SYNAP_HUB_API_KEY" })).toBe(
      "environment variable: SYNAP_HUB_API_KEY"
    );
    expect(formatKeySource({ source: "env-surface", detail: "claude-code" })).toBe(
      "claude-code surface key: claude-code"
    );
    expect(formatKeySource({ source: "flag" })).toBe(KEY_SOURCE_LABEL.flag);
  });
});
