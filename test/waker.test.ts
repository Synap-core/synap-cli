/**
 * `synap waker` — this computer's waker (plan v2 slice 4). Driven through
 * `createWaker` with a stubbed pod (`fetch`) and a stubbed worker start: what
 * is asserted is what the waker DID with each answer of the pod.
 */

import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  REWAKE_MS,
  WAKER_LABEL,
  WAKER_UNIT,
  buildWakerServiceSpec,
  createWaker,
  fetchWakeList,
  installLinuxWaker,
  linuxWakerStatus,
  parseWakerInterval,
  planWakes,
  renderWakerUnit,
  runWakerLoop,
  systemdWord,
  uninstallLinuxWaker,
  wakerNotSupportedMessage,
  wakerUnitPath,
  workerLogName,
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

describe("the waker's poll interval stays inside its lease", () => {
  const parse = (raw: string | undefined, fallback: number) =>
    raw === undefined ? fallback : raw.endsWith("m") ? Number(raw.slice(0, -1)) * 60_000 : Number(raw.replace(/s$/, "")) * 1000;
  it("5s to 60s pass; 0, 4s and 3m are refused with why", () => {
    expect(parseWakerInterval(undefined, parse)).toBe(30_000);
    expect(parseWakerInterval("5s", parse)).toBe(5_000);
    expect(parseWakerInterval("60s", parse)).toBe(60_000);
    for (const bad of ["0s", "4s", "3m"]) expect(() => parseWakerInterval(bad, parse)).toThrow(/outside 5s to 60s/);
  });
});

describe("runWakerLoop: a stop is prompt and ends the workers it started", () => {
  it("SIGTERM during the wait ends the loop at once and stops the workers", async () => {
    const stop = new AbortController();
    const calls: string[] = [];
    const loop = runWakerLoop({
      waker: {
        tick: async () => {
          calls.push("tick");
          return { wakesAgents: true, started: [] };
        },
        waitForWorkers: async () => void calls.push("wait"),
        stopWorkers: async () => void calls.push("stopWorkers"),
      },
      intervalMs: 60_000,
      signal: stop.signal,
      log: () => {},
    });
    await new Promise((r) => setTimeout(r, 20));
    const t0 = Date.now();
    stop.abort();
    await loop;
    expect(Date.now() - t0).toBeLessThan(1_000);
    expect(calls).toEqual(["tick", "stopWorkers"]);
  });

  it("--once waits for the workers it started; a failed poll throws", async () => {
    const calls: string[] = [];
    const waker = {
      tick: async () => ({ wakesAgents: true, started: ["a"] }),
      waitForWorkers: async () => void calls.push("wait"),
      stopWorkers: async () => void calls.push("stopWorkers"),
    };
    await runWakerLoop({ waker, intervalMs: 30_000, once: true, signal: new AbortController().signal, log: () => {} });
    expect(calls).toEqual(["wait"]);
    const failing = { ...waker, tick: async () => Promise.reject(new Error("pod down")) };
    await expect(
      runWakerLoop({ waker: failing, intervalMs: 30_000, once: true, signal: new AbortController().signal, log: () => {} })
    ).rejects.toThrow("pod down");
  });

  it("stopWorkers asks each running worker to end and waits for it", async () => {
    let finish: (c: number) => void = () => {};
    const stopped: string[] = [];
    const w = createWaker({
      podUrl: "https://p",
      computerKey: "k",
      fetchImpl: pod([list({ agents: [agent("a-1", ["s-1"])] })]).fetchImpl,
      saved: () => new Map([["a-1", "hermes"]]),
      startWorker: (name) => ({
        done: new Promise<number | null>((r) => (finish = r)),
        stop: () => {
          stopped.push(name);
          finish(143);
        },
      }),
      say: () => {},
    });
    await w.tick();
    await w.stopWorkers();
    expect(stopped).toEqual(["hermes"]);
  });

  it("an agent whose work the pod cannot read is said once while it lasts", async () => {
    const lines: string[] = [];
    const w = createWaker({
      podUrl: "https://p",
      computerKey: "k",
      fetchImpl: pod([list({ unreadable: ["a-7"] }), list({ unreadable: ["a-7"] }), list(), list({ unreadable: ["a-7"] })]).fetchImpl,
      saved: () => new Map(),
      startWorker: () => ({ done: Promise.resolve(0) }),
      say: (l) => lines.push(l),
    });
    for (let i = 0; i < 4; i++) await w.tick();
    expect(lines.filter((l) => l.includes("a-7"))).toHaveLength(2);
  });
});

