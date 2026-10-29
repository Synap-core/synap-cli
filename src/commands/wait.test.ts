/**
 * `synap wait`: the probe mappers from fixture devbox / gh JSON (shapes
 * captured on 2026-10-29 from `devbox-status.py --name`, `gh pr view --json
 * state,isDraft,statusCheckRollup` and `gh run view --json
 * status,conclusion,name,jobs`), and the poll loop with an injected probe and
 * clock. No network, no ssh, no gh.
 */

import fs from "node:fs";
import { describe, it, expect, beforeEach } from "vitest";
import {
  mapDevbox,
  mapPrChecks,
  mapPrMerged,
  mapRun,
  parsePrRef,
  parseRunRef,
  waitLoop,
  type DevboxDetail,
  type ProbeResult,
} from "./wait.js";
import { readWaits, waitsDir, writeWait, type WaitRecord } from "../lib/wait-state.js";

const START = Date.parse("2026-10-29T12:00:00Z");
const at = (m: number) => new Date(START + m * 60_000).toISOString();
const GRACE = 120_000;

// ── devbox ─────────────────────────────────────────────────────────────

const gate = (id: string, status: string, extra: Record<string, unknown> = {}) => ({ id, status, exit: status === "green" ? 0 : 1, ...extra });

describe("mapDevbox", () => {
  it("queued: its place and lane", () => {
    const d: DevboxDetail = { status: "queued", gates: [], job: { state: "queued", position: 2, queue: "light", gates: ["relay-file", "src/a.test.ts"] } };
    expect(mapDevbox(d, START, GRACE)).toEqual({ state: "queued", detail: "queued 2nd (light)" });
  });

  it("queued, waiting for disk", () => {
    const d: DevboxDetail = { status: "queued", job: { state: "queued", position: 1, queue: "heavy", waiting_for: "disk", disk_wait: { since: at(-5), free_gb: 12, min_gb: 15 } } };
    expect(mapDevbox(d, START, GRACE)).toEqual({ state: "queued", detail: "waiting for disk" });
  });

  it("running: the current gate and gates done n/m (paths after a *-file gate are not gates)", () => {
    const d: DevboxDetail = {
      status: "running",
      started: at(1),
      gates: [gate("be-jobs-tsc", "green")],
      job: { state: "running", gates: ["be-jobs-tsc", "be-file", "packages/api/src/x.test.ts"], activity: "node (vitest 2)" },
    };
    expect(mapDevbox(d, START, GRACE)).toEqual({ state: "running", detail: "be-file · 1/2 done" });
  });

  it("running: a gate that expands (app-tsc → app-tsc-headless…) counts as done once its parts are", () => {
    const d: DevboxDetail = {
      status: "running",
      gates: [gate("app-tsc-headless", "green"), gate("app-tsc-hooks", "green"), gate("app-tsc-web", "green")],
      job: { state: "running", gates: ["app-tsc", "app-file", "packages/web/src/x"], activity: "node (vitest 2)" },
    };
    expect(mapDevbox(d, START, GRACE)).toEqual({ state: "running", detail: "app-file · 3 done" });
  });

  it("running, a red gate already: says so", () => {
    const d: DevboxDetail = {
      status: "running",
      gates: [gate("be-file", "red", { tests_failed: 3 })],
      job: { state: "running", gates: ["be-file", "be-touched"] },
    };
    expect(mapDevbox(d, START, GRACE).detail).toBe("be-touched · 1/2 done · red so far: be-file (3 tests)");
  });

  it("passed: a green run that finished after the wait started → exit 0", () => {
    const d: DevboxDetail = { status: "green", started: at(1), done: at(9), gates: [gate("be-file", "green"), gate("be-touched", "green")], job: null };
    expect(mapDevbox(d, START, GRACE)).toEqual({ state: "passed", detail: "2 gates green", exitCode: 0 });
  });

  it("failed: the red gates and their failed tests → exit 1", () => {
    const d: DevboxDetail = {
      status: "red",
      done: at(9),
      gates: [gate("app-tsc-web", "green"), gate("app-file", "red", { tests_failed: 2 }), gate("app-check:hex", "red-uncounted"), gate("be-types", "red", { ts_errors: 4 })],
    };
    expect(mapDevbox(d, START, GRACE)).toEqual({
      state: "failed",
      detail: "red: app-file (2 tests), app-check:hex, be-types (4 ts errors)",
      exitCode: 1,
    });
  });

  it("infra, NOT-RUN, died, refused → exit 3", () => {
    expect(mapDevbox({ status: "infra", done: at(3), infra: "NOT-RUN (disk): 9 GB free < 15" }, START, GRACE)).toEqual({
      state: "infra",
      detail: "NOT-RUN (disk): 9 GB free < 15",
      exitCode: 3,
    });
    expect(mapDevbox({ status: "died", started: at(1), mtime: at(4), gates: [] }, START, GRACE)).toMatchObject({ state: "infra", exitCode: 3 });
    expect(mapDevbox({ status: "refused", mtime: at(0), refused: "a full suite in a lane" }, START, GRACE)).toEqual({
      state: "infra",
      detail: "refused: a full suite in a lane",
      exitCode: 3,
    });
  });

  it("a run that finished BEFORE the wait started is the previous run: keep waiting", () => {
    const d: DevboxDetail = { status: "red", started: at(-40), done: at(-30), gates: [gate("be-file", "red")] };
    expect(mapDevbox(d, START, GRACE)).toEqual({ state: "pending", detail: "not on the devbox yet (last run red at " + hhmm(at(-30)) + ")" });
  });

  it("…but one that finished within the grace window counts (a fast-path job that beat the wait)", () => {
    const d: DevboxDetail = { status: "green", done: new Date(START - 60_000).toISOString(), gates: [gate("be-file", "green")] };
    expect(mapDevbox(d, START, GRACE).exitCode).toBe(0);
    expect(mapDevbox(d, START, 0).state).toBe("pending");
  });

  it("an unknown name is pending", () => {
    expect(mapDevbox({ status: "unknown", gates: [] }, START, GRACE)).toEqual({ state: "pending", detail: "not on the devbox yet" });
  });
});

