/**
 * The bridge's status file as the status line reads it: judged (fresh /
 * absent / unbound / stale / failed) and drawn. Files go under a temp HOME
 * passed as `home`; time, registry and width are arguments.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, beforeEach } from "vitest";
import {
  BRIDGE_STATUS_MAX_AGE_MS,
  bridgeStatusPath,
  buildBridgeLine,
  readBridgeStatus,
  type BridgeStatusFile,
} from "./bridge-status.js";
import type { RegistryEntry } from "./now-line.js";

const NOW = Date.parse("2026-10-30T22:00:00Z");
const min = (m: number) => NOW - m * 60_000;
const iso = (ms: number) => new Date(ms).toISOString();
// eslint-disable-next-line no-control-regex
const plain = (s: string) => s.replace(/\x1b\[[0-9;]*m|\x1b\]8;;[^\x1b]*\x1b\\/g, "");
const CONV = "11111111-2222-3333-4444-555555555555";

/** A file as the bridge's `statusFile` writes it (synap-bridge hooks/lib.ts). */
const file = (over: Partial<BridgeStatusFile> = {}): BridgeStatusFile => ({
  v: 1,
  writtenAt: iso(min(1)),
  sessionId: "54436c32-783f-4a9d-9322-16ff18f448f7",
  title: "Lane cli-statusfile",
  live: { state: "idle", turnInFlight: false, since: iso(min(20)), lastActivityAt: iso(min(20)), measuredAt: iso(min(1)), windowMs: 300_000 },
  nextMove: { kind: "agent_slot", actor: "ai", label: 'Produce "Wave 2 report"', reason: "Declared deliverable with no output yet" },
  waitingOn: [],
  workUnits: [],
  ...over,
});
const reg = (status: string, extra: Partial<RegistryEntry> = {}): RegistryEntry => ({
  sessionId: CONV,
  pid: 1,
  status,
  statusUpdatedAt: min(4),
  startedAt: min(600),
  ...extra,
});

let home: string;
beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-status-"));
});
const write = (content: string) => {
  const p = bridgeStatusPath(CONV, home);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content);
};
const read = (opts: { startedAt?: number } = {}) => readBridgeStatus(CONV, { now: NOW, home, ...opts });

describe("reading the file", () => {
  it("is where the bridge writes it", () => {
    expect(bridgeStatusPath(CONV, "/home/x")).toBe(`/home/x/.synap/bridge/status/${CONV}.json`);
  });

  it("a fresh file of a bound session is drawn", () => {
    write(JSON.stringify(file()));
    const r = read({ startedAt: min(600) });
    expect(r.status).toBe("fresh");
    if (r.status === "fresh") expect(r.writtenAt).toBe(min(1));
  });

  it("no file is absent (no bridge, or it has not written yet)", () => {
    expect(read()).toEqual({ status: "absent" });
  });

  it("nothing bound (`sessionId: null`, /bridge unbind) is unbound, not drawn", () => {
    write(JSON.stringify(file({ sessionId: null, title: null })));
    expect(read()).toEqual({ status: "unbound" });
  });

  it("a file written before this Claude Code process started is stale", () => {
    write(JSON.stringify(file({ writtenAt: iso(min(90)) })));
    expect(read({ startedAt: min(60) })).toEqual({ status: "stale", why: "written before this Claude Code process started" });
  });

  it("a file older than the max age is stale, even with no registry", () => {
    write(JSON.stringify(file({ writtenAt: iso(NOW - BRIDGE_STATUS_MAX_AGE_MS - 60_000) })));
    expect(read()).toMatchObject({ status: "stale" });
  });

  it("a quiet file younger than the max age is still fresh", () => {
    write(JSON.stringify(file({ writtenAt: iso(min(45)) })));
    expect(read({ startedAt: min(600) }).status).toBe("fresh");
  });

  it("malformed JSON is a failed read, never absent, and never throws", () => {
    write('{"v":1,"writtenAt":');
    expect(read()).toEqual({ status: "failed", why: "not JSON" });
  });

  it("another version, a missing time or a malformed section is a failed read", () => {
    write(JSON.stringify({ ...file(), v: 2 }));
    expect(read()).toMatchObject({ status: "failed", why: "version 2 is not 1" });
    write(JSON.stringify({ ...file(), writtenAt: "soon" }));
    expect(read()).toMatchObject({ status: "failed", why: "no writtenAt time" });
    write(JSON.stringify({ ...file(), waitingOn: { status: "ok", marks: [] } }));
    expect(read()).toMatchObject({ status: "failed", why: "waitingOn is malformed" });
    write(JSON.stringify({ ...file(), live: { state: "working" } }));
    expect(read()).toMatchObject({ status: "failed", why: "live is malformed" });
    write("[]");
    expect(read()).toMatchObject({ status: "failed", why: "not an object" });
  });

  it("an unreadable file (here a directory) is a failed read", () => {
    fs.mkdirSync(bridgeStatusPath(CONV, home), { recursive: true });
    expect(read()).toMatchObject({ status: "failed", why: expect.stringContaining("unreadable") });
  });

  it("a session id that could leave the directory reads no file", () => {
    expect(readBridgeStatus("../../etc/passwd", { now: NOW, home })).toEqual({ status: "absent" });
  });
});

