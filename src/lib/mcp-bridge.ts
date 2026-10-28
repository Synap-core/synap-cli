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
 * ONE method is not transparent: `tools/list`. Claude Code asks for it once per
 * spawn and never retries a failure, so a bridge restarted in a herd (an account
 * switch moves every session at once) that meets a slow pod leaves the synap
 * tools absent for the process's whole life. The bridge keeps the last good list
 * on disk per (pod URL, key) and, when the pod fails or has not answered within
 * `toolsListWaitMs`, answers from it; the real call carries on in the background
 * and a changed list is announced with `notifications/tools/list_changed` (the
 * pod declares `tools.listChanged`). No cache yet = today's behaviour exactly.
 *
 * Known edge: the id is fixed at spawn. After `/clear` Claude Code starts a new
 * session id, but MCP writes keep the pre-clear one (its transcript up to the
 * clear stays resumable). CLI calls send the live id (`hub-client.ts`).
 */

import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import { writeFileAtomic } from "./atomic-file.js";
import {
  CONVERSATION_CWD_HEADER,
  CONVERSATION_CWD_META_KEY,
  CONVERSATION_HEADER,
  CONVERSATION_META_KEY,
} from "./conversation-headers.js";

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
  /** Where the last good tools/list is kept. Default `~/.synap/cache`. */
  cacheDir?: string;
  /** How long a tools/list may wait for the pod before the cache answers. Default 5 s. */
  toolsListWaitMs?: number;
  /** How long a cached list may be served at all. Default 7 days. */
  toolsListMaxAgeMs?: number;
}

const TOOLS_LIST_WAIT_MS = 5_000;
const TOOLS_LIST_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
/** The background refresh after a cache answer must not hold the process open for ever. */
const TOOLS_LIST_REFRESH_LIMIT_MS = 60_000;

type ToolsListCache = { savedAt: number; result: { tools: unknown[] } };

/** One file per (MCP URL, key): the list depends on the key's profile and the URL's lens. */
export function toolsListCachePath(dir: string, url: string, apiKey: string): string {
  const h = createHash("sha256").update(`${url}\n${apiKey}`).digest("hex").slice(0, 24);
  return path.join(dir, `mcp-tools-${h}.json`);
}

/** A plain first-page tools/list REQUEST: the only shape the cache can stand in for. */
function isPlainToolsList(msg: unknown): msg is { id: JsonRpcId; method: string; params?: { cursor?: unknown } } {
  if (!msg || Array.isArray(msg) || typeof msg !== "object") return false;
  const m = msg as JsonRpcMessage & { params?: { cursor?: unknown } };
  return (
    m.method === "tools/list" &&
    (typeof m.id === "string" || typeof m.id === "number") &&
    (m.params?.cursor === undefined || m.params.cursor === null)
  );
}

