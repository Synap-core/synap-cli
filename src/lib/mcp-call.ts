/**
 * A minimal MCP `tools/call` client over the pod's Streamable-HTTP `/mcp` door.
 *
 * For CLI commands that must read an AGENT-facing tool as a named agent: the
 * worker reads `synap_orient`'s `handedToYou`, and the Hub `/orient` REST door
 * refuses grant-scoped agent keys (GRANT_DOOR_UNSUPPORTED) while the MCP door
 * serves them. One MCP session per client, re-initialised once if the pod
 * forgets it. Replies may be plain JSON or SSE; both are read.
 *
 * A FAILED call is never an empty result: transport and JSON-RPC errors throw,
 * and a tool error comes back as `isError: true` with the pod's text.
 */

export interface McpToolResult {
  isError: boolean;
  text: string;
}

/** Extra headers for ONE call (the worker's runner stamp, a run's runner headers); the handshake never carries them. */
export interface McpCallExtras {
  headers?: Record<string, string>;
}

export interface McpCallClient {
  call(tool: string, args?: Record<string, unknown>, extras?: McpCallExtras): Promise<McpToolResult>;
}

export interface McpCallOptions {
  /** The pod's MCP endpoint, e.g. `https://pod.example/mcp`. */
  url: string;
  apiKey: string;
  clientName?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

/** The `data:` payload of the LAST complete SSE event, or the body itself. */
export function lastJsonPayload(body: string): string {
  if (!/^\s*(event:|data:)/m.test(body)) return body;
  const data = body
    .split(/\r?\n/)
    .filter((l) => l.startsWith("data:"))
    .map((l) => l.slice(5).replace(/^ /, ""));
  return data.length ? data[data.length - 1] : "";
}

export function createMcpClient(opts: McpCallOptions): McpCallClient {
  const doFetch = opts.fetchImpl ?? fetch;
  const timeoutMs = opts.timeoutMs ?? 120_000;
  let sessionId: string | undefined;
  let initialized = false;
  let nextId = 1;

  const post = async (message: Record<string, unknown>, extra: Record<string, string> = {}) => {
    const headers: Record<string, string> = {
      ...extra,
      Authorization: `Bearer ${opts.apiKey}`,
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
    };
    if (sessionId) headers["mcp-session-id"] = sessionId;
    const res = await doFetch(opts.url, {
      method: "POST",
      headers,
      body: JSON.stringify(message),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const minted = res.headers.get("mcp-session-id");
    if (minted) sessionId = minted;
    const body = await res.text();
    return { status: res.status, body };
  };

  const initialize = async () => {
    sessionId = undefined;
    const { status, body } = await post({
      jsonrpc: "2.0",
      id: nextId++,
      method: "initialize",
      params: {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: opts.clientName ?? "synap-cli", version: "1" },
      },
    });
    if (status < 200 || status >= 300) {
      throw new Error(`MCP initialize failed (HTTP ${status}): ${body.slice(0, 200)}`);
    }
    // Notifications get no reply; a failure here is not fatal to the session.
    await post({ jsonrpc: "2.0", method: "notifications/initialized", params: {} }).catch(() => undefined);
    initialized = true;
  };

  const callOnce = async (tool: string, args: Record<string, unknown>, extra?: Record<string, string>) => {
    if (!initialized) await initialize();
    return post(
      {
        jsonrpc: "2.0",
        id: nextId++,
        method: "tools/call",
        params: { name: tool, arguments: args },
      },
      extra
    );
  };

  return {
    async call(tool, args = {}, extras = {}) {
      let { status, body } = await callOnce(tool, args, extras.headers);
      if (status === 404 || status === 400) {
        // The pod forgot the session (restart, expiry): one fresh handshake.
        initialized = false;
        ({ status, body } = await callOnce(tool, args, extras.headers));
      }
      if (status < 200 || status >= 300) {
        throw new Error(`MCP ${tool} failed (HTTP ${status}): ${body.slice(0, 300)}`);
      }
      const payload = lastJsonPayload(body);
      let msg: { error?: { message?: string }; result?: { isError?: boolean; content?: Array<{ type?: string; text?: string }> } };
      try {
        msg = JSON.parse(payload);
      } catch {
        throw new Error(`MCP ${tool} returned an unreadable reply: ${payload.slice(0, 200)}`);
      }
      if (msg.error) throw new Error(`MCP ${tool} error: ${msg.error.message ?? JSON.stringify(msg.error)}`);
      const text = (msg.result?.content ?? [])
        .filter((c) => c.type === "text" && typeof c.text === "string")
        .map((c) => c.text as string)
        .join("");
      return { isError: Boolean(msg.result?.isError), text };
    },
  };
}
