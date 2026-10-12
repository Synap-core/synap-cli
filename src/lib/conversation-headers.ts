/**
 * The headers that name the calling CONVERSATION to the pod — the agent's own
 * id, the one a person can reopen (`claude --resume <id>`). The pod reads
 * `X-Synap-Conversation` as the conversation half of the client key, so every
 * session the conversation touches records it (`resolveAgentConversation`,
 * @synap-core/types/agents). Sent by every Hub call (`hub-client.ts`) and by
 * the stdio MCP bridge (`mcp-bridge.ts`). Empty outside Claude Code.
 */
export const CONVERSATION_HEADER = "X-Synap-Conversation";
export const CONVERSATION_CWD_HEADER = "X-Synap-Conversation-Cwd";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** `claude-code:<uuid>` for the Claude Code conversation we run in, if any. */
export function claudeCodeConversation(sessionId: string | undefined): string | undefined {
  const id = sessionId?.trim();
  return id && UUID.test(id) ? `claude-code:${id.toLowerCase()}` : undefined;
}

/**
 * The headers for `sessionId` (pass it explicitly: the CLI's live id is
 * `getClaudeSessionId()`, a stdio server's is its spawn env). Empty without a
 * real Claude Code id; the cwd rides only with a conversation.
 */
export function conversationHeaders(
  sessionId: string | undefined,
  cwd: string = process.cwd()
): Record<string, string> {
  const conversation = claudeCodeConversation(sessionId);
  if (!conversation) return {};
  // HTTP header values must be ByteStrings; a non-ASCII cwd is dropped rather
  // than letting fetch throw and take the whole request down with it.
  return /^[\x20-\x7E]{1,1024}$/.test(cwd)
    ? { [CONVERSATION_HEADER]: conversation, [CONVERSATION_CWD_HEADER]: cwd }
    : { [CONVERSATION_HEADER]: conversation };
}

