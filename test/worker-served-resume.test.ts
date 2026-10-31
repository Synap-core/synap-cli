/**
 * What the worker tells the pod, and what it does with a session handed back
 * to resume, driven end to end through `createWorker`: a fake `claude` binary
 * (a real child process speaking stream-json) and a stubbed pod MCP that
 * records every call with its headers.
 *
 *   - its orient poll, and ONLY that call, carries the served stamp
 *     (`X-Synap-Runner: synap-worker/<version>`, wave contract 3);
 *   - each run's MCP config names its process and says `busy`; when the
 *     process exits, the worker's calls say `ended` for that process;
 *   - a run's verdict lands on its session (one room line, the one open
 *     deliverable claimed on `done`), never through run capture, never a close;
 *   - a `resume` item never launches fresh: with a conversation it is resumed
 *     once per quiet period, with none nothing launches (contract 2).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createWorker } from "../src/commands/worker.js";
import type { McpCallClient } from "../src/lib/mcp-call.js";

const VERSION = (JSON.parse(fs.readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string }).version;

const A = "aaaaaaaa-1111-4111-8111-111111111111";
const B = "bbbbbbbb-2222-4222-8222-222222222222";
const C = "cccccccc-3333-4333-8333-333333333333";
const CLAUDE_SID = "c3c3c3c3-0000-4000-8000-000000000003";
/** The pod's own pattern for `X-Synap-Process` (request-write-context.ts, 0373). */
const POD_PROCESS_RE = /^([A-Za-z0-9._-]{1,255}):(\d{1,10}):(\d{10,14})$/;

let tmp: string;
let fakeLog: string;
let fakeClaude: string;

/** A `claude -p` stand-in: logs its argv and mcp config, prints the verdict from $SYNAP_FAKE_VERDICT. */
const FAKE = `#!/usr/bin/env node
const fs = require("fs");
const argv = process.argv.slice(2);
const cfg = argv[argv.indexOf("--mcp-config") + 1];
fs.appendFileSync(process.env.SYNAP_FAKE_CLAUDE_LOG, JSON.stringify({ argv, mcp: JSON.parse(fs.readFileSync(cfg, "utf8")) }) + "\\n");
const out = (o) => process.stdout.write(JSON.stringify(o) + "\\n");
const r = argv.indexOf("--resume");
out({ type: "system", subtype: "init", session_id: r >= 0 ? argv[r + 1] : "${CLAUDE_SID}" });
out({ type: "result", subtype: "success", is_error: false, result: "Did it.\\nWORKER-RESULT: " + process.env.SYNAP_FAKE_VERDICT });
`;

type Run = { argv: string[]; mcp: { mcpServers: Record<string, { headers: Record<string, string> }> } };
const fakeRuns = (): Run[] =>
  fs.existsSync(fakeLog) ? fs.readFileSync(fakeLog, "utf8").trim().split("\n").map((l) => JSON.parse(l) as Run) : [];

interface Call {
  tool: string;
  args: Record<string, unknown>;
  headers: Record<string, string>;
}

/** A pod whose orient lists `handed` (mutable between ticks) and records every call. */
function stubPod(handed: { items: Array<Record<string, unknown>> }, outcomes: Array<Record<string, unknown>> = []) {
  const calls: Call[] = [];
  const mcp: McpCallClient = {
    async call(tool, args = {}, extras = {}) {
      calls.push({ tool, args, headers: extras.headers ?? {} });
      if (tool === "synap_orient") {
        return { isError: false, text: JSON.stringify({ startHere: { handedToYou: { count: handed.items.length, items: handed.items } } }) };
      }
      if (tool === "synap_get_session") {
        const id = args.sessionId as string;
        return {
          isError: false,
          text: JSON.stringify({ session: { id, goal: "g", playbookId: null, channelId: `room-${id.slice(0, 8)}` }, outcomes: { status: "ok", outcomes } }),
        };
      }
      if (tool === "synap_get_thread_context") return { isError: false, text: JSON.stringify({ messages: [] }) };
      if (tool === "synap_post_message" || tool === "synap_update_session") return { isError: false, text: "{}" };
      throw new Error(`unexpected tool ${tool}`);
    },
  };
  return { mcp, calls };
}