function hhmm(iso: string): string {
  const d = new Date(iso);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

// ── gh ─────────────────────────────────────────────────────────────────

const check = (name: string, status: string, conclusion = "", startedAt = at(0)) => ({ __typename: "CheckRun", name, status, conclusion, startedAt, workflowName: "CI" });

describe("mapPrChecks", () => {
  it("running: the running check and n/m done", () => {
    const pr = { state: "OPEN", statusCheckRollup: [check("Preflight", "COMPLETED", "SUCCESS"), check("Release gate", "IN_PROGRESS"), check("API e2e", "COMPLETED", "SKIPPED"), check("Full suite", "QUEUED")] };
    expect(mapPrChecks(pr, null)).toEqual({ state: "running", detail: "Release gate running · 2/4 done" });
  });

  it("--checks: only those, and one not reported yet is still waited for", () => {
    const pr = { statusCheckRollup: [check("Release gate", "COMPLETED", "SUCCESS"), check("Other", "IN_PROGRESS")] };
    expect(mapPrChecks(pr, ["Release gate", "Full suite"])).toEqual({ state: "queued", detail: "1 queued · 1/2 done" });
  });

  it("all completed, success / skipped / neutral → exit 0", () => {
    const pr = { statusCheckRollup: [check("A", "COMPLETED", "SUCCESS"), check("B", "COMPLETED", "SKIPPED"), check("C", "COMPLETED", "NEUTRAL")] };
    expect(mapPrChecks(pr, null)).toEqual({ state: "passed", detail: "3 checks green", exitCode: 0 });
  });

  it("any failure (or cancel) → exit 1, named", () => {
    const pr = { statusCheckRollup: [check("A", "COMPLETED", "SUCCESS"), check("Full suite", "COMPLETED", "FAILURE"), check("E2E", "COMPLETED", "CANCELLED")] };
    expect(mapPrChecks(pr, null)).toEqual({ state: "failed", detail: "failed: Full suite (failure), E2E (cancelled)", exitCode: 1 });
  });

  it("a re-run replaces the older run of the same check", () => {
    const pr = { statusCheckRollup: [check("A", "COMPLETED", "FAILURE", at(0)), check("A", "IN_PROGRESS", "", at(5))] };
    expect(mapPrChecks(pr, null)).toEqual({ state: "running", detail: "A running · 0/1 done" });
  });

  it("a legacy status context counts too", () => {
    const pr = { statusCheckRollup: [{ __typename: "StatusContext", context: "ci/legacy", state: "PENDING" }] };
    expect(mapPrChecks(pr, null)).toEqual({ state: "queued", detail: "1 queued · 0/1 done" });
  });

  it("no checks yet is pending", () => {
    expect(mapPrChecks({ statusCheckRollup: [] }, null)).toEqual({ state: "pending", detail: "no checks reported yet" });
  });
});

describe("mapPrMerged and mapRun", () => {
  it("merged → 0, closed unmerged → 1, open keeps waiting", () => {
    expect(mapPrMerged({ state: "MERGED" })).toMatchObject({ state: "passed", exitCode: 0 });
    expect(mapPrMerged({ state: "CLOSED" })).toMatchObject({ state: "failed", exitCode: 1 });
    expect(mapPrMerged({ state: "OPEN", isDraft: true })).toEqual({ state: "queued", detail: "open (draft)" });
  });

  it("a run: queued, running, passed, failed", () => {
    expect(mapRun({ status: "queued", jobs: [] })).toEqual({ state: "queued", detail: "queued" });
    expect(
      mapRun({ status: "in_progress", jobs: [{ name: "Preflight", status: "completed", conclusion: "success" }, { name: "Full suite (shard 1/4)", status: "in_progress", conclusion: "" }] })
    ).toEqual({ state: "running", detail: "Full suite (shard 1/4) running · 1/2 jobs done" });
    expect(mapRun({ status: "completed", conclusion: "success", name: "CI" })).toEqual({ state: "passed", detail: "CI success", exitCode: 0 });
    expect(mapRun({ status: "completed", conclusion: "failure", jobs: [{ name: "Lint", status: "completed", conclusion: "failure" }, { name: "Build", status: "completed", conclusion: "success" }] })).toEqual({
      state: "failed",
      detail: "failure: Lint",
      exitCode: 1,
    });
  });
});

describe("targets", () => {
  it("a bare repo means Synap-core/<repo>", () => {
    expect(parsePrRef("backend#412")).toEqual({ repo: "Synap-core/backend", number: 412 });
    expect(parsePrRef("acme/web#7")).toEqual({ repo: "acme/web", number: 7 });
    expect(parsePrRef("https://github.com/Synap-core/synap-cli/pull/42")).toEqual({ repo: "Synap-core/synap-cli", number: 42 });
    expect(parsePrRef("backend")).toBeNull();
  });

  it("a run URL or an id", () => {
    expect(parseRunRef("https://github.com/Synap-core/backend/actions/runs/40872525519")).toEqual({ repo: "Synap-core/backend", id: "40872525519" });
    expect(parseRunRef("40872525519", "backend")).toEqual({ repo: "Synap-core/backend", id: "40872525519" });
    expect(parseRunRef("40872525519")).toEqual({ repo: undefined, id: "40872525519" });
    expect(parseRunRef("main")).toBeNull();
  });
});

// ── the loop ───────────────────────────────────────────────────────────

function clock(startMs: number) {
  let t = startMs;
  return { now: () => t, sleep: async (ms: number) => void (t += ms) };
}

function scripted(results: Array<ProbeResult | Error>) {
  let i = 0;
  return async () => {
    const r = results[Math.min(i++, results.length - 1)];
    if (r instanceof Error) throw r;
    return r;
  };
}

describe("waitLoop", () => {
  beforeEach(() => {
    fs.rmSync(waitsDir("conv-1"), { recursive: true, force: true });
  });

  it("prints one line per state change and a summary, and leaves a final state file", async () => {
    const c = clock(START);
    const lines: string[] = [];
    const code = await waitLoop({
      kind: "devbox",
      ref: "w7-regen",
      intervalMs: 30_000,
      timeoutMs: 3_600_000,
      sessionId: "conv-1",
      now: c.now,
      sleep: c.sleep,
      print: (l) => lines.push(l.replace(/^\d\d:\d\d /, "")),
      probe: scripted([
        { state: "queued", detail: "queued 2nd (light)" },
        { state: "queued", detail: "queued 2nd (light)" },
        { state: "running", detail: "tsc · 0/2 done" },
        { state: "passed", detail: "2 gates green", exitCode: 0 },
      ]),
    });
    expect(code).toBe(0);
    expect(lines).toEqual([
      "devbox w7-regen: queued 2nd (light)",
      "devbox w7-regen: queued 2nd (light) → running (tsc · 0/2 done)",
      "devbox w7-regen: running (tsc · 0/2 done) → passed (2 gates green)",
      "devbox w7-regen: passed after 2 min · 2 gates green · exit 0",
    ]);
    const [rec] = readWaits("conv-1");
    expect(rec).toMatchObject({ kind: "devbox", ref: "w7-regen", state: "passed", exitCode: 0, attempt: 1, probeErrors: 0, pid: process.pid });
    expect(rec.finishedAt).toBe(START + 90_000);
    expect(rec.changedAt).toBe(START + 90_000);
  });

  it("3 failed probes in a row → error, it keeps polling, and a timeout on error exits 3", async () => {
    const c = clock(START);
    const code = await waitLoop({
      kind: "pr",
      ref: "Synap-core/backend#412",
      intervalMs: 60_000,
      timeoutMs: 10 * 60_000,
      sessionId: "conv-1",
      now: c.now,
      sleep: c.sleep,
      print: () => {},
      probe: scripted([new Error("gh: HTTP 502")]),
    });
    expect(code).toBe(3);
    const [rec] = readWaits("conv-1");
    expect(rec.state).toBe("error");
    expect(rec.detail).toBe("probe failed 3× in a row: gh: HTTP 502");
    expect(rec.probeErrors).toBeGreaterThan(3);
  });

  it("a probe that recovers clears the error count", async () => {
    const c = clock(START);
    const code = await waitLoop({
      kind: "run",
      ref: ". run 1",
      intervalMs: 60_000,
      timeoutMs: 3_600_000,
      sessionId: "conv-1",
      now: c.now,
      sleep: c.sleep,
      print: () => {},
      probe: scripted([new Error("x"), new Error("x"), { state: "passed", detail: "CI success", exitCode: 0 }]),
    });
    expect(code).toBe(0);
    expect(readWaits("conv-1")[0]).toMatchObject({ state: "passed", probeErrors: 0 });
  });

  it("the timeout exits 2 with state timeout", async () => {
    const c = clock(START);
    const lines: string[] = [];
    const code = await waitLoop({
      kind: "devbox",
      ref: "slow",
      intervalMs: 30_000,
      timeoutMs: 2 * 60_000,
      sessionId: "conv-1",
      now: c.now,
      sleep: c.sleep,
      print: (l) => lines.push(l),
      probe: scripted([{ state: "queued", detail: "queued 9th (heavy)" }]),
    });
    expect(code).toBe(2);
    expect(readWaits("conv-1")[0]).toMatchObject({ state: "timeout", exitCode: 2, detail: "gave up after 2 min at queued 9th (heavy)" });
    expect(lines.at(-1)).toMatch(/timeout \(gave up after 2 min at queued 9th \(heavy\)\) · exit 2$/);
  });

  it("attempt counts the earlier waits on the same target in this conversation; finished ones older than 24 h are pruned", async () => {
    const base: WaitRecord = {
      id: "old",
      kind: "devbox",
      ref: "w7-regen",
      label: "",
      pid: 1,
      startedAt: START - 60_000,
      probedAt: START - 60_000,
      changedAt: START - 60_000,
      state: "failed",
      detail: "",
      attempt: 1,
      probeErrors: 0,
      exitCode: 1,
      finishedAt: START - 30_000,
    };
    writeWait("conv-1", base);
    writeWait("conv-1", { ...base, id: "old2", attempt: 2 });
    writeWait("conv-1", { ...base, id: "other", ref: "another-job" });
    writeWait("conv-1", { ...base, id: "ancient", finishedAt: START - 25 * 3_600_000 });
    const c = clock(START);
    const lines: string[] = [];
    await waitLoop({
      kind: "devbox",
      ref: "w7-regen",
      intervalMs: 30_000,
      timeoutMs: 3_600_000,
      sessionId: "conv-1",
      now: c.now,
      sleep: c.sleep,
      print: (l) => lines.push(l),
      probe: scripted([{ state: "passed", detail: "ok", exitCode: 0 }]),
    });
    const recs = readWaits("conv-1");
    expect(recs.map((r) => r.id).sort()).not.toContain("ancient");
    const mine = recs.find((r) => !["old", "old2", "other"].includes(r.id))!;
    expect(mine.attempt).toBe(3);
    expect(lines[0]).toMatch(/3rd wait on this target/);
  });

  it("a wait with no Claude session writes under _nosession", async () => {
    const c = clock(START);
    await waitLoop({ kind: "devbox", ref: "x", intervalMs: 1000, timeoutMs: 60_000, sessionId: undefined, now: c.now, sleep: c.sleep, print: () => {}, probe: scripted([{ state: "passed", detail: "", exitCode: 0 }]) });
    expect(waitsDir(undefined).endsWith("/_nosession")).toBe(true);
    expect(readWaits(undefined).length).toBeGreaterThan(0);
  });
});
