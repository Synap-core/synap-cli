/**
 * synap agent ask / chat
 *
 * Hold a REAL conversation with the workspace's deployed Intelligence-Service
 * agent (the orchestrator / co-founder). Unlike `synap agent run` — which hits
 * the IS /v1/chat/completions door directly and stores a research entity — this
 * drives the SAME channel+trigger path the browser uses, so the deployed agent
 * answers with full workspace context, tools, and governance.
 *
 * Verified path (Hub Protocol REST, all under `${podUrl}/api/hub`):
 *   1. resolve/create a WORKSPACE-scoped THREAD channel
 *        POST /threads { userId, workspaceId, title, externalSource, externalId }
 *      channelType defaults to "thread" + scope defaults to "workspace" — this is
 *      NOT the pod-wide personal channel (`/channels/personal` is pod-scoped).
 *      A stable externalId dedups, so repeated `agent ask` calls CONTINUE the
 *      same conversation (multi-turn) unless `--new` forces a fresh thread.
 *   2. post the user turn + trigger the agent
 *        POST /threads/:id/messages { role:"user", content, userId, autoRespond:true }
 *      autoRespond enqueues an A2AI pg-boss job → IS /api/chat/stream (agentType
 *      "meta" → OrchestratorAgent). The reply is ASYNC.
 *   3. poll for the assistant reply
 *        GET /threads/:id/messages  (asc by timestamp)
 *      The a2ai worker persists the answer as a role="assistant" message. We poll
 *      until a NEW assistant message (id not seen before the post) appears.
 */

import chalk from "chalk";
import { createInterface } from "node:readline";
import {
  resolveHubConfig,
  resolveUserId,
  hubGet,
  hubPost,
  type HubConfig,
  renderHubError,
} from "../lib/hub-client.js";
import { unwrapList } from "../lib/unwrapList.js";
import { log } from "../utils/logger.js";

// ── Types ─────────────────────────────────────────────────────────────────────

interface WireMessage {
  id: string;
  role: "system" | "assistant" | "user";
  content: string;
  timestamp?: string;
  authorType?: string | null;
}

export interface AgentAskOpts {
  message?: string;
  workspace?: string;
  thread?: string;
  agentType?: string;
  new?: boolean;
  timeout?: string;
  json?: boolean;
  podUrl?: string;
  apiKey?: string;
}

export interface AgentChatOpts {
  workspace?: string;
  thread?: string;
  agentType?: string;
  new?: boolean;
  timeout?: string;
  podUrl?: string;
  apiKey?: string;
}

// ── Shared helpers ──────────────────────────────────────────────────────────────

/** Resolve a `--workspace <id|name>` value (or the active lens) to a workspace id. */
async function resolveWorkspace(
  cfg: HubConfig,
  wanted: string | undefined
): Promise<string> {
  // Explicit flag first — accept an id OR a name.
  if (wanted) {
    let list: Array<Record<string, unknown>> = [];
    try {
      const res = await hubGet("/workspaces", {}, cfg);
      list = unwrapList<Record<string, unknown>>(res, ["workspaces"]);
    } catch {
      // If the list door fails, fall through and treat `wanted` as a raw id.
    }
    const byId = list.find((w) => String(w.id ?? "") === wanted);
    if (byId) return String(byId.id);
    const byName = list.find(
      (w) => String(w.name ?? "").toLowerCase() === wanted.toLowerCase()
    );
    if (byName) return String(byName.id);
    // No match by name; assume the caller passed a literal id.
    return wanted;
  }
  // Fall back to the active lens / configured workspace.
  if (cfg.workspaceId) return cfg.workspaceId;
  throw new Error(
    "No workspace. Pass --workspace <id|name> or set one with `synap use <workspace>`."
  );
}

/**
 * Resolve or create the workspace-scoped THREAD channel used for this chat.
 * Returns its id. A stable externalId keeps the conversation continuous across
 * invocations; `--new` (or `--thread`) overrides.
 */
async function resolveChannel(
  cfg: HubConfig,
  userId: string,
  workspaceId: string,
  opts: { thread?: string; new?: boolean }
): Promise<string> {
  if (opts.thread) return opts.thread;

  const body: Record<string, unknown> = {
    userId,
    workspaceId,
    title: "CLI agent chat",
  };
  if (!opts.new) {
    // Stable per-(user, workspace) key → POST /threads fast-path dedups on it,
    // so successive calls reuse ONE thread and the agent sees prior turns.
    body.externalSource = "cli";
    body.externalId = `agent-chat:${workspaceId}`;
  }
  const res = (await hubPost("/threads", body, cfg)) as { id?: string };
  if (!res?.id) throw new Error("Failed to resolve chat channel (no id returned).");
  return res.id;
}

