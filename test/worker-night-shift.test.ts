/**
 * `synap worker` night shift, driven end to end through `createWorker`:
 * a fake `claude` binary (a real child process speaking stream-json), a
 * stubbed pod MCP, and a stubbed account probe. What is asserted is what the
 * worker DID: which token each launch received, how the run record moved,
 * and what landed on disk.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createWorker, LIMIT_RESUME_PROMPT, type ExecFn } from "../src/commands/worker.js";
import type { McpCallClient } from "../src/lib/mcp-call.js";

const TOK = { a: "sk-ant-oat01-AAAA-secret-a", b: "sk-ant-oat01-BBBB-secret-b", dev: "sk-ant-oat01-DDDD-secret-dev" };
const H = 3_600_000;
const S1 = "11111111-1111-4111-8111-111111111111";
const D1 = "22222222-2222-4222-8222-222222222222";
const CLAUDE_SID = "c1a1c1a1-0000-4000-8000-000000000001";

let tmp: string;
let fakeLog: string;
let fakeClaude: string;

/** A `claude -p` stand-in: a first launch hits a usage limit; a `--resume` finishes. */
const FAKE = `#!/usr/bin/env node
const fs = require("fs");
const argv = process.argv.slice(2);
fs.appendFileSync(process.env.FAKE_CLAUDE_LOG, JSON.stringify({ argv, token: process.env.CLAUDE_CODE_OAUTH_TOKEN || null }) + "\\n");
const out = (o) => process.stdout.write(JSON.stringify(o) + "\\n");
const r = argv.indexOf("--resume");
out({ type: "system", subtype: "init", session_id: r >= 0 ? argv[r + 1] : "${CLAUDE_SID}" });
if (r < 0) {
  out({ type: "rate_limit_event", rate_limit_info: { status: "rejected", resetsAt: Math.floor(Date.now() / 1000) + 7200, rateLimitType: "five_hour" } });
  out({ type: "assistant", parent_tool_use_id: null, error: "rate_limit", api_error: "usage_limit_reached", api_error_status: 429, message: { content: [{ type: "text", text: "You've hit your session limit · resets 7:30am" }] } });
  out({ type: "result", subtype: "success", is_error: true, api_error_status: 429, result: "You've hit your session limit · resets 7:30am" });
  process.exit(1);
}
out({ type: "assistant", parent_tool_use_id: null, message: { content: [{ type: "text", text: "WORKER-RESULT: done — resumed and finished" }] } });
out({ type: "result", subtype: "success", is_error: false, result: "WORKER-RESULT: done — resumed and finished" });
`;

function writeAccounts(reserve = 0): string {
  const f = path.join(tmp, "accounts.json");
  fs.writeFileSync(
    f,
    JSON.stringify({
      version: 1,
      reserve,
      accounts: [
        { id: "dev", label: "Dev", token: TOK.dev, design: true },
        { id: "a", label: "A", token: TOK.a },
        { id: "b", label: "B", token: TOK.b },
      ],
    }),
    { mode: 0o600 }
  );
  return f;
}

/** The probe: each token's own limit headers. */
function probeFetch(spec: Record<string, { status?: number; util5h?: number; reset5hInH: number }>) {
  const calls: string[] = [];
  const fetchImpl = (async (_url: unknown, init?: RequestInit) => {
    const auth = (init?.headers as Record<string, string>).Authorization.replace("Bearer ", "");
    const id = Object.entries(TOK).find(([, t]) => t === auth)?.[0] ?? "?";
    calls.push(id);
    const s = spec[id];
    const status = s?.status ?? 200;
    return new Response("{}", {
      status,
      headers: {
        "anthropic-ratelimit-unified-status": status === 429 ? "rejected" : "allowed",
        "anthropic-ratelimit-unified-5h-utilization": String(s?.util5h ?? 0.1),
        "anthropic-ratelimit-unified-5h-reset": String(Math.floor((Date.now() + (s?.reset5hInH ?? 1) * H) / 1000)),
        "anthropic-ratelimit-unified-7d-utilization": "0.2",
        "anthropic-ratelimit-unified-7d-reset": String(Math.floor((Date.now() + 100 * H) / 1000)),
      },
    });
  }) as typeof fetch;
  return { fetchImpl, calls };
}