const mk = (agent: string, mcp: McpCallClient, lines: string[] = []) =>
  createWorker(
    { agent, claudeBin: fakeClaude, cwd: tmp, workRoot: path.join(tmp, "work"), maxParallel: "3" },
    { mcp, podUrl: "https://pod.example", apiKey: "k", selfAgentId: "self", say: (l) => lines.push(l) }
  );

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "worker-served-"));
  fakeLog = path.join(tmp, "fake-claude.log");
  fakeClaude = path.join(tmp, "fake-claude.cjs");
  fs.writeFileSync(fakeClaude, FAKE, { mode: 0o755 });
  fs.rmSync(path.join(os.homedir(), ".synap"), { recursive: true, force: true });
  vi.stubEnv("SYNAP_FAKE_CLAUDE_LOG", fakeLog);
  vi.stubEnv("SYNAP_FAKE_VERDICT", "blocked — waiting on the person");
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("the served stamp rides on the orient poll only", () => {
  it("orient carries X-Synap-Runner: synap-worker/<version>; no other call does", async () => {
    const pod = stubPod({ items: [{ id: A, goal: "g" }] });
    const w = mk("served1", pod.mcp);
    await w.tick();
    await w.waitForChildren();

    const orient = pod.calls.filter((c) => c.tool === "synap_orient");
    expect(orient).toHaveLength(1);
    expect(orient[0].headers["X-Synap-Runner"]).toBe(`synap-worker/${VERSION}`);
    const others = pod.calls.filter((c) => c.tool !== "synap_orient");
    expect(others.length).toBeGreaterThan(0);
    for (const c of others) expect(c.headers["X-Synap-Runner"]).toBeUndefined();
    // …and a run never gets it either: its own config is not the worker's poll.
    expect(fakeRuns()[0].mcp.mcpServers["synap-worker"].headers["X-Synap-Runner"]).toBeUndefined();
  });
});

describe("a run names its process to the pod, and its end", () => {
  it("the run's config says busy for its process; the worker's calls after it exit say ended for that process", async () => {
    const pod = stubPod({ items: [{ id: A, goal: "g" }] });
    const w = mk("served2", pod.mcp);
    await w.tick();
    await w.waitForChildren();

    const headers = fakeRuns()[0].mcp.mcpServers["synap-worker"].headers;
    expect(headers["X-Synap-Runner-State"]).toBe("busy");
    expect(headers["X-Synap-Process"]).toMatch(POD_PROCESS_RE);
    expect(headers["X-Synap-Process"]).toBe(w.state.runs[A].process);

    const after = pod.calls.filter((c) => c.headers["X-Synap-Runner-State"]);
    expect(after.length).toBeGreaterThan(0);
    for (const c of after) {
      expect(c.headers).toMatchObject({
        "X-Synap-Runner-State": "ended",
        "X-Synap-Process": headers["X-Synap-Process"],
        "X-Synap-Conversation": `claude-code:${CLAUDE_SID}`,
      });
    }
  });
});

describe("the verdict goes on the session itself", () => {
  it("blocked: one room line, nothing claimed, never run capture, never a close; the local record keeps it", async () => {
    const pod = stubPod({ items: [{ id: A, goal: "g" }] }, [{ key: "draft", kind: "document", owner: "agent", met: false }]);
    const w = mk("verdict1", pod.mcp);
    await w.tick();
    await w.waitForChildren();

    const posts = pod.calls.filter((c) => c.tool === "synap_post_message");
    expect(posts).toHaveLength(1);
    expect(posts[0].args).toEqual({ channelId: `room-${A.slice(0, 8)}`, kind: "update", content: "Result: blocked — waiting on the person" });
    expect(pod.calls.some((c) => c.tool === "synap_update_session")).toBe(false);
    expect(pod.calls.some((c) => /capture|complete_session/.test(c.tool))).toBe(false);
    expect(w.state.runs[A].result).toBe("blocked — waiting on the person");
  });

  it("done: the ONE open deliverable the agent owns is claimed, then the room line", async () => {
    vi.stubEnv("SYNAP_FAKE_VERDICT", "done — the cut is filed");
    const pod = stubPod({ items: [{ id: A, goal: "g" }] }, [
      { key: "video", kind: "file", owner: "agent", met: false },
      { key: "pr-x", kind: "pull_request", owner: "agent", met: true },
      { key: "ask-music", kind: "decision", owner: "human", met: false },
      { key: "looks-right", kind: "fact", owner: "agent", met: false },
      { key: "old", kind: "file", owner: "agent", met: false, retired: true },
    ]);
    const w = mk("verdict2", pod.mcp);
    await w.tick();
    await w.waitForChildren();

    const writes = pod.calls.filter((c) => c.tool === "synap_update_session" || c.tool === "synap_post_message");
    expect(writes.map((c) => [c.tool, c.args])).toEqual([
      ["synap_update_session", { sessionId: A, completeOutput: "video" }],
      ["synap_post_message", { channelId: `room-${A.slice(0, 8)}`, kind: "update", content: "Result: done — the cut is filed" }],
    ]);
  });

  it("done with two open deliverables: neither is guessed", async () => {
    vi.stubEnv("SYNAP_FAKE_VERDICT", "done — both made");
    const pod = stubPod({ items: [{ id: A, goal: "g" }] }, [
      { key: "a", kind: "file", owner: "agent", met: false },
      { key: "b", kind: "file", owner: "agent", met: false },
    ]);
    const w = mk("verdict3", pod.mcp);
    await w.tick();
    await w.waitForChildren();
    expect(pod.calls.some((c) => c.tool === "synap_update_session")).toBe(false);
    expect(pod.calls.filter((c) => c.tool === "synap_post_message")).toHaveLength(1);
  });
});

