/**
 * `synap worker` must recognise its OWN room posts, or every report it posts
 * reads as a follow-up and resumes it (up to MAX_RESUMES per session).
 *
 * The worker runs as SYNAP_AGENT=<name>, and its self id comes from
 * `resolveHubConfig` → `resolveUserId`. That branch used to return the POD
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

let meCalls = 0;
beforeEach(() => {
  meCalls = 0;
  fs.rmSync(path.join(os.homedir(), ".synap"), { recursive: true, force: true });
  vi.stubEnv("SYNAP_AGENT", "claude-code-devbox");
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      if (new URL(String(url)).pathname.endsWith("/users/me")) {
        meCalls++;
        return new Response(JSON.stringify({ id: "agent-from-pod" }), { status: 200, headers: { "Content-Type": "application/json" } });
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
    expect(cfg.userId).toBe(SELF);
    expect(cfg.userId).not.toBe("home");
    const self = await resolveUserId(cfg);
    expect(self).toBe(SELF);
    expect(meCalls).toBe(0);
    expect(followUpsSince(room, "2026-10-15T10:00:00Z", self).map((m) => m.id)).toEqual(["answer"]);
  });

  it("a named agent (synap agents add) resolves the same way", async () => {
    writeConfig({ agents: { "claude-code-devbox": { podName: "home", apiKey: "fake-worker-key", agentUserId: SELF, createdAt: "" } } });
    expect(await resolveUserId(await resolveHubConfig())).toBe(SELF);
  });

  it("no recorded id: the pod is asked with the agent's key — never a profile name", async () => {
    writeConfig({ agentKeys: { "claude-code-devbox": { hubApiKey: "fake-worker-key-2" } } });
    const cfg = await resolveHubConfig();
    expect(await resolveUserId(cfg)).toBe("agent-from-pod");
    expect(meCalls).toBe(1);
  });
});
