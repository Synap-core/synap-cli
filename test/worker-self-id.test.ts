/**
 * `synap worker` must recognise its OWN room posts, or every report it posts
 * reads as a follow-up and resumes it (up to MAX_RESUMES per session).
 *
 * The worker runs as SYNAP_AGENT=<name>, and its self id comes from
 * `resolveHubConfig` → `resolveAgentUserId` (the key's agent principal — NOT
 * `resolveUserId`, the acting user, which the pod answers with the agent's
 * linked HUMAN; 2026-10-23). That branch once returned the POD
 * PROFILE NAME as the user id, so the comparison with a message's
 * `routedTeammateId` (the posting agent's user id, synap-backend
 * post-message.ts) could never match. `followUpsSince` itself was tested only
 * with a hand-written self id, downstream of this seam; this drives the seam:
 * a real config.json on a throwaway HOME → the real resolution → the real
 * filter. The pod is a stubbed `fetch`.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { resolveHubConfig, resolveUserId } from "../src/lib/hub-client.js";
import { resolveAgentUserId } from "../src/lib/credential-class.js";
import { followUpsSince } from "../src/commands/worker.js";

const POD = "https://pod.worker.example.test";
const SELF = "agent-4a14c2cf";

function writeConfig(extra: Record<string, unknown>): void {
  const dir = path.join(os.homedir(), ".synap");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, "config.json"),
    JSON.stringify({
      activePod: "home",
      pods: { home: { podUrl: POD, hubApiKey: "fake-person-key", workspaceId: "", agentUserId: "", savedAt: "" } },
      ...extra,
    })
  );
}

const room = [
  { id: "own", content: "WORKER-RESULT: done — pushed the branch", timestamp: "2026-10-15T10:05:00Z", routedTeammateId: SELF },
  { id: "answer", content: "ANSWER: ship it", timestamp: "2026-10-15T10:06:00Z", routedTeammateId: "agent-orchestrator" },
];

const HUMAN = "human-the-agent-acts-for";
let meCalls = 0;
let statusCalls = 0;
beforeEach(() => {
  meCalls = 0;
  statusCalls = 0;
  fs.rmSync(path.join(os.homedir(), ".synap"), { recursive: true, force: true });
  vi.stubEnv("SYNAP_AGENT", "claude-code-devbox");
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      const p = new URL(String(url)).pathname;
      // /users/me = who the pod ACTS AS (the linked human); /auth/status = who
      // OWNS the key (the agent). Self-recognition must read the second.
      if (p.endsWith("/users/me")) {
        meCalls++;
        return new Response(JSON.stringify({ id: HUMAN }), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      if (p.endsWith("/auth/status")) {
        statusCalls++;
        return new Response(JSON.stringify({ userId: "agent-from-pod" }), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      throw new TypeError(`unexpected call ${url}`);
    })
  );
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("SYNAP_AGENT resolves to the agent's own id", () => {
  it("a surface key with its recorded agent id: the worker's own post never resumes it", async () => {
    writeConfig({ agentKeys: { "claude-code-devbox": { hubApiKey: "fake-worker-key", agentUserId: SELF } } });
    const cfg = await resolveHubConfig();
    expect(cfg.agentUserId).toBe(SELF);
    const self = await resolveAgentUserId(cfg);
    expect(self).toBe(SELF);
    expect(self).not.toBe("home");
    expect(meCalls + statusCalls).toBe(0);
    expect(followUpsSince(room, "2026-10-15T10:00:00Z", self).map((m) => m.id)).toEqual(["answer"]);
    // …while the same config ACTS as the linked human (never the agent id).
    expect(await resolveUserId(cfg)).toBe(HUMAN);
  });

  it("a named agent (synap agents add) resolves the same way", async () => {
    writeConfig({ agents: { "claude-code-devbox": { podName: "home", apiKey: "fake-worker-key", agentUserId: SELF, createdAt: "" } } });
    expect(await resolveAgentUserId(await resolveHubConfig())).toBe(SELF);
  });

  it("no recorded id: the pod is asked who OWNS the key (/auth/status) — never /users/me, never a profile name", async () => {
    writeConfig({ agentKeys: { "claude-code-devbox": { hubApiKey: "fake-worker-key-2" } } });
    const cfg = await resolveHubConfig();
    const self = await resolveAgentUserId(cfg);
    expect(self).toBe("agent-from-pod");
    expect(statusCalls).toBe(1);
    expect(meCalls).toBe(0);
    const own = [{ id: "own", content: "WORKER-RESULT: x", timestamp: "2026-10-15T10:05:00Z", routedTeammateId: "agent-from-pod" }];
    expect(followUpsSince(own, "2026-10-15T10:00:00Z", self)).toEqual([]);
  });
});
