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
 * State (which sessions were launched, their Claude session ids and outcome)
 * lives in ~/.synap/worker/<agent>/state.json; each run's stream-json goes to
 * ~/.synap/worker/<agent>/runs/<sessionId>.jsonl.
 */

import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import { writeSecretFile } from "../lib/atomic-file.js";
import os from "node:os";
import path from "node:path";
import { resolveHubConfig, resolveUserId } from "../lib/hub-client.js";
import { createMcpClient, type McpCallClient } from "../lib/mcp-call.js";

export interface WorkerOptions {
  agent: string;
  interval?: string;
  once?: boolean;
  cwd?: string;
  maxParallel?: string;
  claudeBin?: string;
  claudeConfigDir?: string;
  mcpServer?: string;
  allowedTools?: string;
  skipPermissions?: boolean;
  dryRun?: boolean;
}

export interface HandedItem {
  id: string;
  goal: string | null;
}

export type RunStatus = "running" | "done" | "failed";

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

/** Sessions handed to the agent that this worker has not launched yet. */
export function pickNew(items: HandedItem[], state: WorkerState, slots: number): HandedItem[] {
  if (slots <= 0) return [];
  return items.filter((i) => !state.runs[i.id]).slice(0, slots);
}

/**
 * The MCP server name the local Claude Code uses for THIS pod: the entry in
 * ~/.claude.json whose URL is `<podUrl>/mcp` (user or project scope).
 */
export function findMcpServerName(claudeJson: unknown, podUrl: string): string | null {
  const want = `${podUrl.replace(/\/+$/, "")}/mcp`;
  const scan = (servers: unknown): string | null => {
    if (!servers || typeof servers !== "object") return null;
    for (const [name, v] of Object.entries(servers as Record<string, { url?: unknown }>)) {
      if (typeof v?.url === "string" && v.url.replace(/\/+$/, "") === want) return name;
    }
    return null;
  };
  const cj = claudeJson as { mcpServers?: unknown; projects?: Record<string, { mcpServers?: unknown }> } | null;
  const top = scan(cj?.mcpServers);
  if (top) return top;
  for (const p of Object.values(cj?.projects ?? {})) {
    const hit = scan(p?.mcpServers);
    if (hit) return hit;
  }
  return null;
}

export const DEFAULT_ALLOWED_TOOLS = ["Read", "Edit", "Write", "Glob", "Grep", "Bash", "TodoWrite"];

/** The protocol the launched Claude Code follows for one handed session. */
export function buildWorkerPrompt(p: {
  sessionId: string;
  goal: string | null;
  agentName: string;
  cwd: string;
  mcpServer: string;
}): string {
  const short = p.sessionId.slice(0, 8);
  return [
    `You are the Synap agent "${p.agentName}", an unattended Claude Code worker on this machine.`,
    `A person or an orchestrating AI handed you ONE Synap focus session. Work it end to end.`,
    `Synap tools are on the MCP server "${p.mcpServer}" (mcp__${p.mcpServer}__synap_*).`,
    ``,
    `Session: ${p.sessionId}`,
    `Goal as handed: ${p.goal ?? "(read it from the session)"}`,
    ``,
    `Protocol:`,
    `1. Read: synap_get_session {sessionId} for the goal, outcomes and channelId (the room); then synap_get_thread_context {threadId: <channelId>} for what was said so far.`,
    `2. Claim: synap_post_message to the room (kind "update"), one line: you picked it up and what you will do first.`,
    `3. Work in ${p.cwd}. Shared-tree rules: never commit on a repo's main; for code changes use a git worktree on a branch named devbox/${short}-<slug>; never push to main, never deploy, never run git checkout --, restore, stash or reset --hard on a shared clone.`,
    `4. Need help or a decision: post in the room starting with "QUESTION:" — kind "update" when the orchestrating AI can answer it, kind "question" only for a decision only the person can make. Then wait for the reply: read synap_get_thread_context about every 60 seconds (Bash "sleep 60" between reads), up to 30 minutes, and use the first reply posted after your question. No reply: state your assumption in the room and continue, or stop and say what is blocked.`,
    `5. Report: post a concise result in the room (what changed, where — branch, commit, files). Record deliverables against the session's outcomes with synap_update_session (completeOutput = the outcome key, with a ref when an object exists). Do not close the session; the owner does.`,
    `6. End your final message with one line: WORKER-RESULT: done | blocked | failed — <one sentence>.`,
  ].join("\n");
}

