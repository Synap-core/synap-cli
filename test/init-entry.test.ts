/**
 * `synap init` entry (V1 W1a): agent detection, the no-pod create path, the
 * phone pairing link, and the first-task hand-off.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { detectAgents } from "../src/lib/agent-detect.js";
import { buildPairLink, renderTerminalQr, PAIR_LINK_VERSION } from "../src/lib/pair-link.js";
import { createPodInBrowser } from "../src/lib/init-pod.js";
import { buildHandoff } from "../src/lib/init-handoff.js";

describe("detectAgents", () => {
  let home: string;
  let bin: string;

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), "synap-home-"));
    bin = fs.mkdtempSync(path.join(os.tmpdir(), "synap-bin-"));
  });
  afterEach(() => {
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(bin, { recursive: true, force: true });
  });

  const run = (openClaw = false) =>
    detectAgents({ home, pathEnv: bin, platform: "linux", openClawFound: () => openClaw });
  const found = (rows: ReturnType<typeof run>) => rows.filter((r) => r.found).map((r) => r.target);

  it("lists the four connectable agents, OpenClaw as one row, and finds none on a bare machine", () => {
    const rows = run();
    expect(rows.map((r) => r.target)).toEqual(["claude-code", "codex", "cursor", "openclaw"]);
    expect(found(rows)).toEqual([]);
  });

  it("finds Claude Code from ~/.claude.json", () => {
    fs.writeFileSync(path.join(home, ".claude.json"), "{}");
    const row = run().find((r) => r.target === "claude-code")!;
    expect(row).toMatchObject({ found: true, label: "Claude Code", evidence: "~/.claude.json" });
  });

  it("finds Codex from ~/.codex and Cursor from ~/.cursor", () => {
    fs.mkdirSync(path.join(home, ".codex"));
    fs.mkdirSync(path.join(home, ".cursor"));
    expect(found(run())).toEqual(["codex", "cursor"]);
  });

  it("finds an agent from its binary on PATH alone", () => {
    fs.writeFileSync(path.join(bin, "codex"), "#!/bin/sh\n", { mode: 0o755 });
    const row = run().find((r) => r.target === "codex")!;
    expect(row).toMatchObject({ found: true, evidence: "codex on PATH" });
  });

  it("does not count a directory named like the binary", () => {
    fs.mkdirSync(path.join(bin, "claude"));
    expect(found(run())).toEqual([]);
  });

  it("takes OpenClaw's own detector for its row", () => {
    expect(found(run(true))).toEqual(["openclaw"]);
  });
});

describe("buildPairLink", () => {
  it("encodes the pod origin as the only required field", () => {
    const r = buildPairLink({ podUrl: "https://pod.alice.synap.live/" });
    expect(r).toEqual({
      ok: true,
      link: `synap://pair?v=${PAIR_LINK_VERSION}&pod=https%3A%2F%2Fpod.alice.synap.live`,
    });
  });

  it("parses back to host 'pair' with pod + v (the shape relay's deep-link handler reads)", () => {
    const r = buildPairLink({ podUrl: "https://pod.example.com", token: "t-123" });
    if (!r.ok) throw new Error("expected ok");
    const u = new URL(r.link);
    expect(u.protocol).toBe("synap:");
    expect(`${u.host}${u.pathname}`.replace(/^\/+|\/+$/g, "")).toBe("pair");
    expect(Object.fromEntries(u.searchParams)).toEqual({ v: "1", pod: "https://pod.example.com", token: "t-123" });
  });

  it("omits token when none is given (no pairing-token door exists yet)", () => {
    const r = buildPairLink({ podUrl: "https://pod.example.com" });
    if (!r.ok) throw new Error("expected ok");
    expect(new URL(r.link).searchParams.has("token")).toBe(false);
  });

  it("refuses a pod a phone cannot reach", () => {
    for (const podUrl of ["http://localhost:4000", "http://127.0.0.1", "http://[::1]:4000", "http://app.localhost"]) {
      expect(buildPairLink({ podUrl })).toEqual({ ok: false, reason: "loopback" });
    }
  });

  it("refuses a non-URL and a non-http scheme", () => {
    expect(buildPairLink({ podUrl: "pod.example.com" })).toEqual({ ok: false, reason: "invalid-url" });
    expect(buildPairLink({ podUrl: "ftp://pod.example.com" })).toEqual({ ok: false, reason: "invalid-url" });
  });

  it("renders a terminal QR", async () => {
    const qr = await renderTerminalQr("synap://pair?v=1&pod=https%3A%2F%2Fpod.example.com");
    expect(qr.split("\n").length).toBeGreaterThan(10);
  });
});

describe("createPodInBrowser (no pod → create, never exit)", () => {
  function clock() {
    let t = 0;
    return { now: () => t, sleep: async (ms: number) => void (t += ms) };
  }

  it("waits for the new pod to answer, then continues", async () => {
    const c = clock();
    const health = [false, false, true];
    const checked: string[] = [];
    const r = await createPodInBrowser(
      {
        waitForPodCallback: async () => ({ podUrl: "https://pod.new.synap.live" }),
        checkPodHealth: async (u) => (checked.push(u), { healthy: health.shift() ?? false }),
        ...c,
      },
      { intervalMs: 5_000, timeoutMs: 60_000 }
    );
    expect(r).toEqual({ ok: true, podUrl: "https://pod.new.synap.live" });
    expect(checked).toHaveLength(3);
  });

  it("says 'still starting' — not failure — when the pod exists but doesn't answer in time", async () => {
    const c = clock();
    const r = await createPodInBrowser(
      {
        waitForPodCallback: async () => ({ podUrl: "https://pod.slow.synap.live" }),
        checkPodHealth: async () => ({ healthy: false }),
        ...c,
      },
      { intervalMs: 5_000, timeoutMs: 20_000 }
    );
    expect(r).toEqual({ ok: false, reason: "not-reachable", podUrl: "https://pod.slow.synap.live" });
    expect(c.now()).toBe(20_000);
  });

  it("reports cancelled when the browser never calls back", async () => {
    let probed = false;
    const r = await createPodInBrowser({
      waitForPodCallback: async () => null,
      checkPodHealth: async () => ((probed = true), { healthy: true }),
    });
    expect(r).toEqual({ ok: false, reason: "cancelled" });
    expect(probed).toBe(false);
  });
});

describe("buildHandoff", () => {
  it("names the first connected agent and gives a task that ends in a question", () => {
    const h = buildHandoff(["Claude Code", "Codex"]);
    expect(h.agentLabel).toBe("Claude Code");
    expect(h.prompt).toMatch(/^Use Synap\./);
    expect(h.prompt).toMatch(/ask me/);
    expect(h.more).toHaveLength(2);
  });

  it("falls back to 'your agent' when none was connected", () => {
    expect(buildHandoff([]).agentLabel).toBe("your agent");
  });
});
