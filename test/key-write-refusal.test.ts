/**
 * Never overwrite a working key with a pending one (2026-10-12).
 *
 * Driven through the REAL writers against a stubbed pod, on a temp HOME
 * (test/setup/temp-home.ts):
 *   - `writeClaudeCodeEnv` refuses a key the pod says is awaiting approval and
 *     writes NO file (settings.json, the CLI config) — the incident's writer;
 *   - `provisionAgentKey` refuses to hand out a minted key the pod says is not
 *     live, and on an approval that does not land in time keeps the request
 *     recorded, throws the link + `synap doctor --fix`, and RESUMES that same
 *     request next time instead of filing another;
 *   - every mint carries this computer's `instanceId`;
 *   - the doctor's own rewriter refuses a pending key and touches no file.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const POD = "https://pod.example.test";
const PENDING_STATE = {
  state: "awaiting_approval",
  keyId: "11111111-1111-4111-8111-111111111111",
  approvalUrl: "https://pod-admin.example.test/approve-agent/1111?agentType=claude-code",
};

let home: string;
let calls: Array<{ url: string; body?: any; auth?: string }>;

/** A pod whose key-state door answers from `states` (by bearer). */
function podStub(opts: {
  setupAgent?: (n: number) => Record<string, unknown>;
  states: (key: string, n: number) => Record<string, unknown>;
}) {
  let mints = 0;
  const seen = new Map<string, number>();
  return vi.fn(async (url: string, init?: RequestInit) => {
    const auth = (init?.headers as Record<string, string> | undefined)?.Authorization?.replace(/^Bearer /, "");
    calls.push({ url, body: init?.body ? JSON.parse(String(init.body)) : undefined, auth });
    const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status });
    if (url.endsWith("/api/hub/users/me")) return json({ id: "human-1" });
    if (url.endsWith("/api/hub/setup/agent")) return json(opts.setupAgent!(++mints));
    if (url.endsWith("/api/hub/auth/key-state")) {
      const n = (seen.get(auth!) ?? 0) + 1;
      seen.set(auth!, n);
      return json(opts.states(auth!, n));
    }
    if (url.endsWith("/api/hub/auth/status")) return json({ userId: "agent-1" });
    if (url.includes("/governance")) return json({ posture: null, configured: true });
    if (url.endsWith("/api/hub/workspaces/enroll-agent")) return json({ enrolled: [] });
    return new Response("not found", { status: 404 });
  });
}

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "synap-keywrite-"));
  vi.stubEnv("HOME", home);
  vi.stubEnv("SYNAP_APPROVAL_TIMEOUT_MS", "60");
  vi.stubEnv("SYNAP_APPROVAL_POLL_MS", "10");
  calls = [];
  vi.spyOn(console, "log").mockImplementation(() => undefined);
  vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  vi.resetModules();
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const configJson = () => {
  const f = path.join(home, ".synap", "config.json");
  return fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, "utf8")) : {};
};

describe("writeClaudeCodeEnv refuses a pending key", () => {
  it("a key the pod says is awaiting approval is written NOWHERE", async () => {
    const { presetApprovedKey } = await import("../src/lib/batch-approval.js");
    const { writeClaudeCodeEnv } = await import("../src/lib/targets.js");
    const { KeyNotLiveError } = await import("../src/lib/key-state.js");
    // Handed over as "approved" (device-flow door) — but the pod disagrees.
    presetApprovedKey("claude-code", { hubApiKey: "pending-key", agentUserId: "agent-1" });
    vi.stubGlobal("fetch", podStub({ states: () => PENDING_STATE }));

    await expect(
      writeClaudeCodeEnv({ podUrl: POD, apiKey: "human-key", unattended: true }, { writeMcp: false })
    ).rejects.toBeInstanceOf(KeyNotLiveError);
    // Non-vacuity: the gate really asked the pod about THIS key.
    expect(calls.some((c) => c.url.endsWith("/auth/key-state") && c.auth === "pending-key")).toBe(true);
    expect(fs.existsSync(path.join(home, ".claude", "settings.json"))).toBe(false);
    expect(configJson().agentKeys).toBeUndefined();
    expect(configJson().agentKeysByPod).toBeUndefined();
  });

  it("a live key is written (positive control)", async () => {
    const { presetApprovedKey } = await import("../src/lib/batch-approval.js");
    const { writeClaudeCodeEnv } = await import("../src/lib/targets.js");
    presetApprovedKey("claude-code", { hubApiKey: "live-key", agentUserId: "agent-1" });
    vi.stubGlobal("fetch", podStub({ states: () => ({ state: "active" }) }));
    await writeClaudeCodeEnv({ podUrl: POD, apiKey: "human-key", unattended: true }, { writeMcp: false });
    const settings = JSON.parse(fs.readFileSync(path.join(home, ".claude", "settings.json"), "utf8"));
    expect(settings.env.SYNAP_HUB_API_KEY).toBe("live-key");
    expect(configJson().agentKeysByPod["claude-code"][POD].hubApiKey).toBe("live-key");
  });
});

