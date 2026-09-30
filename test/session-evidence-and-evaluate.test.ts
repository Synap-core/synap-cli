/**
 * `synap session evidence <key>` / `synap session evaluate` — the CLI doors
 * onto Hub REST `POST /focus-sessions/:id/evidence` and
 * `POST /focus-sessions/:id/evaluations` (Lane B).
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const hubPost = vi.fn(async () => ({ status: "evaluated", results: [] }));
const resolveActiveSessionId = vi.fn(() => undefined as string | undefined);

vi.mock("../src/lib/hub-client.js", () => ({
  hubPost,
  hubGet: vi.fn(),
  hubPatch: vi.fn(),
  resolveActiveSessionId: (...args: unknown[]) => resolveActiveSessionId(...args),
  resolveHubConfig: vi.fn(async () => ({
    podUrl: "http://127.0.0.1:1",
    apiKey: "agent-key",
    workspaceId: "ws-config",
  })),
  renderHubError: vi.fn(),
  HubError: class HubError extends Error {},
}));

beforeEach(() => {
  hubPost.mockClear();
  resolveActiveSessionId.mockReset();
  resolveActiveSessionId.mockReturnValue(undefined);
});

describe("session evidence", () => {
  it("posts { evidence: { [key]: { passed, detail } } } to /evidence", async () => {
    const { evidenceSession } = await import("../src/commands/sessions.js");
    await evidenceSession("typecheck", {
      session: "sess-1",
      passed: true,
      detail: "0 errors",
      json: true,
    });

    const [path, body] = hubPost.mock.calls[0] as unknown as [string, Record<string, unknown>];
    expect(path).toBe("/focus-sessions/sess-1/evidence");
    expect(body).toEqual({ evidence: { typecheck: { passed: true, detail: "0 errors" } } });
  });

  it("omits detail when not given", async () => {
    const { evidenceSession } = await import("../src/commands/sessions.js");
    await evidenceSession("typecheck", { session: "sess-1", failed: true, json: true });

    const [, body] = hubPost.mock.calls[0] as unknown as [string, Record<string, unknown>];
    expect(body).toEqual({ evidence: { typecheck: { passed: false } } });
  });

  it("falls back to the terminal's active session when --session is omitted", async () => {
    resolveActiveSessionId.mockReturnValue("active-sess");
    const { evidenceSession } = await import("../src/commands/sessions.js");
    await evidenceSession("typecheck", { passed: true, json: true });

    const [path] = hubPost.mock.calls[0] as unknown as [string];
    expect(path).toBe("/focus-sessions/active-sess/evidence");
  });

  it("rejects neither --passed nor --failed at the edge, not the pod", async () => {
    const exitSpy = vi.spyOn(process, "exit").mockImplementation(() => undefined as never);
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const { evidenceSession } = await import("../src/commands/sessions.js");
    await evidenceSession("typecheck", { session: "sess-1", json: true });

    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(hubPost).not.toHaveBeenCalled();

    exitSpy.mockRestore();
    errSpy.mockRestore();
  });

  it("rejects both --passed and --failed together", async () => {
    const exitSpy = vi.spyOn(process, "exit").mockImplementation(() => undefined as never);
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const { evidenceSession } = await import("../src/commands/sessions.js");
    await evidenceSession("typecheck", { session: "sess-1", passed: true, failed: true, json: true });

    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(hubPost).not.toHaveBeenCalled();

    exitSpy.mockRestore();
    errSpy.mockRestore();
  });
});

describe("session evaluate", () => {
  it("posts an empty body to /evaluations for the given session", async () => {
    const { evaluateSession } = await import("../src/commands/sessions.js");
    await evaluateSession({ session: "sess-1", json: true });

    const [path, body] = hubPost.mock.calls[0] as unknown as [string, Record<string, unknown>];
    expect(path).toBe("/focus-sessions/sess-1/evaluations");
    expect(body).toEqual({});
  });

  it("prints per-criterion verdicts using the vocabulary-pinned labels", async () => {
    hubPost.mockResolvedValueOnce({
      status: "evaluated",
      results: [
        { key: "typecheck", status: "recorded", verdict: "pass" },
        { key: "human-review", status: "skipped", reason: "awaiting a human grade" },
      ],
      verdict: { total: 2, passed: 1, failed: 0, unmeasured: 1, requiredUnmet: 1, state: "incomplete" },
    });
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    const { evaluateSession } = await import("../src/commands/sessions.js");
    await evaluateSession({ session: "sess-1" });

    const out = logSpy.mock.calls.flat().join("\n");
    expect(out).toContain("typecheck");
    expect(out).toContain("Passed");
    expect(out).toContain("human-review");
    expect(out).toContain("skipped");
    expect(out).toContain("1 unmet");

    logSpy.mockRestore();
  });
});
