/**
 * The bridge, driven through its real stdin/stdout pump against a fake pod.
 * Rows where a looser bridge disagrees: the conversation headers must reach
 * EVERY request (not just initialize); the pod-minted Mcp-Session-Id must be
 * echoed after initialize; a pod failure must answer the waiting request (a
 * silent drop hangs Claude Code); SSE and JSON bodies both come through; a
 * notification (no id) gets no invented reply.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import { runMcpBridge, sseEvents, toolsListCachePath, withConversationMeta } from "./mcp-bridge.js";
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

describe("tools/list cache (an account switch must not drop the tools)", () => {
  const list = (names: string[], id = 1) => ({
    jsonrpc: "2.0",
    id,
    result: { tools: names.map((name) => ({ name })) },
  });
  const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "synap-bridge-cache-"));

  /** One bridge process: sends `tools/list`, the pod answers with `pod`. */
  async function run(
    cacheDir: string,
    pod: (init: RequestInit) => Promise<Response>,
    extra: { apiKey?: string; waitMs?: number; maxAgeMs?: number; params?: unknown } = {}
  ) {
    const input = new PassThrough();
    const output = new PassThrough();
    const chunks: string[] = [];
    output.on("data", (c) => chunks.push(String(c)));
    const fetchImpl = ((_u: string, init: RequestInit) => pod(init)) as unknown as typeof fetch;
    const done = runMcpBridge({
      url: "https://pod/mcp",
      apiKey: extra.apiKey ?? "k",
      input,
      output,
      fetchImpl,
      log: () => {},
      cacheDir,
      toolsListWaitMs: extra.waitMs ?? 30,
      toolsListMaxAgeMs: extra.maxAgeMs,
    });
    input.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: extra.params }) + "\n");
    input.end();
    await done;
    return chunks.join("").split("\n").filter(Boolean).map((l) => JSON.parse(l));
  }
  const ok = (names: string[]) => async () => json(list(names));
  const down = async () => new Response("bad gateway", { status: 502 });

  it("a good list is cached, then answers when the pod fails", async () => {
    const dir = tmp();
    expect(await run(dir, ok(["a", "b"]))).toEqual([list(["a", "b"])]);
    expect(await run(dir, down)).toEqual([list(["a", "b"])]);
  });

  it("a pod that does not answer in time is answered from the cache, once; a changed list is announced", async () => {
    const dir = tmp();
    await run(dir, ok(["a"]));
    const late = async () => {
      await new Promise((r) => setTimeout(r, 120));
      return json(list(["a", "c"]));
    };
    const out = await run(dir, late);
    expect(out).toEqual([list(["a"]), { jsonrpc: "2.0", method: "notifications/tools/list_changed" }]);
    // the refresh was kept: the next outage serves the NEW list
    expect(await run(dir, down)).toEqual([list(["a", "c"])]);
  });

  it("a late, identical list sends no notification", async () => {
    const dir = tmp();
    await run(dir, ok(["a"]));
    const late = async () => {
      await new Promise((r) => setTimeout(r, 120));
      return json(list(["a"]));
    };
    expect(await run(dir, late)).toEqual([list(["a"])]);
  });

  it("no cache yet: the failure and the slow pod behave as before", async () => {
    const out = await run(tmp(), down);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ id: 1, error: { code: -32000 } });
    const slow = async () => {
      await new Promise((r) => setTimeout(r, 120));
      return json(list(["a"]));
    };
    expect(await run(tmp(), slow)).toEqual([list(["a"])]);
  });

  it("a JSON-RPC error from the pod is not cached and the cache answers it", async () => {
    const dir = tmp();
    const err = async () => json({ jsonrpc: "2.0", id: 1, error: { code: -32603, message: "boom" } });
    expect((await run(dir, err))[0]).toMatchObject({ error: { message: "boom" } });
    await run(dir, ok(["a"]));
    expect(await run(dir, err)).toEqual([list(["a"])]);
  });

  it("a paged list is neither cached nor intercepted", async () => {
    const dir = tmp();
    const paged = async () => json({ jsonrpc: "2.0", id: 1, result: { tools: [{ name: "a" }], nextCursor: "p2" } });
    await run(dir, paged);
    expect(fs.readdirSync(dir)).toEqual([]);
    await run(dir, ok(["a"]));
    // a request carrying a cursor goes straight to the pod, even when it fails
    const out = await run(dir, down, { params: { cursor: "p2" } });
    expect(out[0]).toMatchObject({ id: 1, error: { code: -32000 } });
  });

  it("the cache belongs to a key: another key never gets this key's tools", async () => {
    const dir = tmp();
    await run(dir, ok(["a"]), { apiKey: "key-1" });
    expect(toolsListCachePath(dir, "https://pod/mcp", "key-1")).not.toBe(toolsListCachePath(dir, "https://pod/mcp", "key-2"));
    expect((await run(dir, down, { apiKey: "key-2" }))[0]).toMatchObject({ error: { code: -32000 } });
    expect(fs.readFileSync(toolsListCachePath(dir, "https://pod/mcp", "key-1"), "utf8")).not.toContain("key-1");
  });

  it("a cache older than the max age is not served", async () => {
    const dir = tmp();
    await run(dir, ok(["a"]));
    await new Promise((r) => setTimeout(r, 20));
    expect((await run(dir, down, { maxAgeMs: 5 }))[0]).toMatchObject({ error: { code: -32000 } });
  });
});