describe("a session handed back to resume never launches fresh", () => {
  it("an empty state file: nothing launches, one line per session, said once", async () => {
    const lines: string[] = [];
    const pod = stubPod({
      items: [A, B, C].map((id) => ({ id, goal: "g", resume: true, quietSince: "2026-10-29T10:00:00.000Z" })),
    });
    const w = mk("resume1", pod.mcp, lines);
    expect((await w.tick()).launched).toBe(0);
    expect((await w.tick()).launched).toBe(0);
    await w.waitForChildren();

    expect(fakeRuns()).toHaveLength(0);
    expect(Object.keys(w.state.runs)).toHaveLength(0);
    const said = lines.filter((l) => l.includes("no conversation of it"));
    expect(said).toHaveLength(3);
    for (const id of [A, B, C]) expect(said.some((l) => l.includes(id))).toBe(true);
  });

  it("with its conversation on this computer: resumed ONCE per quiet period, never a new conversation", async () => {
    const handed = { items: [{ id: A, goal: "g" }] as Array<Record<string, unknown>> };
    const pod = stubPod(handed);
    const w = mk("resume2", pod.mcp);
    await w.tick(); // the first launch
    await w.waitForChildren();
    expect(w.state.runs[A].claudeSessionId).toBe(CLAUDE_SID);

    // It went quiet; the pod hands it back to resume.
    handed.items = [{ id: A, goal: "g", resume: true, quietSince: "2026-10-29T10:00:00.000Z" }];
    expect((await w.tick()).launched).toBe(1);
    await w.waitForChildren();
    expect((await w.tick()).launched).toBe(0); // the same quiet period: once
    await w.waitForChildren();

    // Quiet again later: one more resume.
    handed.items = [{ id: A, goal: "g", resume: true, quietSince: "2026-10-30T10:00:00.000Z" }];
    expect((await w.tick()).launched).toBe(1);
    await w.waitForChildren();

    const runs = fakeRuns();
    expect(runs).toHaveLength(3);
    for (const r of runs.slice(1)) {
      expect(r.argv.slice(r.argv.indexOf("--resume"), r.argv.indexOf("--resume") + 2)).toEqual(["--resume", CLAUDE_SID]);
      expect(r.argv).not.toContain("--session-id");
      expect(r.argv[1]).toContain("went quiet");
    }
    expect(runs[1].argv[1]).toContain("2026-10-29T10:00:00.000Z");
    expect(w.state.runs[A].resumes).toBe(2);
  });

  it("a run that never started (no conversation) is not retried fresh once it is a resume item", async () => {
    const lines: string[] = [];
    const pod = stubPod({ items: [{ id: A, goal: "g", resume: true }] });
    const w = mk("resume3", pod.mcp, lines);
    // A launch that failed before Claude started, long enough ago to be due a retry.
    w.state.runs[A] = { sessionId: A, status: "failed", startedAt: "2026-10-01T00:00:00.000Z", finishedAt: "2026-10-01T00:00:00.000Z" };
    expect((await w.tick()).launched).toBe(0);
    expect(fakeRuns()).toHaveLength(0);
    expect(lines.some((l) => l.includes(A) && l.includes("not launched"))).toBe(true);
  });
});
