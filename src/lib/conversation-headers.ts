/**
 * The headers that name the calling CONVERSATION to the pod — the agent's own
 * id, the one a person can reopen (`claude --resume <id>`). The pod reads
 * `X-Synap-Conversation` as the conversation half of the client key, so every
 * session the conversation touches records it (`resolveAgentConversation`,
 * @synap-core/types/agents). Sent by every Hub call (`hub-client.ts`) and by
 * the stdio MCP bridge (`mcp-bridge.ts`). Outside Claude Code the conversation is
 * this process's own run (`synap-cli:<uuid>`, or `SYNAP_RUN_ID` to span a script).
 */
import { randomUUID } from "node:crypto";
import { cliBuild } from "./cli-build.js";

export const CONVERSATION_HEADER = "X-Synap-Conversation";
export const CONVERSATION_CWD_HEADER = "X-Synap-Conversation-Cwd";

/**
 * Which CLIENT program makes the call, `<name>/<version>`: `synap-cli/<v>` for
 * the CLI's Hub calls, `synap-cli-mcp/<v>` for the stdio MCP bridge (and
 * `synap-bridge/<v>` from the Claude Code mod). The pod counts calls per client
 * in its usage telemetry, so two programs sharing one key and one conversation
 * can be told apart. Never an identity: it only labels the count.
 */
export const CLIENT_HEADER = "X-Synap-Client";
export type SynapClientName = "synap-cli" | "synap-cli-mcp";

/** `{ "X-Synap-Client": "<name>/<version>" }`; the version is the package's. */
export function clientHeader(
  name: SynapClientName,
  version: string = cliBuild().version
): Record<string, string> {
  // A header value must be visible ASCII; an odd version never fails the call.
  const v = /^[\x21-\x7E]{1,64}$/.test(version) ? version : "unknown";
  return { [CLIENT_HEADER]: `${name}/${v}` };
}

/** The same two values in a request's `params._meta` (reverse-DNS vendor keys; `io.modelcontextprotocol/` is reserved). */
export const CONVERSATION_META_KEY = "live.synap/conversation";
export const CONVERSATION_CWD_META_KEY = "live.synap/conversationCwd";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** `claude-code:<uuid>` for the Claude Code conversation we run in, if any. */
export function claudeCodeConversation(sessionId: string | undefined): string | undefined {
  const id = sessionId?.trim();
  return id && UUID.test(id) ? `claude-code:${id.toLowerCase()}` : undefined;
}

const RUN_ID = /^[A-Za-z0-9_.-]{1,128}$/;

/** One id per process, so every Hub call of one CLI run lands in one conversation. */
const PROCESS_RUN_ID = randomUUID();

/**
 * `synap-cli:<id>` for a run outside Claude Code: `SYNAP_RUN_ID` when the caller
 * names one (a multi-command script), else a UUID minted once per process. An
 * unusable `SYNAP_RUN_ID` falls back to the process id rather than failing.
 */
export function cliConversation(env: NodeJS.ProcessEnv = process.env): string {
  const named = env.SYNAP_RUN_ID?.trim();
  return `synap-cli:${named && RUN_ID.test(named) ? named : PROCESS_RUN_ID}`;
}

/**
 * The headers for `sessionId` (pass it explicitly: the CLI's live id is
 * `getClaudeSessionId()`, a stdio server's is its spawn env). Empty without a
 * real Claude Code id the run names itself (`cliConversation`); the cwd rides
 * only with a Claude Code conversation (the one a person can reopen).
 */
export function conversationHeaders(
  sessionId: string | undefined,
  cwd: string = process.cwd()
): Record<string, string> {
  const conversation = claudeCodeConversation(sessionId);
  if (!conversation) return { [CONVERSATION_HEADER]: cliConversation() };
  // HTTP header values must be ByteStrings; a non-ASCII cwd is dropped rather
  // than letting fetch throw and take the whole request down with it.
  return /^[\x20-\x7E]{1,1024}$/.test(cwd)
    ? { [CONVERSATION_HEADER]: conversation, [CONVERSATION_CWD_HEADER]: cwd }
    : { [CONVERSATION_HEADER]: conversation };
}


/** Every header the stdio MCP bridge sends: its client name plus the conversation. */
export function mcpBridgeHeaders(
  sessionId: string | undefined,
  cwd: string = process.cwd()
): Record<string, string> {
  return { ...clientHeader("synap-cli-mcp"), ...conversationHeaders(sessionId, cwd) };
}