/** The launched environment: the subscription, never a stray API key. */
export function workerEnv(base: NodeJS.ProcessEnv, claudeConfigDir?: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...base };
  delete env.ANTHROPIC_API_KEY;
  delete env.ANTHROPIC_AUTH_TOKEN;
  delete env.ANTHROPIC_BASE_URL;
  if (claudeConfigDir) env.CLAUDE_CONFIG_DIR = claudeConfigDir;
  return env;
}

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

// ─── the loop ─────────────────────────────────────────────────────────────────

export async function workerCommand(opts: WorkerOptions): Promise<void> {
  const agent = opts.agent;
  // The named agent's own key and pod (SYNAP_AGENT is the CLI's one door for it).
  process.env.SYNAP_AGENT = agent;
  const cfg = await resolveHubConfig();
  const intervalMs = parseInterval(opts.interval);
  const maxParallel = Math.max(1, Number(opts.maxParallel ?? "1"));
  const cwd = path.resolve(opts.cwd ?? path.join(os.homedir(), "Documents", "Code", "synap"));
  const claudeBin = opts.claudeBin ?? "claude";

  const claudeJsonPath = path.join(opts.claudeConfigDir ?? os.homedir(), ".claude.json");
  let mcpServer = opts.mcpServer ?? null;
  if (!mcpServer && fs.existsSync(claudeJsonPath)) {
    mcpServer = findMcpServerName(JSON.parse(fs.readFileSync(claudeJsonPath, "utf8")), cfg.podUrl);
  }
  if (!mcpServer) {
    throw new Error(
      `No Claude Code MCP server points at ${cfg.podUrl}/mcp in ${claudeJsonPath}. ` +
        `Connect Claude Code to the pod with this agent's key, or pass --mcp-server <name>.`
    );
  }

  const allowed = (opts.allowedTools ? opts.allowedTools.split(",") : DEFAULT_ALLOWED_TOOLS)
    .map((t) => t.trim())
    .filter(Boolean);
  allowed.push(`mcp__${mcpServer}`);

  const mcp: McpCallClient = createMcpClient({
    url: `${cfg.podUrl.replace(/\/+$/, "")}/mcp`,
    apiKey: cfg.apiKey,
    clientName: `synap-worker/${agent}`,
  });

  const state = loadState(agent);
  // A run "running" at start is a run this process can no longer watch.
  for (const r of Object.values(state.runs)) {
    if (r.status === "running") {
      r.status = "failed";
      r.result = "worker restarted while this run was in flight";
      r.finishedAt = new Date().toISOString();
    }
  }
  saveState(agent, state);

  const children = new Map<string, ChildProcess>();
  let stopping = false;
  const stop = () => {
    stopping = true;
    for (const c of children.values()) c.kill("SIGTERM");
  };
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);

  say(`agent ${agent} → ${cfg.podUrl} · MCP server "${mcpServer}" · cwd ${cwd} · every ${intervalMs / 1000}s · max ${maxParallel} parallel`);

  const launch = (item: HandedItem, resume?: { claudeSessionId: string; prompt: string }) => {
    const prompt =
      resume?.prompt ??
      buildWorkerPrompt({ sessionId: item.id, goal: item.goal, agentName: agent, cwd, mcpServer: mcpServer as string });
    const args = ["-p", prompt, "--output-format", "stream-json", "--verbose"];
    if (resume) args.push("--resume", resume.claudeSessionId);
    if (opts.skipPermissions) args.push("--dangerously-skip-permissions");
    else args.push("--permission-mode", "acceptEdits", "--allowedTools", ...allowed);

    const prior = state.runs[item.id];
    const record: RunRecord = resume && prior
      ? Object.assign(prior, { status: "running" as const, resumes: (prior.resumes ?? 0) + 1, exitCode: undefined })
      : { sessionId: item.id, status: "running", startedAt: new Date().toISOString() };
    state.runs[item.id] = record;
    if (opts.dryRun) {
      record.status = "done";
      record.result = `dry run: would launch ${claudeBin} in ${cwd}`;
      saveState(agent, state);
      say(`dry run — session ${item.id}: ${claudeBin} ${args.slice(0, 1).join(" ")} <prompt> ${args.slice(2).join(" ")}`);
      return;
    }

    const runsDir = path.join(stateDir(agent), "runs");
    fs.mkdirSync(runsDir, { recursive: true, mode: 0o700 });
    const out = fs.createWriteStream(path.join(runsDir, `${item.id}.jsonl`), { flags: "a", mode: 0o600 });
    const child = spawn(claudeBin, args, { cwd, env: workerEnv(process.env, opts.claudeConfigDir), stdio: ["ignore", "pipe", "pipe"] });
    children.set(item.id, child);
    record.pid = child.pid;
    saveState(agent, state);
    say(`${resume ? `resumed (follow-up #${record.resumes})` : "launched"} session ${item.id} (pid ${child.pid})`);

    let buffered = "";
    let lastResult: string | undefined;
    child.stdout?.on("data", (chunk: Buffer) => {
      out.write(chunk);
      buffered += chunk.toString("utf8");
      const lines = buffered.split("\n");
      buffered = lines.pop() ?? "";
      for (const line of lines) {
        try {
          const ev = JSON.parse(line) as { type?: string; subtype?: string; session_id?: string; result?: string };
          if (ev.type === "system" && ev.subtype === "init" && ev.session_id && !record.claudeSessionId) {
            record.claudeSessionId = ev.session_id;
            saveState(agent, state);
          }
          if (ev.type === "result" && typeof ev.result === "string") lastResult = ev.result;
        } catch {
          /* a partial or non-JSON line — kept in the run log, not parsed */
        }
      }
    });
    child.stderr?.on("data", (chunk: Buffer) => out.write(chunk));
    child.on("close", (code) => {
      children.delete(item.id);
      out.end();
      record.exitCode = code;
      record.finishedAt = new Date().toISOString();
      record.result = workerVerdict(lastResult) ?? (lastResult ? lastResult.slice(-300) : undefined);
      record.status = code === 0 ? "done" : "failed";
      saveState(agent, state);
      say(`session ${item.id} finished — exit ${code}${record.result ? ` · ${record.result}` : ""}`);
    });
  };

  // Its own posts must never resume it: compare with the key's real agent id.
  const selfAgentId = await resolveUserId(cfg);
  const roomFollowUps = async (sessionId: string, since: string): Promise<RoomMessage[]> => {
    const s = await mcp.call("synap_get_session", { sessionId });
    if (s.isError) throw new Error(`get_session ${sessionId} refused: ${s.text.slice(0, 160)}`);
    const channelId = (findKey(JSON.parse(s.text), "channelId") as string | undefined) ?? null;
    if (!channelId) return [];
    const t = await mcp.call("synap_get_thread_context", { threadId: channelId });
    if (t.isError) throw new Error(`thread ${channelId} refused: ${t.text.slice(0, 160)}`);
    const messages = (JSON.parse(t.text) as { messages?: RoomMessage[] }).messages ?? [];
    return followUpsSince(messages, since, selfAgentId);
  };

  const tick = async () => {
    const res = await mcp.call("synap_orient", {});
    if (res.isError) throw new Error(`orient refused: ${res.text.slice(0, 200)}`);
    const items = parseHandedToYou(res.text);
    const fresh = pickNew(items, state, maxParallel - children.size);
    for (const item of fresh) launch(item);
    let resumed = 0;
    for (const item of items) {
      if (children.size >= maxParallel) break;
      const rec = state.runs[item.id];
      if (!rec || rec.status === "running" || !rec.claudeSessionId || !rec.finishedAt) continue;
      if ((rec.resumes ?? 0) >= MAX_RESUMES) continue;
      const follow = await roomFollowUps(item.id, rec.finishedAt);
      if (!follow.length) continue;
      launch(item, { claudeSessionId: rec.claudeSessionId, prompt: buildFollowUpPrompt(follow) });
      resumed++;
    }
    return { handed: items.length, launched: fresh.length + resumed };
  };

  let failures = 0;
  let paused = false;
  while (!stopping) {
    try {
      const r = await tick();
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
  if (opts.once && children.size) {
    say(`--once: waiting for ${children.size} run(s) to finish`);
    await Promise.all([...children.values()].map((c) => new Promise((r) => c.on("close", r))));
  }
}
