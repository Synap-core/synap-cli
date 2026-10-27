import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildWorkerPrompt,
  RUN_MCP_SERVER,
  runMcpConfig,
  writeRunMcpConfig,
  AgentBoundForDispatchError,
  AgentPausedError,
  parseHandedToYou,
  parseInterval,
  pickNew,
  LAUNCH_RETRY_BASE_MS,
  MAX_LAUNCH_RETRIES,
  workerEnv,
  workerVerdict,
} from "./worker.js";
import { lastJsonPayload } from "../lib/mcp-call.js";

const orient = (handed: unknown) =>
  JSON.stringify({ startHere: { pendingReview: { count: 0 }, handedToYou: handed } });

describe("parseHandedToYou", () => {
  it("reads the handed sessions from orient", () => {
    const items = parseHandedToYou(
      orient({ count: 2, items: [{ id: "a", goal: "fix x" }, { id: "b", goal: null }] })
    );
    expect(items).toEqual([
      { id: "a", goal: "fix x" },
      { id: "b", goal: null },
    ]);
  });

  it("an unavailable block is a FAILED read, not an empty list", () => {
    expect(() => parseHandedToYou(orient({ status: "unavailable" }))).toThrow(/unavailable/);
  });

  it("a bound agent stops the worker — it is never 'nothing handed'", () => {
    expect(() => parseHandedToYou(orient({ status: "bound" }))).toThrow(AgentBoundForDispatchError);
  });

  it("a paused agent is told apart from a failed read", () => {
    expect(() => parseHandedToYou(orient({ status: "paused" }))).toThrow(AgentPausedError);
  });

  it("a missing block throws instead of reading as nothing handed", () => {
    expect(() => parseHandedToYou(JSON.stringify({ startHere: {} }))).toThrow(/no handedToYou/);
  });

  it("non-JSON orient text throws", () => {
    expect(() => parseHandedToYou("Error: pod down")).toThrow(/did not return JSON/);
  });
});

describe("pickNew", () => {
  const items = [{ id: "a", goal: null }, { id: "b", goal: null }, { id: "c", goal: null }];
  it("skips sessions already launched and respects free slots", () => {
    const state = { runs: { a: { sessionId: "a", status: "done" as const, startedAt: "t" } } };
    expect(pickNew(items, state, 1).map((i) => i.id)).toEqual(["b"]);
  });
  it("launches nothing when no slot is free", () => {
    expect(pickNew(items, { runs: {} }, 0)).toEqual([]);
  });

  // A run that failed BEFORE Claude started (no Claude session: an expired
  // login, exhausted credits) had no way back: the session stayed dead even
  // after the cause was fixed (2026-10-20). It is retried with backoff now.
  describe("a run that failed before Claude started is retried with backoff", () => {
    const T0 = Date.parse("2026-10-20T12:00:00Z");
    const failedAt = (retries: number, extra: Record<string, unknown> = {}) => ({
      runs: {
        a: {
          sessionId: "a",
          status: "failed" as const,
          startedAt: "t",
          finishedAt: new Date(T0).toISOString(),
          launchRetries: retries,
          ...extra,
        },
      },
    });
    const one = [{ id: "a", goal: null }];
    it("not before its backoff", () => {
      expect(pickNew(one, failedAt(0), 1, T0 + LAUNCH_RETRY_BASE_MS - 1)).toEqual([]);
    });
    it("once the backoff has passed", () => {
      expect(pickNew(one, failedAt(0), 1, T0 + LAUNCH_RETRY_BASE_MS).map((i) => i.id)).toEqual(["a"]);
    });
    it("the backoff doubles with each retry", () => {
      expect(pickNew(one, failedAt(2), 1, T0 + 4 * LAUNCH_RETRY_BASE_MS - 1)).toEqual([]);
      expect(pickNew(one, failedAt(2), 1, T0 + 4 * LAUNCH_RETRY_BASE_MS).map((i) => i.id)).toEqual(["a"]);
    });
    it("never after the last retry", () => {
      expect(pickNew(one, failedAt(MAX_LAUNCH_RETRIES), 1, T0 + 1e12)).toEqual([]);
    });
    it("never when Claude did start (a room follow-up resumes that one)", () => {
      expect(pickNew(one, failedAt(0, { claudeSessionId: "c1" }), 1, T0 + 1e12)).toEqual([]);
    });
    it("never a run that finished", () => {
      const state = { runs: { a: { sessionId: "a", status: "done" as const, startedAt: "t", finishedAt: new Date(T0).toISOString() } } };
      expect(pickNew(one, state, 1, T0 + 1e12)).toEqual([]);
    });
  });
});

