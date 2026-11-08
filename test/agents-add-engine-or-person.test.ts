/**
 * `synap agents add` for a type an agent TEMPLATE names vs a custom type
 * (founder, 2026-11-07, decision 59c75aab).
 *
 * One agent per computer per template, like Claude Code on the Mac and on
 * the devbox. `synap agents add hermes` and `--name hermes-server --type
 * hermes` are hermes ON THIS COMPUTER: the plain connect request (no
 * `asPerson`), a key for this computer's instance, the approval link
 * printed. `--name` only labels it. Only a type no template names
 * (`researcher`) is asked for AS THE PERSON (`asPerson: true`, W3): a pending
 * key + an `agent/connect` request approved with a proof of presence.
 *
 * Driven through the REAL `agentsAdd` → `createCustomAgent` →
 * `provisionAgentKey` → approval wait, against a stubbed pod (fetch). The
 * installed catalog package is the real one (hermes.agent.yaml).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const POD = "https://pod.test";
const REVIEW_URL = "https://elsewhere.test/approve-agent/tok-1?agentType=hermes";

/** The computer this run is on: its key, its instance, its name. */
let computer = { key: "computer-key", instance: "inst-mac", label: "mac" };

vi.mock("../src/lib/machine-instance.js", async (importOriginal) => {
  const real = await importOriginal<typeof import("../src/lib/machine-instance.js")>();
  return { ...real, machineInstanceId: () => computer.instance, machineInstanceLabel: () => computer.label };
});

const verifyMcpConnection = vi.fn();
const addAgent = vi.fn();
const openPodPage = vi.fn();

vi.mock("../src/lib/targets.js", async (importOriginal) => {
  const real = await importOriginal<typeof import("../src/lib/targets.js")>();
  return { ...real, verifyMcpConnection: (...a: unknown[]) => verifyMcpConnection(...a) };
});

vi.mock("../src/lib/safe-open.js", async (importOriginal) => {
  const real = await importOriginal<typeof import("../src/lib/safe-open.js")>();
  return { ...real, openPodPage: (...a: unknown[]) => openPodPage(...a), openExternalUrl: () => false };
});

vi.mock("../src/lib/pod.js", async (importOriginal) => {
  const real = await importOriginal<typeof import("../src/lib/pod.js")>();
  return {
    ...real,
    checkPodHealth: async () => ({ healthy: true }),
    getPodOverride: () => null,
    listPodProfiles: () => [
      {
        name: "home",
        active: true,
        config: { podUrl: POD, hubApiKey: computer.key, credential: "computer", workspaceId: "", agentUserId: "", savedAt: "" },
      },
    ],
  };
});

vi.mock("../src/lib/agents-config.js", async (importOriginal) => {
  const real = await importOriginal<typeof import("../src/lib/agents-config.js")>();
  return { ...real, addAgent: (...a: unknown[]) => addAgent(...a) };
});

const { agentsAdd } = await import("../src/commands/agents.js");

let mints: Array<Record<string, unknown>>;
let keyStatePolls: string[];
let approved: boolean;
let out: string[];

/** The pod: a custom type asked as the person files a pending key; a client type mints live. */
function stubPod(setupAgent?: (body: Record<string, unknown>) => { status: number; body: unknown }) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      const json = (b: unknown, status = 200) =>
        new Response(JSON.stringify(b), { status, headers: { "content-type": "application/json" } });
      const auth = (init?.headers as Record<string, string> | undefined)?.Authorization?.replace(/^Bearer /, "");
      if (url.endsWith("/api/hub/setup/agent")) {
        const body = JSON.parse(String(init?.body));
        mints.push(body);
        if (setupAgent) {
          const r = setupAgent(body);
          return json(r.body, r.status);
        }
        return json({
          hubApiKey: "pending-hermes",
          agentUserId: "agent-hermes",
          requiresApproval: true,
          pendingToken: "tok-1",
          reviewUrl: REVIEW_URL,
        });
      }
      if (url.endsWith("/api/hub/auth/key-state")) {
        keyStatePolls.push(auth ?? "");
        return json(approved ? { state: "active" } : { state: "awaiting_approval", keyId: "tok-1", approvalUrl: REVIEW_URL });
      }
      if (url.endsWith("/api/hub/workspaces/enroll-agent")) return json({ enrolled: [] });
      return json({ error: "no" }, 404);
    })
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  computer = { key: "computer-key", instance: "inst-mac", label: "mac" };
  vi.stubEnv("SYNAP_APPROVAL_TIMEOUT_MS", "60");
  vi.stubEnv("SYNAP_APPROVAL_POLL_MS", "10");
  mints = [];
  keyStatePolls = [];
  approved = false;
  out = [];
  verifyMcpConnection.mockResolvedValue({ ok: true, toolCount: 9 });
  const capture = (...a: unknown[]) => void out.push(a.map(String).join(" "));
  vi.spyOn(console, "log").mockImplementation(capture);
  vi.spyOn(console, "error").mockImplementation(capture);
  vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  process.exitCode = undefined;
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  process.exitCode = undefined;
});

