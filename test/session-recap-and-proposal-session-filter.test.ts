/**
 * Two "the flag never left the process" defects, pinned at the wire.
 *
 * Task 3 — `synap session close --recap "…"` accepted the text and then built a
 * PATCH body of only `{workspaceId, status}`. The recap was silently discarded.
 * The server field is `verificationReport` (UpdateBodySchema,
 * synap-backend/.../hub-protocol/rest/focus-sessions.ts:114, applied :549-550);
 * `{ summary }` is the key the canonical close path writes into that column
 * (services/focus-sessions/complete-session.ts:86-96). There is NO `recap` field
 * on the route — asserting the exact key is the point of this test.
 *
 * Task 2 — `synap proposals list` never sent `sessionId`, though the hub has
 * read it since proposals.ts:207 and forwards it at :225.
 *
 * Both are asserted by mocking the hub transport and inspecting what the command
 * actually sent, because "the option is registered" is not evidence that the
 * value reaches the pod — that was precisely the bug.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const hubPatch = vi.fn(async () => ({}));
const hubGet = vi.fn(async () => ({ proposals: [] }));

vi.mock("../src/lib/hub-client.js", () => ({
  hubPatch,
  hubGet,
  hubPost: vi.fn(async () => ({})),
  resolveHubConfig: vi.fn(async () => ({
    podUrl: "http://127.0.0.1:1",
    apiKey: "test-key",
    workspaceId: "808939d1-86b3-4c52-a153-ae06ece2c54e",
  })),
  resolveUserId: vi.fn(async () => "user-1"),
  renderHubError: vi.fn(),
  readActiveSessionId: vi.fn(() => undefined),
  clearActiveSessionId: vi.fn(),
  HubError: class HubError extends Error {},
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
});

describe("session close --recap reaches the pod", () => {
  it("sends the recap as verificationReport.summary", async () => {
    const { closeSession } = await import("../src/commands/sessions.js");
    await closeSession(SESSION_ID, { recap: "Shipped the credential guard." } as never);

    expect(hubPatch).toHaveBeenCalledTimes(1);
    const [path, body] = hubPatch.mock.calls[0] as unknown as [string, Record<string, unknown>];
    expect(path).toBe(`/focus-sessions/${SESSION_ID}`);
    expect(body.status).toBe("closed");
    expect(body.verificationReport).toEqual({ summary: "Shipped the credential guard." });
    // Regression tripwire for the whole defect class: guessing a field name
    // reproduces the silent discard with extra steps. The route has no `recap`.
    expect(body).not.toHaveProperty("recap");
  });

  it("omits verificationReport entirely when no recap was given", async () => {
    const { closeSession } = await import("../src/commands/sessions.js");
    await closeSession(SESSION_ID, {} as never);

    const [, body] = hubPatch.mock.calls[0] as unknown as [string, Record<string, unknown>];
    expect(body).not.toHaveProperty("verificationReport");
    expect(body.status).toBe("closed");
  });
});

describe("proposals list --session reaches the pod", () => {
  it("forwards --session as the sessionId query param", async () => {
    const { listProposals } = await import("../src/commands/data-extra.js");
    await listProposals({ session: SESSION_ID } as never);

    expect(hubGet).toHaveBeenCalled();
    const [path, params] = hubGet.mock.calls[0] as unknown as [string, Record<string, unknown>];
    expect(path).toBe("/proposals");
    expect(params.sessionId).toBe(SESSION_ID);
  });

  it("omits sessionId when --session is absent, keeping the user-wide inbox", async () => {
    const { listProposals } = await import("../src/commands/data-extra.js");
    await listProposals({} as never);

    const [, params] = hubGet.mock.calls[0] as unknown as [string, Record<string, unknown>];
    expect(params).not.toHaveProperty("sessionId");
    // And still not workspace-scoped by default — the inbox is the user floor.
    expect(params).not.toHaveProperty("workspaceId");
  });
});