describe("the run's MCP server is pinned to the worker agent's own key", () => {
  // A `synap login --reconnect` on the box rewrote ~/.claude.json with ANOTHER
  // agent's key; runs that inherited it posted as that agent (2026-10-20).
  it("points one http server at the pod with the worker's key", () => {
    expect(runMcpConfig("https://pod.example/", "synap_hub_k")).toEqual({
      mcpServers: {
        [RUN_MCP_SERVER]: {
          type: "http",
          url: "https://pod.example/mcp",
          headers: { Authorization: "Bearer synap_hub_k" },
        },
      },
    });
  });

  it("names the run's Claude session as the conversation, so the pod sees one run", () => {
    const sid = "8c34a72b-b1c1-4c37-9c1f-02920b69ccb2";
    const cfg = runMcpConfig("https://pod.example", "k", sid) as { mcpServers: Record<string, { headers: Record<string, string> }> };
    expect(cfg.mcpServers[RUN_MCP_SERVER]!.headers).toEqual({
      Authorization: "Bearer k",
      "X-Synap-Conversation": `claude-code:${sid}`,
    });
  });

  it("writes it owner-only, replacing a wider file", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "worker-mcp-"));
    const file = path.join(dir, "mcp.json");
    fs.writeFileSync(file, "{}", { mode: 0o644 });
    const written = writeRunMcpConfig(dir, runMcpConfig("https://pod.example", "k"));
    expect(written).toBe(file);
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    expect(JSON.parse(fs.readFileSync(file, "utf8")).mcpServers[RUN_MCP_SERVER].url).toBe("https://pod.example/mcp");
  });
});

describe("workerEnv", () => {
  it("strips API-key billing and sets the chosen Claude config dir", () => {
    const env = workerEnv(
      { PATH: "/bin", ANTHROPIC_API_KEY: "k", ANTHROPIC_AUTH_TOKEN: "t", ANTHROPIC_BASE_URL: "u" },
      "/srv/cc/auto"
    );
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(env.ANTHROPIC_AUTH_TOKEN).toBeUndefined();
    expect(env.ANTHROPIC_BASE_URL).toBeUndefined();
    expect(env.CLAUDE_CONFIG_DIR).toBe("/srv/cc/auto");
    expect(env.PATH).toBe("/bin");
  });
});

describe("prompt + verdict", () => {
  it("the prompt names the session, the MCP server and the branch rule", () => {
    const p = buildWorkerPrompt({ sessionId: "c5a34b78-0000", goal: "g", agentName: "cc-devbox", cwd: "/w", mcpServer: "synap-pod" });
    expect(p).toContain("Session: c5a34b78-0000");
    expect(p).toContain("mcp__synap-pod__synap_*");
    expect(p).toContain("devbox/c5a34b78-");
    expect(p).toContain("WORKER-RESULT:");
  });
  it("lets the goal name the directory and allows only a preview deploy the goal asks for", () => {
    const p = buildWorkerPrompt({ sessionId: "c5a34b78-0000", goal: "g", agentName: "cc-devbox", cwd: "/w", mcpServer: "synap-pod" });
    expect(p).toContain("Work in /w, or in the directory the session goal names");
    expect(p).toContain("Never deploy to production");
    expect(p).toContain("preview deploy only when the session goal asks for one");
  });
  it("reads the last WORKER-RESULT line", () => {
    expect(workerVerdict("work\nWORKER-RESULT: done — posted report")).toBe("done — posted report");
    expect(workerVerdict("no verdict here")).toBeUndefined();
  });
});

describe("parseInterval", () => {
  it("parses units", () => {
    expect(parseInterval("45")).toBe(45_000);
    expect(parseInterval("2m")).toBe(120_000);
    expect(parseInterval(undefined)).toBe(30_000);
    expect(() => parseInterval("soon")).toThrow();
  });
});

describe("lastJsonPayload", () => {
  it("takes the last SSE data line, or the plain body", () => {
    expect(lastJsonPayload('event: message\ndata: {"a":1}\n\ndata: {"b":2}\n')).toBe('{"b":2}');
    expect(lastJsonPayload('{"plain":true}')).toBe('{"plain":true}');
  });
});

import { buildFollowUpPrompt, followUpsSince, MAX_RESUMES } from "./worker.js";

