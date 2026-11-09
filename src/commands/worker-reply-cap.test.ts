/**
 * The worker against a pod that CUTS long MCP replies (backend#906: over
 * 16,000 characters a reply becomes `{truncated:{...}, head}`).
 *
 * Why: on 2026-11-09 the founder's Mac worker restarted in a loop: its whole
 * `synap_list_agents` (27,067 characters) and `synap_orient` (37,416) were cut,
 * and the worker read the envelope as "the roster has no agents list" and
 * "orient carried no handedToYou block (pod too old)". Every test here goes
 * through the REAL MCP client (`createMcpClient`) to a fake pod that applies
 * the cap exactly as `reply-cap.ts` does, so the seam is the wire.
 */
import { describe, expect, it } from "vitest";
import { createMcpClient, McpReplyCappedError } from "../lib/mcp-call.js";
import { readRosterPageWithSelf, resolveWorkerEngine } from "./worker-engine.js";
import { createWorker } from "./worker.js";

const CAP = 16_000;

/** The pod's reply-cap envelope, as `reply-cap.ts` writes it. */
function capped(text: string, tool: string): string {
  if (text.length <= CAP) return text;
  return JSON.stringify({
    truncated: {
      reason: `The reply was ${text.length} characters; the limit is ${CAP}. Only the start of it is shown in \`head\`.`,
      totalChars: text.length,
      shownChars: CAP - 700,
      omittedChars: text.length - (CAP - 700),
      how: tool === "synap_list_agents" ? "Lower `limit` and page with `offset`." : "Narrow the call.",
    },
    head: text.slice(0, CAP - 700),
  });
}

type Handler = (tool: string, args: Record<string, unknown>) => string;

/** A fake pod's `/mcp`: answers the handshake, routes `tools/call` to `handler`, caps every reply. */
function fakePod(handler: Handler) {
  const calls: Array<{ tool: string; args: Record<string, unknown> }> = [];
  const fetchImpl = (async (_url: string, init: { body: string }) => {
    const msg = JSON.parse(init.body) as { id?: number; method: string; params?: { name: string; arguments: Record<string, unknown> } };
    if (msg.method !== "tools/call") {
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: {} }), {
        status: 200,
        headers: { "content-type": "application/json", "mcp-session-id": "s1" },
      });
    }
    const { name, arguments: args } = msg.params!;
    calls.push({ tool: name, args });
    const text = capped(handler(name, args), name);
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { content: [{ type: "text", text }] } }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof fetch;
  return { mcp: createMcpClient({ url: "https://pod/mcp", apiKey: "k", fetchImpl }), calls };
}

/** 47 agents of ~850 characters, like the founder's roster; self is the 33rd. */
const SELF = "agent-33";
const AGENTS = Array.from({ length: 47 }, (_, i) => ({
  agentUserId: `agent-${i + 1}`,
  name: `Agent ${i + 1}`,
  template: i + 1 === 33 ? { slug: "custom-engine", version: "1.0.0", wake: { program: "sh", args: ["-c", "true"] } } : null,
  notes: "x".repeat(700),
}));

/** `synap_list_agents` as backend main pages it (`pageSlice`: default 50, max 200, `nextOffset` only while more remain). */
const listAgents: Handler = (_tool, args) => {
  const limit = Math.min(typeof args.limit === "number" ? args.limit : 50, 200);
  const offset = typeof args.offset === "number" ? args.offset : 0;
  const page = AGENTS.slice(offset, offset + limit);
  const next = offset + limit;
  return JSON.stringify({
    computers: [],
    agents: page,
    total: AGENTS.length,
    offset,
    ...(next < AGENTS.length ? { nextOffset: next } : {}),
  });
};

describe("a capped reply is a named error, never data", () => {
  it("names the tool, the size and the cap, and is never parsed for its head", async () => {
    const { mcp } = fakePod(() => JSON.stringify({ agents: AGENTS }));
    const err = await mcp.call("synap_list_agents", {}).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(McpReplyCappedError);
    expect((err as Error).message).toMatch(/synap_list_agents's reply was cut by the pod's reply cap \(\d+ characters, the limit is 16000\)/);
  });

  it("a reply within the cap, and a tool error, come back as they are", async () => {
    const { mcp } = fakePod((tool) => (tool === "small" ? '{"truncated":false}' : "x"));
    expect(await mcp.call("small", {})).toEqual({ isError: false, text: '{"truncated":false}' });
  });
});

