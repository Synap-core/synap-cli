/**
 * `synap worker` protocols, driven end to end through `createWorker`: a fake
 * `claude` binary (a real child process speaking stream-json) records the
 * directory it ran in, its prompt and its tools; a stubbed pod MCP serves the
 * sessions. What is asserted is what the worker DID with each kind of session.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createWorker, WORK_FOLDER_EXTRA_TOOLS } from "../src/commands/worker.js";
import type { McpCallClient } from "../src/lib/mcp-call.js";

const CODE = "33333333-3333-4333-8333-333333333333";
const RUN = "44444444-4444-4444-8444-444444444444";
const CLAUDE_SID = "c2c2c2c2-0000-4000-8000-000000000002";

let tmp: string;
let fakeLog: string;
let fakeClaude: string;

/** A `claude -p` stand-in that finishes at once and logs where it ran. */
const FAKE = `#!/usr/bin/env node
const fs = require("fs");
const argv = process.argv.slice(2);
fs.appendFileSync(process.env.FAKE_CLAUDE_LOG, JSON.stringify({ argv, cwd: process.cwd() }) + "\\n");
const out = (o) => process.stdout.write(JSON.stringify(o) + "\\n");
const r = argv.indexOf("--resume");
out({ type: "system", subtype: "init", session_id: r >= 0 ? argv[r + 1] : "${CLAUDE_SID}" });
out({ type: "result", subtype: "success", is_error: false, result: "WORKER-RESULT: blocked — waiting on the person" });
`;

const fakeRuns = () =>
  fs.existsSync(fakeLog)
    ? fs.readFileSync(fakeLog, "utf8").trim().split("\n").map((l) => JSON.parse(l) as { argv: string[]; cwd: string })
    : [];

const outcomes = { status: "ok", outcomes: [] };
/** An ad-hoc hand-off, and a Produce Content run (content-os.yaml shape). */
const SESSIONS: Record<string, Record<string, unknown>> = {
  [CODE]: { id: CODE, goal: "fix the bug", playbookId: null, channelId: "room-code" },
  [RUN]: {
    id: RUN,
    goal: "Produce Content for Launch reel",
    playbookId: "pb-produce-content",
    subjectEntityId: "post-1",
    channelId: "room-run",
    metadata: { prompt: "Produce content…", params: { post: "post-1", platform: "instagram", format: "video" } },
    stages: [{ key: "draft", expectedOutputs: [{ kind: "content-composition", label: "Composition" }] }],
  },
};

