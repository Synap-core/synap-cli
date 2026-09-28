/**
 * Re-running `synap init` must not reset an agent's approval settings. The
 * pod has no read door for an agent's posture, so the unattended connect uses
 * setup/agent's `alreadyValid`: a NEW agent gets "normal", an agent the pod
 * already knew keeps what the person chose. Driven through the real
 * `writeClaudeCodeEnv` against a stubbed pod, with a throwaway HOME.
 */

import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";

const POD = "https://pod.example.synap.live";
let home: string;
let writeClaudeCodeEnv: typeof import("../src/lib/targets.js").writeClaudeCodeEnv;
let calls: Array<{ method: string; url: string; body?: unknown }>;

function pod(setupAgent: Record<string, unknown>) {
  return vi.fn(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    calls.push({ method, url, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    const json = (b: unknown) => new Response(JSON.stringify(b), { status: 200 });
    if (url.endsWith("/api/hub/users/me")) return json({ id: "human-1" });
    if (url.endsWith("/api/hub/setup/agent")) return json(setupAgent);
    if (url.endsWith("/api/hub/auth/status")) return json({ userId: "agent-1" });
    if (url.endsWith("/api/hub/workspaces/enroll-agent")) return json({ enrolled: [] });
    if (url.includes("/governance")) return json({ ok: true });
    return new Response("not found", { status: 404 });
  });
}

beforeAll(async () => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "synap-gov-"));
  vi.stubEnv("HOME", home);
  ({ writeClaudeCodeEnv } = await import("../src/lib/targets.js"));
  // A key saved by the earlier run, so the re-run can reuse it.
  const { setSurfaceAgentKey } = await import("../src/lib/pod.js");
  setSurfaceAgentKey("claude-code", { hubApiKey: "agent-key-old", agentUserId: "agent-1", podUrl: POD });
});

afterAll(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  fs.rmSync(home, { recursive: true, force: true });
});

beforeEach(() => {
  calls = [];
  vi.spyOn(console, "log").mockImplementation(() => undefined);
});

const governanceCalls = () => calls.filter((c) => c.url.includes("/governance"));

describe("unattended connect and the agent's approval settings", () => {
  it("a NEW agent gets 'normal' (creates and edits instant)", async () => {
    vi.stubGlobal("fetch", pod({ hubApiKey: "agent-key-new", agentUserId: "agent-1" }));
    await writeClaudeCodeEnv({ podUrl: POD, apiKey: "human-key", unattended: true }, { writeMcp: false });
    const gov = governanceCalls();
    expect(gov).toHaveLength(1);
    expect(gov[0]!.method).toBe("PATCH");
    expect(gov[0]!.url).toBe(`${POD}/api/hub/agent-users/agent-1/governance`);
    expect((gov[0]!.body as { autoApproveFor: string[] }).autoApproveFor).toContain("entity.update");
  });

  it("an agent the pod already knew keeps its settings: no governance write on re-run", async () => {
    vi.stubGlobal("fetch", pod({ alreadyValid: true, agentUserId: "agent-1" }));
    await writeClaudeCodeEnv({ podUrl: POD, apiKey: "human-key", unattended: true }, { writeMcp: false });
    expect(calls.some((c) => c.url.endsWith("/api/hub/setup/agent"))).toBe(true);
    expect(governanceCalls()).toEqual([]);
  });
});