describe("followUpsSince", () => {
  const self = "agent-self";
  const msgs = [
    { id: "1", content: "my question", timestamp: "2026-10-12T10:00:00Z", routedTeammateId: self },
    { id: "2", content: "ANSWER: yes", timestamp: "2026-10-12T10:05:00Z", routedTeammateId: "orchestrator" },
    { id: "3", content: "old", timestamp: "2026-10-12T09:00:00Z", routedTeammateId: "orchestrator" },
    { id: "4", content: "my report", timestamp: "2026-10-12T10:06:00Z", routedTeammateId: self },
    { id: "5", content: "please also do X", timestamp: "2026-10-12T10:07:00Z", authorType: "human", routedTeammateId: null },
    { id: "6", content: "   ", timestamp: "2026-10-12T10:08:00Z", routedTeammateId: "orchestrator" },
  ];
  it("keeps only others' non-empty messages after the run ended, oldest first", () => {
    expect(followUpsSince(msgs, "2026-10-12T10:01:00Z", self).map((m) => m.id)).toEqual(["2", "5"]);
  });
  it("the worker's own posts never resume it", () => {
    expect(followUpsSince(msgs, "2026-10-12T10:05:30Z", self).map((m) => m.id)).toEqual(["5"]);
  });
  it("nothing new → no resume", () => {
    expect(followUpsSince(msgs, "2026-10-12T11:00:00Z", self)).toEqual([]);
  });
  it("the follow-up prompt carries the messages and the verdict rule", () => {
    const p = buildFollowUpPrompt([{ content: "ANSWER: yes", timestamp: "t", routedTeammateId: "orch" }]);
    expect(p).toContain("agent orch (t): ANSWER: yes");
    expect(p).toContain("WORKER-RESULT:");
    expect(MAX_RESUMES).toBeGreaterThan(0);
  });
});

// ─── night shift: limits, design runs, the protocol ──────────────────────────

import {
  BG_SETTLE_MS,
  bgPhase,
  DESIGN_OUTCOME_KIND,
  endedOnLimit,
  foldRunEvent,
  isDesignSession,
  limitUntil,
  parseAgentsList,
  parseBgId,
  readTranscriptEnd,
  type RunEnd,
} from "./worker.js";

const fold = (lines: Array<Record<string, unknown>>): RunEnd => {
  const rejected: { at?: number } = {};
  return lines.reduce<RunEnd>((end, ev) => foldRunEvent(end, ev, rejected), {});
};

// Reduced from a real `claude -p … --output-format stream-json --verbose` run on
// Claude Code 2.1.309 (2026-10-23): field names verbatim.
const OK_STREAM = [
  { type: "system", subtype: "init", session_id: "0d6b64a2-9d15-444e-be4e-a8f449b51b7f", claude_code_version: "2.1.309" },
  { type: "assistant", parent_tool_use_id: null, session_id: "0d6b64a2", message: { role: "assistant", content: [{ type: "text", text: "WORKER-RESULT: done — ok" }] } },
  { type: "rate_limit_event", rate_limit_info: { status: "allowed", resetsAt: 1792725000, rateLimitType: "five_hour" }, session_id: "0d6b64a2" },
  { type: "result", subtype: "success", is_error: false, api_error_status: null, result: "WORKER-RESULT: done — ok", session_id: "0d6b64a2" },
];
// A usage limit, in the stream's spelling. The assistant fields are the real
// transcript entry's (507 of them in this Mac's ~/.claude/projects: error
// "rate_limit", apiError "usage_limit_reached", apiErrorStatus 429,
// apiErrorParams.rate_limit_info.resetsAt) renamed the way the 2.1.309 binary
// maps them onto SDKAssistantMessage (api_error_status, api_error_params).
const LIMIT_STREAM = [
  { type: "system", subtype: "init", session_id: "s-limit" },
  { type: "assistant", parent_tool_use_id: null, message: { content: [{ type: "text", text: "Working on it." }] } },
  { type: "rate_limit_event", rate_limit_info: { status: "rejected", resetsAt: 1792474200, rateLimitType: "five_hour" } },
  {
    type: "assistant",
    parent_tool_use_id: null,
    error: "rate_limit",
    api_error: "usage_limit_reached",
    api_error_status: 429,
    api_error_params: { rate_limit_info: { status: "rejected", resetsAt: 1792474200, rateLimitType: "five_hour" } },
    message: { model: "<synthetic>", content: [{ type: "text", text: "You've hit your session limit · resets 7:30am (Europe/Paris)" }] },
  },
  { type: "result", subtype: "success", is_error: true, api_error_status: 429, result: "You've hit your session limit · resets 7:30am (Europe/Paris)" },
];

