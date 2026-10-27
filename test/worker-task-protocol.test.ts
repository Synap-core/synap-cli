/**
 * `synap worker`: a handed session that FOLLOWS a non-code playbook (CRM
 * "Score a list", "Draft a first message") gets the TASK protocol — pod tools
 * and the web only, and it closes the session itself. Code and design sessions
 * keep their protocol.
 *
 * The classifier is driven from `synap_get_session` payloads reduced from the
 * live pod (2026-10-27, field names verbatim): a CRM run ("Qualify a lead ·
 * Boza", 2c8bd751), a free-form code hand-off (c8d18983), a night-shift build
 * run (f9456e2b's playbook declares `pull-request`). The launch path is driven
 * end to end through `createWorker` with a fake `claude` binary, so what is
 * asserted is the argv the worker actually spawned.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  buildTaskPrompt,
  buildWorkerPrompt,
  classifySession,
  createWorker,
  printRunPermissionArgs,
  TASK_DISALLOWED_TOOLS,
} from "../src/commands/worker.js";
import type { McpCallClient } from "../src/lib/mcp-call.js";

const CRM_PLAYBOOK = "d2ae3728-bb88-430d-90d2-ce6d4f5ac402";

/** A get_session payload: the `session` block and `outcomes` as the pod spells them. */
function getSession(session: Record<string, unknown>, outcomes: Array<Record<string, unknown>>): string {
  return JSON.stringify({ session: { id: "s", channelId: "c", ...session }, outcomes: { status: "ok", counts: {}, outcomes } });
}

// "Qualify a lead · Boza": a playbook run whose outcomes are criteria (facts) and a human decision.
const CRM_RUN = getSession({ origin: "playbook", templateId: null, playbookId: CRM_PLAYBOOK }, [
  { key: "lead-score-set", kind: "fact", source: "criterion", owner: "agent" },
  { key: "lead-decision-chosen", kind: "fact", source: "criterion", owner: "human" },
]);
// "Content Studio S1": an orchestrator's free-form hand-off with a code outcome.
const FREE_CODE = getSession({ origin: "agent", templateId: null, playbookId: null }, [{ key: "pr", kind: "code", owner: "agent" }]);
// A free-form hand-off with no outcomes at all: today's protocol, unchanged.
const FREE_BARE = getSession({ origin: "agent", templateId: null, playbookId: null }, []);
// "Night shift: build a task": a playbook run that declares a pull request.
const NIGHT_BUILD = getSession({ origin: "playbook", templateId: null, playbookId: "cc0c1b52-6f22-4e81-8db1-007af28a38a6" }, [
  { key: "draft-pr", kind: "pull-request", owner: "agent" },
  { key: "plan-or-report", kind: "document", owner: "agent" },
]);
// "Night shift: design a task".
const NIGHT_DESIGN = getSession({ origin: "playbook", templateId: null, playbookId: "62823a0b-697b-476b-b3be-58d6a2f2783d" }, [
  { key: "design", kind: "design", owner: "agent" },
]);

describe("classifySession: which protocol a handed session gets", () => {
  it("a session that follows a non-code playbook is a TASK", () => {
    expect(classifySession(CRM_RUN)).toBe("task");
    // A legacy templateId alone counts as following a playbook.
    expect(classifySession(getSession({ templateId: CRM_PLAYBOOK, playbookId: null }, []))).toBe("task");
    // A playbook whose deliverable is a document (the morning brief) is pod work too.
    expect(classifySession(getSession({ playbookId: "d66ddefa" }, [{ key: "brief", kind: "document" }]))).toBe("task");
  });
  it("a playbook that yields a pull request, and every free-form hand-off, stay CODE", () => {
    expect(classifySession(NIGHT_BUILD)).toBe("code");
    expect(classifySession(FREE_CODE)).toBe("code");
    expect(classifySession(FREE_BARE)).toBe("code");
    for (const kind of ["code", "pull-request", "pull_request", "branch", "commit"]) {
      expect(classifySession(getSession({ playbookId: CRM_PLAYBOOK }, [{ key: "k", kind }])), kind).toBe("code");
    }
  });
  it("a design outcome wins, playbook or not", () => {
    expect(classifySession(NIGHT_DESIGN)).toBe("design");
    expect(classifySession(getSession({ playbookId: null }, [{ kind: "code" }, { kind: "design" }]))).toBe("design");
  });
  it("the goal text is never read for it", () => {
    expect(classifySession(getSession({ playbookId: CRM_PLAYBOOK, goal: "open a pull request on synap-cli" }, []))).toBe("task");
    expect(classifySession(getSession({ playbookId: null, goal: "score the list" }, []))).toBe("code");
  });
  it("a read that cannot say what the session is THROWS — never a guessed protocol", () => {
    expect(() => classifySession(JSON.stringify({ session: { id: "s" }, outcomes: { status: "ok", outcomes: [] } }))).toThrow(/playbookId/);
    expect(() => classifySession(JSON.stringify({ outcomes: { status: "ok", outcomes: [] } }))).toThrow(/playbookId/);
    expect(() => classifySession(JSON.stringify({ session: { playbookId: CRM_PLAYBOOK }, outcomes: { status: "unavailable" } }))).toThrow(/unavailable/);
    expect(() => classifySession(JSON.stringify({ error: "Focus session x not found" }))).toThrow(/not found/);
    expect(() => classifySession("<html>")).toThrow(/JSON/);
  });
});