describe("the roster is read a page at a time", () => {
  it("pages synap_list_agents until the page that lists this agent, each page under the cap", async () => {
    const { mcp, calls } = fakePod(listAgents);
    const page = JSON.parse(await readRosterPageWithSelf(mcp, SELF)) as { agents: Array<{ agentUserId: string }> };
    expect(page.agents.some((a) => a.agentUserId === SELF)).toBe(true);
    expect(calls.every((c) => c.tool === "synap_list_agents" && typeof c.args.limit === "number")).toBe(true);
    expect(calls.map((c) => c.args.offset)).toEqual([0, 10, 20, 30]);
  });

  it("the worker's engine comes from that page: the pod's template for this agent", async () => {
    const { mcp } = fakePod(listAgents);
    const engine = await resolveWorkerEngine("custom", mcp, SELF, "/usr/bin:/bin");
    expect(engine.template).toBe("custom-engine");
    expect(engine.source).toBe("pod");
  });

  it("an agent on no page is said by name, not as a cut reply", async () => {
    const { mcp } = fakePod(listAgents);
    await expect(resolveWorkerEngine("custom", mcp, "agent-999", "/usr/bin:/bin")).rejects.toThrow(/does not list this agent \(agent-999\)/);
  });

  it("a pod older than paging answers the whole roster once: read as one page", async () => {
    const small = AGENTS.slice(0, 5);
    const { mcp, calls } = fakePod(() => JSON.stringify({ agents: small.map((a) => ({ ...a, notes: "" })) }));
    const page = await readRosterPageWithSelf(mcp, "agent-2");
    expect(page).toContain("agent-2");
    expect(calls).toHaveLength(1);
  });
});

describe("the worker's poll reads handedToYou through a door the cap cannot cut", () => {
  const briefing = (items: Array<{ id: string }>) =>
    JSON.stringify({ startHere: { pendingReview: { count: 0 }, big: "x".repeat(37_000), handedToYou: { count: items.length, items } } });

  const worker = (mcp: ReturnType<typeof fakePod>["mcp"], readOrientRest?: () => Promise<string>) => {
    const lines: string[] = [];
    const w = createWorker(
      { agent: "cap-test", cwd: "/nonexistent-cap-test", protocols: "work-folder" },
      { mcp, podUrl: "https://pod", apiKey: "k", selfAgentId: "self", say: (l) => lines.push(l), readOrientRest }
    );
    return { w, lines };
  };

  it("asks orient for only:'handedToYou' and reads the block whole", async () => {
    const { mcp, calls } = fakePod((tool, args) =>
      tool === "synap_orient" && args.only === "handedToYou"
        ? JSON.stringify({ handedToYou: { count: 0, items: [] } })
        : briefing([])
    );
    const { w } = worker(mcp, async () => {
      throw new Error("the Hub door must not be read when the narrow read answers");
    });
    expect(await w.tick()).toEqual({ handed: 0, launched: 0 });
    expect(calls.find((c) => c.tool === "synap_orient")?.args).toEqual({ only: "handedToYou" });
  });

  it("a pod older than the narrow read (its briefing cut): the uncapped Hub orient door answers", async () => {
    const { mcp, calls } = fakePod(() => briefing([]));
    let restReads = 0;
    const { w } = worker(mcp, async () => {
      restReads++;
      return briefing([]);
    });
    expect(await w.tick()).toEqual({ handed: 0, launched: 0 });
    expect(restReads).toBe(1);
    // The MCP call is still made: its runner stamp tells the pod a process serves this agent.
    expect(calls.filter((c) => c.tool === "synap_orient")).toHaveLength(1);
  });

  it("cut and no Hub door either: an error naming the tool, the cap and the fix — never 'pod too old'", async () => {
    const { mcp } = fakePod(() => briefing([]));
    const { w } = worker(mcp, async () => {
      throw new Error("GRANT_DOOR_UNSUPPORTED");
    });
    const err = (await w.tick().catch((e: unknown) => e)) as Error;
    expect(err.message).toMatch(/synap_orient's reply was cut by the pod's reply cap .*the limit is 16000/);
    expect(err.message).toMatch(/update the pod \(backend#932\)/);
    expect(err.message).not.toMatch(/pod too old/);
  });
});

describe("a handed session is read lean: the full read is over the cap", () => {
  it("reads how to run it from get_session detail:'lean' (a fresh session's full read is ~20,000 characters)", async () => {
    const sid = "aaaaaaaa-0000-4000-8000-00000000000a";
    const { mcp, calls } = fakePod((tool, args) => {
      if (tool === "synap_orient") return JSON.stringify({ handedToYou: { count: 1, items: [{ id: sid, goal: "g" }] } });
      if (tool === "synap_get_session" && args.detail === "lean")
        return JSON.stringify({ session: { id: sid, playbookId: "p-1", channelId: null }, outcomes: { status: "ok", outcomes: [] } });
      if (tool === "synap_get_session") return JSON.stringify({ session: { id: sid, playbookId: "p-1" }, continuation: "x".repeat(20_000) });
      return "{}";
    });
    const lines: string[] = [];
    // This worker takes code runs only: a playbook run (work-folder) is refused by name, which proves its shape was read.
    const w = createWorker(
      { agent: "cap-test", cwd: "/nonexistent-cap-test", protocols: "code" },
      { mcp, podUrl: "https://pod", apiKey: "k", selfAgentId: "self", say: (l) => lines.push(l) }
    );
    await w.tick();
    expect(lines.join("\n")).toMatch(/a work-folder session — this worker takes code runs only/);
    expect(lines.join("\n")).not.toMatch(/could not read how to run it/);
    expect(calls.filter((c) => c.tool === "synap_get_session").every((c) => c.args.detail === "lean")).toBe(true);
  });
});