/** Fetch all messages in a thread (asc by timestamp). */
async function fetchMessages(
  cfg: HubConfig,
  channelId: string
): Promise<WireMessage[]> {
  const res = await hubGet(`/threads/${channelId}/messages`, {}, cfg);
  return unwrapList<WireMessage>(res, ["messages"]);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Post one user turn and wait for the deployed agent's reply.
 *
 * @returns the assistant reply text, or null on timeout.
 */
async function sendTurnAndAwaitReply(
  cfg: HubConfig,
  channelId: string,
  userId: string,
  message: string,
  agentType: string | undefined,
  timeoutMs: number,
  onWait?: () => void
): Promise<{ reply: string | null; userMessageId: string }> {
  // Snapshot the assistant messages that already exist so we can tell OUR reply
  // apart from history — the reliable "reply is ready" signal.
  const before = await fetchMessages(cfg, channelId);
  const seenAssistant = new Set(
    before.filter((m) => m.role === "assistant").map((m) => m.id)
  );

  const postBody: Record<string, unknown> = {
    role: "user",
    content: message,
    userId,
    autoRespond: true,
  };
  // agentType is a forward-compat hint: the backend autoRespond door currently
  // routes every reply to the workspace orchestrator ("meta"). Stored in metadata
  // so a future selectable-agent door can honor it.
  if (agentType) postBody.metadata = { requestedAgentType: agentType };

  const posted = (await hubPost(
    `/threads/${channelId}/messages`,
    postBody,
    cfg
  )) as { messageId?: string };
  const userMessageId = posted?.messageId ?? "";

  const deadline = Date.now() + timeoutMs;
  const intervalMs = 2000;
  while (Date.now() < deadline) {
    await sleep(intervalMs);
    onWait?.();
    let msgs: WireMessage[];
    try {
      msgs = await fetchMessages(cfg, channelId);
    } catch {
      continue; // transient — keep polling until the deadline
    }
    const reply = msgs.find(
      (m) => m.role === "assistant" && !seenAssistant.has(m.id)
    );
    if (reply) return { reply: reply.content, userMessageId };
  }
  return { reply: null, userMessageId };
}

function parseTimeout(raw: string | undefined): number {
  const secs = raw ? parseInt(raw, 10) : NaN;
  return Number.isFinite(secs) && secs > 0 ? secs * 1000 : 90_000;
}

const TIMEOUT_HINT =
  "The agent did not respond in time. The Intelligence Service may be down or " +
  "still working. Retry, or raise --timeout. Check IS health: `synap status`.";

// ── agent ask (single-shot) ─────────────────────────────────────────────────────

export async function agentAsk(opts: AgentAskOpts): Promise<void> {
  const message = (opts.message ?? "").trim();
  if (!message) {
    console.error(chalk.red("Error: a message is required. Usage: synap agent ask \"your message\""));
    process.exit(1);
  }
  try {
    const cfg = await resolveHubConfig(opts);
    const userId = await resolveUserId(cfg);
    const workspaceId = await resolveWorkspace(cfg, opts.workspace);
    const channelId = await resolveChannel(cfg, userId, workspaceId, opts);
    const timeoutMs = parseTimeout(opts.timeout);

    if (!opts.json) {
      log.dim(`workspace ${workspaceId}  ·  thread ${channelId}`);
      process.stdout.write(chalk.dim("    waiting for agent"));
    }

    const { reply } = await sendTurnAndAwaitReply(
      cfg,
      channelId,
      userId,
      message,
      opts.agentType,
      timeoutMs,
      () => {
        if (!opts.json) process.stdout.write(chalk.dim("."));
      }
    );
    if (!opts.json) process.stdout.write("\n");

    if (reply === null) {
      if (opts.json) {
        console.log(
          JSON.stringify(
            { ok: false, error: "timeout", workspaceId, threadId: channelId },
            null,
            2
          )
        );
      } else {
        log.error(TIMEOUT_HINT);
      }
      process.exit(1);
    }

    if (opts.json) {
      console.log(
        JSON.stringify(
          { ok: true, reply, workspaceId, threadId: channelId },
          null,
          2
        )
      );
    } else {
      log.blank();
      console.log(chalk.green("  agent") + chalk.dim("  ▸"));
      console.log(reply.split("\n").map((l) => "  " + l).join("\n"));
      log.blank();
    }
  } catch (e) {
    if (opts.json) {
      console.log(JSON.stringify({ ok: false, error: (e as Error).message }, null, 2));
    } else {
      renderHubError(e);
    }
    process.exit(1);
  }
}

// ── agent chat (interactive REPL) ────────────────────────────────────────────────

export async function agentChat(opts: AgentChatOpts): Promise<void> {
  let cfg: HubConfig;
  let userId: string;
  let workspaceId: string;
  let channelId: string;
  const timeoutMs = parseTimeout(opts.timeout);
  try {
    cfg = await resolveHubConfig(opts);
    userId = await resolveUserId(cfg);
    workspaceId = await resolveWorkspace(cfg, opts.workspace);
    channelId = await resolveChannel(cfg, userId, workspaceId, opts);
  } catch (e) {
    renderHubError(e);
    process.exit(1);
    return;
  }

  log.heading("Synap agent chat");
  log.dim(`workspace ${workspaceId}  ·  thread ${channelId}`);
  log.dim("Type your message and press enter. /exit or Ctrl-D to quit.");
  log.blank();

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const prompt = () => rl.setPrompt(chalk.cyan("you ▸ "));
  prompt();
  rl.prompt();

  rl.on("line", async (line) => {
    const message = line.trim();
    if (!message) {
      rl.prompt();
      return;
    }
    if (message === "/exit" || message === "/quit") {
      rl.close();
      return;
    }
    rl.pause();
    process.stdout.write(chalk.dim("    waiting for agent"));
    try {
      const { reply } = await sendTurnAndAwaitReply(
        cfg,
        channelId,
        userId,
        message,
        opts.agentType,
        timeoutMs,
        () => process.stdout.write(chalk.dim("."))
      );
      process.stdout.write("\n");
      if (reply === null) {
        log.error(TIMEOUT_HINT);
      } else {
        console.log(chalk.green("agent ▸"));
        console.log(reply.split("\n").map((l) => "  " + l).join("\n"));
        log.blank();
      }
    } catch (e) {
      process.stdout.write("\n");
      log.error((e as Error).message);
    }
    rl.resume();
    rl.prompt();
  });

  rl.on("close", () => {
    log.blank();
    log.dim("Chat ended.");
    process.exit(0);
  });
}
