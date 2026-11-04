/**
 * `synap session list --kind` — the population-lens filter and its column.
 *
 * The Hub REST `GET /focus-sessions` door (backend: `routers/hub-protocol/
 * rest/focus-sessions.ts`) accepts `kind: work|run|receipt|all` (default
 * "all") and projects `kind` onto every returned row
 * (`services/focus-sessions/session-kind.ts`). Before this the CLI neither
 * forwarded a kind filter nor rendered the field it already received —
 * `synap session list` printed receipts and runs indistinguishable from a
 * person's own work.
 *
 * `sessionKindLabel` is `@synap-core/types/vocabulary`'s `resolveStatusLabel`
 * (imported, no local table), so the last describe pins the words the person
 * reads, not a copy.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const hubGet = vi.fn(async () => [] as unknown[]);

vi.mock("../src/lib/hub-client.js", () => ({
  hubGet,
  resolveHubConfig: vi.fn(async () => ({
    podUrl: "http://127.0.0.1:1",
    apiKey: "agent-key",
    workspaceId: "ws-config",
  })),
  renderHubError: vi.fn(),
}));

beforeEach(() => {
  hubGet.mockClear();
});

describe("session list — --kind forwarding", () => {
  it("forwards kind when a specific population is requested", async () => {
    const { listSessions } = await import("../src/commands/sessions.js");
    await listSessions({ workspace: "ws-1", kind: "run", json: true });

    const [, params] = hubGet.mock.calls[0] as unknown as [
      string,
      Record<string, unknown>,
    ];
    expect(params.kind).toBe("run");
  });

  it("omits kind entirely for the default 'all' — the door's own default", async () => {
    const { listSessions } = await import("../src/commands/sessions.js");
    await listSessions({ workspace: "ws-1", kind: "all", json: true });

    const [, params] = hubGet.mock.calls[0] as unknown as [
      string,
      Record<string, unknown>,
    ];
    expect(params).not.toHaveProperty("kind");
  });

  it("omits kind when --kind is not given at all", async () => {
    const { listSessions } = await import("../src/commands/sessions.js");
    await listSessions({ workspace: "ws-1", json: true });

    const [, params] = hubGet.mock.calls[0] as unknown as [
      string,
      Record<string, unknown>,
    ];
    expect(params).not.toHaveProperty("kind");
  });

  it("rejects an unknown --kind value at the edge, not on the pod", async () => {
    const { listSessions } = await import("../src/commands/sessions.js");
    const exitSpy = vi
      .spyOn(process, "exit")
      .mockImplementation(() => undefined as never);
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    await listSessions({ workspace: "ws-1", kind: "bogus", json: true });

    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(errSpy.mock.calls.join(" ")).toContain("--kind");

    exitSpy.mockRestore();
    errSpy.mockRestore();
  });
});

describe("session list — KIND column words come from the vocabulary door", () => {
  it("prints the registry's words for the three lenses", async () => {
    const { sessionKindLabel } = await import("../src/commands/sessions.js");
    expect(sessionKindLabel("work")).toBe("Work");
    expect(sessionKindLabel("run")).toBe("Run");
    expect(sessionKindLabel("receipt")).toBe("Receipt");
  });

  it("a kind the door does not name reads as words, never as the raw token", async () => {
    const { sessionKindLabel } = await import("../src/commands/sessions.js");
    expect(sessionKindLabel("stale_run")).toBe("Stale run");
  });
});
