/**
 * The process key (`X-Synap-Process`) the stdio MCP bridge sends for the
 * Claude Code process it serves (sessions cockpit, plan 3884fadf C2). The
 * synap-bridge mod sends the same key from inside Claude Code; the pod keys a
 * runner row by it, so the two doors must format it byte for byte alike.
 *
 * ONE fixture, the same in synap-bridge (`tests/adapter.test.ts`,
 * PROCESS_FIXTURE): host `devbox`, Claude Code's pid 4242, started
 * Wed Oct 14 17:46:40 2026 UTC -> `devbox:4242:1792000000000`.
 */
import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import {
  claudeCodeProcess,
  lstartMs,
  mcpBridgeHeaders,
  PROCESS_HEADER,
  processIdentity,
} from "./conversation-headers.js";
import { runProcessIdentity } from "../commands/worker.js";

const PROCESS_FIXTURE = { host: "devbox", pid: 4242, lstart: "Wed Oct 14 17:46:40 2026", key: "devbox:4242:1792000000000" };
/** The pod's own check (`parseProcessIdentity`, backend request-write-context.ts). */
const POD_PROCESS_RE = /^([A-Za-z0-9._-]{1,255}):(\d{1,10}):(\d{10,14})$/;
const SID = "8c34a72b-b1c1-4c37-9c1f-02920b69ccb2";

describe("the process key, one format for every door", () => {
  it("formats the shared fixture as synap-bridge does, from ps's UTC text", () => {
    const startedAt = lstartMs(`${PROCESS_FIXTURE.lstart}    \n`);
    expect(startedAt).toBe(1_792_000_000_000);
    expect(processIdentity(PROCESS_FIXTURE.host, PROCESS_FIXTURE.pid, startedAt!)).toBe(PROCESS_FIXTURE.key);
    expect(PROCESS_FIXTURE.key).toMatch(POD_PROCESS_RE);
  });

  it("is the worker's own format: runProcessIdentity goes through it", () => {
    expect(runProcessIdentity(1_792_000_000_000, "devbox", 1)).toBe(processIdentity("devbox", 1, 1_792_000_000_000));
    expect(processIdentity("MacBook Pro (2).local", 7, 1_792_000_000_000.9)).toBe("MacBook-Pro--2-.local:7:1792000000000");
    expect(processIdentity("", 7, 1_792_000_000_000)).toBe("computer:7:1792000000000");
  });

  it("reads ps's padded day; a local, translated or partial text is no time, never a guess", () => {
    expect(lstartMs("Mon Nov  2 13:09:07 2026")).toBe(Date.UTC(2026, 10, 2, 13, 9, 7));
    for (const bad of ["lun.  2 nov 13:09:07 2026", "Nov  2 13:09:07 2026", "Mon Foo  2 13:09:07 2026", "2026-11-02T13:09:07Z", ""]) {
      expect(lstartMs(bad)).toBeUndefined();
    }
  });
});

describe("claudeCodeProcess: the parent the stdio bridge serves", () => {
  it("is the parent's pid and start on this host", () => {
    const asked: number[] = [];
    const key = claudeCodeProcess({
      ppid: PROCESS_FIXTURE.pid,
      hostname: PROCESS_FIXTURE.host,
      startMs: (pid) => (asked.push(pid), lstartMs(PROCESS_FIXTURE.lstart)),
    });
    expect(key).toBe(PROCESS_FIXTURE.key);
    expect(asked).toEqual([PROCESS_FIXTURE.pid]);
  });

  it("is undefined for an orphan or a start ps could not give", () => {
    expect(claudeCodeProcess({ ppid: 1, hostname: "devbox", startMs: () => 1_792_000_000_000 })).toBeUndefined();
    expect(claudeCodeProcess({ ppid: 4242, hostname: "devbox", startMs: () => undefined })).toBeUndefined();
  });

  it("reads the real parent through ps (this test runner's own parent), its start in UTC whatever the zone", () => {
    const key = claudeCodeProcess();
    // A CI sandbox without ps reads undefined, never a made-up key.
    if (key === undefined) return;
    expect(key).toMatch(new RegExp(`^[A-Za-z0-9._-]+:${process.ppid}:\\d{13}$`));
    // An independent reading: now minus ps's elapsed time ([[dd-]hh:]mm:ss), which no time zone moves.
    const etime = execFileSync("ps", ["-o", "etime=", "-p", String(process.ppid)], { encoding: "utf8" }).trim();
    const [days, clock] = etime.includes("-") ? etime.split("-") : ["0", etime];
    const elapsedS = clock!.split(":").map(Number).reduce((acc, n) => acc * 60 + n, 0) + Number(days) * 86_400;
    const startedAt = Number(key.split(":").at(-1));
    expect(Math.abs(startedAt - (Date.now() - elapsedS * 1000))).toBeLessThan(3_000);
  });
});

describe("mcpBridgeHeaders sends the process with a Claude Code conversation only", () => {
  it("adds X-Synap-Process beside the conversation", () => {
    const h = mcpBridgeHeaders(SID, "/x", PROCESS_FIXTURE.key);
    expect(h[PROCESS_HEADER]).toBe(PROCESS_FIXTURE.key);
    expect(h["X-Synap-Conversation"]).toBe(`claude-code:${SID}`);
  });

  it("sends none without a process, or outside Claude Code", () => {
    expect(PROCESS_HEADER in mcpBridgeHeaders(SID, "/x")).toBe(false);
    expect(PROCESS_HEADER in mcpBridgeHeaders(undefined, "/x", PROCESS_FIXTURE.key)).toBe(false);
  });
});