describe("a run that ends on a usage limit", () => {
  it("is told apart from a run that finished", () => {
    const ok = fold(OK_STREAM);
    expect(ok.claudeSessionId).toBe("0d6b64a2-9d15-444e-be4e-a8f449b51b7f");
    expect(endedOnLimit(ok)).toBeUndefined();
    expect(endedOnLimit(fold(LIMIT_STREAM))).toEqual({ error: "rate_limit", resetsAt: 1792474200_000 });
  });
  it("the assistant's limit error alone counts (no result line: the process died after it), with its own reset", () => {
    const own = { ...LIMIT_STREAM[3], api_error_params: { rate_limit_info: { status: "rejected", resetsAt: 1792480000 } } };
    expect(endedOnLimit(fold([LIMIT_STREAM[0], own]))).toEqual({ error: "rate_limit", resetsAt: 1792480000_000 });
    expect(endedOnLimit(fold([LIMIT_STREAM[0], { ...own, error: "billing_error" }]))?.error).toBe("billing_error");
  });
  it("a 429 result alone counts, with the reset from the rejected rate_limit_event", () => {
    const end = fold([LIMIT_STREAM[0], LIMIT_STREAM[2], { type: "result", is_error: true, api_error_status: 429, result: "x" }]);
    expect(endedOnLimit(end)).toEqual({ error: "rate_limit", resetsAt: 1792474200_000 });
  });
  it("a limit a later healthy turn got past is not how the run ended", () => {
    expect(endedOnLimit(fold([LIMIT_STREAM[3], OK_STREAM[1]]))).toBeUndefined();
  });
  it("a subagent's limit does not decide the run", () => {
    expect(endedOnLimit(fold([{ ...LIMIT_STREAM[3], parent_tool_use_id: "toolu_1" }]))).toBeUndefined();
  });
  it("a printed WORKER-RESULT verdict means the protocol finished", () => {
    const end = fold([...LIMIT_STREAM.slice(0, 4), { type: "result", is_error: true, api_error_status: 429, result: "WORKER-RESULT: done — x" }]);
    expect(endedOnLimit(end)).toBeUndefined();
  });
  it("the account is out until the reset, or a quarter hour (an hour for billing) when none was given", () => {
    const now = 1_000_000;
    expect(limitUntil({ error: "rate_limit", resetsAt: now + 5 }, now)).toBe(now + 5);
    expect(limitUntil({ error: "rate_limit" }, now)).toBe(now + 15 * 60_000);
    expect(limitUntil({ error: "billing_error" }, now)).toBe(now + 60 * 60_000);
  });
});

describe("design runs: the structured signal", () => {
  const session = (outcomes: unknown) => JSON.stringify({ session: { id: "s" }, outcomes });
  it("an outcome of kind 'design' makes it a design run", () => {
    expect(DESIGN_OUTCOME_KIND).toBe("design");
    expect(isDesignSession(session({ status: "ok", outcomes: [{ key: "pr", kind: "code" }, { key: "design", kind: "design" }] }))).toBe(true);
    expect(isDesignSession(session({ status: "ok", outcomes: [{ key: "design-notes", kind: "document" }] }))).toBe(false);
  });
  it("the goal text is never read for it", () => {
    const s = JSON.stringify({ session: { goal: "design the landing page" }, outcomes: { status: "ok", outcomes: [] } });
    expect(isDesignSession(s)).toBe(false);
  });
  it("outcomes that could not be read THROW — never 'not a design run'", () => {
    expect(() => isDesignSession(session({ status: "unavailable", reason: "read_failed" }))).toThrow(/unavailable/);
    expect(() => isDesignSession(JSON.stringify({ session: {} }))).toThrow(/missing/);
    expect(() => isDesignSession(JSON.stringify({ error: "Focus session x not found" }))).toThrow(/not found/);
  });
});