describe("a type an agent template names is an engine on this computer", () => {
  it("--name hermes-server --type hermes: the plain request, no asPerson, the link printed, saved under its label once approved", async () => {
    stubPod();
    await agentsAdd(undefined, { name: "hermes-server", type: "hermes" });

    expect(mints).toHaveLength(1);
    expect(mints[0].agentType).toBe("hermes");
    expect(mints[0].asPerson).toBeUndefined();
    expect(mints[0].podWide).toBeUndefined();
    expect(mints[0].instanceId).toBe("inst-mac");
    expect(mints[0].template).toBe("hermes");

    const text = out.join("\n");
    expect(text).not.toContain("acts for you");
    expect(text).not.toMatch(/Face ID|confirm it is you/);
    // A headless server opens nothing: the link is printed, and the wait runs.
    expect(text).toContain(REVIEW_URL);
    expect(openPodPage).toHaveBeenCalled();
    expect(keyStatePolls.length).toBeGreaterThan(0);
    // Not approved yet: nothing saved, and the run reads as not done.
    expect(addAgent).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);

    approved = true;
    process.exitCode = undefined;
    await agentsAdd(undefined, { name: "hermes-server", type: "hermes" });
    expect(mints).toHaveLength(1);
    expect(addAgent).toHaveBeenCalledTimes(1);
    expect(addAgent.mock.calls[0][0]).toBe("hermes-server");
    expect(addAgent.mock.calls[0][1]).toMatchObject({ apiKey: "pending-hermes", agentUserId: "agent-hermes" });
    expect(process.exitCode).toBeUndefined();
  });

  it("`agents add hermes` is the same engine path", async () => {
    stubPod();
    approved = true;
    await agentsAdd("hermes", {});
    expect(mints).toHaveLength(1);
    expect(mints[0].agentType).toBe("hermes");
    expect(mints[0].asPerson).toBeUndefined();
    expect(addAgent.mock.calls[0][0]).toBe("hermes");
  });

  it("two computers: two requests, each for ITS instance with ITS computer's key, two agents, two keys", async () => {
    const byComputer: Record<string, string> = {};
    const authOf: string[] = [];
    stubPod((body) => {
      // The pod host-keys the agent by the CALLING computer (D1).
      const agent = `agent-hermes-${String(body.instanceId)}`;
      byComputer[String(body.instanceId)] = agent;
      return {
        status: 200,
        body: {
          hubApiKey: `key-${String(body.instanceId)}`,
          agentUserId: agent,
          requiresApproval: true,
          pendingToken: `tok-${String(body.instanceId)}`,
          reviewUrl: REVIEW_URL,
        },
      };
    });
    const realFetch = globalThis.fetch;
    vi.stubGlobal("fetch", (url: string, init?: RequestInit) => {
      if (String(url).endsWith("/api/hub/setup/agent"))
        authOf.push(String((init?.headers as Record<string, string>).Authorization));
      return realFetch(url, init);
    });
    approved = true;

    await agentsAdd("hermes", {});
    // The second computer: its own key, instance and (fresh) local config.
    const pod = await import("../src/lib/pod.js");
    pod.clearPendingAgentKey("hermes", POD);
    computer = { key: "ct112-computer-key", instance: "inst-ct112", label: "ct112" };
    await agentsAdd("hermes", {});

    expect(mints.map((m) => m.instanceId)).toEqual(["inst-mac", "inst-ct112"]);
    expect(mints.every((m) => m.asPerson === undefined)).toBe(true);
    expect(authOf).toEqual(["Bearer computer-key", "Bearer ct112-computer-key"]);
    expect(addAgent.mock.calls.map((c) => (c[1] as { apiKey: string; agentUserId: string }).apiKey)).toEqual([
      "key-inst-mac",
      "key-inst-ct112",
    ]);
    expect(new Set(Object.values(byComputer)).size).toBe(2);
  });

  it("a pod that does not know the template yet: says it needs a newer pod, never the custom path", async () => {
    stubPod(() => ({
      status: 400,
      body: {
        error: "Agent keys may only provision surface agent types. Named agents (non-surface agentType) require a human-owned hub-protocol.write key.",
        code: "SURFACE_AGENT_TYPE_REQUIRED",
      },
    }));
    await agentsAdd(undefined, { name: "hermes-server", type: "hermes" });
    expect(mints).toHaveLength(1);
    expect(mints[0].asPerson).toBeUndefined();
    const text = out.join("\n");
    expect(text).toContain("Your pod does not know hermes as an AI program on a computer yet: it needs a newer pod.");
    expect(text).not.toMatch(/--name hermes --type hermes|custom agent/);
    expect(addAgent).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
  });
});

