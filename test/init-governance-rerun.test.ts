/**
 * `synap init` must never write an agent's approval settings: a new agent
 * follows the pod default ("reversible writes act", founder 2026-09-28) and a
 * configured one keeps its choice on re-run. Driven through the real
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

function pod(
  setupAgent: Record<string, unknown>,
  governance: Record<string, unknown> | "missing" = {
    posture: null,
    configured: false,
  }
) {
  return vi.fn(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    calls.push({ method, url, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    const json = (b: unknown) => new Response(JSON.stringify(b), { status: 200 });
    if (url.endsWith("/api/hub/users/me")) return json({ id: "human-1" });
    if (url.endsWith("/api/hub/setup/agent")) return json(setupAgent);
    if (url.endsWith("/api/hub/auth/status")) return json({ userId: "agent-1" });
    if (url.endsWith("/api/hub/workspaces/enroll-agent")) return json({ enrolled: [] });
    if (url.includes("/governance") && method === "GET")
      return governance === "missing"
        ? new Response("not found", { status: 404 })
        : json(governance);
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
const governanceWrites = () => governanceCalls().filter((c) => c.method === "PATCH");

describe("unattended connect and the agent's approval settings", () => {
  // `synap init` never writes an agent's governance: a new agent follows the
  // POD default ("reversible writes act", founder 2026-09-28) and a configured
  // one keeps whatever someone chose. One case per shape the pod can answer.
  for (const [name, setup, governance] of [
    ["an agent nobody configured", { hubApiKey: "agent-key-new", agentUserId: "agent-1" }, { posture: null, configured: false }],
    ["a configured agent on re-run", { alreadyValid: true, agentUserId: "agent-1" }, { posture: null, configured: true }],
    ["a new agent on a pod without the read door", { hubApiKey: "agent-key-new", agentUserId: "agent-1" }, "missing"],
    ["a known agent on a pod without the read door", { alreadyValid: true, agentUserId: "agent-1" }, "missing"],
  ] as const) {
    it(`${name}: no governance write, the pod default applies`, async () => {
      vi.stubGlobal("fetch", pod(setup as Record<string, unknown>, governance as Record<string, unknown> | "missing"));
      await writeClaudeCodeEnv({ podUrl: POD, apiKey: "human-key", unattended: true }, { writeMcp: false });
      // Non-vacuity: the connect really ran against the stubbed pod.
      expect(calls.some((c) => c.url.endsWith("/api/hub/setup/agent"))).toBe(true);
      expect(governanceWrites()).toEqual([]);
    });
  }
});
