/**
 * `synap session post <toSessionId> <text>` — pins:
 *   • it posts into the TARGET session's room with `intent`, `cause`,
 *     `fromSessionId` and `refs` as the Hub door names them, role assistant;
 *   • a delivery the pod stamped exits 0;
 *   • a pod that predates coordination posts (no `sessionPost` in its reply:
 *     it dropped `intent` and stored a plain room post) exits 1 and says so —
 *     never reported as delivered;
 *   • `--ref kind:id[:label]` parses, a label may hold colons.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { parseRef, sessionPostCommand } from "../src/commands/session-post.js";
import { log } from "../src/utils/logger.js";

const TARGET = "11111111-1111-1111-1111-111111111111";
const ROOM = "99999999-9999-9999-9999-999999999999";
const CAUSE = "55555555-5555-5555-5555-555555555555";
const OPTS = { podUrl: "https://pod.example.test", apiKey: "k" };

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

let warned: string[];
let posted: Record<string, unknown> | undefined;

function stubPod(postReply: unknown) {
  posted = undefined;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      const u = new URL(url);
      if (u.pathname === `/api/hub/focus-sessions/${TARGET}`) return json({ id: TARGET, channelId: ROOM });
      if (u.pathname === `/api/hub/threads/${ROOM}/messages` && init?.method === "POST") {
        posted = JSON.parse(String(init.body));
        return json(postReply);
      }
      throw new Error(`unexpected fetch: ${url}`);
    })
  );
}

async function exitCodeOf(run: () => Promise<void>): Promise<number | undefined> {
  try {
    await run();
  } catch (e) {
    const m = /process\.exit\((\d+)\)/.exec((e as Error).message);
    if (m) return Number(m[1]);
    throw e;
  }
  return undefined;
}

beforeEach(() => {
  vi.stubEnv("SYNAP_USER_ID", "owner-1");
  warned = [];
  vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
    throw new Error(`process.exit(${code})`);
  }) as never);
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(log, "warn").mockImplementation((m: string) => void warned.push(m));
  for (const level of ["success", "info", "error", "hint", "dim"] as const) {
    vi.spyOn(log, level).mockImplementation((() => {}) as never);
  }
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("sessionPostCommand", () => {
  it("posts into the target's room with intent, cause, sender and refs, and exits 0 on a stamped delivery", async () => {
    stubPod({
      success: true,
      messageId: "m-1",
      sessionPost: { intent: "done", from: { sessionId: "s-a" }, to: { sessionId: TARGET }, hop: 1, wake: false },
    });
    const code = await exitCodeOf(() =>
      sessionPostCommand(TARGET, ["keys", "are", "in"], {
        ...OPTS,
        intent: "done",
        cause: CAUSE,
        from: "22222222-2222-2222-2222-222222222222",
        ref: ["session:33333333-3333-3333-3333-333333333333"],
      })
    );
    expect(code).toBe(0);
    expect(posted).toEqual({
      role: "assistant",
      content: "keys are in",
      userId: "owner-1",
      intent: "done",
      fromSessionId: "22222222-2222-2222-2222-222222222222",
      refs: [{ kind: "session", id: "33333333-3333-3333-3333-333333333333" }],
      cause: CAUSE,
    });
    expect(warned).toEqual([]);
  });

  it("a pod that does not deliver agent messages: exit 1 and a plain warning, never 'sent'", async () => {
    stubPod({ success: true, messageId: "m-2" });
    const code = await exitCodeOf(() => sessionPostCommand(TARGET, ["hello"], { ...OPTS, intent: "handoff" }));
    expect(code).toBe(1);
    expect(posted?.intent).toBe("handoff");
    expect(warned.join("\n")).toContain("does not deliver agent messages yet");
  });

  it("intent defaults to fyi (the one that never wakes)", async () => {
    stubPod({
      success: true,
      messageId: "m-3",
      sessionPost: { intent: "fyi", from: { sessionId: null }, to: { sessionId: TARGET }, hop: 0, wake: false },
    });
    await exitCodeOf(() => sessionPostCommand(TARGET, ["fyi"], { ...OPTS }));
    expect(posted?.intent).toBe("fyi");
  });
});

describe("parseRef", () => {
  it("reads kind:id and kind:id:label (a label may hold colons)", () => {
    expect(parseRef("proposal:abc")).toEqual({ kind: "proposal", id: "abc" });
    expect(parseRef("slot:abc:Stripe key: EU")).toEqual({ kind: "slot", id: "abc", label: "Stripe key: EU" });
    expect(() => parseRef("session")).toThrow(/kind:id/);
  });
});