function stubPod(handed: string[], room: Record<string, unknown[]> = {}): McpCallClient {
  return {
    async call(tool, args = {}) {
      if (tool === "synap_orient") {
        const items = handed.map((id) => ({ id, goal: SESSIONS[id].goal }));
        return { isError: false, text: JSON.stringify({ startHere: { handedToYou: { count: items.length, items } } }) };
      }
      if (tool === "synap_get_session") {
        return { isError: false, text: JSON.stringify({ session: SESSIONS[args.sessionId as string], outcomes }) };
      }
      if (tool === "synap_get_thread_context") {
        return { isError: false, text: JSON.stringify({ messages: room[args.threadId as string] ?? [] }) };
      }
      throw new Error(`unexpected tool ${tool}`);
    },
  };
}

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "worker-protocol-"));
  fakeLog = path.join(tmp, "fake-claude.log");
  fakeClaude = path.join(tmp, "fake-claude.cjs");
  fs.writeFileSync(fakeClaude, FAKE, { mode: 0o755 });
  fs.rmSync(path.join(os.homedir(), ".synap"), { recursive: true, force: true });
  vi.stubEnv("FAKE_CLAUDE_LOG", fakeLog);
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("the worker picks the protocol per session", () => {
  it("a playbook run works in its own folder under the work root, with the work-folder prompt and skills", async () => {
    const code = path.join(tmp, "code");
    const workRoot = path.join(tmp, "synap-work");
    fs.mkdirSync(code);
    const w = createWorker(
      { agent: "proto1", claudeBin: fakeClaude, cwd: code, workRoot, maxParallel: "2" },
      { mcp: stubPod([CODE, RUN]), podUrl: "https://pod.example", apiKey: "k", selfAgentId: "self", say: () => {} }
    );
    await w.tick();
    await w.waitForChildren();

    const runs = fakeRuns();
    expect(runs).toHaveLength(2);
    const byPrompt = (s: string) => runs.find((r) => r.argv[1].includes(`Session: ${s}`))!;

    // The ad-hoc hand-off: the code protocol, exactly as before.
    const c = byPrompt(CODE);
    expect(fs.realpathSync(c.cwd)).toBe(fs.realpathSync(code));
    expect(c.argv[1]).toContain(`git worktree on a branch named devbox/${CODE.slice(0, 8)}-<slug>`);
    expect(c.argv).not.toContain("Skill");
    expect(w.state.runs[CODE]).toMatchObject({ protocol: "code" });
    expect(w.state.runs[CODE].workDir).toBeUndefined();

    // The playbook run: its own folder, created owner-only; no git; slot asks.
    const folder = path.join(workRoot, RUN);
    const r = byPrompt(RUN);
    expect(fs.realpathSync(r.cwd)).toBe(fs.realpathSync(folder));
    expect(fs.statSync(folder).mode & 0o777).toBe(0o700);
    expect(r.argv[1]).toContain(`Work folder: ${folder}`);
    expect(r.argv[1]).toContain("synap_wait_for_answer");
    expect(r.argv[1]).not.toContain("worktree");
    expect(r.argv).toEqual(expect.arrayContaining(WORK_FOLDER_EXTRA_TOOLS));
    expect(w.state.runs[RUN]).toMatchObject({ protocol: "work-folder", workDir: folder, status: "done" });
  });

  it("an answer in the room resumes a work-folder run IN ITS FOLDER (Claude finds the conversation by its cwd)", async () => {
    const workRoot = path.join(tmp, "synap-work");
    const room: Record<string, unknown[]> = {};
    const w = createWorker(
      { agent: "proto2", claudeBin: fakeClaude, cwd: tmp, workRoot },
      { mcp: stubPod([RUN], room), podUrl: "https://pod.example", apiKey: "k", selfAgentId: "self", say: () => {} }
    );
    await w.tick();
    await w.waitForChildren();
    // The person answers the slot's ask: the pod posts the answer in the room.
    room["room-run"] = [
      { id: "m1", content: "Cut it to 30 seconds", timestamp: new Date(Date.now() + 60_000).toISOString(), authorType: "human" },
    ];
    await w.tick();
    await w.waitForChildren();

    const runs = fakeRuns();
    expect(runs).toHaveLength(2);
    expect(runs[1].argv.slice(runs[1].argv.indexOf("--resume"), runs[1].argv.indexOf("--resume") + 2)).toEqual(["--resume", CLAUDE_SID]);
    expect(runs[1].argv[1]).toContain("Cut it to 30 seconds");
    expect(fs.realpathSync(runs[1].cwd)).toBe(fs.realpathSync(path.join(workRoot, RUN)));
    expect(w.state.runs[RUN]).toMatchObject({ protocol: "work-folder", resumes: 1 });
  });

  it("a session that cannot be read is not launched — never run as code by default", async () => {
    const said: string[] = [];
    const mcp: McpCallClient = {
      async call(tool) {
        if (tool === "synap_orient") {
          return { isError: false, text: JSON.stringify({ startHere: { handedToYou: { count: 1, items: [{ id: RUN, goal: "g" }] } } }) };
        }
        return { isError: false, text: JSON.stringify({ outcomes, session: null }) };
      },
    };
    const w = createWorker(
      { agent: "proto3", claudeBin: fakeClaude, cwd: tmp, workRoot: path.join(tmp, "synap-work") },
      { mcp, podUrl: "https://pod.example", apiKey: "k", selfAgentId: "self", say: (l) => said.push(l) }
    );
    await w.tick();
    await w.waitForChildren();
    expect(fakeRuns()).toEqual([]);
    expect(w.state.runs[RUN]).toBeUndefined();
    expect(said.join("\n")).toContain("could not read how to run it");
  });
});
