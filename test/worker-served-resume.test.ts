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
import {
  MAX_LIMIT_RESUMES,
  MAX_SETTLE_ATTEMPTS,
  createWorker,
  deadRunSentence,
  type ExecFn,
  type RunRecord,
  type WorkerDeps,
} from "../src/commands/worker.js";
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
const verdict = process.env.SYNAP_FAKE_VERDICT;
out({ type: "result", subtype: "success", is_error: false, result: "Did it." + (verdict === "none" ? "" : "\\nWORKER-RESULT: " + verdict) });
process.exitCode = Number(process.env.SYNAP_FAKE_EXIT || 0);
`;

type Run = { argv: string[]; mcp: { mcpServers: Record<string, { headers: Record<string, string> }> } };
const fakeRuns = (): Run[] =>
  fs.existsSync(fakeLog) ? fs.readFileSync(fakeLog, "utf8").trim().split("\n").map((l) => JSON.parse(l) as Run) : [];

interface Call {
  tool: string;
  args: Record<string, unknown>;
  headers: Record<string, string>;
}

/**
 * A pod whose orient lists `handed` (mutable between ticks) and records every
 * call, and when each room post landed. `outcomesFailFrom`: from that
 * synap_get_session read on (1-based), the outcomes read says `unavailable`.
 * `blips`: the next N room posts throw like a dropped connection, `lost` before
 * they land, `unacked` after (the pod has the line, the worker never heard).
 * The room keeps one line per `idempotencyKey`, as the pod does (post-message.ts),
 * and the room read returns its lines as the worker agent's own (`self`).
 */
function stubPod(
  handed: { items: Array<Record<string, unknown>> },
  outcomes: Array<Record<string, unknown>> = [],
  outcomesFailFrom = Infinity,
  blips: { n: number; mode: "lost" | "unacked" } = { n: 0, mode: "lost" }
) {
  const calls: Call[] = [];
  let sessionReads = 0;
  const postedAt: string[] = [];
  const room = new Map<string, { id: string; content: string; timestamp: string; authorType: string; routedTeammateId: string }>();
  const mcp: McpCallClient = {
    async call(tool, args = {}, extras = {}) {
      calls.push({ tool, args, headers: extras.headers ?? {} });
      if (tool === "synap_orient") {
        return { isError: false, text: JSON.stringify({ startHere: { handedToYou: { count: handed.items.length, items: handed.items } } }) };
      }
      if (tool === "synap_get_session") {
        const id = args.sessionId as string;
        const outcomesStatus = ++sessionReads >= outcomesFailFrom ? "unavailable" : "ok";
        return {
          isError: false,
          text: JSON.stringify({
            session: { id, goal: "g", playbookId: null, channelId: `room-${id.slice(0, 8)}` },
            // The lean read (backend#932) says whose each outcome is and whether it was withdrawn.
            outcomes: {
              status: outcomesStatus,
              ...(outcomesStatus === "ok" ? { outcomes: outcomes.map((o) => ({ retired: false, ...o })) } : {}),
            },
          }),
        };
      }
      if (tool === "synap_get_thread_context") return { isError: false, text: JSON.stringify({ messages: [...room.values()] }) };
      if (tool === "synap_post_message") {
        if (blips.n > 0 && blips.mode === "lost") {
          blips.n--;
          throw new Error("fetch failed");
        }
        const key = String(args.idempotencyKey ?? `nokey-${calls.length}`);
        if (!room.has(key)) {
          const at = new Date().toISOString();
          room.set(key, { id: key, content: String(args.content), timestamp: at, authorType: "agent", routedTeammateId: "self" });
          postedAt.push(at);
        }
        if (blips.n > 0) {
          blips.n--;
          throw new Error("fetch failed");
        }
      }
      if (tool === "synap_post_message" || tool === "synap_update_session") return { isError: false, text: "{}" };
      throw new Error(`unexpected tool ${tool}`);
    },
  };
  return { mcp, calls, postedAt, room };
}

const mk = (agent: string, mcp: McpCallClient, lines: string[] = [], extra: Partial<WorkerDeps> = {}) =>
  createWorker(
    { agent, claudeBin: fakeClaude, cwd: tmp, workRoot: path.join(tmp, "work"), maxParallel: "3" },
    { mcp, podUrl: "https://pod.example", apiKey: "k", selfAgentId: "self", say: (l) => lines.push(l), ...extra }
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
    expect(posts[0].args).toEqual({
      channelId: `room-${A.slice(0, 8)}`,
      kind: "update",
      content: "Result: blocked — waiting on the person",
      idempotencyKey: `result:${A}:${w.state.runs[A].process}`,
    });
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
      [
        "synap_post_message",
        {
          channelId: `room-${A.slice(0, 8)}`,
          kind: "update",
          content: "Result: done — the cut is filed",
          idempotencyKey: `result:${A}:${w.state.runs[A].process}`,
        },
      ],
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

  it("done with an open pull request: the PR is never claimed (it is delivered when it merges)", async () => {
    vi.stubEnv("SYNAP_FAKE_VERDICT", "done — PR #12 is open");
    const pod = stubPod({ items: [{ id: A, goal: "g" }] }, [
      { key: "pr-backend-12", kind: "pull_request", owner: "agent", met: false, ref: { url: "https://github.com/o/backend/pull/12" } },
    ]);
    const w = mk("verdict4", pod.mcp);
    await w.tick();
    await w.waitForChildren();
    expect(pod.calls.some((c) => c.tool === "synap_update_session")).toBe(false);
    expect(pod.calls.filter((c) => c.tool === "synap_post_message").map((c) => c.args.content)).toEqual(["Result: done — PR #12 is open"]);
  });

  it("done, but the process exited non-zero: failed is posted and nothing is claimed", async () => {
    vi.stubEnv("SYNAP_FAKE_VERDICT", "done — the cut is filed");
    vi.stubEnv("SYNAP_FAKE_EXIT", "3");
    const pod = stubPod({ items: [{ id: A, goal: "g" }] }, [{ key: "video", kind: "file", owner: "agent", met: false }]);
    const w = mk("verdict5", pod.mcp);
    await w.tick();
    await w.waitForChildren();
    expect(w.state.runs[A].status).toBe("failed");
    expect(pod.calls.some((c) => c.tool === "synap_update_session")).toBe(false);
    expect(pod.calls.filter((c) => c.tool === "synap_post_message").map((c) => c.args.content)).toEqual([
      "Result: failed — the run exited 3; it said done — the cut is filed",
    ]);
  });

  it("done, but the outcomes could not be read: nothing is claimed, and that is said", async () => {
    vi.stubEnv("SYNAP_FAKE_VERDICT", "done — the cut is filed");
    const lines: string[] = [];
    // The launch reads the session (read 1); the run's end reads it again (read 2), unreadable.
    const pod = stubPod({ items: [{ id: A, goal: "g" }] }, [{ key: "video", kind: "file", owner: "agent", met: false }], 2);
    const w = mk("verdict6", pod.mcp, lines);
    await w.tick();
    await w.waitForChildren();
    expect(pod.calls.some((c) => c.tool === "synap_update_session")).toBe(false);
    expect(lines.some((l) => l.includes(A) && l.includes("its outcomes could not be read (outcomes unavailable)"))).toBe(true);
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

  it("quiet since the run's own Result post: never resumed again (the post is the run's own activity)", async () => {
    const handed = { items: [{ id: A, goal: "g" }] as Array<Record<string, unknown>> };
    const pod = stubPod(handed);
    const w = mk("resume4", pod.mcp);
    await w.tick(); // the first launch; its end posts "Result: blocked — …"
    await w.waitForChildren();
    expect(pod.postedAt).toHaveLength(1);

    // The pod's quietSince is the session's newest activity: that Result post.
    handed.items = [{ id: A, goal: "g", resume: true, quietSince: pod.postedAt[0] }];
    expect((await w.tick()).launched).toBe(0);
    await w.waitForChildren();
    expect((await w.tick()).launched).toBe(0);
    await w.waitForChildren();
    expect(fakeRuns()).toHaveLength(1);
    expect(w.state.runs[A].resumes ?? 0).toBe(0);
  });

  it("a resume whose launch did not start leaves the quiet period due: the next tick resumes it", async () => {
    let gets = 0;
    // The App token fails once, on the resume's launch only.
    const githubToken = {
      get: async () => {
        gets++;
        if (gets === 2) throw new Error("GitHub said 502");
        return "ghs_token";
      },
    };
    const handed = { items: [{ id: A, goal: "g" }] as Array<Record<string, unknown>> };
    const pod = stubPod(handed);
    const w = mk("resume5", pod.mcp, [], { githubToken });
    try {
      await w.tick();
      await w.waitForChildren();
      handed.items = [{ id: A, goal: "g", resume: true, quietSince: "2026-10-29T10:00:00.000Z" }];
      expect((await w.tick()).launched).toBe(0); // the token failed: nothing started
      expect(w.state.runs[A].resumedQuietSince).toBeUndefined();
      expect((await w.tick()).launched).toBe(1); // still due
      await w.waitForChildren();
      expect(w.state.runs[A].resumedQuietSince).toBe("2026-10-29T10:00:00.000Z");
      expect(fakeRuns()).toHaveLength(2);
    } finally {
      w.stop();
    }
  });
});

const posts = (calls: Call[]) => calls.filter((c) => c.tool === "synap_post_message");
const stateFile = (agent: string) => path.join(os.homedir(), ".synap", "worker", agent, "state.json");

describe("the Result post survives a blip or a crash (task 57f66aae)", () => {
  it("a post lost to a blip is retried on the next tick under the same key, then never again", async () => {
    const lines: string[] = [];
    const pod = stubPod({ items: [{ id: A, goal: "g" }] }, [], Infinity, { n: 1, mode: "lost" });
    const w = mk("settle1", pod.mcp, lines);
    await w.tick();
    await w.waitForChildren();
    expect(posts(pod.calls)).toHaveLength(1);
    expect(pod.room.size).toBe(0);
    expect(w.state.runs[A].unsettled).toBeDefined();
    expect(w.state.runs[A].settledAt).toBeUndefined();
    expect(lines.some((l) => l.includes(A) && l.includes("retried next tick"))).toBe(true);

    await w.tick();
    await w.waitForChildren();
    const sent = posts(pod.calls);
    expect(sent).toHaveLength(2);
    expect(sent[1].args.idempotencyKey).toBe(`result:${A}:${w.state.runs[A].process}`);
    expect(sent[1].args.idempotencyKey).toBe(sent[0].args.idempotencyKey);
    expect([...pod.room.values()].map((m) => m.content)).toEqual(["Result: blocked — waiting on the person"]);
    expect(w.state.runs[A].unsettled).toBeUndefined();
    expect(w.state.runs[A].settledAt).toBeDefined();

    await w.tick();
    await w.waitForChildren();
    expect(posts(pod.calls)).toHaveLength(2);
    expect(fakeRuns()).toHaveLength(1); // its own Result line never woke it
  });

  it("a post that landed but whose answer was lost: the retry returns it, the room has ONE line", async () => {
    const pod = stubPod({ items: [{ id: A, goal: "g" }] }, [], Infinity, { n: 1, mode: "unacked" });
    const w = mk("settle2", pod.mcp);
    await w.tick();
    await w.waitForChildren();
    await w.tick();
    await w.waitForChildren();
    expect(posts(pod.calls)).toHaveLength(2);
    expect(pod.room.size).toBe(1);
    expect(w.state.runs[A].unsettled).toBeUndefined();
  });

  it("the worker died before its post landed: the next worker on this computer posts it", async () => {
    const first = stubPod({ items: [{ id: A, goal: "g" }] }, [], Infinity, { n: 1, mode: "lost" });
    const w1 = mk("settle3", first.mcp);
    await w1.tick();
    await w1.waitForChildren();
    const process1 = w1.state.runs[A].process;
    expect(JSON.parse(fs.readFileSync(stateFile("settle3"), "utf8")).runs[A].unsettled).toBeDefined();

    const second = stubPod({ items: [] });
    const w2 = mk("settle3", second.mcp);
    await w2.tick();
    const sent = posts(second.calls);
    expect(sent).toHaveLength(1);
    expect(sent[0].args).toMatchObject({ content: "Result: blocked — waiting on the person", idempotencyKey: `result:${A}:${process1}` });
    expect(sent[0].headers).toMatchObject({ "X-Synap-Runner-State": "ended", "X-Synap-Process": process1 });
  });

  it(`gives up after ${MAX_SETTLE_ATTEMPTS} tries, and says so`, async () => {
    const lines: string[] = [];
    const pod = stubPod({ items: [{ id: A, goal: "g" }] }, [], Infinity, { n: Infinity, mode: "lost" });
    const w = mk("settle4", pod.mcp, lines);
    await w.tick();
    await w.waitForChildren();
    for (let i = 1; i < MAX_SETTLE_ATTEMPTS + 2; i++) await w.tick();
    expect(posts(pod.calls)).toHaveLength(MAX_SETTLE_ATTEMPTS);
    expect(w.state.runs[A].unsettled).toBeUndefined();
    expect(lines.some((l) => l.includes(A) && l.includes(`gave up after ${MAX_SETTLE_ATTEMPTS} tries`))).toBe(true);
  });
});

describe("a run that dies says so in its room (task e337af57)", () => {
  it("exit non-zero with no WORKER-RESULT: one `Result: failed` line saying how it ended", async () => {
    vi.stubEnv("SYNAP_FAKE_VERDICT", "none");
    vi.stubEnv("SYNAP_FAKE_EXIT", "2");
    const pod = stubPod({ items: [{ id: A, goal: "g" }] }, [{ key: "video", kind: "file", owner: "agent", met: false }]);
    const w = mk("dead1", pod.mcp);
    await w.tick();
    await w.waitForChildren();
    expect(w.state.runs[A]).toMatchObject({ status: "failed", result: "Did it." });
    expect(posts(pod.calls).map((c) => c.args.content)).toEqual(["Result: failed — the run exited 2 without a verdict: Did it."]);
    expect(pod.calls.some((c) => c.tool === "synap_update_session")).toBe(false);

    // Its own line is no follow-up: the next tick resumes nothing.
    expect((await w.tick()).launched).toBe(0);
    expect(fakeRuns()).toHaveLength(1);
  });

  it("the worker restarted while a run was in flight: the pod hears that runner end, and the room why", async () => {
    const proc = "box:4242:1793600000000";
    fs.mkdirSync(path.dirname(stateFile("dead2")), { recursive: true });
    const running: RunRecord = {
      sessionId: A,
      status: "running",
      startedAt: "2026-11-01T10:00:00.000Z",
      launchedAt: "2026-11-01T10:00:00.000Z",
      mode: "print",
      pid: 999_999,
      claudeSessionId: CLAUDE_SID,
      process: proc,
    };
    fs.writeFileSync(stateFile("dead2"), JSON.stringify({ runs: { [A]: running } }));
    const pod = stubPod({ items: [] });
    const w = mk("dead2", pod.mcp);
    await w.tick();
    const read = pod.calls.find((c) => c.tool === "synap_get_session");
    expect(read?.headers).toMatchObject({ "X-Synap-Runner-State": "ended", "X-Synap-Process": proc, "X-Synap-Conversation": `claude-code:${CLAUDE_SID}` });
    expect(posts(pod.calls).map((c) => c.args.content)).toEqual([
      "Result: failed — the run ended without a verdict: worker restarted while this run was in flight",
    ]);
    expect(posts(pod.calls)[0].args.idempotencyKey).toBe(`result:${A}:${proc}`);
  });

  it("a run cut off by usage limits too many times: failed, and said in the room", async () => {
    const pod = stubPod({ items: [{ id: A, goal: "g" }] });
    const w = mk("dead3", pod.mcp);
    w.state.runs[A] = {
      sessionId: A,
      status: "limited",
      startedAt: "2026-11-01T10:00:00.000Z",
      finishedAt: "2026-11-01T11:00:00.000Z",
      limitResumes: MAX_LIMIT_RESUMES,
      claudeSessionId: CLAUDE_SID,
      process: "box:1:1793600000000",
    };
    expect((await w.tick()).launched).toBe(0);
    expect(w.state.runs[A].status).toBe("failed");
    expect(posts(pod.calls).map((c) => c.args.content)).toEqual([
      `Result: failed — the run ended without a verdict: stopped: cut off by a usage limit ${MAX_LIMIT_RESUMES + 1} times`,
    ]);
    expect(fakeRuns()).toHaveLength(0);
  });

  it("a background run that vanished: failed, and said in the room", async () => {
    const exec: ExecFn = async (_bin, args) => ({ code: 0, stdout: args[0] === "agents" ? "[]" : "", stderr: "" });
    const pod = stubPod({ items: [] });
    const w = mk("dead4", pod.mcp, [], { exec });
    w.state.runs[A] = {
      sessionId: A,
      status: "running",
      mode: "bg",
      bgId: "bg1",
      startedAt: "2026-11-01T10:00:00.000Z",
      launchedAt: "2026-11-01T10:00:00.000Z",
      claudeSessionId: CLAUDE_SID,
      process: "box:1:1793600000000",
    };
    await w.tick();
    expect(w.state.runs[A].status).toBe("failed");
    expect(posts(pod.calls).map((c) => c.args.content)).toEqual([
      "Result: failed — the run ended without a verdict: background session no longer listed by claude agents",
    ]);
  });

  it("the synthesised sentence is one line of at most 300 characters", () => {
    expect(deadRunSentence({ result: "a\n\n  b", exitCode: 1 })).toBe("the run exited 1 without a verdict: a b");
    expect(deadRunSentence({})).toBe("the run ended without a verdict");
    const long = deadRunSentence({ result: "x".repeat(500) });
    expect(long).toHaveLength(300);
    expect(long.endsWith("…")).toBe(true);
  });
});