const line = (f: BridgeStatusFile, registry: RegistryEntry | null = reg("idle"), width?: number) =>
  plain(buildBridgeLine({ now: NOW, file: f, writtenAt: Date.parse(f.writtenAt), registry, width }));

describe("drawing the line", () => {
  it("idle with nothing waited on: stopped, with the pod's next move", () => {
    expect(line(file())).toBe('■ stopped · 4m · next: Produce "Wave 2 report"');
  });

  it("idle and waiting: the pod's marks, in the vocabulary's words, and the open PRs", () => {
    const f = file({
      waitingOn: [
        { reason: "another_work", count: 2, refs: [{ kind: "session", id: "s2" }] },
        { reason: "approval", count: 1 },
      ],
      workUnits: [
        { key: "pr-synap-cli-52", label: "synap-cli#52 feat(statusline): read the bridge file", kind: "pull_request", url: "https://github.com/Synap-core/synap-cli/pull/52", state: "open", prState: { status: "ok", label: "Open", state: "open", checks: "failed" } },
        { key: "pr-backend-9", label: "backend#9 done already", kind: "pull_request", url: "https://github.com/Synap-core/backend/pull/9", state: "met", prState: { status: "ok", label: "Merged", state: "merged" } },
      ],
    });
    expect(line(f)).toBe('⏳ waiting on 3 · other work (2) · approval · synap-cli#52 open ✗ · next: Produce "Wave 2 report"');
  });

  it("working (the registry says busy): the marks follow, the next move does not", () => {
    const f = file({ waitingOn: [{ reason: "input", count: 1 }] });
    expect(line(f, reg("busy", { statusUpdatedAt: min(3) }))).toBe("▶ working · 3m · ⏳ 1 · input");
  });

  it("the registry's permission prompt beats everything", () => {
    expect(line(file(), reg("waiting", { waitingFor: "permission prompt" }))).toBe("✋ needs you · permission prompt");
  });

  it("no registry: the pod's live, re-judged now by its own window", () => {
    const working = file({ live: { state: "working", turnInFlight: false, since: iso(min(2)), lastActivityAt: iso(min(2)), measuredAt: iso(min(1)), windowMs: 300_000 } });
    expect(line(working, null)).toBe("▶ working · 2m");
    // Measured as working, but its last activity is now past the window: idle.
    const lapsed = file({ live: { state: "working", turnInFlight: false, since: iso(min(8)), lastActivityAt: iso(min(8)), measuredAt: iso(min(1)), windowMs: 300_000 } });
    expect(line(lapsed, null)).toBe('■ stopped · 8m · next: Produce "Wave 2 report"');
    expect(line(file({ live: null }), null)).toBe('○ no session status · next: Produce "Wave 2 report"');
  });

  it("a section the pod could not read is said, never drawn as nothing", () => {
    expect(line(file({ waitingOn: null, workUnits: null, nextMove: null }))).toBe("■ stopped · 4m · ⚑ not read: waits, PRs");
  });

  it("a PR whose state the pod could not read is marked; one with nothing recorded is just named", () => {
    const f = file({
      nextMove: null,
      workUnits: [
        { key: "a", label: "backend#7 x", kind: "pull_request", url: "https://github.com/Synap-core/backend/pull/7", state: "open", prState: { status: "unavailable" } },
        { key: "b", label: "relay-app#3 y", kind: "pull_request", url: null, state: "claimed", prState: null },
      ],
    });
    expect(line(f)).toBe("■ stopped · 4m · backend#7 ⚑ not read · relay-app#3");
  });

  it("a quiet file says how old the pod's word is", () => {
    expect(line(file({ writtenAt: iso(min(40)), nextMove: null }))).toBe("■ stopped · 4m · pod 40m ago");
  });

  it("caps itself to the width", () => {
    const f = file({ waitingOn: Array.from({ length: 6 }, (_, i) => ({ reason: `reason_${i}`, count: 1 })) });
    const out = line(f, reg("idle"), 50);
    expect(out.length).toBeLessThanOrEqual(50);
    expect(out).toMatch(/\+\d+ more$/);
  });
});