function stubPod(sessions: Record<string, { goal: string; outcomes: unknown }>): McpCallClient {
  return {
    async call(tool, args = {}) {
      if (tool === "synap_orient") {
        const items = Object.entries(sessions).map(([id, s]) => ({ id, goal: s.goal }));
        return { isError: false, text: JSON.stringify({ startHere: { handedToYou: { count: items.length, items } } }) };
      }
      if (tool === "synap_get_session") {
        const s = sessions[args.sessionId as string];
        return { isError: false, text: JSON.stringify({ session: { id: args.sessionId, channelId: null }, outcomes: s.outcomes }) };
      }
      throw new Error(`unexpected tool ${tool}`);
    },
  };
}

const plain = { status: "ok", outcomes: [{ key: "pr", label: "Draft PR", kind: "code" }] };
const designOutcomes = { status: "ok", outcomes: [{ key: "design", label: "Design", kind: "design" }] };

/** Every file the worker wrote under its state dir, with its contents. */
function workerFiles(agent: string): Array<{ file: string; text: string }> {
  const root = path.join(os.homedir(), ".synap", "worker", agent);
  const out: Array<{ file: string; text: string }> = [];
  const walk = (d: string) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else out.push({ file: path.relative(root, p), text: fs.readFileSync(p, "utf8") });
    }
  };
  walk(root);
  return out;
}

const fakeRuns = () =>
  fs.existsSync(fakeLog)
    ? fs.readFileSync(fakeLog, "utf8").trim().split("\n").map((l) => JSON.parse(l) as { argv: string[]; token: string | null })
    : [];

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "worker-night-"));
  fakeLog = path.join(tmp, "fake-claude.log");
  fakeClaude = path.join(tmp, "fake-claude.cjs");
  fs.writeFileSync(fakeClaude, FAKE, { mode: 0o755 });
  fs.rmSync(path.join(os.homedir(), ".synap"), { recursive: true, force: true });
  fs.rmSync(path.join(os.homedir(), ".claude"), { recursive: true, force: true });
  vi.stubEnv("FAKE_CLAUDE_LOG", fakeLog);
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("a run cut off by a usage limit resumes on the next account", () => {
  it("marks the account full, resumes the SAME Claude session on another account, and records which", async () => {
    const accounts = writeAccounts();
    // a resets soonest, then b; dev (design) last.
    const probe = probeFetch({ a: { reset5hInH: 1 }, b: { reset5hInH: 3 }, dev: { reset5hInH: 4 } });
    const said: string[] = [];
    const w = createWorker(
      { agent: "night", claudeBin: fakeClaude, cwd: tmp, accounts, maxParallel: "2" },
      { mcp: stubPod({ [S1]: { goal: "fix the bug", outcomes: plain } }), podUrl: "https://pod.example", apiKey: "synap_hub_k", selfAgentId: "self", fetchImpl: probe.fetchImpl, say: (l) => said.push(l) }
    );

    await w.tick();
    await w.waitForChildren();
    expect(w.state.runs[S1]).toMatchObject({ status: "limited", accountId: "a", claudeSessionId: CLAUDE_SID });

    await w.tick();
    await w.waitForChildren();
    expect(w.state.runs[S1]).toMatchObject({ status: "done", accountId: "b", limitResumes: 1, result: "done — resumed and finished" });

    const runs = fakeRuns();
    expect(runs).toHaveLength(2);
    expect(runs[0].token).toBe(TOK.a);
    expect(runs[0].argv).not.toContain("--resume");
    expect(runs[1].token).toBe(TOK.b);
    expect(runs[1].argv.slice(runs[1].argv.indexOf("--resume"), runs[1].argv.indexOf("--resume") + 2)).toEqual(["--resume", CLAUDE_SID]);
    expect(runs[1].argv[1]).toBe(LIMIT_RESUME_PROMPT);

    // No token anywhere the worker writes or prints.
    const files = workerFiles("night");
    expect(files.map((f) => f.file).sort()).toEqual(["mcp.json", `runs/${S1}.jsonl`, "state.json"]);
    expect(files.find((f) => f.file === "state.json")?.text).toContain('"accountId": "b"');
    for (const f of files) for (const t of Object.values(TOK)) expect(f.text, f.file).not.toContain(t);
    for (const t of Object.values(TOK)) expect(said.join("\n")).not.toContain(t);
    expect(said.join("\n")).toContain("on account b");
  });

  it("an inherited token never reaches a run once an account is picked", async () => {
    vi.stubEnv("CLAUDE_CODE_OAUTH_TOKEN", "sk-ant-oat01-INHERITED");
    const w = createWorker(
      { agent: "night2", claudeBin: fakeClaude, cwd: tmp, accounts: writeAccounts() },
      { mcp: stubPod({ [S1]: { goal: "g", outcomes: plain } }), podUrl: "https://pod.example", apiKey: "k", selfAgentId: "self", fetchImpl: probeFetch({}).fetchImpl, say: () => {} }
    );
    await w.tick();
    await w.waitForChildren();
    expect(fakeRuns()[0].token).not.toBe("sk-ant-oat01-INHERITED");
    expect(Object.values(TOK)).toContain(fakeRuns()[0].token);
  });

  it("no accounts file: the environment's login, as before, and nothing is probed", async () => {
    vi.stubEnv("CLAUDE_CODE_OAUTH_TOKEN", "env-login");
    const probe = probeFetch({});
    const w = createWorker(
      { agent: "night3", claudeBin: fakeClaude, cwd: tmp },
      { mcp: stubPod({ [S1]: { goal: "g", outcomes: plain } }), podUrl: "https://pod.example", apiKey: "k", selfAgentId: "self", fetchImpl: probe.fetchImpl, say: () => {} }
    );
    await w.tick();
    await w.waitForChildren();
    expect(fakeRuns()[0].token).toBe("env-login");
    expect(probe.calls).toEqual([]);
    // Without accounts a limit is a plain failure (nowhere to move it).
    expect(w.state.runs[S1].status).toBe("failed");
  });

  it("no account with room: nothing launches, said once", async () => {
    const probe = probeFetch({ a: { status: 429, reset5hInH: 1 }, b: { status: 429, reset5hInH: 1 }, dev: { status: 429, reset5hInH: 1 } });
    const said: string[] = [];
    const w = createWorker(
      { agent: "night4", claudeBin: fakeClaude, cwd: tmp, accounts: writeAccounts() },
      { mcp: stubPod({ [S1]: { goal: "g", outcomes: plain } }), podUrl: "https://pod.example", apiKey: "k", selfAgentId: "self", fetchImpl: probe.fetchImpl, say: (l) => said.push(l) }
    );
    await w.tick();
    await w.tick();
    expect(fakeRuns()).toEqual([]);
    expect(w.state.runs[S1]).toBeUndefined();
    expect(said.filter((l) => l.includes("no account with room"))).toHaveLength(1);
  });
});

