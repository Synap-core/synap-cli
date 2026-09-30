/**
 * `synap track` + `synap session start --track` — the bytes sent to the Hub
 * `/tracks` routes and the honesty of what is printed: a proposal prints as
 * QUEUED (never "started"), and the pod's domain advisories (`domainsNote`,
 * `domainNote`) reach the terminal.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const hubPost = vi.fn();
const hubGet = vi.fn();
const hubPatch = vi.fn();
const attachActiveSessionId = vi.fn(() => "session-lens");

vi.mock("../src/lib/hub-client.js", () => ({
  hubPost,
  hubGet,
  hubPatch,
  attachActiveSessionId,
  resolveHubConfig: vi.fn(async () => ({
    podUrl: "http://127.0.0.1:1",
    apiKey: "agent-key",
    workspaceId: "ws-lens",
    projectId: "proj-lens",
  })),
  renderHubError: vi.fn(),
  HubError: class HubError extends Error {},
}));

let out: string[];
beforeEach(() => {
  hubPost.mockReset();
  hubGet.mockReset();
  hubPatch.mockReset();
  attachActiveSessionId.mockClear();
  out = [];
  const capture = (...a: unknown[]) => void out.push(a.map(String).join(" "));
  vi.spyOn(console, "log").mockImplementation(capture);
  vi.spyOn(console, "error").mockImplementation(capture);
});
afterEach(() => vi.restoreAllMocks());

const printed = () => out.join("\n");

describe("synap track start", () => {
  it("prints a proposal as queued with its review link, and the domain note", async () => {
    hubPost.mockResolvedValueOnce({
      status: "proposed",
      proposalId: "prop-1",
      reviewUrl: "https://pod/open/prop-1",
      missingDomains: ["market"],
      domainsNote: 'No workspace is installed for this stage domain: "market".',
    });
    const { startTrack } = await import("../src/commands/tracks.js");
    await startTrack({ playbook: "pb-1", param: ["budget=1000", "market=null"] });

    const [path, body] = hubPost.mock.calls[0] as [string, Record<string, unknown>];
    expect(path).toBe("/tracks");
    expect(body).toEqual({
      projectId: "proj-lens",
      playbookId: "pb-1",
      params: { budget: 1000, market: null },
    });
    expect(printed()).toContain("queued for your review");
    expect(printed()).toContain("https://pod/open/prop-1");
    expect(printed()).toContain('stage domain: "market"');
    expect(printed()).not.toContain("Track started");
  });
});

describe("synap track start-step", () => {
  it("resolves the current step, then prints the pod's domain fallback", async () => {
    hubGet.mockResolvedValueOnce({ id: "t-1", name: "BM", currentStage: "scan", status: "active" });
    hubPost.mockResolvedValueOnce({
      status: "created",
      stageKey: "scan",
      session: { id: "sess-1" },
      domainFallback: { wanted: "market", reason: "no_workspace" },
      domainNote: "…started in the project's home workspace instead.",
    });
    const { startStep } = await import("../src/commands/tracks.js");
    await startStep("t-1", {});

    expect(hubPost.mock.calls[0][0]).toBe("/tracks/t-1/stages/scan/sessions");
    expect(printed()).toContain("home workspace instead");
    expect(printed()).toContain("sess-1");
  });
});

describe("synap track advance", () => {
  it("prints the step's offer as NOT started", async () => {
    hubPost.mockResolvedValueOnce({
      status: "advanced",
      paused: false,
      offer: { name: "Build", goal: "Build the MVP" },
    });
    const { advanceTrack } = await import("../src/commands/tracks.js");
    await advanceTrack("t-1", "build", {});
    expect(hubPost.mock.calls[0]).toEqual(["/tracks/t-1/advance", { toStage: "build" }, expect.anything()]);
    expect(printed()).toContain("Offered (not started): Build");
  });
});

describe("synap session start --track", () => {
  it("sends trackId and NOT the ambient project/workspace lens", async () => {
    hubGet.mockResolvedValueOnce({ id: "user-1" });
    hubPost.mockResolvedValueOnce({ id: "sess-1", goal: "g" });
    const { startSession } = await import("../src/commands/sessions.js");
    await startSession({ goal: "g", track: "t-1", json: true });

    const [, body] = hubPost.mock.calls[0] as [string, Record<string, unknown>];
    expect(body.trackId).toBe("t-1");
    expect(body).not.toHaveProperty("projectId");
    expect(body).not.toHaveProperty("workspaceId");
  });

  it("prints a proposed start as queued and attaches nothing", async () => {
    hubGet.mockResolvedValueOnce({ id: "user-1" });
    hubPost.mockResolvedValueOnce({
      status: "proposed",
      proposalId: "prop-9",
      reviewUrl: "https://pod/open/prop-9",
      session: null,
    });
    const { startSession } = await import("../src/commands/sessions.js");
    await startSession({ goal: "g", track: "t-1" });

    expect(printed()).toContain("queued for your review");
    expect(printed()).not.toContain("Session started");
    expect(attachActiveSessionId).not.toHaveBeenCalled();
  });
});
