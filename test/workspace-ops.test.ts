/**
 * R8a — `synap workspace archive|restore|rename` and `synap entity move` hit
 * the governed Hub doors with the right shape, and print a proposal as the
 * success it is (never as an error, never as "done").
 *
 *   archive → POST  /workspaces/:id/archive
 *   restore → POST  /workspaces/:id/restore   (an id works for an ARCHIVED ws,
 *                                               which the list hides)
 *   rename  → PATCH /workspaces/:id  { name }
 *   move    → POST  /entities/move   { entityIds, workspaceId }
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const WS = "33333333-3333-4333-8333-333333333333";
const E1 = "77777777-7777-4777-8777-777777777777";

const h = vi.hoisted(() => ({
  hubGet: vi.fn(),
  hubPost: vi.fn(),
  hubPatch: vi.fn(),
}));

vi.mock("../src/lib/hub-client.js", () => ({
  hubGet: h.hubGet,
  hubPost: h.hubPost,
  hubPatch: h.hubPatch,
  resolveHubConfig: vi.fn(async () => ({
    podUrl: "http://127.0.0.1:1",
    apiKey: "k",
    workspaceId: "ws-config",
  })),
}));

import {
  workspaceArchive,
  workspaceRestore,
  workspaceRename,
  entityMove,
} from "../src/commands/workspace-ops.js";

let out: string[] = [];
beforeEach(() => {
  h.hubGet.mockReset();
  h.hubPost.mockReset();
  h.hubPatch.mockReset();
  h.hubGet.mockResolvedValue({ workspaces: [{ id: WS, name: "Radar" }] });
  out = [];
  vi.spyOn(console, "log").mockImplementation((...a) => void out.push(a.join(" ")));
  vi.spyOn(console, "error").mockImplementation((...a) => void out.push(a.join(" ")));
});

describe("synap workspace archive / restore / rename", () => {
  it("archive resolves a NAME and posts to the archive door; lists paused automations", async () => {
    h.hubPost.mockResolvedValue({
      name: "Radar",
      status: "archived",
      pausedAutomations: [{ id: "a1", name: "nightly scan" }],
    });
    await workspaceArchive("radar", { reason: "retired" });
    expect(h.hubPost).toHaveBeenCalledWith(
      `/workspaces/${WS}/archive`,
      { reasoning: "retired" },
      expect.anything()
    );
    const text = out.join("\n");
    expect(text).toContain("Archived workspace 'Radar'");
    expect(text).toContain("nightly scan");
  });

  it("a proposal prints as filed-for-review with the approve door", async () => {
    h.hubPost.mockResolvedValue({ status: "proposed", proposalId: "prop-1" });
    await workspaceArchive(WS, {});
    const text = out.join("\n");
    expect(text).toContain("filed for review");
    expect(text).toContain("synap open proposal prop-1");
    expect(text).not.toContain("Archived workspace");
  });

  it("restore takes an id without listing (archived workspaces are hidden) and offers re-enabling", async () => {
    h.hubPost.mockResolvedValue({
      status: "restored",
      name: "Radar",
      pausedByArchive: [{ id: "a1", name: "nightly scan" }],
    });
    await workspaceRestore(WS, {});
    expect(h.hubGet).not.toHaveBeenCalled();
    expect(h.hubPost).toHaveBeenCalledWith(`/workspaces/${WS}/restore`, {}, expect.anything());
    expect(out.join("\n")).toContain("synap automation enable a1");
  });

  it("rename PATCHes the name", async () => {
    h.hubPatch.mockResolvedValue({ status: "updated" });
    await workspaceRename("Radar", "  Radar v2 ", {});
    expect(h.hubPatch).toHaveBeenCalledWith(`/workspaces/${WS}`, { name: "Radar v2" }, expect.anything());
  });
});

describe("synap entity move", () => {
  it("posts ids + the resolved destination and reports each outcome", async () => {
    h.hubPost.mockResolvedValue({
      moved: [E1],
      proposed: [{ entityId: E1, proposalId: "prop-2" }],
      errors: [],
    });
    await entityMove([E1], { to: "Radar", reason: "misrouted" });
    expect(h.hubPost).toHaveBeenCalledWith(
      "/entities/move",
      { entityIds: [E1], workspaceId: WS, reason: "misrouted" },
      expect.anything()
    );
    const text = out.join("\n");
    expect(text).toContain("Moved 1 entity");
    expect(text).toContain("synap open proposal prop-2");
  });
});
