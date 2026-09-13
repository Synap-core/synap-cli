/**
 * Door-parity tripwire: `synap agent run` / `agent schedule` / `data update`
 * must never send a raw config sentinel as `body.userId`.
 *
 * The pod's Hub REST identity check (`mayActAsUser`,
 * synap-backend/packages/api/src/routers/hub-protocol/rest/_shared.ts) now
 * 403s a `body.userId` that is neither the authenticated user nor the key's
 * own agent principal. `HubConfig.userId` can legitimately hold a CLI
 * sentinel ("cli", "agent", or a saved pod-profile name — see
 * `resolveHubConfig` in `src/lib/hub-client.ts`), so any call site that
 * forwarded `cfg.userId` verbatim into a POST/PATCH body now breaks every
 * write for a caller resolved via those branches.
 *
 * These tests pin the wire body, not the resolution logic, so the
 * regression (re-adding a raw `userId: cfg.userId`) cannot silently return.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const SENTINEL_USER_IDS = ["cli", "agent", "my-pod"];

const hubPost = vi.fn(async () => ({ id: "entity-1" }));
const hubPatch = vi.fn(async () => ({ id: "entity-1" }));
const hubGet = vi.fn(async () => ({ id: "user-1" }));

vi.mock("../src/lib/hub-client.js", () => ({
  hubPost,
  hubPatch,
  hubGet,
  resolveHubConfig: vi.fn(async () => ({
    podUrl: "http://127.0.0.1:1",
    apiKey: "agent-key",
    // The sentinel a caller resolved through the --pod-url/--api-key escape
    // hatch, SYNAP_AGENT override, or a saved pod profile can carry here —
    // see hub-client.ts:~602/~615/~695. Never a real pod user id.
    userId: "my-pod",
    workspaceId: "ws-1",
  })),
  resolveUserId: vi.fn(async () => "real-user-1"),
  renderHubError: vi.fn(),
  resolveActiveSessionId: vi.fn(async () => undefined),
}));

beforeEach(() => {
  hubPost.mockClear();
  hubPatch.mockClear();
  hubGet.mockClear();
});

function assertNoSentinelUserId(body: Record<string, unknown>): void {
  if (!("userId" in body)) return; // omitted entirely — the clean fix
  expect(SENTINEL_USER_IDS).not.toContain(body.userId);
}

describe("agent-run — no raw cfg.userId sentinel on the wire", () => {
  it("agentSchedule (add) never sends cfg.userId as body.userId", async () => {
    const { agentSchedule } = await import("../src/commands/agent-run.js");
    await agentSchedule({
      goal: "check the news",
      name: "daily-check",
      every: "daily",
    });

    expect(hubPost).toHaveBeenCalled();
    const [path, body] = hubPost.mock.calls[0] as unknown as [
      string,
      Record<string, unknown>,
    ];
    expect(path).toBe("/entities");
    assertNoSentinelUserId(body);
  });

  it("storeResearch (via agentRun) never sends cfg.userId as body.userId", async () => {
    const originalFetch = global.fetch;
    global.fetch = vi.fn(async () =>
      new Response(
        JSON.stringify({ choices: [{ message: { content: "done" }, finish_reason: "stop" }] }),
        { status: 200 }
      )
    ) as unknown as typeof fetch;

    try {
      const { agentRun } = await import("../src/commands/agent-run.js");
      await agentRun({ goal: "research X" });
    } finally {
      global.fetch = originalFetch;
    }

    expect(hubPost).toHaveBeenCalled();
    const call = hubPost.mock.calls.find(([path]) => path === "/entities");
    expect(call).toBeDefined();
    const [, body] = call as unknown as [string, Record<string, unknown>];
    assertNoSentinelUserId(body);
  });
});

describe("data update — no raw cfg.userId sentinel on the wire", () => {
  it("updateEntity never sends cfg.userId as body.userId", async () => {
    const { updateEntity } = await import("../src/commands/data.js");
    await updateEntity("entity-1", { props: '{"name":"x"}', json: true });

    expect(hubPatch).toHaveBeenCalled();
    const [, body] = hubPatch.mock.calls[0] as unknown as [
      string,
      Record<string, unknown>,
    ];
    assertNoSentinelUserId(body);
  });
});
