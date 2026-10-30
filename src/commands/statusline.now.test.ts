/**
 * The statusline's per-conversation pod cache and its 4th ("now") line,
 * driven through the REAL exported `statusline()`.
 *
 * The `/tmp/synap-statusline-*` caches live in an in-memory map (a test must
 * never read or write the person's real cache); every other path is the real
 * fs under the throwaway HOME of test/setup/temp-home.ts. fd 0 (stdin) returns
 * the Claude Code JSON fixture.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const tmpFiles = new Map<string, string>();
let stdin = "";
const isTmp = (p: unknown) => typeof p === "string" && p.startsWith("/tmp/synap-statusline");

vi.mock("node:fs", async () => {
  const real = await vi.importActual<typeof import("node:fs")>("node:fs");
  const fs = {
    ...real,
    readFileSync: ((p: unknown, ...rest: unknown[]) => {
      if (p === 0) return stdin;
      if (isTmp(p)) {
        if (!tmpFiles.has(p as string)) throw new Error(`ENOENT ${String(p)}`);
        return tmpFiles.get(p as string)!;
      }
      return (real.readFileSync as (...a: unknown[]) => unknown)(p, ...rest);
    }) as typeof real.readFileSync,
    writeFileSync: ((p: unknown, data: unknown, ...rest: unknown[]) => {
      if (isTmp(p)) return void tmpFiles.set(p as string, String(data));
      return (real.writeFileSync as (...a: unknown[]) => unknown)(p, data, ...rest);
    }) as typeof real.writeFileSync,
    unlinkSync: ((p: unknown) => {
      if (isTmp(p)) return void tmpFiles.delete(p as string);
      return real.unlinkSync(p as string);
    }) as typeof real.unlinkSync,
    statSync: ((p: unknown, ...rest: unknown[]) => {
      if (isTmp(p)) {
        if (!tmpFiles.has(p as string)) throw new Error(`ENOENT ${String(p)}`);
        return { mtimeMs: Date.now(), size: tmpFiles.get(p as string)!.length };
      }
      return (real.statSync as (...a: unknown[]) => unknown)(p, ...rest);
    }) as typeof real.statSync,
  };
  // `default` last: `real` carries its own `default`, which must not win.
  return { ...fs, default: fs };
});

// Every way out of the process throws: render must never need one.
const spawn = vi.fn((_cmd: string, _args: string[]) => {
  throw new Error("render must not spawn into the network");
});
const forbidden = (name: string) => () => {
  throw new Error(`render must not call child_process.${name}`);
};
vi.mock("node:child_process", () => ({
  spawn: (cmd: string, args: string[]) => spawn(cmd, args),
  exec: forbidden("exec"),
  execSync: forbidden("execSync"),
  execFile: forbidden("execFile"),
  execFileSync: forbidden("execFileSync"),
}));

const hubGet = vi.fn();
vi.mock("../lib/hub-client.js", async () => {
  const real = await vi.importActual<Record<string, unknown>>("../lib/hub-client.js");
  return {
    ...real,
    resolveHubConfig: async () => ({ podUrl: "https://pod.test", apiKey: "k", workspaceId: `ws-${process.env.SYNAP_LENS_SESSION}` }),
    hubGet: (...args: unknown[]) => hubGet(...(args as [])),
  };
});
vi.mock("../lib/session-lens.js", () => ({
  resolveActiveLens: () => ({ focusSessionId: `fs-${process.env.SYNAP_LENS_SESSION}` }),
}));
vi.mock("../lib/pod.js", () => ({ getSurfaceAgentKey: () => null, SURFACE_NAMES: [] }));

const { statusline, convCacheFile } = await import("./statusline.js");

const SHARED = "/tmp/synap-statusline-cache.json";
// eslint-disable-next-line no-control-regex
const plain = (s: string) => s.replace(/\x1b\[[0-9;]*m|\x1b\]8;;[^\x1b]*\x1b\\/g, "");

function podAnswers(): void {
  hubGet.mockImplementation(async (p: string) => {
    if (p === "/workspaces") return { workspaces: [{ id: "ws-A", name: "Alpha", entityCount: 3 }, { id: "ws-B", name: "Beta", entityCount: 4 }] };
    if (p.startsWith("/agent-skills")) return { total: 7 };
    if (p === "/needs-you") return { count: { needsYou: 0, truncated: false } };
    const m = /^\/focus-sessions\/fs-(\w+)$/.exec(p);
    if (m) return { id: `fs-${m[1]}`, goal: `goal of ${m[1]}` };
    return null;
  });
}

async function refreshAs(conv: string): Promise<void> {
  vi.stubEnv("SYNAP_LENS_SESSION", conv);
  await statusline({ refresh: true });
}

async function renderAs(conv: string, extra: Record<string, unknown> = {}): Promise<string[]> {
  stdin = JSON.stringify({ session_id: conv, model: { display_name: "Opus" }, context_window: { used_percentage: 12 }, cost: { total_cost_usd: 1.5 }, ...extra });
  const out: string[] = [];
  const log = vi.spyOn(console, "log").mockImplementation((s: unknown) => void out.push(plain(String(s))));
  try {
    await statusline();
  } finally {
    log.mockRestore();
  }
  return out;
}

beforeEach(() => {
  tmpFiles.clear();
  spawn.mockClear();
  hubGet.mockReset();
  vi.stubEnv("CLAUDE_CODE_SESSION_ID", "");
  vi.stubEnv("SYNAP_STATUSLINE_TRANSCRIPT", "");
  vi.stubEnv("COLUMNS", "");
});
afterEach(() => vi.unstubAllEnvs());

describe("per-conversation pod cache", () => {
  it("each conversation's session lives in its own file; the pod-wide burst runs once for both", async () => {
    podAnswers();
    await refreshAs("A");
    await refreshAs("B");

    expect(JSON.parse(tmpFiles.get(convCacheFile("A"))!)).toMatchObject({ sessionGoal: "goal of A", activeWorkspaceId: "ws-A" });
    expect(JSON.parse(tmpFiles.get(convCacheFile("B"))!)).toMatchObject({ sessionGoal: "goal of B", activeWorkspaceId: "ws-B" });
    // N conversations never multiply the pod-wide burst: B found the shared cache fresh.
    expect(hubGet.mock.calls.filter(([p]) => p === "/workspaces")).toHaveLength(1);
    expect(JSON.parse(tmpFiles.get(SHARED)!)).not.toHaveProperty("sessionGoal");

    const a = await renderAs("A");
    const b = await renderAs("B");
    expect(a[1]).toContain("goal of A");
    expect(a[1]).toContain("Alpha");
    expect(a[1]).not.toContain("goal of B");
    expect(b[1]).toContain("goal of B");
    expect(b[1]).toContain("Beta");
  });

  it("a conversation with no cache of its own never shows the session another conversation left in an old shared cache", async () => {
    tmpFiles.set(SHARED, JSON.stringify({ ts: Date.now(), attemptedTs: Date.now(), ok: true, workspaces: [], sessionGoal: "someone else's goal", sessionId: "x" }));
    const out = await renderAs("C");
    expect(out.join("\n")).not.toContain("someone else's goal");
  });

  it("a failing pod keeps the conversation's last good values and stamps its attempt", async () => {
    podAnswers();
    await refreshAs("A");
    const before = JSON.parse(tmpFiles.get(convCacheFile("A"))!);
    hubGet.mockRejectedValue(new Error("429"));
    tmpFiles.set(convCacheFile("A"), JSON.stringify({ ...before, attemptedTs: 0 })); // due again
    await refreshAs("A");
    const after = JSON.parse(tmpFiles.get(convCacheFile("A"))!);
    expect(after).toMatchObject({ ok: false, sessionGoal: "goal of A", ts: before.ts }); // a 429 keeps the last good value
    expect(Date.now() - after.attemptedTs).toBeLessThan(5_000); // …and stamps the attempt (no storm)
  });

  it("render refreshes only when a cache is due, and a refresh of one conversation does not refetch the other's", async () => {
    const fresh = { ts: Date.now(), attemptedTs: Date.now(), ok: true };
    tmpFiles.set(SHARED, JSON.stringify({ ...fresh, workspaces: [] }));
    tmpFiles.set(convCacheFile("A"), JSON.stringify(fresh));
    await renderAs("A");
    expect(spawn).not.toHaveBeenCalled();
    await renderAs("B"); // B has no cache yet → a refresh is wanted (spawn throws; render goes on)
    expect(spawn).toHaveBeenCalledTimes(1);
  });
});

describe("render touches no network", () => {
  it("prints all 4 lines from local files with fetch and every child_process call throwing", async () => {
    const fetchSpy = vi.fn(() => {
      throw new Error("render must not fetch");
    });
    vi.stubGlobal("fetch", fetchSpy);
    try {
      const home = os.homedir();
      const conv = "11111111-2222-3333-4444-555555555555";
      // Claude Code's registry: this conversation is idle (its turn ended).
      fs.mkdirSync(path.join(home, ".claude", "sessions"), { recursive: true });
      fs.writeFileSync(
        path.join(home, ".claude", "sessions", "999.json"),
        JSON.stringify({ pid: 999, sessionId: conv, status: "shell", statusUpdatedAt: Date.now() - 60_000, startedAt: Date.now() - 3_600_000 })
      );
      // The transcript: one background agent, still running.
      const transcript = path.join(home, "t.jsonl");
      const ts = new Date(Date.now() - 5 * 60_000).toISOString();
      fs.writeFileSync(
        transcript,
        [
          JSON.stringify({ type: "assistant", timestamp: ts, message: { content: [{ type: "tool_use", id: "toolu_a", name: "Agent", input: { description: "Review the diff" } }] } }),
          JSON.stringify({ type: "user", timestamp: ts, message: { content: [{ type: "tool_result", tool_use_id: "toolu_a", content: "ok" }] }, toolUseResult: { status: "async_launched", agentId: "a1" } }),
        ].join("\n") + "\n"
      );
      // A typed wait, running.
      const wdir = path.join(home, ".synap", "waits", conv);
      fs.mkdirSync(wdir, { recursive: true });
      fs.writeFileSync(
        path.join(wdir, "w.json"),
        JSON.stringify({ id: "w", kind: "devbox", ref: "w7", label: "", pid: process.pid, startedAt: Date.now() - 120_000, probedAt: Date.now(), changedAt: Date.now(), state: "running", detail: "be-file · 1/2 done", attempt: 1, probeErrors: 0 })
      );

      const out = await renderAs(conv, { transcript_path: transcript, cwd: home, rate_limits: { five_hour: { used_percentage: 10 } } });

      expect(fetchSpy).not.toHaveBeenCalled();
      expect(out).toHaveLength(4);
      expect(out[3]).toBe("⏳ waiting on 2 · devbox w7 running (be-file · 1/2 done) 2m · Review the diff 5m");
      // The index it built is on disk for the next render.
      expect(JSON.parse(fs.readFileSync(path.join(home, ".synap", "statusline", `${conv}.json`), "utf-8")).open.a1).toBeDefined();
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe("line 4 from the bridge's status file", () => {
  /** This conversation's registry (idle, its process started an hour ago) and, when given, its status file. */
  function conversation(conv: string, statusFile?: string): void {
    const home = os.homedir();
    fs.mkdirSync(path.join(home, ".claude", "sessions"), { recursive: true });
    fs.writeFileSync(
      path.join(home, ".claude", "sessions", `${conv.slice(0, 4)}.json`),
      JSON.stringify({ pid: 4321, sessionId: conv, status: "idle", statusUpdatedAt: Date.now() - 60_000, startedAt: Date.now() - 3_600_000 })
    );
    if (statusFile === undefined) return;
    const dir = path.join(home, ".synap", "bridge", "status");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, `${conv}.json`), statusFile);
  }
  const bridgeFile = (writtenAt: number) =>
    JSON.stringify({
      v: 1,
      writtenAt: new Date(writtenAt).toISOString(),
      sessionId: "54436c32-783f-4a9d-9322-16ff18f448f7",
      title: "Lane cli-statusfile",
      live: null,
      nextMove: { kind: "agent_slot", actor: "ai", label: "Open the PR", reason: "" },
      waitingOn: [{ reason: "approval", count: 2 }],
      workUnits: [],
    });

  it("a fresh file is drawn: what the pod says the conversation waits on", async () => {
    const conv = "aaaa1111-2222-3333-4444-555555555555";
    conversation(conv, bridgeFile(Date.now() - 30_000));
    const out = await renderAs(conv);
    expect(out[3]).toBe("⏳ waiting on 2 · approval (2) · next: Open the PR");
  });

  it("no file: the transcript index line, as before", async () => {
    const conv = "bbbb1111-2222-3333-4444-555555555555";
    conversation(conv);
    const out = await renderAs(conv);
    expect(out[3]).toBe("■ stopped · nothing running · 1m");
  });

  it("a file an earlier Claude Code process wrote is stale: the transcript index line", async () => {
    const conv = "cccc1111-2222-3333-4444-555555555555";
    conversation(conv, bridgeFile(Date.now() - 2 * 3_600_000));
    const out = await renderAs(conv);
    expect(out[3]).toBe("■ stopped · nothing running · 1m");
  });

  it("a malformed file falls back, never throws, and is marked as a failed read", async () => {
    const conv = "dddd1111-2222-3333-4444-555555555555";
    conversation(conv, '{"v":1,"writ');
    const out = await renderAs(conv);
    expect(out).toHaveLength(4);
    expect(out[3]).toBe("■ stopped · nothing running · 1m · ⚑ bridge status not JSON");
  });
});
