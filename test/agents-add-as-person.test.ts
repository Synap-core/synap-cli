/**
 * `synap agents add --name hermes-server --type hermes` (founder, 2026-11-07).
 *
 * A computer's key cannot create a custom agent type by itself
 * (SURFACE_AGENT_TYPE_REQUIRED), so the CLI dead-ended with "only you, signed
 * in as yourself, can … The CLI cannot sign in as you yet". The pod already
 * takes the request AS THE PERSON (`asPerson: true`, W3, synap-backend
 * routers/hub-protocol/rest/setup.ts): a pending key + an `agent/connect`
 * request the person approves with a proof of presence. Never pod-wide.
 *
 * Driven through the REAL `agentsAdd` → `createCustomAgent` →
 * `provisionAgentKey` → approval wait, against a stubbed pod (fetch).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const POD = "https://pod.test";
const REVIEW_URL = "https://elsewhere.test/approve-agent/tok-1?agentType=hermes";

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
        config: { podUrl: POD, hubApiKey: "computer-key", credential: "computer", workspaceId: "", agentUserId: "", savedAt: "" },
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

describe("a custom agent type is asked for as the person", () => {
  it("sends asPerson and never podWide, waits for the person's approval, and the same command resumes it", async () => {
    stubPod();
    await agentsAdd(undefined, { name: "hermes-server", type: "hermes" });

    expect(mints).toHaveLength(1);
    expect(mints[0].agentType).toBe("hermes");
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
    expect(text).toContain("Then run this again: synap agents add --name hermes-server --type hermes");
    expect(text).not.toMatch(/cannot sign in as you/i);
    // Nothing saved while it waits; the run reads as not done.
    expect(addAgent).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);

    // The person approves; the same command picks up THE SAME request.
    approved = true;
    process.exitCode = undefined;
    await agentsAdd(undefined, { name: "hermes-server", type: "hermes" });
    expect(mints).toHaveLength(1);
    expect(addAgent).toHaveBeenCalledTimes(1);
    expect(addAgent.mock.calls[0][0]).toBe("hermes-server");
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
    await agentsAdd(undefined, { name: "hermes-server", type: "hermes" });
    expect(mints[0].asPerson).toBe(true);
    const text = out.join("\n");
    expect(text).toContain('Your pod does not accept a request for the custom agent "hermes" from this computer yet: it needs a newer pod.');
    expect(text).toContain("/agents)");
    expect(text).not.toMatch(/cannot sign in as you/i);
    expect(text).not.toMatch(/reconnect/i);
    expect(process.exitCode).toBe(1);
  });
});