describe("a worker's log never leaves the waker's folder", () => {
  it("a name with a path or leading dots becomes a plain file name", () => {
    expect(workerLogName("hermes-ct112")).toBe("hermes-ct112.log");
    expect(workerLogName("../../.ssh/authorized_keys")).not.toMatch(/\//);
    expect(workerLogName("..")).toBe("_.log");
    expect(path.basename(workerLogName("a/b c"))).toBe(workerLogName("a/b c"));
  });
});

describe("the waker's service on Linux: a systemd user unit (CT112)", () => {
  const spec = () =>
    buildWakerServiceSpec({}, { home: "/home/a b", nodePath: "/usr/bin/node", synapPath: "/opt/synap/index.js", searchPath: "/usr/bin" });

  it("the unit runs this synap's waker with its environment, restarts it, and appends to the waker's log", () => {
    const unit = renderWakerUnit(spec());
    expect(unit).toContain("ExecStart=/usr/bin/node /opt/synap/index.js waker");
    // Every ExecStart word, the first included, escapes $ (systemd expands it there).
    expect(renderWakerUnit({ ...spec(), programArguments: ["/x$y/node", "a$b"] })).toContain('ExecStart="/x$$y/node" "a$$b"');
    expect(unit).toContain('WorkingDirectory="/home/a b"');
    expect(unit).toContain('Environment="HOME=/home/a b"');
    expect(unit).toContain("Restart=always");
    expect(unit).toContain("StandardOutput=append:/home/a b/.synap/waker/waker.log");
    expect(unit).toContain("WantedBy=default.target");
    expect(systemdWord("50%$x")).toBe('"50%%$$x"');
    // Environment= never expands $: escaping it there would write a literal $$ into the value.
    expect(systemdWord("50%$x", false)).toBe('"50%%$x"');
    expect(renderWakerUnit({ ...spec(), environment: { PATH: "/a$b" } })).toContain('Environment="PATH=/a$b"');
  });

  function fakeSystem(linger = "no") {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "waker-home-"));
    const calls: string[] = [];
    const run = async (cmd: string, args: string[]) => {
      calls.push(`${cmd} ${args.join(" ")}`);
      if (cmd === "loginctl") return { code: 0, stdout: `${linger}\n`, stderr: "" };
      if (args.includes("show")) return { code: 0, stdout: "ActiveState=active\nMainPID=4242\n", stderr: "" };
      return { code: 0, stdout: "", stderr: "" };
    };
    return { deps: { home, user: "a", run }, calls, home };
  }

  it("install writes the unit, enables and starts it, says when it would stop at logout; a second install changes nothing", async () => {
    const { deps, calls, home } = fakeSystem("no");
    const s = { ...spec(), logPath: path.join(home, ".synap", "waker", "waker.log") };
    const r = await installLinuxWaker(s, deps);
    expect(r).toMatchObject({ action: "installed", lingers: false });
    expect(fs.readFileSync(wakerUnitPath(home), "utf8")).toBe(renderWakerUnit(s));
    expect(calls).toEqual([
      "systemctl --user daemon-reload",
      `systemctl --user enable --now ${WAKER_UNIT}`,
      "loginctl show-user a --property=Linger --value",
    ]);
    calls.length = 0;
    expect((await installLinuxWaker(s, deps)).action).toBe("unchanged");
    expect(calls.some((c) => c.includes("restart"))).toBe(false);
    expect((await installLinuxWaker({ ...s, programArguments: [...s.programArguments, "--protocols", "code"] }, deps)).action).toBe("updated");
    expect(calls).toContain(`systemctl --user restart ${WAKER_UNIT}`);
  });

  it("a systemctl that fails stops the install with its own words", async () => {
    const { deps, home } = fakeSystem();
    const failing = { ...deps, run: async () => ({ code: 1, stdout: "", stderr: "Failed to connect to bus" }) };
    await expect(installLinuxWaker({ ...spec(), logPath: path.join(home, "w.log") }, failing)).rejects.toThrow(/Failed to connect to bus/);
  });

  it("status reads the unit's state and pid; uninstall disables it and removes the unit", async () => {
    const { deps, calls, home } = fakeSystem("yes");
    expect(await linuxWakerStatus(deps)).toBeNull();
    await installLinuxWaker({ ...spec(), logPath: path.join(home, "w.log") }, deps);
    expect(await linuxWakerStatus(deps)).toEqual({ state: "active", pid: 4242 });
    expect(await uninstallLinuxWaker(deps)).toBe(true);
    expect(fs.existsSync(wakerUnitPath(home))).toBe(false);
    expect(calls).toContain(`systemctl --user disable --now ${WAKER_UNIT}`);
    expect(await uninstallLinuxWaker(deps)).toBe(false);
  });

  it("any other platform is told the command to keep running, in the waker's own words", () => {
    expect(wakerNotSupportedMessage("win32", spec())).toMatch(/^`synap waker install` sets up a service on macOS \(launchd\) and Linux/);
    expect(wakerNotSupportedMessage("win32", spec())).toContain("/usr/bin/node /opt/synap/index.js waker");
  });
});
