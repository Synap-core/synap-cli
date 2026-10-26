/**
 * An agent key writes AS the person it acts for — never as its own agent id.
 *
 * Found 2026-10-23: `SYNAP_AGENT=feynman synap create entity …` → HTTP 403
 * "userId does not match the authenticated identity". The pod's auth middleware
 * maps an agent key to the human it is linked to (`userId = linkedUserId`,
 * synap-backend access/key-identity.ts `effectiveUserId`); the REST door then
 * hands `body.userId` to the tRPC procedure, whose `assertMayActAs`
 * (hub-protocol/guard.ts) refuses anything but that effective id. The CLI sent
 * the AGENT principal id, because `resolveHubConfig` seeded `HubConfig.userId`
 * with the agent id recorded next to the key, and `resolveUserId` returns a
 * seeded id as-is.
 *
 * Two different ids, two different jobs:
 *   - acting identity (sent on reads and writes) → `resolveUserId` → /users/me
 *   - the agent's own id (recognising its own room posts) → `cfg.agentUserId`
 *     (worker-self-id.test.ts covers that half).
 *
 * Driven through the REAL resolveHubConfig on a throwaway HOME, and for the
 * reported symptom through the REAL `createEntity` door down to the wire body.
 * The pod is a stubbed fetch whose /users/me answers the linked HUMAN.
 *
 * Coverage boundary (measured): one case per rung of resolveHubConfig that can
 * carry a recorded agent id (--pod, SYNAP_AGENT ×2 sources, claude-code surface
 * swap, active profile). It does not cover the ad-hoc HubConfig literals in the
 * setup commands (bridge/proton/app/lens/review); those follow the same shape
 * by reading, not by test.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const POD = "https://pod.identity.example.test";
const AGENT = "d25bf9be-agent-principal";
const HUMAN = "e418d146-linked-human";

type Call = { method: string; path: string; body?: Record<string, unknown> };
let calls: Call[] = [];

function writeConfig(cfg: Record<string, unknown>): void {
  const dir = path.join(os.homedir(), ".synap");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "config.json"), JSON.stringify(cfg));
}

const profile = (agentUserId: string, hubApiKey = "profile-key") => ({
  podUrl: POD,
  hubApiKey,
  workspaceId: "",
  agentUserId,
  savedAt: "",
});

async function load() {
  // Config paths and the userId cache are module state: re-import per case.
  vi.resetModules();
  return {
    hub: await import("../src/lib/hub-client.js"),
    pod: await import("../src/lib/pod.js"),
    data: await import("../src/commands/data.js"),
  };
}

beforeEach(() => {
  calls = [];
  fs.rmSync(path.join(os.homedir(), ".synap"), { recursive: true, force: true });
  for (const k of [
    "SYNAP_AGENT",
    "SYNAP_POD_URL",
    "SYNAP_HUB_API_KEY",
    "SYNAP_USER_ID",
    "SYNAP_WORKSPACE_ID",
    "SYNAP_PROJECT_ID",
    "SYNAP_KEY_SCOPES",
    "SYNAP_SESSION_ID",
    "SYNAP_LENS_SESSION",
    "CLAUDE_CODE_SESSION_ID",
  ])
    vi.stubEnv(k, undefined as unknown as string);
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      const u = new URL(String(url));
      const method = (init?.method ?? "GET").toUpperCase();
      const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : undefined;
      calls.push({ method, path: u.pathname, body });
      const json = (v: unknown) =>
        new Response(JSON.stringify(v), { status: 200, headers: { "Content-Type": "application/json" } });
      if (u.pathname.endsWith("/users/me")) return json({ id: HUMAN, isAgent: true });
      if (u.pathname.endsWith("/auth/status")) return json({ userId: AGENT });
      if (method === "POST" && u.pathname.endsWith("/entities")) return json({ id: "entity-1", title: "x" });
      return json({});
    })
  );
  vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
    throw new Error(`process.exit(${code})`);
  }) as never);
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(process.stderr, "write").mockImplementation(() => true);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

const entityPost = () => calls.find((c) => c.method === "POST" && c.path.endsWith("/entities"));

describe("the reported symptom: SYNAP_AGENT=<name> synap create entity", () => {
  it("named agent (synap agents add): POST /entities carries the linked human, not the agent", async () => {
    writeConfig({
      activePod: "home",
      pods: { home: profile("") },
      agents: { feynman: { podName: "home", apiKey: "feynman-key", agentUserId: AGENT, createdAt: "" } },
    });
    vi.stubEnv("SYNAP_AGENT", "feynman");
    const { data } = await load();
    await data.createEntity({ profile: "research", name: "Probe" } as never);
    const post = entityPost();
    expect(post, "createEntity never reached POST /entities").toBeDefined();
    expect(post!.body?.userId).toBe(HUMAN);
  });

  it("surface agent key (agentKeys.<name>): same", async () => {
    writeConfig({
      activePod: "home",
      pods: { home: profile("") },
      agentKeys: { feynman: { hubApiKey: "feynman-key", agentUserId: AGENT } },
    });
    vi.stubEnv("SYNAP_AGENT", "feynman");
    const { data } = await load();
    await data.createEntity({ profile: "research", name: "Probe" } as never);
    expect(entityPost()?.body?.userId).toBe(HUMAN);
  });
});

describe("every rung that can carry a recorded agent id resolves the acting user from the pod", () => {
  it("--pod <name> override with a recorded agent id", async () => {
    writeConfig({ activePod: "home", pods: { home: profile(""), other: profile(AGENT, "other-key") } });
    const { hub, pod } = await load();
    pod.setPodOverrideByName("other");
    const cfg = await hub.resolveHubConfig();
    expect(cfg.apiKey).toBe("other-key");
    expect(await hub.resolveUserId(cfg)).toBe(HUMAN);
    expect(cfg.agentUserId).toBe(AGENT);
  });

  it("claude-code surface key swapped in over an inherited env key", async () => {
    writeConfig({ activePod: "home", pods: { home: profile("") } });
    vi.stubEnv("SYNAP_POD_URL", POD);
    vi.stubEnv("SYNAP_HUB_API_KEY", "inherited-env-key");
    const { pod } = await load();
    pod.setSurfaceAgentKey("claude-code", { podUrl: POD, hubApiKey: "surface-key", agentUserId: AGENT } as never);
    const { hub } = await load();
    const cfg = await hub.resolveHubConfig();
    expect(cfg.apiKey).toBe("surface-key");
    expect(await hub.resolveUserId(cfg)).toBe(HUMAN);
    expect(cfg.agentUserId).toBe(AGENT);
  });

  it("active profile holding an agent (computer) key", async () => {
    writeConfig({ activePod: "home", pods: { home: profile(AGENT, "computer-key") } });
    const { hub } = await load();
    const cfg = await hub.resolveHubConfig();
    expect(await hub.resolveUserId(cfg)).toBe(HUMAN);
    expect(cfg.agentUserId).toBe(AGENT);
  });

  it("KEPT: an explicit SYNAP_USER_ID is still the caller's word", async () => {
    vi.stubEnv("SYNAP_POD_URL", POD);
    vi.stubEnv("SYNAP_HUB_API_KEY", "env-key");
    vi.stubEnv("SYNAP_USER_ID", "u-explicit");
    const { hub } = await load();
    expect(await hub.resolveUserId(await hub.resolveHubConfig())).toBe("u-explicit");
    expect(calls.some((c) => c.path.endsWith("/users/me"))).toBe(false);
  });
});

describe("synap show: a refused read is not an absent entity", () => {
  async function showWith(status: number): Promise<string> {
    writeConfig({ activePod: "home", pods: { home: profile("") } });
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        const p = new URL(String(url)).pathname;
        if (p.endsWith("/users/me")) return new Response(JSON.stringify({ id: HUMAN }), { status: 200, headers: { "Content-Type": "application/json" } });
        if (p.endsWith("/entities/ent-1"))
          return new Response(JSON.stringify({ error: "userId does not match the authenticated identity" }), { status, headers: { "Content-Type": "application/json" } });
        return new Response(JSON.stringify({}), { status: 200, headers: { "Content-Type": "application/json" } });
      })
    );
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.resetModules();
    const { showEntity } = await import("../src/commands/data-extra.js");
    await expect(showEntity("ent-1", {} as never)).rejects.toThrow("process.exit(1)");
    return err.mock.calls.map((c) => c.map(String).join(" ")).join("\n");
  }

  it("403 → the pod's refusal is shown, never \"Entity not found\"", async () => {
    const out = await showWith(403);
    expect(out).not.toContain("Entity not found");
    expect(out).toContain("does not match the authenticated identity");
  });

  it("KEPT: 404 → \"Entity not found\"", async () => {
    expect(await showWith(404)).toContain("Entity not found: ent-1");
  });
});
