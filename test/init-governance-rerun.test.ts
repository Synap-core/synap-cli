/**
 * Re-running `synap init` must not reset an agent's approval settings. The
 * unattended connect READS the agent's governance first
 * (`GET /agent-users/:id/governance`) and writes only when nobody ever set it
 * — then the named posture "creates" (`create-with-undo`, D2), resolved by the
 * pod. A pod too old to answer the read falls back to setup/agent's
 * `alreadyValid`, and never sends a posture it would ignore. Driven through
 * the real `writeClaudeCodeEnv` against a stubbed pod, with a throwaway HOME.
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
  it("an agent nobody configured gets the named posture 'creates' — the pod resolves it, the CLI sends no list", async () => {
    vi.stubGlobal("fetch", pod({ hubApiKey: "agent-key-new", agentUserId: "agent-1" }));
    await writeClaudeCodeEnv({ podUrl: POD, apiKey: "human-key", unattended: true }, { writeMcp: false });
    const gov = governanceCalls();
    // Read BEFORE write.
    expect(gov.map((c) => c.method)).toEqual(["GET", "PATCH"]);
    expect(gov[1]!.url).toBe(`${POD}/api/hub/agent-users/agent-1/governance`);
    expect(gov[1]!.body).toEqual({ posture: "create-with-undo" });
  });

  it("a NEW agent the pod already seeded (D2) is left alone: read, no write", async () => {
    vi.stubGlobal(
      "fetch",
      pod(
        { hubApiKey: "agent-key-new", agentUserId: "agent-1" },
        { posture: "create-with-undo", configured: true }
      )
    );
    await writeClaudeCodeEnv({ podUrl: POD, apiKey: "human-key", unattended: true }, { writeMcp: false });
    expect(governanceCalls().map((c) => c.method)).toEqual(["GET"]);
  });

  it("an agent someone configured keeps its settings on re-run, even a custom one", async () => {
    vi.stubGlobal(
      "fetch",
      pod({ alreadyValid: true, agentUserId: "agent-1" }, { posture: null, configured: true })
    );
    await writeClaudeCodeEnv({ podUrl: POD, apiKey: "human-key", unattended: true }, { writeMcp: false });
    expect(calls.some((c) => c.url.endsWith("/api/hub/setup/agent"))).toBe(true);
    expect(governanceWrites()).toEqual([]);
  });

  it("a pod without the read door: a known agent keeps its settings (as before)", async () => {
    vi.stubGlobal("fetch", pod({ alreadyValid: true, agentUserId: "agent-1" }, "missing"));
    await writeClaudeCodeEnv({ podUrl: POD, apiKey: "human-key", unattended: true }, { writeMcp: false });
    expect(governanceWrites()).toEqual([]);
  });

  it("a pod without the read door never gets a posture it would ignore — a new agent falls back to 'safe'", async () => {
    vi.stubGlobal("fetch", pod({ hubApiKey: "agent-key-new", agentUserId: "agent-1" }, "missing"));
    await writeClaudeCodeEnv({ podUrl: POD, apiKey: "human-key", unattended: true }, { writeMcp: false });
    const [write] = governanceWrites();
    expect(write!.body).not.toHaveProperty("posture");
    expect((write!.body as { writesRequireProposal: boolean }).writesRequireProposal).toBe(true);
    expect((write!.body as { autoApproveFor: string[] }).autoApproveFor).not.toContain("entity.update");
  });
});
