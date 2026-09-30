/**
 * `synap context`'s "Active Focus Sessions" section previously printed the
 * raw `goal` with no population marker — a run or receipt read
 * indistinguishable from a person's own work, same audit finding as
 * `synap session list` before `test/session-kind-column.test.ts`. It now
 * reuses `sessionKindLabel` / `resolveSessionTitle` from `sessions.ts`.
 */
import { describe, it, expect, vi } from "vitest";

vi.mock("../src/lib/hub-client.js", () => ({
  hubGet: vi.fn(async (path: string) => {
    if (path === "/focus-sessions") {
      return [{ id: "sess-1", goal: "Ship billing", kind: "run", title: null }];
    }
    return [];
  }),
  hubPost: vi.fn(),
  hubPatch: vi.fn(),
  resolveHubConfig: vi.fn(async () => ({
    podUrl: "http://127.0.0.1:1",
    apiKey: "agent-key",
    workspaceId: "ws-config",
  })),
  renderHubError: vi.fn(),
}));

vi.mock("../src/lib/pod.js", () => ({
  getAgentWorkspaceRouting: vi.fn(() => null),
}));

describe("synap context — session kind marker + title", () => {
  it("prints the [Run] marker and the resolved title, not the bare goal line", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    const { contextSummary } = await import("../src/commands/context.js");
    await contextSummary({});

    const out = logSpy.mock.calls.flat().join("\n");
    expect(out).toContain("Run");
    expect(out).toContain("Ship billing");

    logSpy.mockRestore();
  });
});
