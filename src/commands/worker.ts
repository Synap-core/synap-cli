/**
 * `synap worker` — run Claude Code unattended on THIS machine for the sessions
 * a person or an AI handed to an agent.
 *
 * The door it reuses: a session's roster. Putting an agent on a focus session
 * (`synap_start_session` agentIds, `synap_update_session` addAgentId, capture
 * "Give to agent") is how work is handed to it, and `synap_orient` lists those
 * sessions as `handedToYou` for that agent. The worker is that agent: it polls
 * orient with the agent's own key, claims each new session once, and launches
 * the unmodified `claude` binary headless in the workspace with a protocol
 * prompt. The launched Claude Code does the work and talks in the session room
 * through the Synap MCP — so the AI that launched the session (the
 * orchestrator) and the person read and answer it there, and relay shows it.
 *
 * Synap never spawns a coding agent: this process runs on the person's own
 * machine, under their own Claude login, as an agent they connected.
 *
 * Which Claude subscription a run uses = which Claude config the process sees:
 * `--claude-config-dir` sets CLAUDE_CONFIG_DIR for the launched runs (log that
 * directory in once with `CLAUDE_CONFIG_DIR=<dir> claude login`). API-key
 * variables are removed from the launched environment so a stray key can never
 * silently switch billing away from the subscription.
 *
 * Several Claude accounts (`--accounts <file>`, default
 * ~/.config/synap-worker/accounts.json when it exists): before each launch the
 * accounts are measured and one is picked (worker-accounts.ts); its token goes
 * into the run's environment only. A run cut off by a usage limit marks that
 * account full and is RESUMED (same Claude conversation) on the next account.
 *
 * Three protocols (`classifySession`): CODE (worktree, draft PR, the owner
 * closes the session), TASK (a session that follows a non-code playbook, e.g.
 * the CRM's "Score a list": pod tools and the web only, no shell or files, and
 * it closes the session itself when nothing is left for the person), DESIGN.
 *
 * A DESIGN run (the session declares an outcome of kind "design") launches as
 * `claude --bg` — the only mode that has the Artifact tool — on the account
 * flagged `design`, and is watched through `claude agents --json` and its
 * transcript.
 *
 * State (which sessions were launched, their Claude session ids and outcome)
 * lives in ~/.synap/worker/<agent>/state.json; each run's stream-json goes to
 * ~/.synap/worker/<agent>/runs/<sessionId>.jsonl. Neither ever holds a token.
 */

