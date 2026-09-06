/**
 * Two "the flag never left the process" defects, pinned at the wire.
 *
 * Task 3 — `synap session close --recap "…"` must reach the pod as `summary`
 * on POST /focus-sessions/:id/complete (canonical pack close). On older pods
 * (404) it falls back to PATCH with verificationReport.summary — same key the
 * complete path writes (services/focus-sessions/complete-session.ts). There is
 * NO `recap` field on either route — asserting the exact key is the point.
 *
 * Task 2 — `synap proposals list` never sent `sessionId`, though the hub has
 * read it since proposals.ts:207 and forwards it at :225.
 *
 * Both are asserted by mocking the hub transport and inspecting what the command
 * actually sent, because "the option is registered" is not evidence that the
 * value reaches the pod — that was precisely the bug.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const { hubPatch, hubGet, hubPost, MockHubError } = vi.hoisted(() => {
  class MockHubError extends Error {
    status: number;
    constructor(message: string, status: number) {
      super(message);
      this.name = "HubError";
      this.status = status;
    }
  }
  return {
    hubPatch: vi.fn(async () => ({})),
    hubGet: vi.fn(async () => ({ proposals: [] })),
    hubPost: vi.fn(async () => ({
      session: { id: "7f3a9c21-1111-4a2b-8c3d-99887766aabb", status: "closed" },
      pendingProposals: [],
      counts: { pending: 0, unfinishedOutputs: 0 },
      warnings: [],
    })),
    MockHubError,
  };
});

vi.mock("../src/lib/hub-client.js", () => ({
  hubPatch,
  hubGet,
  hubPost,
  resolveHubConfig: vi.fn(async () => ({
    podUrl: "http://127.0.0.1:1",
    apiKey: "test-key",
    workspaceId: "808939d1-86b3-4c52-a153-ae06ece2c54e",
  })),
  resolveUserId: vi.fn(async () => "user-1"),
  renderHubError: vi.fn(),
  resolveActiveSessionId: vi.fn(() => undefined),
  detachActiveSessionId: vi.fn(() => undefined),
  HubError: MockHubError,
}));

// The list footer classifies the calling key; stub it so these tests stay
// offline and assert only the query that went out.
vi.mock("../src/lib/credential-class.js", () => ({
  classifyActiveCredential: vi.fn(async () => "unknown"),
}));

const SESSION_ID = "7f3a9c21-1111-4a2b-8c3d-99887766aabb";

beforeEach(() => {
  hubPatch.mockClear();
  hubGet.mockClear();
  hubPost.mockClear();
  hubPost.mockResolvedValue({
    session: { id: SESSION_ID, status: "closed" },
    pendingProposals: [],
    counts: { pending: 0, unfinishedOutputs: 0 },
    warnings: [],
  });
  hubPatch.mockResolvedValue({});
});

describe("session close --recap reaches the pod", () => {
  it("POSTs complete with summary (not a bare recap field)", async () => {
    const { closeSession } = await import("../src/commands/sessions.js");
    await closeSession(SESSION_ID, { recap: "Shipped the credential guard." } as never);

    expect(hubPost).toHaveBeenCalledTimes(1);
    const [path, body] = hubPost.mock.calls[0] as unknown as [
      string,
      Record<string, unknown>,
    ];
    expect(path).toBe(`/focus-sessions/${SESSION_ID}/complete`);
    expect(body.summary).toBe("Shipped the credential guard.");
    // Regression: CLI flag name must not leak onto the wire.
    expect(body).not.toHaveProperty("recap");
    expect(hubPatch).not.toHaveBeenCalled();
  });

  it("omits summary entirely when no recap was given", async () => {
    const { closeSession } = await import("../src/commands/sessions.js");
    await closeSession(SESSION_ID, {} as never);

    const [, body] = hubPost.mock.calls[0] as unknown as [
      string,
      Record<string, unknown>,
    ];
    expect(body).not.toHaveProperty("summary");
    expect(body).not.toHaveProperty("recap");
    expect(hubPatch).not.toHaveBeenCalled();
  });

  it("falls back to PATCH verificationReport.summary when complete is 404", async () => {
    hubPost.mockRejectedValueOnce(
      new MockHubError("Hub POST failed (HTTP 404)", 404)
    );

    const { closeSession } = await import("../src/commands/sessions.js");
    await closeSession(SESSION_ID, {
      recap: "Closed on an older pod.",
    } as never);

    expect(hubPost).toHaveBeenCalledTimes(1);
    expect(hubPatch).toHaveBeenCalledTimes(1);
    const [path, body] = hubPatch.mock.calls[0] as unknown as [
      string,
      Record<string, unknown>,
    ];
    expect(path).toBe(`/focus-sessions/${SESSION_ID}`);
    expect(body.status).toBe("closed");
    expect(body.verificationReport).toEqual({
      summary: "Closed on an older pod.",
    });
    expect(body).not.toHaveProperty("recap");
  });

  it("does not require --workspace for complete", async () => {
    const { closeSession } = await import("../src/commands/sessions.js");
    // No workspace on opts; mock resolveHubConfig still has one, but close must
    // not refuse when workspace is absent from the flag surface.
    await closeSession(SESSION_ID, { recap: "no workspace flag" } as never);
    expect(hubPost).toHaveBeenCalledTimes(1);
  });
});

describe("proposals list --session reaches the pod", () => {
  it("forwards --session as the sessionId query param", async () => {
    const { listProposals } = await import("../src/commands/data-extra.js");
    await listProposals({ session: SESSION_ID } as never);

    expect(hubGet).toHaveBeenCalled();
    const [path, params] = hubGet.mock.calls[0] as unknown as [
      string,
      Record<string, unknown>,
    ];
    expect(path).toBe("/proposals");
    expect(params.sessionId).toBe(SESSION_ID);
  });

  it("omits sessionId when --session is absent, keeping the user-wide inbox", async () => {
    const { listProposals } = await import("../src/commands/data-extra.js");
    await listProposals({} as never);

    const [, params] = hubGet.mock.calls[0] as unknown as [
      string,
      Record<string, unknown>,
    ];
    expect(params).not.toHaveProperty("sessionId");
    // And still not workspace-scoped by default — the inbox is the user floor.
    expect(params).not.toHaveProperty("workspaceId");
  });
});
