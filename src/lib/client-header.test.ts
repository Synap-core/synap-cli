/**
 * Every call names its client program (`X-Synap-Client: <name>/<version>`), so
 * the pod's usage telemetry can tell the CLI, its stdio MCP bridge and the
 * synap-bridge mod apart on one key and one conversation.
 *
 * Driven through the real doors: `hubGet` (every Hub call goes through
 * `sessionHeaders`), the real bridge pump, and the `synap mcp bridge` command.
 */
import { readFileSync } from "node:fs";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";

const captured = vi.hoisted(() => ({ opts: undefined as undefined | { headers?: Record<string, string> } }));
vi.mock("./mcp-bridge.js", async (orig) => {
  const real = await orig<typeof import("./mcp-bridge.js")>();
  return {
    ...real,
    runMcpBridge: vi.fn(async (opts: { headers?: Record<string, string> }) => {
      captured.opts = opts;
    }),
  };
});

import { hubGet } from "./hub-client.js";
import { mcpBridgeHeaders, CLIENT_HEADER, RUNNER_HEADER, clientHeader } from "./conversation-headers.js";
import { mcpBridge } from "../commands/mcp.js";

const VERSION = (
  JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")) as { version: string }
).version;

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("X-Synap-Client", () => {
  it("names the package version; an unusable version says unknown", () => {
    expect(VERSION).toMatch(/^\d+\.\d+\.\d+/);
    expect(clientHeader("synap-cli")).toEqual({ [CLIENT_HEADER]: `synap-cli/${VERSION}` });
    expect(clientHeader("synap-cli", "1 2")).toEqual({ [CLIENT_HEADER]: "synap-cli/unknown" });
  });

  it("every Hub call sends synap-cli/<version>", async () => {
    const seen: Record<string, string>[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init: RequestInit) => {
        seen.push(init.headers as Record<string, string>);
        return new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      })
    );
    await hubGet("/workspaces", {}, { podUrl: "https://pod.example", apiKey: "k" } as never);
    expect(seen).toHaveLength(1);
    expect(seen[0]![CLIENT_HEADER]).toBe(`synap-cli/${VERSION}`);
    // The worker's served stamp is the worker poll's alone: an ordinary command never claims it.
    expect(seen[0]![RUNNER_HEADER]).toBeUndefined();
  });

  it("the stdio MCP bridge sends synap-cli-mcp/<version> on every request", async () => {
    const { runMcpBridge } = await vi.importActual<typeof import("./mcp-bridge.js")>("./mcp-bridge.js");
    const input = new PassThrough();
    const output = new PassThrough();
    const sent: Record<string, string>[] = [];
    const fetchImpl = (async (_u: string, init: RequestInit) => {
      sent.push(init.headers as Record<string, string>);
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: sent.length, result: {} }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as unknown as typeof fetch;
    const done = runMcpBridge({
      url: "https://pod/mcp",
      apiKey: "k",
      headers: mcpBridgeHeaders(undefined, "/x"),
      input,
      output,
      fetchImpl,
      log: () => {},
    });
    input.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }) + "\n");
    input.write(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" }) + "\n");
    input.end();
    await done;
    expect(sent.length).toBe(2);
    for (const h of sent) expect(h[CLIENT_HEADER]).toBe(`synap-cli-mcp/${VERSION}`);
    for (const h of sent) expect(h[RUNNER_HEADER]).toBeUndefined();
  });

  it("`synap mcp bridge` hands the bridge those headers", async () => {
    vi.stubEnv("SYNAP_HUB_API_KEY", "k");
    await mcpBridge({ url: "https://pod/mcp" });
    expect(captured.opts?.headers?.[CLIENT_HEADER]).toBe(`synap-cli-mcp/${VERSION}`);
    expect(captured.opts?.headers?.["X-Synap-Conversation"]).toBeTruthy();
  });
});