describe("provisionAgentKey: one request per computer, never a pending key handed out", () => {
  it("every mint carries this computer's instanceId", async () => {
    const { provisionAgentKey } = await import("../src/lib/targets.js");
    const { machineInstanceId, machineInstanceLabel } = await import("../src/lib/machine-instance.js");
    vi.stubGlobal("fetch", podStub({ setupAgent: () => ({ hubApiKey: "k", agentUserId: "agent-1" }), states: () => ({ state: "active" }) }));
    await provisionAgentKey(POD, "human-key", "codex");
    const mint = calls.find((c) => c.url.endsWith("/setup/agent"))!;
    expect(mint.body.instanceId).toBe(machineInstanceId("codex"));
    expect(mint.body.instanceId).toMatch(/^m-[0-9a-f]{16}$/);
    // …and this computer's NAME, so the connection reads "Codex on <computer>".
    expect(mint.body.instanceLabel).toEqual(expect.any(String));
    expect(mint.body.instanceLabel).toBe(machineInstanceLabel());
  });

  it("a minted key the pod says is not live is refused, not returned", async () => {
    const { provisionAgentKey } = await import("../src/lib/targets.js");
    const { KeyNotLiveError } = await import("../src/lib/key-state.js");
    vi.stubGlobal("fetch", podStub({ setupAgent: () => ({ hubApiKey: "k", agentUserId: "agent-1" }), states: () => PENDING_STATE }));
    await expect(provisionAgentKey(POD, "human-key", "codex")).rejects.toBeInstanceOf(KeyNotLiveError);
  });

  it("an approval that does not land in time: request recorded, link + resume command thrown — and the next run RESUMES it", async () => {
    const { provisionAgentKey } = await import("../src/lib/targets.js");
    const { AgentKeyAwaitingApprovalError } = await import("../src/lib/key-approval.js");
    const mint = (n: number) => ({
      hubApiKey: `pending-${n}`,
      agentUserId: "agent-1",
      requiresApproval: true,
      pendingToken: `tok-${n}`,
      reviewUrl: `https://pod-admin.example.test/approve-agent/tok-${n}`,
    });
    let approved = false;
    vi.stubGlobal(
      "fetch",
      podStub({ setupAgent: mint, states: () => (approved ? { state: "active" } : PENDING_STATE) })
    );

    const err = await provisionAgentKey(POD, "human-key", "codex").catch((e) => e);
    expect(err).toBeInstanceOf(AgentKeyAwaitingApprovalError);
    expect(String(err.message)).toContain("https://pod-admin.example.test/approve-agent/tok-1");
    expect(String(err.message)).toContain("synap doctor --fix");
    expect(configJson().pendingAgentKeys.codex[POD]).toMatchObject({ hubApiKey: "pending-1", keyId: "tok-1" });
    expect(configJson().agentKeysByPod).toBeUndefined(); // nothing written as a working key

    // The person approves; the next run resumes THE SAME request.
    approved = true;
    const r = await provisionAgentKey(POD, "human-key", "codex");
    expect(r.hubApiKey).toBe("pending-1");
    expect(calls.filter((c) => c.url.endsWith("/setup/agent"))).toHaveLength(1);
    expect(configJson().pendingAgentKeys.codex).toBeUndefined();
  });
});

describe("the doctor's rewriter refuses a pending key", () => {
  it("rewriteSurfaceKey throws and leaves every file as it was", async () => {
    fs.mkdirSync(path.join(home, ".claude"), { recursive: true });
    const settingsFile = path.join(home, ".claude", "settings.json");
    fs.writeFileSync(settingsFile, JSON.stringify({ env: { SYNAP_HUB_API_KEY: "old" } }));
    const before = fs.readFileSync(settingsFile, "utf8");
    vi.stubGlobal("fetch", podStub({ states: () => PENDING_STATE }));
    const { checkKeyHealth, rewriteSurfaceKey } = await import("../src/lib/key-doctor.js");
    const report = await checkKeyHealth(POD, { home, envKey: undefined, labelOf: (s) => s, instanceIdFor: () => "m-x" });
    await expect(rewriteSurfaceKey(report, "claude-code", "pending-key", "agent-1")).rejects.toThrow(/awaiting approval/);
    expect(fs.readFileSync(settingsFile, "utf8")).toBe(before);
    expect(fs.existsSync(path.join(home, ".synap", "config.json"))).toBe(false);
  });
});
