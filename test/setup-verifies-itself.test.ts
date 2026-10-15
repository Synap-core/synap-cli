/**
 * A setup command's success line comes from CHECKING the result, never from
 * having written it (founder-agreed, 2026-10-15 — the devbox printed
 * "✓ Claude Code connected" over a key the pod held as awaiting approval).
 *
 * Driven through the real doors that print "<Agent> connected" — the batch
 * door `synap init` / `agents add` / device-connect use (`connectAgentsBatch`)
 * and the single-target door `synap connect` uses (`connectKnownAgent`) — down
 * to the real read-back (`confirmSurfaceKey` → the doctor's `checkKeyHealth`).
 * Only the installer (which writes the key the way every installer does, with
 * `setSurfaceAgentKey`), the approval step and the pod (`fetch`) are faked.
 * No real pod, no browser, a throwaway HOME (test/setup).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const POD = "https://pod.verify.example.test";
const KEY = (target: string) => `fake-${target}-key`;

/** The pod's answer per agent key; anything not listed is unknown to it. */
let podSays: Record<string, Record<string, unknown>> = {};
const asked: string[] = [];

vi.mock("../src/lib/targets.js", async (importOriginal) => {
  const real = await importOriginal<typeof import("../src/lib/targets.js")>();
  const { setSurfaceAgentKey } = await import("../src/lib/pod.js");
  return {
    ...real,
    // What every installer does with its key: store it for this pod. Returns
    // "installed" — the success the door must NOT take at its word.
    installForTarget: vi.fn(async (target: string, cfg: { podUrl: string }) => {
      setSurfaceAgentKey(target as never, { hubApiKey: KEY(target), agentUserId: `agent-${target}`, podUrl: cfg.podUrl });
      return true;
    }),
  };
});

vi.mock("../src/lib/batch-approval.js", async (importOriginal) => {
  const real = await importOriginal<typeof import("../src/lib/batch-approval.js")>();
  return { ...real, approveAgentKeysAtOnce: vi.fn(async () => ({ notApproved: [], reasons: {} })) };
});

vi.mock("../src/lib/pod.js", async (importOriginal) => {
  const real = await importOriginal<typeof import("../src/lib/pod.js")>();
  return { ...real, checkPodHealth: async () => ({ healthy: true }) };
});

const { connectAgentsBatch, connectKnownAgent } = await import("../src/lib/agent-door.js");
const { confirmSurfaceKey } = await import("../src/lib/key-doctor.js");

let lines: string[] = [];
const text = () => lines.join("\n");

beforeEach(() => {
  fs.rmSync(path.join(os.homedir(), ".synap"), { recursive: true, force: true });
  podSays = {};
  asked.length = 0;
  lines = [];
  const capture = (...a: unknown[]) => void lines.push(a.map(String).join(" "));
  vi.spyOn(console, "log").mockImplementation(capture);
  vi.spyOn(console, "error").mockImplementation(capture);
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      const u = new URL(String(url));
      if (u.origin !== POD || u.pathname !== "/api/hub/auth/key-state") throw new TypeError(`unexpected call ${url}`);
      const key = String((init?.headers as Record<string, string>)?.Authorization ?? "").replace(/^Bearer /, "");
      asked.push(key);
      const body = podSays[key] ?? { state: "unknown" };
      return new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
    })
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const awaiting = { state: "awaiting_approval", approvalUrl: "https://pod-admin.verify.example.test/approve-agent/k1", createdAt: "2026-10-15T09:00:00Z" };

describe("init / agents add: the batch door", () => {
  it("an install whose key the pod holds as awaiting approval is NOT connected; an active one is", async () => {
    podSays[KEY("codex")] = awaiting;
    podSays[KEY("cursor")] = { state: "active" };

    const r = await connectAgentsBatch({ podUrl: POD, apiKey: "fake-human-key" }, ["codex", "cursor"], {});

    expect(r).toEqual({ connected: ["cursor"], notApproved: [], failed: ["codex"] });
    // The pod was asked about the key each install WROTE — and only those.
    expect(asked.sort()).toEqual([KEY("codex"), KEY("cursor")]);
    expect(text()).toContain("✓ Cursor connected");
    expect(text()).not.toContain("Codex connected");
    // The doctor's own diagnosis, then its command.
    expect(text()).toContain("OpenAI Codex is waiting for your approval — not connected.");
    expect(text()).toContain("→ synap doctor --fix");
    // Never the key itself.
    expect(text()).not.toContain(KEY("codex"));
  });

  it("a key the pod could not be asked about is not claimed connected either", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("down", { status: 503 })));
    const r = await connectAgentsBatch({ podUrl: POD, apiKey: "fake-human-key" }, ["cursor"], {});
    expect(r.connected).toEqual([]);
    expect(r.failed).toEqual(["cursor"]);
    expect(text()).toContain("Cursor: could not check the key — not connected.");
  });
});

describe("synap connect --target: the single-target door", () => {
  it("awaiting approval → no 'connected' line, and the command fails", async () => {
    podSays[KEY("codex")] = awaiting;
    const ok = await connectKnownAgent("codex", { podUrl: POD, apiKey: "fake-human-key" }, {});
    expect(ok).toBe(false);
    expect(text()).not.toMatch(/Codex connected/);
    expect(text()).toContain("OpenAI Codex is waiting for your approval — not connected.");
  });

  it("active → connected, named with its pod", async () => {
    podSays[KEY("codex")] = { state: "active" };
    const ok = await connectKnownAgent("codex", { podUrl: POD, apiKey: "fake-human-key" }, {});
    expect(ok).toBe(true);
    expect(text()).toContain(`✓ OpenAI Codex connected to ${POD}`);
  });
});

describe("confirmSurfaceKey", () => {
  it("a target that keeps no key the CLI can read back is 'unchecked', with the target's own reason — never 'active'", async () => {
    expect(await confirmSurfaceKey(POD, "chatgpt-oauth")).toEqual({
      verdict: "unchecked",
      reason: "OAuth through the control plane — no key",
    });
    expect(asked).toEqual([]);
  });

  it("a target whose key should be in a file, but none is there, is not active", async () => {
    const r = await confirmSurfaceKey(POD, "cursor");
    expect(r.verdict).toBe("not-active");
  });

  it("only the asked surface's keys go to the pod — not the person's key or another agent's", async () => {
    const { setSurfaceAgentKey, addPodProfile } = await import("../src/lib/pod.js");
    addPodProfile("verify", { podUrl: POD, hubApiKey: "fake-person-key", workspaceId: "", agentUserId: "", savedAt: "" } as never);
    setSurfaceAgentKey("codex", { hubApiKey: KEY("codex"), agentUserId: "a", podUrl: POD });
    setSurfaceAgentKey("cursor", { hubApiKey: KEY("cursor"), agentUserId: "b", podUrl: POD });
    podSays[KEY("cursor")] = { state: "active" };
    expect(await confirmSurfaceKey(POD, "cursor")).toEqual({ verdict: "active" });
    expect(asked).toEqual([KEY("cursor")]);
  });
});
