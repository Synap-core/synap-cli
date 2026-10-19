/**
 * `synap context` is injected into an agent's session start (CLAUDE.md, a
 * hook). An EMPTY section and a FAILED read are different facts: its readers
 * (`fetchEntities` / `fetchProposals` / `fetchSessions`) used to
 * `catch { return [] }`, so a 403 / 500 / unreachable pod printed
 * "Open Proposals (0 pending) (none)" — a calm, confident, wrong start state
 * an agent then acts on ("nothing awaits review").
 *
 * Now a failed section says so (markdown: "could not read: …"; JSON: an
 * `error` field and NO `items`), the sections that did read still render, and
 * a pod that answered nothing at all exits 1.
 */
import { afterEach, describe, it, expect, vi } from "vitest";

const h = vi.hoisted(() => ({ failing: new Set<string>() }));

vi.mock("../src/lib/hub-client.js", () => ({
  hubGet: vi.fn(async (path: string) => {
    if (h.failing.has(path)) {
      throw new Error(`Hub GET ${path} failed (HTTP 500)`);
    }
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

const { contextSummary } = await import("../src/commands/context.js");

function capture() {
  const out: string[] = [];
  const err: string[] = [];
  const logSpy = vi
    .spyOn(console, "log")
    .mockImplementation((...a: unknown[]) => void out.push(a.join(" ")));
  const errSpy = vi
    .spyOn(console, "error")
    .mockImplementation((...a: unknown[]) => void err.push(a.join(" ")));
  const exitSpy = vi
    .spyOn(process, "exit")
    .mockImplementation((() => undefined) as never);
  return { out, err, exitSpy, restore: () => vi.restoreAllMocks() };
}

afterEach(() => {
  h.failing.clear();
  vi.restoreAllMocks();
});

describe("synap context — a failed read is not an empty section", () => {
  it("markdown: the failed section says it could not read; the others still render", async () => {
    h.failing.add("/proposals");
    const c = capture();
    await contextSummary({});
    const text = c.out.join("\n");
    expect(text).not.toMatch(/Open Proposals \(0 pending\)/);
    expect(text).toMatch(/Open Proposals[^\n]*\n[^\n]*could not read[^\n]*HTTP 500/i);
    // The sections that DID read are unaffected.
    expect(text).toContain("Ship billing");
    expect(c.exitSpy).not.toHaveBeenCalled();
  });

  it("json: the failed section carries `error` and no `items`", async () => {
    h.failing.add("/proposals");
    const c = capture();
    await contextSummary({ json: true });
    const lines = c.out.map((l) => JSON.parse(l) as Record<string, unknown>);
    const proposals = lines.find((l) => l.section === "proposals")!;
    expect(proposals.error).toMatch(/HTTP 500/);
    expect(proposals).not.toHaveProperty("items");
    const sessions = lines.find((l) => l.section === "sessions")!;
    expect(sessions.items).toHaveLength(1);
  });

  it("a genuinely empty section still reads (none)", async () => {
    const c = capture();
    await contextSummary({});
    const text = c.out.join("\n");
    expect(text).toMatch(/Open Proposals \(0 pending\)\n[^\n]*\(none\)/);
  });

  it("nothing could be read → exits 1", async () => {
    for (const p of ["/entities", "/proposals", "/focus-sessions"]) {
      h.failing.add(p);
    }
    const c = capture();
    await contextSummary({});
    expect(c.exitSpy).toHaveBeenCalledWith(1);
  });
});