describe("background (design) runs: how they are watched", () => {
  it("reads the short id `claude --bg` prints (verbatim 2.1.309 output)", () => {
    const out = "Starting background service…\nbackgrounded · fd009109\n  claude agents             list sessions\n  claude attach fd009109    open in this terminal\n";
    expect(parseBgId(out)).toBe("fd009109");
    expect(parseBgId("Error: not logged in")).toBeUndefined();
  });
  it("maps `claude agents --json --all` states (verbatim 2.1.309 entry first)", () => {
    const list = parseAgentsList(
      JSON.stringify([
        { pid: 20822, id: "fd009109", cwd: "/w", kind: "background", startedAt: 1792723262938, sessionId: "fd009109-0488-47e7-a314-064ba85d1c5e", name: "bg test", status: "idle", state: "done" },
        { id: "aa", state: "blocked" },
        { id: "bb", state: "working", status: "busy" },
        { id: "cc", state: "failed" },
      ])
    );
    expect(list.map((e) => bgPhase(e))).toEqual(["finished", "blocked", "running", "finished"]);
    expect(bgPhase(undefined)).toBe("gone");
    expect(() => parseAgentsList("{}")).toThrow();
  });
  it("the transcript gives the final text and a limit, counting only entries since the launch", () => {
    const t0 = Date.parse("2026-10-23T02:41:00Z");
    const lines = [
      { type: "assistant", timestamp: "2026-10-23T02:40:00Z", message: { content: [{ type: "text", text: "WORKER-RESULT: done — old turn" }] } },
      { type: "user", timestamp: "2026-10-23T02:41:01Z", message: { content: "go" } },
      { type: "assistant", timestamp: "2026-10-23T02:41:05Z", message: { content: [{ type: "thinking" }] } },
      { type: "assistant", timestamp: "2026-10-23T02:41:06Z", message: { content: [{ type: "text", text: "WORKER-RESULT: done — new turn" }] } },
    ].map((l) => JSON.stringify(l));
    const end = readTranscriptEnd(lines.join("\n"), t0);
    expect(end.seen).toBe(2);
    expect(end.text).toBe("WORKER-RESULT: done — new turn");
    expect(readTranscriptEnd(lines.slice(0, 1).join("\n"), t0).seen).toBe(0);
    // The real transcript spelling of a usage limit.
    const limit = JSON.stringify({
      type: "assistant",
      timestamp: "2026-10-23T02:42:00Z",
      isSidechain: false,
      isApiErrorMessage: true,
      error: "rate_limit",
      apiError: "usage_limit_reached",
      apiErrorStatus: 429,
      apiErrorParams: { rate_limit_info: { status: "rejected", resetsAt: 1792474200, rateLimitType: "five_hour" } },
      message: { content: [{ type: "text", text: "You've hit your session limit · resets 7:30am (Europe/Paris)" }] },
    });
    expect(endedOnLimit(readTranscriptEnd([lines[1], limit].join("\n"), t0))).toEqual({ error: "rate_limit", resetsAt: 1792474200_000 });
    expect(BG_SETTLE_MS).toBeGreaterThan(0);
  });
});

describe("the night protocol in the prompt", () => {
  const p = (design = false) =>
    buildWorkerPrompt({ sessionId: "c5a34b78-0000", goal: "g", agentName: "cc-devbox", cwd: "/w", mcpServer: "synap-pod", design });
  it("every run: worktree branch, a DRAFT PR at most, never merge / push main", () => {
    expect(p()).toContain("git worktree on a branch named devbox/c5a34b78-<slug>");
    expect(p()).toContain("open a DRAFT pull request (gh pr create --draft); never merge one");
    expect(p()).toContain("never push to main");
  });
  it("every run records every deliverable with its ref, and says what to look at first", () => {
    expect(p()).toContain("Record EVERY deliverable as a session output");
    expect(p()).toContain("outcomes:[{key, label, kind, ref:{url}}]");
    expect(p()).toContain("the draft PR (ref = its URL), the branch, the gate summary path");
    expect(p()).toContain('starting "Look at first:"');
  });
  it("a design run is told to quickstart the Artifact tool, publish, and store the URL on the session and the subject", () => {
    const d = p(true);
    expect(d).toContain('Artifact tool with action "quickstart" and intent "design" FIRST');
    expect(d).toContain("the outcome of kind \"design\", ref = the artifact's claude.ai URL");
    expect(d).toContain("subject entity");
    expect(p()).not.toContain("quickstart");
  });
});

describe("workerEnv with an account", () => {
  it("the chosen token REPLACES an inherited one", () => {
    const env = workerEnv({ CLAUDE_CODE_OAUTH_TOKEN: "inherited", CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR: "4" }, undefined, "chosen");
    expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBe("chosen");
    expect(env.CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR).toBeUndefined();
    expect(workerEnv({ CLAUDE_CODE_OAUTH_TOKEN: "inherited" }).CLAUDE_CODE_OAUTH_TOKEN).toBe("inherited");
  });
});