/** The reply's `result.tools` when it is a complete (single-page) list, else undefined. */
function completeToolsResult(payload: unknown): { tools: unknown[] } | undefined {
  if (!payload || Array.isArray(payload) || typeof payload !== "object") return undefined;
  const r = (payload as JsonRpcMessage).result as { tools?: unknown; nextCursor?: unknown } | undefined;
  if (!r || !Array.isArray(r.tools) || r.nextCursor) return undefined;
  return r as { tools: unknown[] };
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

/**
 * The line with `params._meta["live.synap/conversation"]` (and the cwd) set on
 * every request, from the same conversation the headers carry, for a path that
 * cannot set headers. The header still wins at the pod. Responses, and a line
 * that is not an object, pass through untouched.
 */
export function withConversationMeta(msg: unknown, headers: Record<string, string> | undefined): unknown {
  const conversation = headers?.[CONVERSATION_HEADER];
  if (!conversation) return msg;
  const cwd = headers?.[CONVERSATION_CWD_HEADER];
  const stamp = (m: unknown) => {
    if (!m || typeof m !== "object" || typeof (m as JsonRpcMessage).method !== "string") return m;
    const params = ((m as { params?: unknown }).params ?? {}) as Record<string, unknown>;
    if (typeof params !== "object" || Array.isArray(params)) return m;
    const meta = (params._meta ?? {}) as Record<string, unknown>;
    return {
      ...(m as object),
      params: {
        ...params,
        _meta: {
          ...meta,
          [CONVERSATION_META_KEY]: conversation,
          ...(cwd ? { [CONVERSATION_CWD_META_KEY]: cwd } : {}),
        },
      },
    };
  };
  return Array.isArray(msg) ? msg.map(stamp) : stamp(msg);
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

  const cacheDir = opts.cacheDir ?? path.join(os.homedir(), ".synap", "cache");
  const cacheFile = toolsListCachePath(cacheDir, opts.url, opts.apiKey);
  const readCache = (): ToolsListCache | undefined => {
    try {
      const c = JSON.parse(fs.readFileSync(cacheFile, "utf8")) as ToolsListCache;
      const fresh = Date.now() - c.savedAt <= (opts.toolsListMaxAgeMs ?? TOOLS_LIST_MAX_AGE_MS);
      return fresh && completeToolsResult({ result: c.result }) ? c : undefined;
    } catch {
      return undefined; // absent or unreadable: no cache, the pod answers alone
    }
  };
  const writeCache = (result: { tools: unknown[] }) => {
    try {
      writeFileAtomic(cacheFile, JSON.stringify({ savedAt: Date.now(), result }));
    } catch (err) {
      log(`could not write the tools cache: ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  /** POST one message to the pod; what comes back goes to `emit`, a failure to `onFail`. */
  const send = async (
    msg: unknown,
    ids: JsonRpcId[],
    emit: (payload: unknown) => void,
    onFail: (ids: JsonRpcId[], message: string) => void,
    signal?: AbortSignal
  ) => {
    const emitAll = (payload: unknown) => (Array.isArray(payload) ? payload.forEach(emit) : emit(payload));
    try {
      const res = await doFetch(opts.url, {
        ...(signal ? { signal } : {}),
        method: "POST",
        headers: {
          Authorization: `Bearer ${opts.apiKey}`,
          "Content-Type": "application/json",
          Accept: "application/json, text/event-stream",
          ...(sessionId ? { "Mcp-Session-Id": sessionId } : {}),
          ...(protocolVersion ? { "Mcp-Protocol-Version": protocolVersion } : {}),
          ...opts.headers,
        },
        body: JSON.stringify(withConversationMeta(msg, opts.headers)),
      });
      const minted = res.headers.get("mcp-session-id");
      if (minted) sessionId = minted;
      if (!res.ok) {
        const text = await res.text().catch(() => "");
        onFail(ids, `Synap pod answered HTTP ${res.status}${text ? `: ${text.slice(0, 300)}` : ""}`);
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
              emitAll(JSON.parse(data));
            } catch {
              log("dropped an event that is not JSON");
            }
          }
          if (done) break;
        }
        return;
      }
      const text = await res.text();
      if (text.trim()) emitAll(JSON.parse(text));
    } catch (err) {
      onFail(ids, `Synap pod unreachable at ${opts.url}: ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  const forward = async (line: string) => {
    let msg: unknown;
    try {
      msg = JSON.parse(line);
    } catch {
      log("dropped a line that is not JSON");
      return;
    }
    if (isPlainToolsList(msg)) return forwardToolsList(msg);
    await send(msg, requestIds(msg), write, fail);
  };

  const sleep = (ms: number) => new Promise<"slow">((r) => setTimeout(() => r("slow"), ms).unref?.());

  /**
   * tools/list through the cache. The pod's reply is collected rather than
   * written, so that exactly ONE reply per id reaches Claude Code: the pod's
   * when it is good and in time, else the cache's (and the pod's late reply
   * then only refreshes the cache).
   */
  const forwardToolsList = async (msg: { id: JsonRpcId }) => {
    const collected: unknown[] = [];
    let failure: { ids: JsonRpcId[]; message: string } | undefined;
    const settled = send(
      msg,
      [msg.id],
      (p) => collected.push(p),
      (ids, message) => {
        failure = { ids, message };
      },
      AbortSignal.timeout(TOOLS_LIST_REFRESH_LIMIT_MS)
    ).then(() => "done" as const);
    const first = await Promise.race([settled, sleep(opts.toolsListWaitMs ?? TOOLS_LIST_WAIT_MS)]);
    const cached = readCache();
    const goodResult = () =>
      failure ? undefined : completeToolsResult(collected.find((c) => (c as JsonRpcMessage)?.id === msg.id));
    const serveCache = (why: string) => {
      log(`${why}: answering tools/list from the cache saved ${Math.round((Date.now() - cached!.savedAt) / 1000)}s ago`);
      write({ jsonrpc: "2.0", id: msg.id, result: cached!.result });
    };

    if (first === "done") {
      const fresh = goodResult();
      if (fresh) {
        writeCache(fresh);
        collected.forEach(write);
      } else if (cached) {
        serveCache(failure ? failure.message : "the pod's tools/list was not a list");
      } else if (failure) {
        fail(failure.ids, failure.message);
      } else {
        collected.forEach(write);
      }
      return;
    }

    // The pod is slow. No cache: wait for it, exactly as without one.
    if (!cached) {
      await settled;
      const fresh = goodResult();
      if (fresh) writeCache(fresh);
      if (failure) fail(failure.ids, failure.message);
      else collected.forEach(write);
      return;
    }
    serveCache(`the pod has not answered tools/list in ${opts.toolsListWaitMs ?? TOOLS_LIST_WAIT_MS}ms`);
    await settled;
    const fresh = goodResult();
    if (!fresh) return; // still failing: the cached list stays what Claude Code has
    writeCache(fresh);
    if (JSON.stringify(fresh.tools) !== JSON.stringify(cached.result.tools)) {
      write({ jsonrpc: "2.0", method: "notifications/tools/list_changed" });
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