import { execFile, spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import { ensureSecretDir, writeSecretFile } from "../lib/atomic-file.js";
import os from "node:os";
import path from "node:path";
import { CONVERSATION_HEADER, claudeCodeConversation } from "../lib/conversation-headers.js";
import { resolveHubConfig } from "../lib/hub-client.js";
import { resolveAgentUserId } from "../lib/credential-class.js";
import { createMcpClient, type McpCallClient } from "../lib/mcp-call.js";
import {
  AccountPool,
  accountsFileTooOpen,
  defaultAccountsFile,
  loadAccountsFile,
  probeAccount,
  type AccountSpec,
} from "./worker-accounts.js";

export interface WorkerOptions {
  agent: string;
  interval?: string;
  once?: boolean;
  cwd?: string;
  maxParallel?: string;
  claudeBin?: string;
  claudeConfigDir?: string;
  allowedTools?: string;
  skipPermissions?: boolean;
  dryRun?: boolean;
  /** The Claude accounts file (default ~/.config/synap-worker/accounts.json, used when it exists). */
  accounts?: string;
}

export interface HandedItem {
  id: string;
  goal: string | null;
}

/** `limited`: cut off by a usage limit, waiting to be resumed on another account. */
export type RunStatus = "running" | "done" | "failed" | "limited";

export interface RunRecord {
  sessionId: string;
  status: RunStatus;
  startedAt: string;
  finishedAt?: string;
  pid?: number;
  claudeSessionId?: string;
  exitCode?: number | null;
  result?: string;
  /** How many times a room follow-up resumed this Claude conversation. */
  resumes?: number;
  /** How many times a run that failed before Claude started was relaunched. */
  launchRetries?: number;
  /** The accounts-file id the latest launch ran on — an id, never a token. */
  accountId?: string;
  /** `print` = `claude -p` (default); `bg` = `claude --bg`, a design run. */
  mode?: "print" | "bg";
  /** A print run's protocol (see `classifySession`); absent on records written before it existed = "code". */
  protocol?: "code" | "task";
  /** The short id `claude --bg` printed (what `claude agents|stop` take). */
  bgId?: string;
  /** When the latest launch (first or resumed) started. */
  launchedAt?: string;
  /** How many times a run cut off by a usage limit was resumed on another account. */
  limitResumes?: number;
  /** A background run first seen blocked (needs input) at this time. */
  blockedSince?: string;
}

interface WorkerState {
  runs: Record<string, RunRecord>;
}

// ─── pure helpers (tested) ────────────────────────────────────────────────────

/** "30s" | "2m" | "1h" | "45" (seconds) → milliseconds. */
export function parseInterval(raw: string | undefined, fallbackMs = 30_000): number {
  if (!raw) return fallbackMs;
  const m = /^(\d+)(ms|s|m|h)?$/.exec(raw.trim());
  if (!m) throw new Error(`Invalid interval "${raw}" — use e.g. 30s, 2m`);
  const n = Number(m[1]);
  const unit = m[2] ?? "s";
  return unit === "ms" ? n : unit === "s" ? n * 1000 : unit === "m" ? n * 60_000 : n * 3_600_000;
}

/**
 * The pod hands this agent its work through a provider binding (reach
 * `dispatch`), so it lists nothing to pull: a worker pulling for it would run
 * the same work a second time. The worker stops on it.
 */
export class AgentBoundForDispatchError extends Error {
  constructor() {
    super(
      "this agent is bound to a provider: the pod hands it work directly, so there is nothing to pull. Stop this worker, or unbind the agent in Settings › Agents."
    );
    this.name = "AgentBoundForDispatchError";
  }
}

/**
 * A person PAUSED this agent: it takes no new work until resumed. Not a failed
 * read — the worker keeps polling and launches nothing.
 */
export class AgentPausedError extends Error {
  constructor() {
    super("this agent is paused: it takes no new work until a person resumes it");
    this.name = "AgentPausedError";
  }
}

/**
 * Read `handedToYou` out of `synap_orient`'s text. A missing or `unavailable`
 * block is a FAILED read and throws — never "nothing handed to me". A `bound`
 * block throws `AgentBoundForDispatchError`.
 */
export function parseHandedToYou(orientText: string): HandedItem[] {
  let data: unknown;
  try {
    data = JSON.parse(orientText);
  } catch {
    throw new Error(`orient did not return JSON: ${orientText.slice(0, 160)}`);
  }
  const block = findKey(data, "handedToYou") as
    | { status?: string; items?: Array<{ id?: unknown; goal?: unknown }> }
    | undefined;
  if (!block || typeof block !== "object") {
    throw new Error("orient carried no handedToYou block (pod too old, or not an agent key)");
  }
  if (block.status === "bound") throw new AgentBoundForDispatchError();
  if (block.status === "paused") throw new AgentPausedError();
  if (block.status === "unavailable" || !Array.isArray(block.items)) {
    throw new Error("orient could not read handedToYou (status unavailable)");
  }
  return block.items
    .filter((i): i is { id: string; goal?: unknown } => typeof i?.id === "string")
    .map((i) => ({ id: i.id, goal: typeof i.goal === "string" ? i.goal : null }));
}

function findKey(x: unknown, key: string): unknown {
  if (!x || typeof x !== "object") return undefined;
  if (Array.isArray(x)) {
    for (const v of x) {
      const r = findKey(v, key);
      if (r !== undefined) return r;
    }
    return undefined;
  }
  const obj = x as Record<string, unknown>;
  if (key in obj) return obj[key];
  for (const v of Object.values(obj)) {
    const r = findKey(v, key);
    if (r !== undefined) return r;
  }
  return undefined;
}

/**
 * A run that failed BEFORE Claude started (no Claude session: an expired login,
 * exhausted credits) is relaunched after 30 min, then 1 h, 2 h and 4 h, enough
 * to outlast a credit reset. A run Claude did start is resumed only by a room
 * follow-up, never relaunched from scratch.
 */
export const LAUNCH_RETRY_BASE_MS = 30 * 60_000;
export const MAX_LAUNCH_RETRIES = 4;

function launchRetryDue(rec: RunRecord, now: number): boolean {
  if (rec.status !== "failed" || rec.claudeSessionId || !rec.finishedAt) return false;
  const retries = rec.launchRetries ?? 0;
  if (retries >= MAX_LAUNCH_RETRIES) return false;
  return now - Date.parse(rec.finishedAt) >= LAUNCH_RETRY_BASE_MS * 2 ** retries;
}

/** Sessions to launch now: never launched, or due a relaunch (see above). */
export function pickNew(
  items: HandedItem[],
  state: WorkerState,
  slots: number,
  now: number = Date.now()
): HandedItem[] {
  if (slots <= 0) return [];
  return items
    .filter((i) => {
      const rec = state.runs[i.id];
      return !rec || launchRetryDue(rec, now);
    })
    .slice(0, slots);
}

/**
 * The pod MCP server every run gets, under this name, carrying the WORKER
 * AGENT's own key. Runs never inherit the server in ~/.claude.json: whatever
 * key that file holds (a `synap login --reconnect` on the box rewrites it with
 * another agent's) would decide who the run posts as, and the worker would
 * then read its own posts as follow-ups (2026-10-20).
 */
export const RUN_MCP_SERVER = "synap-worker";

export function runMcpConfig(
  podUrl: string,
  apiKey: string,
  /** The run's Claude session id: names the conversation to the pod, one id across resumes. */
  claudeSessionId?: string
): { mcpServers: Record<string, unknown> } {
  const conversation = claudeCodeConversation(claudeSessionId);
  return {
    mcpServers: {
      [RUN_MCP_SERVER]: {
        type: "http",
        url: `${podUrl.replace(/\/+$/, "")}/mcp`,
        headers: { Authorization: `Bearer ${apiKey}`, ...(conversation ? { [CONVERSATION_HEADER]: conversation } : {}) },
      },
    },
  };
}

/** Writes the run config owner-only (it holds the key) and returns its path. */
export function writeRunMcpConfig(dir: string, config: { mcpServers: Record<string, unknown> }, name = "mcp.json"): string {
  ensureSecretDir(dir);
  const file = path.join(dir, name);
  writeSecretFile(file, JSON.stringify(config, null, 2));
  return file;
}

export const DEFAULT_ALLOWED_TOOLS = ["Read", "Edit", "Write", "Glob", "Grep", "Bash", "TodoWrite"];

/** The tools a design run adds: the claude.ai Artifact tool (and the search that loads deferred tools). */
export const DESIGN_EXTRA_TOOLS = ["Artifact", "ToolSearch"];

/**
 * A TASK run (see `classifySession`) writes ONLY through the pod: its tools are
 * the pod MCP server plus the web (research needs it). No shell, no file tool.
 * The list is fixed: `--allowed-tools` and `--dangerously-skip-permissions`
 * apply to code runs only.
 */
export const TASK_ALLOWED_TOOLS = ["WebSearch", "WebFetch"];
/** Denied outright on a TASK run, on top of `dontAsk` (which already denies anything not allowed). */
export const TASK_DISALLOWED_TOOLS = ["Bash", "Edit", "Write", "NotebookEdit"];

/**
 * The permission flags of a print (`claude -p`) run. A code run keeps today's
 * flags. A task run is `dontAsk` — never `acceptEdits`, which would auto-accept
 * file edits — with the task tools allowed and the file and shell tools denied.
 */
export function printRunPermissionArgs(
  protocol: "code" | "task",
  p: { codeAllowed: string[]; mcpServer: string; skipPermissions?: boolean }
): string[] {
  if (protocol === "task") {
    return [
      "--permission-mode",
      "dontAsk",
      "--allowedTools",
      [...TASK_ALLOWED_TOOLS, `mcp__${p.mcpServer}`].join(","),
      "--disallowedTools",
      TASK_DISALLOWED_TOOLS.join(","),
    ];
  }
  if (p.skipPermissions) return ["--dangerously-skip-permissions"];
  return ["--permission-mode", "acceptEdits", "--allowedTools", ...p.codeAllowed];
}

/**
 * The protocol for a TASK session: a process whose work happens in the pod
 * (score a list, draft a message, qualify a lead). It writes through pod tools
 * only, marks its outcomes, and closes the session itself when nothing is left
 * for the person.
 */
export function buildTaskPrompt(p: { sessionId: string; goal: string | null; agentName: string; mcpServer: string }): string {
  return [
    `You are the Synap agent "${p.agentName}", an unattended Claude Code worker on this machine.`,
    `A person or an orchestrating AI handed you ONE Synap focus session that follows a process whose work happens in the pod, not in code. Work it end to end, then close it.`,
    `Synap tools are on the MCP server "${p.mcpServer}" (mcp__${p.mcpServer}__synap_*).`,
    ``,
    `Session: ${p.sessionId}`,
    `Goal as handed: ${p.goal ?? "(read it from the session)"}`,
    `This is a TASK run: you have the pod tools, WebSearch and WebFetch. No shell, no files.`,
    ``,
    `Protocol:`,
    `1. Read: synap_get_session {sessionId} for the goal, the process instructions and params (metadata.prompt, metadata.params), the stages and currentStage, the subject, the outcomes with their owner, and channelId (the room); then synap_get_thread_context {threadId: <channelId>} for what was said so far. Read the subject and every entity the params name (synap_get_entity) before you write. The fields a process reads often live on the subject's ROLES, not on the entity itself (a lead's icpScore, buyingSignal, buyingSignalSource, qualificationNotes, nextAction are on its lead facet): read them there and use what they say. The pod's own research on the subject wins over a search of yours; a doubt about it goes in the room, not into a different signal.`,
    `2. Claim: synap_post_message to the room (kind "update"), one line: you picked it up and what you will do first.`,
    `3. Work: follow the goal and the process instructions stage by stage; when a stage is done, move the session on (synap_update_session currentStage <stage key>; a stage that moves the subject's status moves the subject, with expectedStatus). Research with WebSearch and WebFetch, public sources only, and keep each source URL with the fact it supports. Write ONLY through the pod tools: entities and their fields (synap_update_entity, synap_create_entity), facets (synap_attach_facet), relations (synap_link_entities), documents (synap_create_document, synap_update_document). Never synap_capture a record the process asks you to create or change: capture is for free text and lets the pod's AI choose the fields and file it again; create it with synap_create_entity (its profileSlug and the exact property keys the goal names, e.g. messageContent) and change fields with synap_update_entity. Give an entity only its OWN identity fields: never put a company's website, domain or email on a person (or a person's on a company), because the pod matches identity on them and would merge the person into the company. Never edit files, never run code, never open a pull request. A write that comes back "proposed" is success: keep going, never retry it. If the goal turns out to need a code change or files, stop: say so in the room and end with WORKER-RESULT: blocked — this session needs a code run (an outcome of kind "pull-request").`,
    `4. Need help or a decision: post in the room starting with "QUESTION:" — kind "update" when the orchestrating AI can answer it, kind "question" only for a decision only the person can make (with slotLabel and an ask: choose, your recommendation marked). Then wait with synap_wait_for_answer {sessionId} (call it again with since = nextSince), up to 30 minutes in all. No reply: state your assumption in the room and continue, or stop and say what is blocked.`,
    `5. Mark each outcome you produced: synap_update_session {sessionId, completeOutput: <key>} for every agent-owned outcome you delivered, with its evidence when it has none yet (outcomes:[{key, ref:{kind, id}}] naming the entity or document you wrote). For outcomes of kind "fact", call synap_evaluate_session {sessionId} once the work is written.`,
    `6. Report: post ONE paragraph in the room starting "Look at first:" — what you wrote (each entity or document by name), what is left, and the first thing to check.`,
    `7. Close: read synap_get_session again. When every required agent-owned outcome is met and nothing waits on the person (no owner "human" outcome pending, no question unanswered, no stage gate waiting), complete the session: synap_complete_session {sessionId, terminalStatus: "closed", summary: <one sentence of what was done>}. Proposals your writes created do not keep it open: closing hands them to the person's review. Otherwise leave the session open and say in the room which outcome or answer it waits on.`,
    `8. End your final message with one line: WORKER-RESULT: done | blocked | failed — <one sentence>. done = you closed the session; blocked = it waits on the person or on a code run.`,
  ].join("\n");
}

/** The protocol the launched Claude Code follows for one handed session. */
export function buildWorkerPrompt(p: {
  sessionId: string;
  goal: string | null;
  agentName: string;
  cwd: string;
  mcpServer: string;
  /** A design run: the deliverable is a claude.ai Design artifact. */
  design?: boolean;
}): string {
  const short = p.sessionId.slice(0, 8);
  return [
    `You are the Synap agent "${p.agentName}", an unattended Claude Code worker on this machine.`,
    `A person or an orchestrating AI handed you ONE Synap focus session. Work it end to end.`,
    `Synap tools are on the MCP server "${p.mcpServer}" (mcp__${p.mcpServer}__synap_*).`,
    ``,
    `Session: ${p.sessionId}`,
    `Goal as handed: ${p.goal ?? "(read it from the session)"}`,
    ...(p.design ? [`This is a DESIGN run: the deliverable is a design made with the Artifact tool.`] : []),
    ``,
    `Protocol:`,
    `1. Read: synap_get_session {sessionId} for the goal, outcomes and channelId (the room); then synap_get_thread_context {threadId: <channelId>} for what was said so far.`,
    `2. Claim: synap_post_message to the room (kind "update"), one line: you picked it up and what you will do first.`,
    `3. Work in ${p.cwd}, or in the directory the session goal names (e.g. a new site under ~/sites). Shared-tree rules: never commit on a shared clone's main; for code changes in an existing repo use a git worktree on a branch named devbox/${short}-<slug>; never push to main, never run git checkout --, restore, stash or reset --hard on a shared clone. You may push that branch and open a DRAFT pull request (gh pr create --draft); never merge one. Never deploy to production or change a domain; a preview deploy only when the session goal asks for one.`,
    ...(p.design
      ? [
          `3b. Design: call the Artifact tool with action "quickstart" and intent "design" FIRST, follow what it returns, then publish, and keep the claude.ai URL the publish returns.`,
        ]
      : []),
    `4. Need help or a decision: post in the room starting with "QUESTION:" — kind "update" when the orchestrating AI can answer it, kind "question" only for a decision only the person can make. Then wait for the reply: read synap_get_thread_context about every 60 seconds (Bash "sleep 60" between reads), up to 30 minutes, and use the first reply posted after your question. No reply: state your assumption in the room and continue, or stop and say what is blocked.`,
    `5. Record EVERY deliverable as a session output: synap_update_session {sessionId, outcomes:[{key, label, kind, ref:{url}}]}, then completeOutput <key> for each — the draft PR (ref = its URL), the branch, the gate summary path (name both in the label)${p.design ? `, and the design (the outcome of kind "design", ref = the artifact's claude.ai URL); also put that URL on the session's subject entity (synap_update_entity)` : ""}. Do not close the session; the owner does.`,
    `6. Report: post ONE paragraph in the room starting "Look at first:" — what changed, where (PR, branch${p.design ? ", artifact URL" : ""}), and the first thing to check.`,
    `7. End your final message with one line: WORKER-RESULT: done | blocked | failed — <one sentence>.`,
  ].join("\n");
}

/**
 * The launched environment: the subscription, never a stray API key. With an
 * account picked, its token REPLACES any token the worker inherited.
 */
export function workerEnv(base: NodeJS.ProcessEnv, claudeConfigDir?: string, oauthToken?: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...base };
  delete env.ANTHROPIC_API_KEY;
  delete env.ANTHROPIC_AUTH_TOKEN;
  delete env.ANTHROPIC_BASE_URL;
  if (claudeConfigDir) env.CLAUDE_CONFIG_DIR = claudeConfigDir;
  if (oauthToken) {
    env.CLAUDE_CODE_OAUTH_TOKEN = oauthToken;
    delete env.CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR;
  }
  return env;
}

// ─── usage limits (stream-json and transcript) ────────────────────────────────

/**
 * The `error` values Claude Code puts on an API-error assistant message that
 * mean the ACCOUNT is out (SDKAssistantMessage.error; transcript `error`).
 * Verified on Claude Code 2.1.309 (and present in 2.1.296): a usage limit is
 * `error: "rate_limit"`, `apiError: "usage_limit_reached"`, status 429, with
 * `apiErrorParams.rate_limit_info.resetsAt` (epoch seconds) — 507 such
 * entries in this Mac's transcripts, text "You've hit your session limit ·
 * resets 7:30am". `billing_error` = out of credits.
 */
const LIMIT_ERRORS = new Set(["rate_limit", "billing_error"]);

export interface LimitHit {
  error: string;
  /** When the limit lifts (ms), when Claude Code said. */
  resetsAt?: number;
}

/** What one run's events say about how it ended. */
export interface RunEnd {
  claudeSessionId?: string;
  /** The `result` text (stream) or the last main assistant text (transcript). */
  text?: string;
  /** Set when the run's LAST main-thread turn was refused by a usage limit. */
  limit?: LimitHit;
  isError?: boolean;
}

function epochToMs(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? v * 1000 : undefined;
}

/**
 * Fold one event (a stream-json line of `claude -p`, or a transcript line of
 * a background session — the two spell the fields differently) into the run's
 * ending. A later healthy assistant message clears an earlier limit: only a
 * run whose last turn hit the limit "ended on a limit".
 */
export function foldRunEvent(end: RunEnd, ev: Record<string, unknown>, rejectedResetsAt?: { at?: number }): RunEnd {
  const type = ev.type;
  if (type === "system" && ev.subtype === "init" && typeof ev.session_id === "string" && !end.claudeSessionId) {
    return { ...end, claudeSessionId: ev.session_id };
  }
  if (type === "rate_limit_event") {
    const info = ev.rate_limit_info as { status?: string; resetsAt?: number } | undefined;
    if (info?.status === "rejected" && rejectedResetsAt) rejectedResetsAt.at = epochToMs(info.resetsAt);
    return end;
  }
  if (type === "assistant") {
    // Subagent turns (parent_tool_use_id / isSidechain) never decide how the run ended.
    if (ev.parent_tool_use_id || ev.isSidechain) return end;
    const error = typeof ev.error === "string" ? ev.error : undefined;
    if (error && LIMIT_ERRORS.has(error)) {
      const params = (ev.api_error_params ?? ev.apiErrorParams) as { rate_limit_info?: { resetsAt?: number } } | undefined;
      return { ...end, limit: { error, resetsAt: epochToMs(params?.rate_limit_info?.resetsAt) ?? rejectedResetsAt?.at } };
    }
    if (error || ev.isApiErrorMessage) return end;
    const content = (ev.message as { content?: unknown } | undefined)?.content;
    const text = Array.isArray(content)
      ? content
          .filter((b): b is { type: string; text: string } => !!b && (b as { type?: unknown }).type === "text" && typeof (b as { text?: unknown }).text === "string")
          .map((b) => b.text)
          .join("\n")
      : undefined;
    return { ...end, limit: undefined, ...(text ? { text } : {}) };
  }
  if (type === "result") {
    const next: RunEnd = { ...end, isError: ev.is_error === true };
    if (typeof ev.result === "string") next.text = ev.result;
    if (ev.api_error_status === 429 && !next.limit) next.limit = { error: "rate_limit", resetsAt: rejectedResetsAt?.at };
    return next;
  }
  return end;
}

/** A run that printed its WORKER-RESULT verdict finished its protocol: never a limit. */
export function endedOnLimit(end: RunEnd): LimitHit | undefined {
  if (workerVerdict(end.text)) return undefined;
  return end.limit;
}

/** How long an account stays out after a limit with no reset time given. */
export function limitUntil(hit: LimitHit, now: number): number {
  if (hit.resetsAt && hit.resetsAt > now) return hit.resetsAt;
  return now + (hit.error === "billing_error" ? 60 : 15) * 60_000;
}

/** At most this many usage-limit resumes per session. */
export const MAX_LIMIT_RESUMES = 6;

/** The prompt that resumes a run a usage limit cut off, on another account. */
export const LIMIT_RESUME_PROMPT =
  "Continue where you stopped. Your previous turn was cut off by a Claude usage limit and this session moved to another account. Same protocol; end with one line: WORKER-RESULT: done | blocked | failed — <one sentence>.";

// ─── design runs ──────────────────────────────────────────────────────────────

/**
 * The structured signal for a DESIGN run: the session declares an outcome of
 * kind "design" (`synap_get_session` → `outcomes.outcomes[].kind`, the
 * playbook's `expectedOutputs: [{kind: "design", label: "Design"}]`). The goal
 * text is never read for it. A session whose outcomes could not be read
 * THROWS: an unreadable session is not "not a design run".
 */
export const DESIGN_OUTCOME_KIND = "design";

interface SessionRead {
  session?: { playbookId?: unknown; templateId?: unknown } | null;
  outcomes: Array<{ kind?: unknown }>;
}

/** `synap_get_session` text → the fields the worker decides on. A failed or partial read THROWS. */
function readSessionForProtocol(getSessionText: string): SessionRead {
  let data: unknown;
  try {
    data = JSON.parse(getSessionText);
  } catch {
    throw new Error(`get_session did not return JSON: ${getSessionText.slice(0, 160)}`);
  }
  const d = data as {
    error?: unknown;
    session?: SessionRead["session"];
    outcomes?: { status?: string; outcomes?: Array<{ kind?: unknown }> };
  };
  if (typeof d?.error === "string") throw new Error(`get_session: ${d.error}`);
  const o = d?.outcomes;
  if (!o || o.status !== "ok" || !Array.isArray(o.outcomes)) {
    throw new Error(`get_session could not read the session's outcomes (${o?.status ?? "missing"})`);
  }
  return { session: d.session, outcomes: o.outcomes };
}

export function isDesignSession(getSessionText: string): boolean {
  return readSessionForProtocol(getSessionText).outcomes.some((x) => x?.kind === DESIGN_OUTCOME_KIND);
}

/**
 * The outcome kinds that declare CODE work: a pull request (`pull-request` in
 * the night-shift playbooks' expectedOutputs, `pull_request` in the work-units
 * rule), `code` (an orchestrator's hand-off), a branch or a commit.
 */
export const CODE_OUTCOME_KINDS: ReadonlySet<string> = new Set(["code", "pull-request", "pull_request", "branch", "commit"]);

/**
 * Which protocol a handed session gets. Only structured fields of
 * `synap_get_session` decide it; the goal text is never read for it.
 *
 *   design — an outcome of kind "design" (see `isDesignSession`).
 *   code   — an outcome whose kind is in CODE_OUTCOME_KINDS; or a session that
 *            follows NO playbook (`session.playbookId` and `session.templateId`
 *            both null): a free-form hand-off, which is how an orchestrating AI
 *            hands repo work today, so it keeps today's protocol unchanged.
 *   task   — a session that FOLLOWS a playbook and declares no code outcome:
 *            a process whose work happens in the pod (CRM "Score a list",
 *            "Draft a first message", "Qualify a lead", a morning brief). It
 *            writes through pod tools only and closes itself.
 *
 * Why outcomes and not the playbook's space or name: the pod has no "dev
 * process" marker on a playbook, and a space id is one pod's, not a rule. What a
 * process must YIELD is the declaration it makes: a process that yields a pull
 * request is code work. The known gap, measured on the founder's pod
 * (2026-10-27): the Builder playbooks "Bugfix", "Quick change", "AI Dev
 * Session" and "Design to implementation" declare no outcome at all, so a run
 * of one classifies TASK; the task prompt then stops it `blocked`, saying the
 * session needs a code outcome. Those playbooks should declare
 * `expectedOutputs: [{kind: "pull-request"}]`.
 *
 * A session block with neither `playbookId` nor `templateId` THROWS: a read
 * that cannot say whether the session follows a playbook is not "it does not".
 */
export type SessionProtocol = "design" | "code" | "task";

export function classifySession(getSessionText: string): SessionProtocol {
  const r = readSessionForProtocol(getSessionText);
  if (r.outcomes.some((x) => x?.kind === DESIGN_OUTCOME_KIND)) return "design";
  if (r.outcomes.some((x) => typeof x?.kind === "string" && CODE_OUTCOME_KINDS.has(x.kind))) return "code";
  const s = r.session;
  if (!s || typeof s !== "object" || (!("playbookId" in s) && !("templateId" in s))) {
    throw new Error("get_session did not say whether the session follows a playbook (no playbookId/templateId)");
  }
  const followsPlaybook = typeof s.playbookId === "string" || typeof s.templateId === "string";
  return followsPlaybook ? "task" : "code";
}

/** The short id `claude --bg` prints ("backgrounded · fd009109"). */
export function parseBgId(output: string): string | undefined {
  return /backgrounded\b[^\n0-9a-f]*([0-9a-f]{8})\b/.exec(output)?.[1];
}

export interface BgEntry {
  id: string;
  sessionId?: string;
  /** Background sessions: working | blocked | done | failed (Claude Code 2.1.296+). */
  state?: string;
  status?: string;
}

/** `claude agents --json --all` → entries. Anything but a JSON list THROWS (a failed read is not "gone"). */
export function parseAgentsList(text: string): BgEntry[] {
  const data = JSON.parse(text) as unknown;
  if (!Array.isArray(data)) throw new Error("claude agents --json did not return a list");
  return data.filter((e): e is BgEntry => !!e && typeof (e as { id?: unknown }).id === "string");
}

export type BgPhase = "running" | "finished" | "blocked" | "gone";

export function bgPhase(entry: BgEntry | undefined): BgPhase {
  if (!entry) return "gone";
  if (entry.state === "done" || entry.state === "failed") return "finished";
  if (entry.state === "blocked") return "blocked";
  return "running";
}

/** The transcript of a Claude session: `<config>/projects/<any>/<sessionId>.jsonl`. */
export function findTranscript(claudeConfigDir: string | undefined, sessionId: string): string | undefined {
  const projects = path.join(claudeConfigDir ?? path.join(os.homedir(), ".claude"), "projects");
  let dirs: string[];
  try {
    dirs = fs.readdirSync(projects);
  } catch {
    return undefined;
  }
  for (const d of dirs) {
    const f = path.join(projects, d, `${sessionId}.jsonl`);
    if (fs.existsSync(f)) return f;
  }
  return undefined;
}

/** How a background run's transcript ends, reading only entries written since `sinceMs`. */
export function readTranscriptEnd(text: string, sinceMs: number): RunEnd & { seen: number } {
  let end: RunEnd = {};
  let seen = 0;
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    let ev: Record<string, unknown>;
    try {
      ev = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (ev.type !== "assistant") continue;
    const at = typeof ev.timestamp === "string" ? Date.parse(ev.timestamp) : NaN;
    if (!(at >= sinceMs)) continue;
    seen++;
    end = foldRunEvent(end, ev);
  }
  return { ...end, seen };
}

/** A background run blocked (it needs input nobody will give) this long is ended. */
export const BG_BLOCKED_MAX_MS = 15 * 60_000;
/** A background run not yet listed, or listed with nothing new, is waited for this long after launch. */
export const BG_SETTLE_MS = 2 * 60_000;

/** The final `WORKER-RESULT:` line of a run's result text, if present. */
export function workerVerdict(resultText: string | undefined): string | undefined {
  if (!resultText) return undefined;
  const lines = resultText.trim().split(/\r?\n/);
  for (let i = lines.length - 1; i >= 0; i--) {
    const m = /WORKER-RESULT:\s*(.+)$/.exec(lines[i]);
    if (m) return m[1].trim();
  }
  return undefined;
}

export interface RoomMessage {
  id?: string;
  content?: string;
  timestamp?: string;
  authorType?: string;
  routedTeammateId?: string | null;
}

/** At most this many follow-up resumes per session (a runaway-loop guard). */
export const MAX_RESUMES = 20;

/**
 * Room messages posted after `since` by anyone but this agent — the follow-ups
 * (an orchestrator's ANSWER, the person's reply) that should resume a finished
 * run. The worker's own posts carry its agent id and never resume it.
 */
export function followUpsSince(messages: RoomMessage[], since: string, selfAgentId: string): RoomMessage[] {
  const t0 = Date.parse(since);
  return messages
    .filter((m) => typeof m.timestamp === "string" && Date.parse(m.timestamp) > t0)
    .filter((m) => m.routedTeammateId !== selfAgentId)
    .filter((m) => typeof m.content === "string" && m.content.trim().length > 0)
    .sort((a, b) => Date.parse(a.timestamp as string) - Date.parse(b.timestamp as string));
}

/** The prompt that resumes a finished run with the room's new messages. */
export function buildFollowUpPrompt(messages: RoomMessage[]): string {
  const lines = messages.map((m) => {
    const who = m.authorType === "human" ? "the person" : m.routedTeammateId ? `agent ${m.routedTeammateId}` : "someone";
    const text = (m.content ?? "").trim();
    return `- ${who} (${m.timestamp}): ${text.length > 2000 ? `${text.slice(0, 2000)}…` : text}`;
  });
  return [
    `New messages arrived in this session's room after your last run:`,
    ...lines,
    ``,
    `Continue under the same protocol: re-read the room if needed, act on these messages, report in the room, record outcomes, and end with one line: WORKER-RESULT: done | blocked | failed — <one sentence>.`,
  ].join("\n");
}

// ─── state ────────────────────────────────────────────────────────────────────

function stateDir(agent: string): string {
  return path.join(os.homedir(), ".synap", "worker", agent);
}

function loadState(agent: string): WorkerState {
  const file = path.join(stateDir(agent), "state.json");
  if (!fs.existsSync(file)) return { runs: {} };
  return JSON.parse(fs.readFileSync(file, "utf8")) as WorkerState;
}

function saveState(agent: string, state: WorkerState): void {
  const dir = stateDir(agent);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const tmp = path.join(dir, "state.json.tmp");
  writeSecretFile(tmp, JSON.stringify(state, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, path.join(dir, "state.json"));
}

function say(line: string): void {
  process.stdout.write(`[synap worker ${new Date().toISOString()}] ${line}\n`);
}

// ─── the worker ───────────────────────────────────────────────────────────────

export interface ExecResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

/** Runs a short-lived command (`claude --bg`, `claude agents`, `claude stop`). */
export type ExecFn = (bin: string, args: string[], o: { cwd: string; env: NodeJS.ProcessEnv }) => Promise<ExecResult>;

const defaultExec: ExecFn = (bin, args, o) =>
  new Promise((resolve) => {
    execFile(bin, args, { cwd: o.cwd, env: o.env, timeout: 60_000, maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) => {
      const code = err ? (typeof (err as { code?: unknown }).code === "number" ? ((err as { code: number }).code) : 1) : 0;
      resolve({ code, stdout: String(stdout ?? ""), stderr: String(stderr ?? "") });
    });
  });

export interface WorkerDeps {
  mcp: McpCallClient;
  podUrl: string;
  apiKey: string;
  /** The worker agent's own user id: its posts never resume it. */
  selfAgentId: string;
  exec?: ExecFn;
  /** The account probe's fetch (tests stub it). */
  fetchImpl?: typeof fetch;
  now?: () => number;
  say?: (line: string) => void;
}

export interface Worker {
  tick(): Promise<{ handed: number; launched: number }>;
  /** Re-read the background runs' state (design runs). */
  watch(): Promise<void>;
  waitForChildren(): Promise<void>;
  backgroundRunning(): number;
  stop(): void;
  readonly state: WorkerState;
}

type How =
  | { kind: "fresh" }
  | { kind: "followUp"; claudeSessionId: string; prompt: string }
  | { kind: "limitResume"; claudeSessionId?: string };

export function createWorker(opts: WorkerOptions, deps: WorkerDeps): Worker {
  const agent = opts.agent;
  const now = deps.now ?? Date.now;
  const log = deps.say ?? say;
  const exec = deps.exec ?? defaultExec;
  const iso = () => new Date(now()).toISOString();
  const maxParallel = Math.max(1, Number(opts.maxParallel ?? "1"));
  const cwd = path.resolve(opts.cwd ?? path.join(os.homedir(), "Documents", "Code", "synap"));
  const claudeBin = opts.claudeBin ?? "claude";

  const mcpServer = RUN_MCP_SERVER;

  const allowed = (opts.allowedTools ? opts.allowedTools.split(",") : DEFAULT_ALLOWED_TOOLS)
    .map((t) => t.trim())
    .filter(Boolean);
  allowed.push(`mcp__${mcpServer}`);

  const accountsFile = loadAccountsFile(opts.accounts);
  const pool = accountsFile
    ? new AccountPool(accountsFile, (token) => probeAccount(token, { fetchImpl: deps.fetchImpl, now }), now)
    : undefined;
  if (accountsFile && accountsFileTooOpen(opts.accounts ?? defaultAccountsFile())) {
    log(`warning: the accounts file is readable by other users — chmod 600 ${opts.accounts ?? defaultAccountsFile()}`);
  }

  const state = loadState(agent);
  for (const r of Object.values(state.runs)) {
    // A print run dies with this process. A background run outlives it and is
    // watched again — unless it never got its id (the worker died mid-launch).
    if (r.status === "running" && (r.mode !== "bg" || !r.bgId)) {
      r.status = "failed";
      r.result = "worker restarted while this run was in flight";
      r.finishedAt = iso();
    }
  }
  saveState(agent, state);
  const save = () => saveState(agent, state);

  const runsDir = path.join(stateDir(agent), "runs");
  const appendRunLog = (sessionId: string, line: Record<string, unknown>) => {
    fs.mkdirSync(runsDir, { recursive: true, mode: 0o700 });
    fs.appendFileSync(path.join(runsDir, `${sessionId}.jsonl`), `${JSON.stringify({ ...line, at: iso() })}\n`, { mode: 0o600 });
  };

  const children = new Map<string, ChildProcess>();
  const bgRunning = () => Object.values(state.runs).filter((r) => r.status === "running" && r.mode === "bg");
  const active = () => children.size + bgRunning().length;

  const who = accountsFile
    ? `accounts ${accountsFile.accounts.map((a) => `${a.id}${a.design ? " (design)" : ""}`).join(", ")} · reserve ${accountsFile.reserve}`
    : "the environment's Claude login";
  log(`agent ${agent} → ${deps.podUrl} · MCP server "${mcpServer}" · cwd ${cwd} · max ${maxParallel} parallel · ${who}`);

  // ── accounts ──
  const saidOnce = new Set<string>();
  const sayOnce = (key: string, line: string) => {
    if (saidOnce.has(key)) return;
    saidOnce.add(key);
    log(line);
  };
  let measuredThisTick = false;
  /** `undefined`: no accounts file (the environment's login). `null`: no account with room — do not launch. */
  const pick = async (design: boolean): Promise<AccountSpec | null | undefined> => {
    if (!pool) return undefined;
    if (!measuredThisTick) {
      await pool.measure();
      measuredThisTick = true;
    }
    const key = `noroom:${design ? "design" : "run"}`;
    const sel = pool.select({ design });
    if (!sel.account) {
      sayOnce(key, `${sel.reason} — not launching ${design ? "design runs" : "runs"} for now; checking every tick`);
      return null;
    }
    if (saidOnce.delete(key)) log(`account ${sel.account.id} has room again`);
    return sel.account;
  };

  /** A run that ended on a usage limit: that account is out until its reset, the run waits to move. */
  const markLimited = (rec: RunRecord, hit: LimitHit) => {
    if (!pool || !rec.accountId) return false;
    const until = limitUntil(hit, now());
    pool.markFull(rec.accountId, until);
    rec.status = "limited";
    rec.result = `usage limit (${hit.error}) on account ${rec.accountId} until ${new Date(until).toISOString()} — resumes on another account`;
    return true;
  };

  // ── launching ──
  const launch = async (item: HandedItem, how: How, protocol: SessionProtocol, account: AccountSpec | undefined): Promise<void> => {
    const design = protocol === "design";
    const resumeId = how.kind === "fresh" ? undefined : how.claudeSessionId;
    // The run names its own Claude session up front (`--session-id`), so the pod sees ONE
    // conversation per run, kept across resumes, instead of a new MCP transport id each launch.
    const runSessionId = resumeId ?? randomUUID();
    const mcpConfigPath = writeRunMcpConfig(
      stateDir(agent),
      runMcpConfig(deps.podUrl, deps.apiKey, runSessionId),
      `mcp-${item.id}.json`
    );
    const prompt =
      how.kind === "followUp"
        ? how.prompt
        : how.kind === "limitResume" && how.claudeSessionId
          ? LIMIT_RESUME_PROMPT
          : protocol === "task"
            ? buildTaskPrompt({ sessionId: item.id, goal: item.goal, agentName: agent, mcpServer })
            : buildWorkerPrompt({ sessionId: item.id, goal: item.goal, agentName: agent, cwd, mcpServer, design });

    const prior = state.runs[item.id];
    const base = {
      status: "running" as const,
      exitCode: undefined,
      accountId: account?.id,
      mode: design ? ("bg" as const) : ("print" as const),
      protocol: design ? undefined : protocol,
      launchedAt: iso(),
      blockedSince: undefined,
    };
    const record: RunRecord =
      how.kind !== "fresh" && prior
        ? Object.assign(
            prior,
            base,
            how.kind === "followUp" ? { resumes: (prior.resumes ?? 0) + 1 } : { limitResumes: (prior.limitResumes ?? 0) + 1 }
          )
        : {
            sessionId: item.id,
            startedAt: iso(),
            ...base,
            // A relaunch of a run that never started keeps counting its retries.
            ...(prior && prior.status === "failed" && !prior.claudeSessionId
              ? { launchRetries: (prior.launchRetries ?? 0) + 1 }
              : {}),
          };
    state.runs[item.id] = record;
    const what =
      how.kind === "fresh"
        ? "launched"
        : how.kind === "followUp"
          ? `resumed (follow-up #${record.resumes})`
          : `resumed after a usage limit (#${record.limitResumes})`;
    const on = `${account ? ` on account ${account.id}` : ""}${protocol === "task" ? " · task protocol" : ""}`;
    const env = workerEnv(process.env, opts.claudeConfigDir, account?.token);

    if (design) {
      // `claude --bg` is the mode that has the Artifact tool. --strict-mcp-config: a
      // project .mcp.json would stop it on an interactive "new MCP servers" prompt.
      // dontAsk: a tool outside the list is denied, never a prompt nobody answers.
      const args = [
        "--bg",
        ...(resumeId ? ["--resume", resumeId] : ["--session-id", runSessionId]),
        prompt,
        "--strict-mcp-config",
        "--mcp-config",
        mcpConfigPath,
        ...(opts.skipPermissions
          ? ["--dangerously-skip-permissions"]
          : ["--permission-mode", "dontAsk", "--allowedTools", [...allowed, ...DESIGN_EXTRA_TOOLS].join(",")]),
      ];
      if (opts.dryRun) {
        record.status = "done";
        record.result = `dry run: would launch ${claudeBin} --bg in ${cwd}${on}`;
        save();
        log(`dry run — design session ${item.id}${on}: ${claudeBin} --bg <prompt> ${args.slice(4).join(" ")}`);
        return;
      }
      save();
      const res = await exec(claudeBin, args, { cwd, env });
      const bgId = parseBgId(`${res.stdout}\n${res.stderr}`);
      appendRunLog(item.id, { type: "synap-worker", event: "bg-launch", bgId: bgId ?? null, accountId: account?.id ?? null, exit: res.code });
      if (res.code !== 0 || !bgId) {
        record.status = "failed";
        record.exitCode = res.code;
        record.finishedAt = iso();
        record.result = `claude --bg did not start (exit ${res.code}): ${(res.stderr || res.stdout).trim().slice(-200)}`;
        save();
        log(`session ${item.id}: ${record.result}`);
        return;
      }
      record.bgId = bgId;
      save();
      log(`${what} design session ${item.id} as background ${bgId}${on}`);
      return;
    }

    const args = ["-p", prompt, "--output-format", "stream-json", "--verbose", "--mcp-config", mcpConfigPath];
    args.push(...(resumeId ? ["--resume", resumeId] : ["--session-id", runSessionId]));
    args.push(...printRunPermissionArgs(protocol, { codeAllowed: allowed, mcpServer, skipPermissions: opts.skipPermissions }));

    if (opts.dryRun) {
      record.status = "done";
      record.result = `dry run: would launch ${claudeBin} in ${cwd}${on}`;
      save();
      log(`dry run — session ${item.id}${on}: ${claudeBin} ${args.slice(0, 1).join(" ")} <prompt> ${args.slice(2).join(" ")}`);
      return;
    }

    fs.mkdirSync(runsDir, { recursive: true, mode: 0o700 });
    const out = fs.createWriteStream(path.join(runsDir, `${item.id}.jsonl`), { flags: "a", mode: 0o600 });
    const child = spawn(claudeBin, args, { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
    children.set(item.id, child);
    record.pid = child.pid;
    save();
    log(`${what} session ${item.id} (pid ${child.pid})${on}`);

    let buffered = "";
    let end: RunEnd = {};
    const rejected: { at?: number } = {};
    child.stdout?.on("data", (chunk: Buffer) => {
      out.write(chunk);
      buffered += chunk.toString("utf8");
      const lines = buffered.split("\n");
      buffered = lines.pop() ?? "";
      for (const line of lines) {
        try {
          end = foldRunEvent(end, JSON.parse(line) as Record<string, unknown>, rejected);
        } catch {
          continue; // a partial or non-JSON line — kept in the run log, not parsed
        }
        if (end.claudeSessionId && !record.claudeSessionId) {
          record.claudeSessionId = end.claudeSessionId;
          save();
        }
      }
    });
    child.stderr?.on("data", (chunk: Buffer) => out.write(chunk));
    child.on("error", (err) => {
      // The binary could not be started: `close` follows with no exit code.
      out.write(`synap-worker: could not start ${claudeBin}: ${err.message}\n`);
    });
    child.on("close", (code) => {
      children.delete(item.id);
      out.end();
      record.exitCode = code;
      record.finishedAt = iso();
      const hit = endedOnLimit(end);
      if (!(hit && markLimited(record, hit))) {
        record.result = workerVerdict(end.text) ?? (end.text ? end.text.slice(-300) : undefined);
        record.status = code === 0 ? "done" : "failed";
      }
      save();
      log(`session ${item.id} finished — exit ${code}${record.result ? ` · ${record.result}` : ""}`);
    });
  };

  // ── watching background (design) runs ──
  const stopBg = async (rec: RunRecord) => {
    if (!rec.bgId) return;
    const r = await exec(claudeBin, ["stop", rec.bgId], { cwd, env: workerEnv(process.env, opts.claudeConfigDir) });
    if (r.code !== 0) log(`could not stop background ${rec.bgId} (exit ${r.code}); stop it with: claude stop ${rec.bgId}`);
  };
  const endBg = async (rec: RunRecord, status: "done" | "failed", result: string | undefined) => {
    rec.status = status;
    rec.result = result;
    rec.finishedAt = iso();
    rec.blockedSince = undefined;
    save();
    appendRunLog(rec.sessionId, { type: "synap-worker", event: "bg-end", bgId: rec.bgId ?? null, status });
    log(`session ${rec.sessionId} (background ${rec.bgId}) finished — ${status}${result ? ` · ${result}` : ""}`);
    await stopBg(rec);
  };

  const watch = async () => {
    const running = bgRunning().filter((r) => r.bgId);
    if (!running.length) return;
    const res = await exec(claudeBin, ["agents", "--json", "--all", "--cwd", cwd], {
      cwd,
      env: workerEnv(process.env, opts.claudeConfigDir),
    });
    let list: BgEntry[];
    try {
      if (res.code !== 0) throw new Error(`exit ${res.code}: ${res.stderr.trim().slice(-160)}`);
      list = parseAgentsList(res.stdout);
    } catch (err) {
      // A failed read is not "gone": the runs stay as they were.
      log(`could not list background sessions (${(err as Error).message}); checking again next tick`);
      return;
    }
    for (const rec of running) {
      const entry = list.find((e) => e.id === rec.bgId);
      if (entry?.sessionId && !rec.claudeSessionId) {
        rec.claudeSessionId = entry.sessionId;
        save();
      }
      const phase = bgPhase(entry);
      const since = Date.parse(rec.launchedAt ?? rec.startedAt);
      if (phase === "running") {
        if (rec.blockedSince) {
          rec.blockedSince = undefined;
          save();
        }
        continue;
      }
      if (phase === "gone") {
        if (now() - since > BG_SETTLE_MS) await endBg(rec, "failed", "background session no longer listed by claude agents");
        continue;
      }
      const file = rec.claudeSessionId ? findTranscript(opts.claudeConfigDir, rec.claudeSessionId) : undefined;
      const end = file ? readTranscriptEnd(fs.readFileSync(file, "utf8"), since) : undefined;
      const hit = end ? endedOnLimit(end) : undefined;
      if (hit) {
        rec.finishedAt = iso();
        rec.blockedSince = undefined;
        if (!markLimited(rec, hit)) {
          rec.status = "failed";
          rec.result = `usage limit (${hit.error})`;
        }
        save();
        log(`session ${rec.sessionId} (background ${rec.bgId}): ${rec.result}`);
        await stopBg(rec);
        continue;
      }
      if (phase === "finished") {
        // Just resumed: the listing can still show the previous turn's ending.
        if (!end?.seen && now() - since < BG_SETTLE_MS) continue;
        const text = end?.text;
        await endBg(
          rec,
          entry?.state === "done" ? "done" : "failed",
          workerVerdict(text) ?? (text ? text.slice(-300) : file ? "no reply since launch" : "transcript not found")
        );
        continue;
      }
      // Blocked and not on a limit: it waits for input nobody here will give.
      if (!rec.blockedSince) {
        rec.blockedSince = iso();
        save();
      } else if (now() - Date.parse(rec.blockedSince) > BG_BLOCKED_MAX_MS) {
        await endBg(rec, "failed", `background session blocked (needs input) for ${BG_BLOCKED_MAX_MS / 60_000} min — claude attach ${rec.bgId}`);
      }
    }
  };

  // ── the tick ──
  const roomFollowUps = async (sessionId: string, since: string): Promise<RoomMessage[]> => {
    const s = await deps.mcp.call("synap_get_session", { sessionId });
    if (s.isError) throw new Error(`get_session ${sessionId} refused: ${s.text.slice(0, 160)}`);
    const channelId = (findKey(JSON.parse(s.text), "channelId") as string | undefined) ?? null;
    if (!channelId) return [];
    const t = await deps.mcp.call("synap_get_thread_context", { threadId: channelId });
    if (t.isError) throw new Error(`thread ${channelId} refused: ${t.text.slice(0, 160)}`);
    const messages = (JSON.parse(t.text) as { messages?: RoomMessage[] }).messages ?? [];
    return followUpsSince(messages, since, deps.selfAgentId);
  };

  /** Which protocol a handed session gets; `undefined` when that could not be read (not launched this tick). */
  const readProtocol = async (sessionId: string): Promise<SessionProtocol | undefined> => {
    try {
      const s = await deps.mcp.call("synap_get_session", { sessionId });
      if (s.isError) throw new Error(`refused: ${s.text.slice(0, 160)}`);
      return classifySession(s.text);
    } catch (err) {
      const msg = (err as Error).message;
      sayOnce(`protocol:${sessionId}:${msg}`, `session ${sessionId}: could not read which protocol it needs (${msg}) — not launched; retried every tick`);
      return undefined;
    }
  };
  /** The protocol a run was launched under: a resume keeps it. */
  const recordedProtocol = (rec: RunRecord): SessionProtocol => (rec.mode === "bg" ? "design" : (rec.protocol ?? "code"));

  const tick = async () => {
    measuredThisTick = false;
    const res = await deps.mcp.call("synap_orient", {});
    if (res.isError) throw new Error(`orient refused: ${res.text.slice(0, 200)}`);
    const items = parseHandedToYou(res.text);
    await watch();
    const free = () => maxParallel - active();
    const handed = new Map(items.map((i) => [i.id, i]));
    let launched = 0;

    // 1. Runs a usage limit cut off: resumed first, on an account with room.
    for (const rec of Object.values(state.runs)) {
      if (free() <= 0) break;
      const item = rec.status === "limited" ? handed.get(rec.sessionId) : undefined;
      if (!item) continue;
      if ((rec.limitResumes ?? 0) >= MAX_LIMIT_RESUMES) {
        rec.status = "failed";
        rec.result = `stopped: cut off by a usage limit ${MAX_LIMIT_RESUMES + 1} times`;
        save();
        log(`session ${rec.sessionId}: ${rec.result}`);
        continue;
      }
      const protocol = recordedProtocol(rec);
      const account = await pick(protocol === "design");
      if (account === null) continue;
      await launch(item, { kind: "limitResume", claudeSessionId: rec.claudeSessionId }, protocol, account);
      launched++;
    }

    // 2. Sessions never launched (or due a relaunch).
    for (const item of pickNew(items, state, items.length, now())) {
      if (free() <= 0) break;
      const protocol = await readProtocol(item.id);
      if (protocol === undefined) continue;
      const account = await pick(protocol === "design");
      if (account === null) continue;
      await launch(item, { kind: "fresh" }, protocol, account);
      launched++;
    }

    // 3. Finished runs with new room messages: resumed.
    for (const item of items) {
      if (free() <= 0) break;
      const rec = state.runs[item.id];
      if (!rec || rec.status === "running" || rec.status === "limited" || !rec.claudeSessionId || !rec.finishedAt) continue;
      if ((rec.resumes ?? 0) >= MAX_RESUMES) continue;
      const follow = await roomFollowUps(item.id, rec.finishedAt);
      if (!follow.length) continue;
      const protocol = recordedProtocol(rec);
      const account = await pick(protocol === "design");
      if (account === null) continue;
      await launch(item, { kind: "followUp", claudeSessionId: rec.claudeSessionId, prompt: buildFollowUpPrompt(follow) }, protocol, account);
      launched++;
    }
    return { handed: items.length, launched };
  };

  return {
    tick,
    watch,
    state,
    backgroundRunning: () => bgRunning().length,
    waitForChildren: async () => {
      while (children.size) {
        await Promise.all([...children.values()].map((c) => new Promise((r) => c.once("close", r))));
      }
    },
    stop: () => {
      for (const c of children.values()) c.kill("SIGTERM");
    },
  };
}

// ─── the loop ─────────────────────────────────────────────────────────────────

export async function workerCommand(opts: WorkerOptions): Promise<void> {
  const agent = opts.agent;
  // The named agent's own key and pod (SYNAP_AGENT is the CLI's one door for it).
  process.env.SYNAP_AGENT = agent;
  const cfg = await resolveHubConfig();
  const intervalMs = parseInterval(opts.interval);

  const mcp: McpCallClient = createMcpClient({
    url: `${cfg.podUrl.replace(/\/+$/, "")}/mcp`,
    apiKey: cfg.apiKey,
    clientName: `synap-worker/${agent}`,
  });
  // Its own posts must never resume it: compare with the key's AGENT id (who
  // the key is), never the acting user /users/me answers (its linked human).
  const selfAgentId = await resolveAgentUserId(cfg);
  const worker = createWorker(opts, { mcp, podUrl: cfg.podUrl, apiKey: cfg.apiKey, selfAgentId });

  let stopping = false;
  const stop = () => {
    stopping = true;
    worker.stop();
  };
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
  say(`every ${intervalMs / 1000}s`);

  let failures = 0;
  let paused = false;
  while (!stopping) {
    try {
      const r = await worker.tick();
      failures = 0;
      if (paused) say("resumed: picking up work again");
      paused = false;
      if (r.launched) say(`${r.handed} handed · launched ${r.launched}`);
    } catch (err) {
      if (err instanceof AgentBoundForDispatchError) {
        // Not a failed read: retrying would never change the answer.
        say(err.message);
        break;
      }
      if (err instanceof AgentPausedError) {
        // Not a failed read either: idle at the normal pace, say it once.
        if (!paused) say(err.message);
        paused = true;
        if (opts.once) break;
        await new Promise((r) => setTimeout(r, intervalMs));
        continue;
      }
      failures++;
      say(`read failed (${failures} in a row): ${(err as Error).message}`);
      if (opts.once) throw err;
    }
    if (opts.once) break;
    await new Promise((r) => setTimeout(r, Math.min(intervalMs * Math.max(1, failures), 10 * 60_000)));
  }
  if (opts.once) {
    say(`--once: waiting for the run(s) to finish`);
    await worker.waitForChildren();
    while (!stopping && worker.backgroundRunning()) {
      await new Promise((r) => setTimeout(r, intervalMs));
      await worker.watch();
    }
  }
}
