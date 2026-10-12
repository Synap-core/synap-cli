/**
 * The stdio MCP bridge — `synap mcp bridge`.
 *
 * WHY IT EXISTS: a Claude Code conversation's own id is what lets a person
 * reopen the agent that did a piece of work (`claude --resume <id>`). Claude
 * Code hands that id to a STDIO MCP server (`CLAUDE_CODE_SESSION_ID`, plus its
 * cwd) but never to an HTTP one — tested against 2.1.296: `${VAR}` in `headers`
 * is sent literally and `headersHelper` runs without it. So Claude Code spawns
 * this bridge over stdio, and the bridge forwards every JSON-RPC message to the
 * pod's Streamable-HTTP `/mcp`, adding `X-Synap-Conversation` +
 * `X-Synap-Conversation-Cwd`. The pod reads the header as the conversation half
 * of the client key, so every session the conversation touches records it.
 *
 * Transparent by design: it never parses tool payloads, only the envelope
 * (ids, for an error reply when the pod cannot be reached — a request with no
 * reply hangs the client). The pod is stateless, so there is no server→client
 * GET stream to hold open.
 *
 * Known edge: the id is fixed at spawn. After `/clear` Claude Code starts a new
 * session id, but MCP writes keep the pre-clear one (its transcript up to the
 * clear stays resumable). CLI calls send the live id (`hub-client.ts`).
 */

import readline from "node:readline";

type JsonRpcId = string | number;
type JsonRpcMessage = { jsonrpc?: string; id?: JsonRpcId | null; method?: string; result?: unknown };

export interface McpBridgeOptions {
  url: string;
  apiKey: string;
  /** Extra headers on every request (the conversation headers). */
  headers?: Record<string, string>;
  input?: NodeJS.ReadableStream;
  output?: NodeJS.WritableStream;
  fetchImpl?: typeof fetch;
  log?: (line: string) => void;
}

/** Ids of the REQUESTS in a message (a batch may carry several). */
function requestIds(msg: unknown): JsonRpcId[] {
  const items = Array.isArray(msg) ? msg : [msg];
  return items
    .filter(
      (m): m is JsonRpcMessage =>
        !!m && typeof m === "object" && typeof (m as JsonRpcMessage).method === "string"
    )
    .map((m) => m.id)
    .filter((id): id is JsonRpcId => typeof id === "string" || typeof id === "number");
}

/** Parse SSE text into the `data:` payload of each complete event. */
export function sseEvents(buffer: string): { events: string[]; rest: string } {
  const events: string[] = [];
  const blocks = buffer.split(/\r?\n\r?\n/);
  const rest = blocks.pop() ?? "";
  for (const block of blocks) {
    const data = block
      .split(/\r?\n/)
      .filter((l) => l.startsWith("data:"))
      .map((l) => l.slice(5).replace(/^ /, ""))
      .join("\n");
    if (data) events.push(data);
  }
  return { events, rest };
}

/**
 * Pump stdin → pod → stdout until stdin closes and every in-flight request has
 * answered. Resolves when done; never rejects (failures become JSON-RPC errors).
 */
export async function runMcpBridge(opts: McpBridgeOptions): Promise<void> {
  const input = opts.input ?? process.stdin;
  const output = opts.output ?? process.stdout;
  const doFetch = opts.fetchImpl ?? fetch;
  const log = opts.log ?? ((line: string) => process.stderr.write(`[synap mcp bridge] ${line}\n`));
  let sessionId: string | undefined;
  let protocolVersion: string | undefined;
  const inFlight = new Set<Promise<void>>();

  const write = (msg: unknown) => {
    if (msg && typeof msg === "object") {
      const m = msg as JsonRpcMessage;
      const v = (m.result as { protocolVersion?: unknown } | undefined)?.protocolVersion;
      if (typeof v === "string") protocolVersion = v;
    }
    output.write(JSON.stringify(msg) + "\n");
  };
  const writeAll = (payload: unknown) =>
    Array.isArray(payload) ? payload.forEach(write) : write(payload);
  const fail = (ids: JsonRpcId[], message: string) => {
    log(message);
    for (const id of ids) write({ jsonrpc: "2.0", id, error: { code: -32000, message } });
  };

  const forward = async (line: string) => {
    let msg: unknown;
    try {
      msg = JSON.parse(line);
    } catch {
      log("dropped a line that is not JSON");
      return;
    }
    const ids = requestIds(msg);
    try {
      const res = await doFetch(opts.url, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${opts.apiKey}`,
          "Content-Type": "application/json",
          Accept: "application/json, text/event-stream",
          ...(sessionId ? { "Mcp-Session-Id": sessionId } : {}),
          ...(protocolVersion ? { "Mcp-Protocol-Version": protocolVersion } : {}),
          ...opts.headers,
        },
        body: line,
      });
      const minted = res.headers.get("mcp-session-id");
      if (minted) sessionId = minted;
      if (!res.ok) {
        const text = await res.text().catch(() => "");
        fail(ids, `Synap pod answered HTTP ${res.status}${text ? `: ${text.slice(0, 300)}` : ""}`);
        return;
      }
      const type = res.headers.get("content-type") ?? "";
      if (type.includes("text/event-stream") && res.body) {
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        for (;;) {
          const { done, value } = await reader.read();
          buffer += done ? decoder.decode() : decoder.decode(value, { stream: true });
          const { events, rest } = sseEvents(done ? buffer + "\n\n" : buffer);
          buffer = rest;
          for (const data of events) {
            try {
              writeAll(JSON.parse(data));
            } catch {
              log("dropped an event that is not JSON");
            }
          }
          if (done) break;
        }
        return;
      }
      const text = await res.text();
      if (text.trim()) writeAll(JSON.parse(text));
    } catch (err) {
      fail(ids, `Synap pod unreachable at ${opts.url}: ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  const rl = readline.createInterface({ input, crlfDelay: Infinity });
  for await (const raw of rl) {
    const line = raw.trim();
    if (!line) continue;
    const p = forward(line).finally(() => inFlight.delete(p));
    inFlight.add(p);
  }
  await Promise.all(inFlight);
}