describe("a design run launches with --bg on the design account and is watched to its end", () => {
  const BG = "d1d1d1d1";
  const BG_SID = `${BG}-0488-47e7-a314-064ba85d1c5e`;

  function fakeExec(phase: { state: string }) {
    const calls: Array<{ args: string[]; token: string | undefined }> = [];
    const exec: ExecFn = async (_bin, args, o) => {
      calls.push({ args, token: o.env.CLAUDE_CODE_OAUTH_TOKEN });
      if (args[0] === "--bg") return { code: 0, stdout: `Starting background service…\nbackgrounded · ${BG}\n`, stderr: "" };
      if (args[0] === "agents") return { code: 0, stdout: JSON.stringify([{ id: BG, kind: "background", sessionId: BG_SID, state: phase.state }]), stderr: "" };
      if (args[0] === "stop") return { code: 0, stdout: "", stderr: "" };
      return { code: 1, stdout: "", stderr: "unexpected" };
    };
    return { exec, calls };
  }

  it("pins the design account, gives the run the Artifact tool, and reads the verdict from the transcript", async () => {
    // a would win a normal run; a design run must still go to dev.
    const probe = probeFetch({ a: { reset5hInH: 1 }, b: { reset5hInH: 2 }, dev: { reset5hInH: 4 } });
    const phase = { state: "working" };
    const { exec, calls } = fakeExec(phase);
    const w = createWorker(
      { agent: "night5", claudeBin: "claude", cwd: tmp, accounts: writeAccounts() },
      { mcp: stubPod({ [D1]: { goal: "design the page", outcomes: designOutcomes } }), podUrl: "https://pod.example", apiKey: "k", selfAgentId: "self", fetchImpl: probe.fetchImpl, exec, say: () => {} }
    );
    await w.tick();
    const launch = calls.find((c) => c.args[0] === "--bg");
    expect(launch?.token).toBe(TOK.dev);
    expect(launch?.args).toEqual(expect.arrayContaining(["--strict-mcp-config", "--permission-mode", "dontAsk"]));
    expect(launch?.args[launch.args.indexOf("--allowedTools") + 1].split(",")).toEqual(expect.arrayContaining(["Artifact", "mcp__synap-worker"]));
    expect(w.state.runs[D1]).toMatchObject({ status: "running", mode: "bg", bgId: BG, accountId: "dev" });

    // Still working: nothing changes.
    await w.watch();
    expect(w.state.runs[D1].status).toBe("running");
    expect(w.state.runs[D1].claudeSessionId).toBe(BG_SID);

    // Done: the transcript's last reply carries the verdict.
    const dir = path.join(os.homedir(), ".claude", "projects", "-w");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, `${BG_SID}.jsonl`),
      JSON.stringify({ type: "assistant", timestamp: new Date(Date.now() + 1000).toISOString(), message: { content: [{ type: "text", text: "Published.\nWORKER-RESULT: done — artifact published" }] } }) + "\n"
    );
    phase.state = "done";
    await w.watch();
    expect(w.state.runs[D1]).toMatchObject({ status: "done", result: "done — artifact published" });
    expect(calls.filter((c) => c.args[0] === "stop").map((c) => c.args)).toEqual([["stop", BG]]);
    for (const f of workerFiles("night5")) for (const t of Object.values(TOK)) expect(f.text, f.file).not.toContain(t);
  });

  it("waits when the design account is full — never publishes from another account", async () => {
    const probe = probeFetch({ a: { reset5hInH: 1 }, b: { reset5hInH: 2 }, dev: { status: 429, reset5hInH: 1 } });
    const { exec, calls } = fakeExec({ state: "working" });
    const said: string[] = [];
    const w = createWorker(
      { agent: "night6", claudeBin: "claude", cwd: tmp, accounts: writeAccounts() },
      { mcp: stubPod({ [D1]: { goal: "design", outcomes: designOutcomes } }), podUrl: "https://pod.example", apiKey: "k", selfAgentId: "self", fetchImpl: probe.fetchImpl, exec, say: (l) => said.push(l) }
    );
    await w.tick();
    await w.tick();
    expect(calls.filter((c) => c.args[0] === "--bg")).toEqual([]);
    expect(w.state.runs[D1]).toBeUndefined();
    expect(said.filter((l) => l.includes("no design account with room"))).toHaveLength(1);
  });

  it("a background run cut off by a usage limit waits for the SAME design account and resumes there", async () => {
    let devFull = false;
    const probe = probeFetch({ a: { reset5hInH: 1 }, b: { reset5hInH: 2 }, dev: { reset5hInH: 4 } });
    const fetchImpl = (async (u: unknown, init?: RequestInit) => {
      const auth = (init?.headers as Record<string, string>).Authorization;
      if (devFull && auth.endsWith(TOK.dev)) {
        return new Response("{}", { status: 429, headers: { "anthropic-ratelimit-unified-status": "rejected", "anthropic-ratelimit-unified-reset": String(Math.floor((Date.now() + H) / 1000)) } });
      }
      return probe.fetchImpl(u as string, init);
    }) as typeof fetch;
    const phase = { state: "working" };
    const { exec, calls } = fakeExec(phase);
    const w = createWorker(
      { agent: "night7", claudeBin: "claude", cwd: tmp, accounts: writeAccounts() },
      { mcp: stubPod({ [D1]: { goal: "design", outcomes: designOutcomes } }), podUrl: "https://pod.example", apiKey: "k", selfAgentId: "self", fetchImpl, exec, say: () => {} }
    );
    await w.tick();
    await w.watch();
    const dir = path.join(os.homedir(), ".claude", "projects", "-w");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, `${BG_SID}.jsonl`),
      JSON.stringify({
        type: "assistant",
        timestamp: new Date(Date.now() + 1000).toISOString(),
        isApiErrorMessage: true,
        error: "rate_limit",
        apiError: "usage_limit_reached",
        apiErrorStatus: 429,
        apiErrorParams: { rate_limit_info: { status: "rejected", resetsAt: Math.floor(Date.now() / 1000) + 3600 } },
        message: { content: [{ type: "text", text: "You've hit your session limit" }] },
      }) + "\n"
    );
    phase.state = "blocked";
    devFull = true;
    await w.watch();
    expect(w.state.runs[D1]).toMatchObject({ status: "limited", accountId: "dev" });
    await w.tick();
    // a and b have room, but a design run waits for dev.
    expect(calls.filter((c) => c.args[0] === "--bg")).toHaveLength(1);
    expect(w.state.runs[D1].status).toBe("limited");
  });
});
