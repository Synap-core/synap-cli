/**
 * `synap waker` — this computer's waker (plan v2 slice 4). Driven through
 * `createWaker` with a stubbed pod (`fetch`) and a stubbed worker start: what
 * is asserted is what the waker DID with each answer of the pod.
 */

import { describe, expect, it } from "vitest";
import path from "node:path";
import {
  REWAKE_MS,
  WAKER_LABEL,
  buildWakerServiceSpec,
  createWaker,
  fetchWakeList,
  planWakes,
  type WakeList,
} from "../src/commands/waker.js";

const COMPUTER = { id: "m-1", name: "CT112" };
const list = (over: Partial<WakeList> = {}): WakeList => ({
  computer: COMPUTER,
  wakesAgents: true,
  leaseMs: 120_000,
  agents: [],
  unreadable: [],
  ...over,
});
const agent = (id: string, sessions: string[]) => ({
  agentUserId: id,
  name: `agent ${id}`,
  sessions: sessions.map((s) => ({ id: s })),
});

/** A pod that answers each poll with the next list, and records the requests. */
function pod(answers: Array<WakeList | { status: number; body: unknown }>) {
  const calls: Array<{ url: string; headers: Record<string, string> }> = [];
  let i = 0;
  const fetchImpl = (async (url: string, init?: RequestInit) => {
    calls.push({ url, headers: init?.headers as Record<string, string> });
    const a = answers[Math.min(i++, answers.length - 1)]!;
    const [status, body] = "status" in a && !("computer" in a) ? [a.status, a.body] : [200, a];
    return new Response(typeof body === "string" ? body : JSON.stringify(body), { status });
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

describe("planWakes — which agents to start now", () => {
  const saved = new Map([
    ["a-1", "hermes-ct112"],
    ["a-2", "claude-code"],
  ]);
  const base = { saved, running: new Set<string>(), woken: new Map(), now: 1_000_000 };

  it("starts a saved agent with a handed session; the switch off starts nothing", () => {
    const l = list({ agents: [agent("a-1", ["s-1"]), agent("a-2", [])] });
    expect(planWakes(l, base).start.map((s) => s.name)).toEqual(["hermes-ct112"]);
    expect(planWakes({ ...l, wakesAgents: false }, base).start).toEqual([]);
  });

  it("never a second worker for an agent already running; an agent not saved here is named, never guessed", () => {
    const l = list({ agents: [agent("a-1", ["s-1"]), agent("a-9", ["s-2"])] });
    const p = planWakes(l, { ...base, running: new Set(["a-1"]) });
    expect(p.start).toEqual([]);
    expect(p.notSaved).toEqual(["agent a-9"]);
  });

  it("a session it already started the agent for: again only after REWAKE_MS (follow-ups), at once for a new one", () => {
    const woken = new Map([["a-1", { sessions: ["s-1"], at: base.now }]]);
    const l = list({ agents: [agent("a-1", ["s-1"])] });
    expect(planWakes(l, { ...base, woken, now: base.now + REWAKE_MS - 1 }).start).toEqual([]);
    expect(planWakes(l, { ...base, woken, now: base.now + REWAKE_MS }).start.map((s) => s.reason)).toEqual([
      "work still handed: checking for follow-ups",
    ]);
    const more = list({ agents: [agent("a-1", ["s-1", "s-2"])] });
    expect(planWakes(more, { ...base, woken, now: base.now + 1 }).start.map((s) => s.reason)).toEqual(["handed s-2"]);
  });
});

describe("fetchWakeList — the poll is the lease", () => {
  it("asks with the computer's key and the waker's runner stamp", async () => {
    const p = pod([list()]);
    await fetchWakeList("https://pod.me.synap.live/", "computer-key", p.fetchImpl);
    expect(p.calls[0]!.url).toBe("https://pod.me.synap.live/api/hub/computers/me/wakes");
    expect(p.calls[0]!.headers.Authorization).toBe("Bearer computer-key");
    expect(p.calls[0]!.headers["X-Synap-Runner"]).toMatch(/^synap-waker\/\S+$/);
  });

  it("a refusal, an older pod or a body that is not one THROWS: never read as an empty list", async () => {
    const at = (a: { status: number; body: unknown }) => fetchWakeList("https://p", "k", pod([a]).fetchImpl);
    await expect(at({ status: 403, body: { code: "NOT_A_COMPUTER", error: "Only a computer" } })).rejects.toThrow(
      /refused the waker \(403 NOT_A_COMPUTER\): Only a computer/
    );
    await expect(at({ status: 404, body: { error: "Not found" } })).rejects.toThrow(/older than the waker/);
    await expect(at({ status: 200, body: "<html>" })).rejects.toThrow(/not JSON/);
    await expect(at({ status: 200, body: { ok: true } })).rejects.toThrow(/not one/);
  });
});

describe("createWaker — a computer's agents start when work is handed to them", () => {
  it("starts each due agent once, never twice while it runs, and again for new work", async () => {
    const p = pod([
      list({ agents: [agent("a-1", ["s-1"])] }),
      list({ agents: [agent("a-1", ["s-1"])] }),
      list({ agents: [agent("a-1", ["s-1", "s-2"])] }),
    ]);
    const started: string[] = [];
    let finish: (code: number) => void = () => {};
    const w = createWaker({
      podUrl: "https://p",
      computerKey: "k",
      fetchImpl: p.fetchImpl,
      saved: () => new Map([["a-1", "hermes-ct112"]]),
      startWorker: (name) => {
        started.push(name);
        return { done: new Promise<number | null>((r) => (finish = r)) };
      },
      say: () => {},
    });
    expect((await w.tick()).started).toEqual(["hermes-ct112"]);
    // Still running: the same work does not start a second worker.
    expect((await w.tick()).started).toEqual([]);
    finish(0);
    await w.waitForWorkers();
    // A new session handed: started again.
    expect((await w.tick()).started).toEqual(["hermes-ct112"]);
    expect(started).toEqual(["hermes-ct112", "hermes-ct112"]);
    expect(p.calls).toHaveLength(3);
  });

  it("the switch off: nothing starts, and it is said once", async () => {
    const lines: string[] = [];
    const w = createWaker({
      podUrl: "https://p",
      computerKey: "k",
      fetchImpl: pod([list({ wakesAgents: false, agents: [agent("a-1", ["s-1"])], why: "Turn it on in pod admin" })]).fetchImpl,
      saved: () => new Map([["a-1", "x"]]),
      startWorker: () => {
        throw new Error("must not start");
      },
      say: (l) => lines.push(l),
    });
    expect(await w.tick()).toEqual({ wakesAgents: false, started: [] });
    await w.tick();
    expect(lines.filter((l) => l.includes('"Wakes agents" is off'))).toHaveLength(1);
  });
});

describe("the waker's login service", () => {
  it("runs this synap's `waker` with the person's PATH (it starts their engines), one label per computer", () => {
    const spec = buildWakerServiceSpec(
      { protocols: "work-folder" },
      { home: "/Users/a", nodePath: "/opt/node/bin/node", synapPath: "/opt/node/bin/synap", searchPath: "/Users/a/.hermes/bin:/opt/homebrew/bin:relative" }
    );
    expect(spec.label).toBe(WAKER_LABEL);
    expect(spec.programArguments).toEqual(["/opt/node/bin/node", "/opt/node/bin/synap", "waker", "--protocols", "work-folder"]);
    const dirs = spec.environment.PATH!.split(":");
    expect(dirs[0]).toBe("/opt/node/bin");
    expect(dirs).toContain("/Users/a/.hermes/bin");
    expect(dirs).not.toContain("relative");
    expect(Object.keys(spec.environment).sort()).toEqual(["HOME", "PATH"]);
    expect(spec.logPath).toBe(path.join("/Users/a", ".synap", "waker", "waker.log"));
  });
});
