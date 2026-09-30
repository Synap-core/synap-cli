/**
 * `synap session list --project <id>` — a project is a scope of its own.
 *
 * GRP agent-XP diagnosis 2026-09-28: the MCP and CP doors listed a project's
 * sessions by projectId alone, but the CLI had no flag, and always sent the
 * AMBIENT workspace — so a project whose sessions live in another space read
 * as empty from the terminal. The Hub REST `GET /focus-sessions` accepts
 * projectId alone (project-member floor, lane X1).
 *
 * Pins: the flag forwards `projectId`; with it, the ambient workspace is NOT
 * sent (only an explicit --workspace narrows); without it, behaviour is
 * unchanged (ambient workspace, no projectId).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const hubGet = vi.fn(async () => [] as unknown[]);

vi.mock("../src/lib/hub-client.js", () => ({
  hubGet,
  resolveHubConfig: vi.fn(async () => ({
    podUrl: "http://127.0.0.1:1",
    apiKey: "agent-key",
    workspaceId: "ws-ambient",
  })),
  renderHubError: vi.fn(),
}));

beforeEach(() => {
  hubGet.mockClear();
});

const lastParams = (): Record<string, unknown> => {
  const call = hubGet.mock.calls.at(-1) as unknown as [string, Record<string, unknown>];
  expect(call[0]).toBe("/focus-sessions");
  return call[1];
};

describe("session list --project", () => {
  it("forwards projectId and drops the ambient workspace", async () => {
    const { listSessions } = await import("../src/commands/sessions.js");
    await listSessions({ project: "proj-1", json: true });
    const params = lastParams();
    expect(params.projectId).toBe("proj-1");
    expect(params).not.toHaveProperty("workspaceId");
  });

  it("keeps an EXPLICIT --workspace alongside --project", async () => {
    const { listSessions } = await import("../src/commands/sessions.js");
    await listSessions({ project: "proj-1", workspace: "ws-1", json: true });
    const params = lastParams();
    expect(params.projectId).toBe("proj-1");
    expect(params.workspaceId).toBe("ws-1");
  });

  it("without --project: ambient workspace, no projectId (unchanged)", async () => {
    const { listSessions } = await import("../src/commands/sessions.js");
    await listSessions({ json: true });
    const params = lastParams();
    expect(params.workspaceId).toBe("ws-ambient");
    expect(params).not.toHaveProperty("projectId");
  });

  it("the command registers the flag", async () => {
    const { readFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const src = readFileSync(join(__dirname, "../src/index.ts"), "utf8");
    // Anchored on the `session` group's own list command, so another group's
    // `list` (there are several) cannot satisfy it.
    const start = src.indexOf('session\n  .command("list", { isDefault: true })');
    const end = src.indexOf("listSessions(opts)", start);
    expect(start).toBeGreaterThanOrEqual(0);
    const listBlock = src.slice(start, end);
    expect(listBlock.length).toBeGreaterThan(50);
    expect(listBlock.length).toBeLessThan(1500);
    expect(listBlock).toContain('.option("--project <id>"');
  });
});
