/**
 * The status line's 4th line, for each state, from fixtures. Pure: time,
 * liveness and width are arguments.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect } from "vitest";
import { buildNowLine, ordinal, readRegistry, visibleLength, type RegistryEntry } from "./now-line.js";
import type { OpenTask } from "./transcript-index.js";
import type { WaitRecord } from "./wait-state.js";

const NOW = Date.parse("2026-10-29T12:00:00Z");
const min = (m: number) => NOW - m * 60_000;
// eslint-disable-next-line no-control-regex
const plain = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "");

const reg = (status: string, extra: Partial<RegistryEntry> = {}): RegistryEntry => ({
  sessionId: "s1",
  pid: 1,
  status,
  statusUpdatedAt: min(4),
  startedAt: min(600),
  ...extra,
});
const task = (description: string, startedMin: number, extra: Partial<OpenTask> = {}): OpenTask => ({
  kind: "bash",
  description,
  toolUseId: `t-${description}`,
  startedAt: min(startedMin),
  ...extra,
});
const wait = (extra: Partial<WaitRecord>): WaitRecord => ({
  id: "w1",
  kind: "devbox",
  ref: "w7-regen",
  label: "",
  pid: 4242,
  startedAt: min(6),
  probedAt: min(0.5),
  changedAt: min(2),
  state: "running",
  detail: "be-file · 2/4 done",
  attempt: 1,
  probeErrors: 0,
  ...extra,
});
const alive = () => true;
const dead = () => false;

const line = (over: Partial<Parameters<typeof buildNowLine>[0]>) =>
  plain(buildNowLine({ now: NOW, registry: reg("idle"), open: [], waits: [], alive, ...over }));

describe("the four states", () => {
  it("needs you: the registry says waiting, with what for", () => {
    expect(line({ registry: reg("waiting", { waitingFor: "permission prompt" }) })).toBe("✋ needs you · permission prompt");
  });

  it("working: busy, with its age, then the open waits", () => {
    expect(line({ registry: reg("busy") })).toBe("▶ working · 4m");
    expect(line({ registry: reg("busy"), open: [task("Run the suite", 3)] })).toBe("▶ working · 4m · ⏳ 1 · Run the suite 3m");
  });

  it("waiting on n: idle (turn over) with open waits, typed waits first", () => {
    const out = line({ registry: reg("shell"), open: [task("Serve the build", 10)], waits: [wait({})] });
    expect(out).toBe("⏳ waiting on 2 · devbox w7-regen running be-file · 2/4 done 6m · Serve the build 10m");
  });

  it("stopped: idle with nothing open, and how long since", () => {
    expect(line({ registry: reg("idle") })).toBe("■ stopped · nothing running · 4m");
  });

  it("no registry entry at all says so instead of guessing", () => {
    expect(line({ registry: null })).toBe("○ no session status");
  });
});

describe("which background tasks count", () => {
  it("a task from before this Claude Code process started is not shown (it died with that process)", () => {
    expect(line({ registry: reg("busy", { startedAt: min(5) }), open: [task("old", 30)] })).toBe("▶ working · 4m");
  });

  it("idle means no live background shell, so open shells are dropped; agents and teammates stay", () => {
    const open = [task("Serve the build", 10), task("Audit", 10, { kind: "agent" }), task("@lane-a", 9, { kind: "teammate" })];
    expect(line({ registry: reg("idle"), open })).toBe("⏳ waiting on 2 · Audit 10m · @lane-a 9m");
    expect(line({ registry: reg("shell"), open })).toContain("Serve the build");
  });

  it("a background task that runs `synap wait` for a typed wait is shown once, as the typed wait", () => {
    const t = task("Wait for w7", 7, { command: "synap wait devbox w7-regen --label w7" });
    const out = line({ registry: reg("shell"), open: [t], waits: [wait({})] });
    expect(out).toBe("⏳ waiting on 1 · devbox w7-regen running be-file · 2/4 done 6m");
  });

  it("a `synap wait` task for ANOTHER target is still its own item", () => {
    const t = task("Wait for PR", 7, { command: "synap wait pr backend#412" });
    expect(line({ registry: reg("shell"), open: [t], waits: [wait({})] })).toContain("Wait for PR");
  });
});

describe("typed wait states", () => {
  const one = (w: Partial<WaitRecord>, alive_ = alive) => line({ registry: reg("shell"), waits: [wait(w)], alive: alive_ });
  const raw = (w: Partial<WaitRecord>) => buildNowLine({ now: NOW, registry: reg("shell"), open: [], waits: [wait(w)], alive });

  it("queued is dim, running cyan", () => {
    expect(one({ state: "queued", detail: "queued 2nd (light)" })).toBe("⏳ waiting on 1 · devbox w7-regen queued 2nd (light) 6m");
    expect(raw({ state: "queued", detail: "queued 2nd (light)" })).toContain("\x1b[2mdevbox w7-regen queued");
    expect(raw({ state: "running" })).toContain("\x1b[36mdevbox w7-regen running");
  });

  it("passed shows green ✓ for 10 min after it finished, then goes", () => {
    const passed = { state: "passed" as const, detail: "4 gates green", exitCode: 0 };
    expect(one({ ...passed, finishedAt: min(3) })).toBe("⏳ waiting on 1 · ✓ devbox w7-regen passed 3m ago");
    expect(raw({ ...passed, finishedAt: min(3) })).toContain("\x1b[32m✓");
    expect(one({ ...passed, finishedAt: min(11) })).toBe("■ stopped · nothing running · 4m");
  });

  it("failed shows red ✗ with its detail", () => {
    const out = one({ state: "failed", detail: "red: be-file (3 tests)", exitCode: 1, finishedAt: min(1) });
    expect(out).toBe("⏳ waiting on 1 · ✗ devbox w7-regen failed red: be-file (3 tests)");
    expect(raw({ state: "failed", detail: "x", exitCode: 1, finishedAt: min(1) })).toContain("\x1b[31m✗");
  });

  it("infra, error and timeout are red", () => {
    for (const state of ["infra", "error", "timeout"] as const) {
      expect(raw({ state, detail: "d", exitCode: state === "timeout" ? 2 : 3, finishedAt: min(1) })).toContain(`\x1b[31m✗ devbox w7-regen ${state}`);
    }
    expect(raw({ state: "error", detail: "probe failed 3× in a row" })).toContain("\x1b[31mdevbox w7-regen error");
  });

  it("stale: a non-final state that has not changed for 30 min is amber, with how long", () => {
    const out = raw({ state: "queued", detail: "queued 1st (heavy)", changedAt: min(34) });
    expect(out).toContain("\x1b[33mdevbox w7-regen queued");
    expect(plain(out)).toContain("no change 34m");
  });

  it("died: a non-final state whose process is gone is red", () => {
    expect(one({ state: "running" }, dead)).toBe("⏳ waiting on 1 · ✗ devbox w7-regen died (the wait stopped at running)");
  });

  it("the 3rd try on one target is called out in amber", () => {
    expect(one({ attempt: 3 })).toContain("· 3rd try");
    expect(raw({ attempt: 3 })).toContain("\x1b[33m· 3rd try");
    expect(one({ attempt: 2 })).not.toContain("try");
  });

  it("a PR wait drops the Synap-core owner from its name", () => {
    expect(one({ kind: "pr", ref: "Synap-core/backend#412", state: "running", detail: "Release gate running · 2/4 done" })).toContain(
      "pr backend#412 running Release gate running · 2/4 done"
    );
  });
});

describe("width", () => {
  it("caps the line to the width, saying how many more there are", () => {
    const open = Array.from({ length: 8 }, (_, i) => task(`Background job number ${i}`, 20 - i, { kind: "agent" }));
    const out = line({ registry: reg("idle"), open, width: 100 });
    expect(visibleLength(out)).toBeLessThanOrEqual(100);
    expect(out).toMatch(/· \+\d more$/);
    expect(out.startsWith("⏳ waiting on 8 · Background job number 0")).toBe(true);
  });

  it("defaults to 120 columns", () => {
    const open = Array.from({ length: 20 }, (_, i) => task(`Job ${i} with a long description`, 20, { kind: "agent" }));
    expect(visibleLength(line({ registry: reg("idle"), open }))).toBeLessThanOrEqual(120);
  });
});

describe("helpers", () => {
  it("ordinal", () => {
    expect([1, 2, 3, 4, 11, 12, 13, 21, 22, 23, 101].map(ordinal)).toEqual(["1st", "2nd", "3rd", "4th", "11th", "12th", "13th", "21st", "22nd", "23rd", "101st"]);
  });

  it("readRegistry picks the file for this conversation, newest status when several", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "synap-reg-"));
    fs.writeFileSync(path.join(dir, "1.json"), JSON.stringify({ pid: 1, sessionId: "a", status: "idle", statusUpdatedAt: 5 }));
    fs.writeFileSync(path.join(dir, "2.json"), JSON.stringify({ pid: 2, sessionId: "a", status: "busy", statusUpdatedAt: 9 }));
    fs.writeFileSync(path.join(dir, "3.json"), JSON.stringify({ pid: 3, sessionId: "b", status: "waiting", statusUpdatedAt: 99 }));
    fs.writeFileSync(path.join(dir, "3.abc.key"), "not json");
    expect(readRegistry("a", dir)?.status).toBe("busy");
    expect(readRegistry("z", dir)).toBeNull();
    expect(readRegistry("a", path.join(dir, "missing"))).toBeNull();
  });
});
