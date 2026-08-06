/**
 * Unit tests for the cross-pod workspace resolution rule (`resolveWorkspaceForPod`).
 *
 * The bug this guards: a global `activeWorkspaceId` belongs to exactly ONE pod,
 * but is stored pod-agnostically. Sending it to a different pod than the one the
 * command targets produces "Access denied to workspace" (403). The CLI must
 * never send a workspaceId that belongs to a different pod than it's calling.
 *
 * Pure function → no disk, no network.
 */
import { describe, it, expect } from "vitest";
import { resolveWorkspaceForPod, type MultiPodConfig } from "../src/lib/pod.js";

const PERSO_WS = "perso-ws-0000";
const TEAM_WS = "0698c7a8-team-ws";

function baseConfig(overrides: Partial<MultiPodConfig> = {}): MultiPodConfig {
  return {
    activePod: "perso",
    pods: {
      perso: {
        podUrl: "https://pod.perso.example",
        workspaceId: PERSO_WS,
        agentUserId: "",
        hubApiKey: "k-perso",
        savedAt: "2026-07-24",
      },
      team: {
        podUrl: "https://pod.team.example",
        workspaceId: TEAM_WS,
        agentUserId: "",
        hubApiKey: "k-team",
        savedAt: "2026-07-24",
      },
    },
    ...overrides,
  };
}

describe("resolveWorkspaceForPod", () => {
  it("returns the pod's own default when there is no override", () => {
    const cfg = baseConfig();
    expect(resolveWorkspaceForPod(cfg, "perso")).toBe(PERSO_WS);
    expect(resolveWorkspaceForPod(cfg, "team")).toBe(TEAM_WS);
  });

  it("THE BUG: a legacy override that is another pod's default is NOT sent to the target pod", () => {
    // activePod=perso but activeWorkspaceId is the TEAM workspace (no binding) —
    // exactly the reported broken config. Targeting perso must use perso's ws.
    const cfg = baseConfig({ activeWorkspaceId: TEAM_WS });
    expect(resolveWorkspaceForPod(cfg, "perso")).toBe(PERSO_WS);
    // Targeting the pod the workspace actually belongs to is fine.
    expect(resolveWorkspaceForPod(cfg, "team")).toBe(TEAM_WS);
  });

  it("honors a bound override only for its bound pod", () => {
    const cfg = baseConfig({
      activeWorkspaceId: TEAM_WS,
      activeWorkspace: { workspaceId: TEAM_WS, podName: "team" },
    });
    // Bound to team → team gets it, perso falls back to perso's own default.
    expect(resolveWorkspaceForPod(cfg, "team")).toBe(TEAM_WS);
    expect(resolveWorkspaceForPod(cfg, "perso")).toBe(PERSO_WS);
  });

  it("honors a bound custom workspace on its pod (not that pod's default)", () => {
    const custom = "perso-custom-ws";
    const cfg = baseConfig({
      activeWorkspaceId: custom,
      activeWorkspace: { workspaceId: custom, podName: "perso" },
    });
    expect(resolveWorkspaceForPod(cfg, "perso")).toBe(custom);
    // Not sent to team.
    expect(resolveWorkspaceForPod(cfg, "team")).toBe(TEAM_WS);
  });

  it("preserves legacy same-pod `synap use <custom-ws>` (no binding, matches no other pod default)", () => {
    const custom = "perso-custom-ws";
    const cfg = baseConfig({ activeWorkspaceId: custom });
    // No evidence it belongs elsewhere → assume it's the target pod's.
    expect(resolveWorkspaceForPod(cfg, "perso")).toBe(custom);
  });

  it("returns undefined (pod-wide) for a target pod that isn't saved", () => {
    const cfg = baseConfig({ activeWorkspaceId: TEAM_WS });
    // Unknown pod + an override that belongs to a known pod → never send it.
    expect(resolveWorkspaceForPod(cfg, "ghost")).toBeUndefined();
    expect(resolveWorkspaceForPod(cfg, undefined)).toBeUndefined();
  });

  it("prefers perso binding over a drifted activeWorkspaceId + wrong profile default", () => {
    // Real dual-pod dogfood: perso profile.workspaceId was team CRM UUID;
    // binding points at Brand Library. Resolution must use the binding.
    const brand = "f001a1a7-brand-library";
    const teamCrm = "499328b7-team-crm";
    const cfg = baseConfig({
      activeWorkspaceId: teamCrm,
      activeWorkspace: { workspaceId: brand, podName: "perso" },
      pods: {
        perso: {
          podUrl: "https://pod.perso.example",
          workspaceId: teamCrm, // drifted profile default
          agentUserId: "",
          hubApiKey: "k-perso",
          savedAt: "2026-07-24",
        },
        team: {
          podUrl: "https://pod.team.example",
          workspaceId: TEAM_WS,
          agentUserId: "",
          hubApiKey: "k-team",
          savedAt: "2026-07-24",
        },
      },
    });
    expect(resolveWorkspaceForPod(cfg, "perso")).toBe(brand);
    expect(resolveWorkspaceForPod(cfg, "team")).toBe(TEAM_WS);
  });
});