describe("the TASK protocol", () => {
  const p = buildTaskPrompt({ sessionId: "ba6f39c8-0000", goal: "Score a list", agentName: "claude-code", mcpServer: "synap-worker" });
  it("reads the session, writes only through pod tools, never files or PRs", () => {
    expect(p).toContain("Session: ba6f39c8-0000");
    expect(p).toContain("synap_get_session {sessionId}");
    expect(p).toContain("Write ONLY through the pod tools");
    expect(p).toContain("Never edit files, never run code, never open a pull request");
    expect(p).not.toMatch(/git worktree|gh pr create|draft PR/i);
  });
  it("reads the subject's role fields and keeps the pod's own signal (Month'Immo e2e, 27 Oct)", () => {
    expect(p).toContain("read them there and use what they say");
    expect(p).toContain("lead facet");
  });
  it("creates the records a process asks for with exact fields, never through free-text capture", () => {
    expect(p).toContain("Never synap_capture a record the process asks you to create or change");
    expect(p).toContain("synap_create_entity (its profileSlug and the exact property keys the goal names");
    expect(p).toContain("never put a company's website, domain or email on a person");
  });
  it("asks with QUESTION: and waits through the pod, not a shell sleep", () => {
    expect(p).toContain('"QUESTION:"');
    expect(p).toContain("synap_wait_for_answer");
    expect(p).not.toContain("sleep 60");
  });
  it("marks each outcome, then closes the session itself only when nothing waits on the person", () => {
    expect(p).toContain("completeOutput: <key>");
    expect(p).toContain('synap_complete_session {sessionId, terminalStatus: "closed", summary:');
    expect(p).toContain('no owner "human" outcome pending');
    expect(p).toContain("Otherwise leave the session open and say in the room which outcome or answer it waits on");
    expect(p).toMatch(/WORKER-RESULT: done \| blocked \| failed/);
  });
  it("the CODE protocol is unchanged: it still leaves the session to its owner", () => {
    const code = buildWorkerPrompt({ sessionId: "c5a34b78-0000", goal: "g", agentName: "a", cwd: "/w", mcpServer: "synap-worker" });
    expect(code).toContain("Do not close the session; the owner does.");
    expect(code).not.toContain("synap_complete_session");
  });
});

describe("printRunPermissionArgs", () => {
  const codeAllowed = ["Read", "Edit", "Bash", "mcp__synap-worker"];
  it("a task run: dontAsk, the pod MCP + the web allowed, shell and file tools denied — even with skip-permissions", () => {
    for (const skipPermissions of [false, true]) {
      const a = printRunPermissionArgs("task", { codeAllowed, mcpServer: "synap-worker", skipPermissions });
      expect(a).not.toContain("--dangerously-skip-permissions");
      expect(a[a.indexOf("--permission-mode") + 1]).toBe("dontAsk");
      expect(a[a.indexOf("--allowedTools") + 1].split(",").sort()).toEqual(["WebFetch", "WebSearch", "mcp__synap-worker"]);
      expect(a[a.indexOf("--disallowedTools") + 1].split(",")).toEqual(expect.arrayContaining(["Bash", "Edit", "Write"]));
    }
  });
  it("a code run keeps today's flags", () => {
    expect(printRunPermissionArgs("code", { codeAllowed, mcpServer: "synap-worker" })).toEqual([
      "--permission-mode",
      "acceptEdits",
      "--allowedTools",
      ...codeAllowed,
    ]);
    expect(printRunPermissionArgs("code", { codeAllowed, mcpServer: "synap-worker", skipPermissions: true })).toEqual(["--dangerously-skip-permissions"]);
  });
});

// ─── end to end: what the worker spawns ──────────────────────────────────────

const CRM = "33333333-3333-4333-8333-333333333333";
const CODE = "44444444-4444-4444-8444-444444444444";
const CLAUDE_SID = "c1a1c1a1-0000-4000-8000-000000000009";

/** A `claude -p` stand-in: logs its argv, finishes with a verdict. */
const FAKE = `#!/usr/bin/env node
const fs = require("fs");
const argv = process.argv.slice(2);
fs.appendFileSync(process.env.FAKE_CLAUDE_LOG, JSON.stringify({ argv }) + "\\n");
const out = (o) => process.stdout.write(JSON.stringify(o) + "\\n");
out({ type: "system", subtype: "init", session_id: "${CLAUDE_SID}" });
out({ type: "result", subtype: "success", is_error: false, result: "WORKER-RESULT: done — closed the session" });
`;

let tmp: string;
let fakeLog: string;
let fakeClaude: string;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "worker-task-"));
  fakeLog = path.join(tmp, "fake-claude.log");
  fakeClaude = path.join(tmp, "fake-claude.cjs");
  fs.writeFileSync(fakeClaude, FAKE, { mode: 0o755 });
  fs.rmSync(path.join(os.homedir(), ".synap"), { recursive: true, force: true });
  vi.stubEnv("FAKE_CLAUDE_LOG", fakeLog);
});
afterEach(() => vi.unstubAllEnvs());

