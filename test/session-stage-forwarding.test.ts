/**
 * Door-parity tripwire: the CLI must FORWARD the session staging fields.
 *
 * `focus_sessions` carries a first-class `currentStage`, and the Hub accepts it
 * (PATCH /focus-sessions/:id — UpdateBodySchema.currentStage) alongside
 * `templateId` on create (POST /focus-sessions — CreateBodySchema.templateId).
 * The CLI previously accepted NEITHER: `session update` sent only
 * progress/status/goal and `session start` sent only workspace/goal/correlationId.
 * Backend accepts, CLI drops == a silent no-op for every AI driving the CLI
 * (which `autonomous-dev` does) — the door-parity severance class.
 *
 * These tests pin the wire body, not the flag parsing, so the severance cannot
 * silently return.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const hubPatch = vi.fn(async () => ({ id: "sess-1" }));
const hubPost = vi.fn(async () => ({ id: "sess-1" }));
const hubGet = vi.fn(async () => ({ id: "user-1" }));

vi.mock("../src/lib/hub-client.js", () => ({
  hubPatch,
  hubPost,
  hubGet,
  resolveHubConfig: vi.fn(async () => ({
    podUrl: "http://127.0.0.1:1",
    apiKey: "agent-key",
    workspaceId: "ws-config",
  })),
  renderHubError: vi.fn(),
}));

beforeEach(() => {
  hubPatch.mockClear();
  hubPost.mockClear();
});

describe("session update — stage forwarding", () => {
  it("sends currentStage when --stage is given", async () => {
    const { updateSession } = await import("../src/commands/sessions.js");
    await updateSession("sess-1", { workspace: "ws-1", stage: "in-work", json: true });

    const [, body] = hubPatch.mock.calls[0] as unknown as [string, Record<string, unknown>];
    expect(body.currentStage).toBe("in-work");
  });

  it("omits currentStage entirely when --stage is absent", async () => {
    const { updateSession } = await import("../src/commands/sessions.js");
    await updateSession("sess-1", { workspace: "ws-1", progress: "40", json: true });

    const [, body] = hubPatch.mock.calls[0] as unknown as [string, Record<string, unknown>];
    expect(body).not.toHaveProperty("currentStage");
    expect(body.progress).toBe(40);
  });

  it("forwards every canonical lifecycle stage verbatim (no re-spelling)", async () => {
    const { updateSession } = await import("../src/commands/sessions.js");
    const stages = [
      "brainstorming",
      "validating",
      "planning",
      "in-work",
      "verifying",
      "finishing",
    ];
    for (const stage of stages) {
      hubPatch.mockClear();
      await updateSession("sess-1", { workspace: "ws-1", stage, json: true });
      const [, body] = hubPatch.mock.calls[0] as unknown as [string, Record<string, unknown>];
      expect(body.currentStage).toBe(stage);
    }
  });
});

describe("session start — template forwarding", () => {
  it("sends templateId when --template is given (seeds currentStage server-side)", async () => {
    const { startSession } = await import("../src/commands/sessions.js");
    await startSession({ goal: "g", workspace: "ws-1", template: "pb-1", json: true });

    const [, body] = hubPost.mock.calls[0] as unknown as [string, Record<string, unknown>];
    expect(body.templateId).toBe("pb-1");
  });

  it("omits templateId when --template is absent", async () => {
    const { startSession } = await import("../src/commands/sessions.js");
    await startSession({ goal: "g", workspace: "ws-1", json: true });

    const [, body] = hubPost.mock.calls[0] as unknown as [string, Record<string, unknown>];
    expect(body).not.toHaveProperty("templateId");
  });
});
