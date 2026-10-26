/**
 * The bridge, driven through its real stdin/stdout pump against a fake pod.
 * Rows where a looser bridge disagrees: the conversation headers must reach
 * EVERY request (not just initialize); the pod-minted Mcp-Session-Id must be
 * echoed after initialize; a pod failure must answer the waiting request (a
 * silent drop hangs Claude Code); SSE and JSON bodies both come through; a
 * notification (no id) gets no invented reply.
 */
import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import { runMcpBridge, sseEvents, withConversationMeta } from "./mcp-bridge.js";
import { conversationHeaders, claudeCodeConversation, cliConversation } from "./conversation-headers.js";

const SID = "8c34a72b-b1c1-4c37-9c1f-02920b69ccb2";

type Seen = { headers: Record<string, string>; body: string };

async function drive(
  lines: unknown[],
  respond: (body: { id?: number; method?: string }, n: number) => Response,
  headers: Record<string, string> = {}
): Promise<{ seen: Seen[]; out: unknown[] }> {
  const input = new PassThrough();
  const output = new PassThrough();
  const chunks: string[] = [];
  output.on("data", (c) => chunks.push(String(c)));
  const seen: Seen[] = [];
  const fetchImpl = (async (_url: string, init: RequestInit) => {
    seen.push({ headers: init.headers as Record<string, string>, body: String(init.body) });
    return respond(JSON.parse(String(init.body)), seen.length);
  }) as unknown as typeof fetch;
  const done = runMcpBridge({ url: "https://pod/mcp", apiKey: "k", headers, input, output, fetchImpl, log: () => {} });
  for (const l of lines) input.write(JSON.stringify(l) + "\n");
  input.end();
  await done;
  const out = chunks.join("").split("\n").filter(Boolean).map((l) => JSON.parse(l));
  return { seen, out };
}

const json = (body: unknown, extra: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json", ...extra } });

describe("runMcpBridge", () => {
  it("names the conversation on every request and echoes the minted session id", async () => {
    const conv = conversationHeaders(SID, "/Users/a/code");
    const { seen, out } = await drive(
      [{ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }],
      () => json({ jsonrpc: "2.0", id: 1, result: { protocolVersion: "2025-11-25" } }, { "mcp-session-id": "minted-1" }),
      conv
    );
    expect(seen[0]!.headers["X-Synap-Conversation"]).toBe(`claude-code:${SID}`);
    expect(seen[0]!.headers["X-Synap-Conversation-Cwd"]).toBe("/Users/a/code");
    expect(out).toEqual([{ jsonrpc: "2.0", id: 1, result: { protocolVersion: "2025-11-25" } }]);

    // Second connection turn: after initialize, the minted id + version ride along.
    const input = new PassThrough();
    const output = new PassThrough();
    const sent: Record<string, string>[] = [];
    let n = 0;
    const fetchImpl = (async (_u: string, init: RequestInit) => {
      sent.push(init.headers as Record<string, string>);
      n += 1;
      return n === 1
        ? json({ jsonrpc: "2.0", id: 1, result: { protocolVersion: "2025-11-25" } }, { "mcp-session-id": "minted-1" })
        : new Response(null, { status: 202 });
    }) as unknown as typeof fetch;
    const done = runMcpBridge({ url: "u", apiKey: "k", headers: conv, input, output, fetchImpl, log: () => {} });
    input.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }) + "\n");
    await new Promise((r) => setTimeout(r, 20));
    input.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
    input.end();
    await done;
    expect(sent[1]!["Mcp-Session-Id"]).toBe("minted-1");
    expect(sent[1]!["Mcp-Protocol-Version"]).toBe("2025-11-25");
    expect(sent[1]!["X-Synap-Conversation"]).toBe(`claude-code:${SID}`);
  });

  it("a pod failure answers the waiting request; a notification gets no reply", async () => {
    const { out } = await drive(
      [
        { jsonrpc: "2.0", id: 7, method: "tools/call", params: {} },
        { jsonrpc: "2.0", method: "notifications/initialized" },
      ],
      () => new Response("boom", { status: 502 })
    );
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ jsonrpc: "2.0", id: 7, error: { code: -32000 } });
    expect((out[0] as { error: { message: string } }).error.message).toContain("HTTP 502");
  });

  it("an SSE body is unwrapped into its messages", async () => {
    const sse = `event: message\ndata: {"jsonrpc":"2.0","id":3,"result":{"ok":true}}\n\n`;
    const { out } = await drive([{ jsonrpc: "2.0", id: 3, method: "tools/list" }], () =>
      new Response(sse, { status: 200, headers: { "content-type": "text/event-stream" } })
    );
    expect(out).toEqual([{ jsonrpc: "2.0", id: 3, result: { ok: true } }]);
  });
});

describe("conversation headers", () => {
  it("only a real Claude Code UUID names a conversation", () => {
    expect(claudeCodeConversation(SID.toUpperCase())).toBe(`claude-code:${SID}`);
    expect(claudeCodeConversation("not-a-uuid")).toBeUndefined();
  });

  it("outside Claude Code the run names itself: one id per process, SYNAP_RUN_ID wins", () => {
    const a = conversationHeaders(undefined, "/x")["X-Synap-Conversation"]!;
    expect(a).toMatch(/^synap-cli:[0-9a-f-]{36}$/);
    expect(conversationHeaders(undefined, "/y")["X-Synap-Conversation"]).toBe(a);
    expect(conversationHeaders(undefined, "/x")).not.toHaveProperty("X-Synap-Conversation-Cwd");
    expect(cliConversation({ SYNAP_RUN_ID: "nightly-42" })).toBe("synap-cli:nightly-42");
    expect(cliConversation({ SYNAP_RUN_ID: "bad id" })).toBe(a);
  });

  it("a non-ASCII cwd is dropped, the conversation still sent", () => {
    expect(conversationHeaders(SID, "/Users/é")).toEqual({ "X-Synap-Conversation": `claude-code:${SID}` });
  });

  it("sseEvents keeps an incomplete event for the next chunk", () => {
    expect(sseEvents("data: a\n\ndata: b")).toEqual({ events: ["a"], rest: "data: b" });
  });
});

describe("conversation in _meta", () => {
  const conv = conversationHeaders(SID, "/Users/a/code");

  it("every forwarded request carries live.synap/conversation (and the cwd) in params._meta", async () => {
    const { seen } = await drive(
      [
        { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "t", _meta: { keep: 1 } } },
        { jsonrpc: "2.0", id: 2, method: "tools/list" },
      ],
      (b) => json({ jsonrpc: "2.0", id: b.id, result: {} }),
      conv
    );
    const bodies = seen.map((s) => JSON.parse(s.body));
    for (const b of bodies) {
      expect(b.params._meta["live.synap/conversation"]).toBe(`claude-code:${SID}`);
      expect(b.params._meta["live.synap/conversationCwd"]).toBe("/Users/a/code");
    }
    expect(bodies.find((b) => b.id === 1).params).toMatchObject({ name: "t", _meta: { keep: 1 } });
  });

  it("leaves responses and header-less bridges untouched", () => {
    const resp = { jsonrpc: "2.0", id: 1, result: {} };
    expect(withConversationMeta(resp, conv)).toEqual(resp);
    const req = { jsonrpc: "2.0", id: 1, method: "ping" };
    expect(withConversationMeta(req, {})).toBe(req);
  });
});