function stubPod(sessions: Record<string, string>, room: Array<Record<string, unknown>> = []): McpCallClient {
  return {
    async call(tool, args = {}) {
      if (tool === "synap_orient") {
        const items = Object.keys(sessions).map((id) => ({ id, goal: `goal of ${id.slice(0, 4)}` }));
        return { isError: false, text: JSON.stringify({ startHere: { handedToYou: { count: items.length, items } } }) };
      }
      if (tool === "synap_get_session") return { isError: false, text: sessions[args.sessionId as string] };
      if (tool === "synap_get_thread_context") return { isError: false, text: JSON.stringify({ messages: room }) };
      throw new Error(`unexpected tool ${tool}`);
    },
  };
}

const spawned = () =>
  fs.readFileSync(fakeLog, "utf8").trim().split("\n").map((l) => (JSON.parse(l) as { argv: string[] }).argv);
const flag = (argv: string[], f: string) => argv[argv.indexOf(f) + 1];

describe("the worker launches each protocol with its own prompt and tools", () => {
  it("a CRM run gets the task prompt and the task tools; a code hand-off keeps today's", async () => {
    const w = createWorker(
      { agent: "task1", claudeBin: fakeClaude, cwd: tmp, maxParallel: "2" },
      { mcp: stubPod({ [CRM]: CRM_RUN, [CODE]: FREE_CODE }), podUrl: "https://pod.example", apiKey: "k", selfAgentId: "self", say: () => {} }
    );
    await w.tick();
    await w.waitForChildren();
    const runs = spawned();
    const crm = runs.find((a) => flag(a, "-p").includes(`Session: ${CRM}`));
    const code = runs.find((a) => flag(a, "-p").includes(`Session: ${CODE}`));
    if (!crm || !code) throw new Error(`expected both runs, got ${runs.length}`);

    expect(flag(crm, "-p")).toContain("synap_complete_session");
    expect(flag(crm, "--permission-mode")).toBe("dontAsk");
    expect(flag(crm, "--allowedTools").split(",").sort()).toEqual(["WebFetch", "WebSearch", "mcp__synap-worker"]);
    expect(flag(crm, "--disallowedTools").split(",")).toEqual(TASK_DISALLOWED_TOOLS);
    expect(w.state.runs[CRM]).toMatchObject({ status: "done", mode: "print", protocol: "task", result: "done — closed the session" });

    expect(flag(code, "-p")).toContain("Do not close the session; the owner does.");
    expect(flag(code, "--permission-mode")).toBe("acceptEdits");
    expect(code).toEqual(expect.arrayContaining(["Bash", "Edit", "Write", "mcp__synap-worker"]));
    expect(code).not.toContain("--disallowedTools");
    expect(w.state.runs[CODE]).toMatchObject({ status: "done", protocol: "code" });
  });

  it("a follow-up resume of a task run keeps the task tools", async () => {
    const w = createWorker(
      { agent: "task2", claudeBin: fakeClaude, cwd: tmp },
      { mcp: stubPod({ [CRM]: CRM_RUN }), podUrl: "https://pod.example", apiKey: "k", selfAgentId: "self", say: () => {} }
    );
    await w.tick();
    await w.waitForChildren();
    const after = new Date(Date.parse(w.state.runs[CRM].finishedAt as string) + 1000).toISOString();
    const w2 = createWorker(
      { agent: "task2", claudeBin: fakeClaude, cwd: tmp },
      {
        mcp: stubPod({ [CRM]: CRM_RUN }, [{ id: "m1", content: "ANSWER: score only the first 20", timestamp: after, authorType: "human" }]),
        podUrl: "https://pod.example",
        apiKey: "k",
        selfAgentId: "self",
        say: () => {},
      }
    );
    await w2.tick();
    await w2.waitForChildren();
    const resume = spawned().find((a) => a.includes("--resume"));
    if (!resume) throw new Error("no resume launched");
    expect(flag(resume, "--resume")).toBe(CLAUDE_SID);
    expect(flag(resume, "--permission-mode")).toBe("dontAsk");
    expect(resume).toContain("--disallowedTools");
    expect(w2.state.runs[CRM]).toMatchObject({ resumes: 1, protocol: "task" });
  });

  it("a session whose protocol cannot be read is not launched", async () => {
    const said: string[] = [];
    const w = createWorker(
      { agent: "task3", claudeBin: fakeClaude, cwd: tmp },
      {
        mcp: stubPod({ [CRM]: JSON.stringify({ session: { id: CRM }, outcomes: { status: "ok", outcomes: [] } }) }),
        podUrl: "https://pod.example",
        apiKey: "k",
        selfAgentId: "self",
        say: (l) => said.push(l),
      }
    );
    expect(await w.tick()).toEqual({ handed: 1, launched: 0 });
    expect(w.state.runs[CRM]).toBeUndefined();
    expect(said.some((l) => l.includes("could not read which protocol it needs"))).toBe(true);
  });
});