describe("a custom agent type is asked for as the person", () => {
  it("sends asPerson and never podWide, waits for the person's approval, and the same command resumes it", async () => {
    stubPod();
    await agentsAdd(undefined, { name: "researcher", type: "researcher" });

    expect(mints).toHaveLength(1);
    expect(mints[0].agentType).toBe("researcher");
    expect(mints[0].asPerson).toBe(true);
    expect(mints[0].podWide).toBeUndefined();
    // It entered the approval wait: the pod was asked about the PENDING key.
    expect(keyStatePolls.length).toBeGreaterThan(0);
    expect(keyStatePolls.every((k) => k === "pending-hermes")).toBe(true);

    const text = out.join("\n");
    expect(text).toContain("acts for you · every space");
    expect(text).not.toContain("pod-wide");
    expect(text).toMatch(/confirm it is you \(Face ID, Touch ID or a passkey\)/);
    expect(text).toContain("Approve it on Relay");
    expect(text).toContain(REVIEW_URL);
    expect(text).toContain("Then run this again: synap agents add --name researcher --type researcher");
    expect(text).not.toMatch(/cannot sign in as you/i);
    // Nothing saved while it waits; the run reads as not done.
    expect(addAgent).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);

    // The person approves; the same command picks up THE SAME request.
    approved = true;
    process.exitCode = undefined;
    await agentsAdd(undefined, { name: "researcher", type: "researcher" });
    expect(mints).toHaveLength(1);
    expect(addAgent).toHaveBeenCalledTimes(1);
    expect(addAgent.mock.calls[0][0]).toBe("researcher");
    expect(addAgent.mock.calls[0][1]).toMatchObject({ apiKey: "pending-hermes", agentUserId: "agent-hermes" });
    expect(process.exitCode).toBeUndefined();
  });

  it("a client's type (an explicit --type generic) keeps the plain request", async () => {
    stubPod(() => ({ status: 200, body: { hubApiKey: "generic-key", agentUserId: "agent-g" } }));
    approved = true; // the minted-live key is checked once before it is handed out
    await agentsAdd(undefined, { name: "my-bot", type: "generic" });
    expect(mints).toHaveLength(1);
    expect(mints[0].agentType).toBe("generic");
    expect(mints[0].asPerson).toBeUndefined();
    expect(mints[0].podWide).toBeUndefined();
    expect(out.join("\n")).not.toContain("acts for you");
  });

  it("an older pod that ignores asPerson: says so plainly and points at pod admin", async () => {
    stubPod(() => ({
      status: 400,
      body: {
        error: "Agent keys may only provision surface agent types. Named agents (non-surface agentType) require a human-owned hub-protocol.write key.",
        code: "SURFACE_AGENT_TYPE_REQUIRED",
      },
    }));
    await agentsAdd(undefined, { name: "researcher", type: "researcher" });
    expect(mints[0].asPerson).toBe(true);
    const text = out.join("\n");
    expect(text).toContain('Your pod does not accept a request for the custom agent "researcher" from this computer yet: it needs a newer pod.');
    expect(text).toContain("/agents)");
    expect(text).not.toMatch(/cannot sign in as you/i);
    expect(text).not.toMatch(/reconnect/i);
    expect(process.exitCode).toBe(1);
  });
});
