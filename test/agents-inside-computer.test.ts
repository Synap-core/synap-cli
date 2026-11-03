/**
 * Agents inside a computer, CLI side (plan "Computer once, agents inside" rev
 * 3, pod document 31470fd5, §10 test 9): the seat id, the device request on
 * today's pod and on a pod that knows seats, `held` (ids only), and an agent
 * with a job (`agents add <engine> --as`, the worker's first run, adopt).
 *
 * Driven against a fake pod on loopback with the real fetch: `/health`
 * answers the feature mark (or not), `/api/hub/setup/device` and
 * `/api/hub/setup/agent` record the RAW body they got.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import http from "node:http";
import type { AddressInfo } from "node:net";

import { deviceConnect, buildDeviceRequestBody, DeviceJobRefusedError, type DeviceSeatEvidence } from "../src/lib/device-connect.js";
import { deriveSeatId, normalizeSeat, thisSeat, type MachineIdSources } from "../src/lib/machine-instance.js";
import { heldKeySources, toHeldKeys, collectHeldKeys } from "../src/lib/held-keys.js";
import { parseAgentJob, initJobFor } from "../src/lib/agent-jobs.js";
import { addRoleAgent, adoptHeldKey, workerFirstRunPlan } from "../src/lib/role-agent.js";
import { readPodFeature, AGENT_SEATS_FEATURE } from "../src/lib/pod-features.js";
import type { AgentProfile } from "../src/lib/agents-config.js";

// ─── a fake pod ───────────────────────────────────────────────────────────────

/** What `/health` answers: the mark, no mark, or a failure. */
let health: { status: number; body: unknown } = { status: 200, body: { status: "ok" } };
let deviceBodies: string[] = [];
let agentBodies: Array<Record<string, unknown>> = [];
let seen: string[] = [];
let server: http.Server;
let podUrl: string;

const GRANT = {
  access_token: "computer-key",
  token_type: "Bearer",
  expires_in: 7776000,
  computer: { id: "c-1", name: "devbox", apiKey: "computer-key", keyId: "k-c", expiresAt: null },
  agents: [],
};

beforeAll(async () => {
  server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (d) => (raw += d));
    req.on("end", () => {
      const json = (status: number, body: unknown) => {
        res.writeHead(status, { "Content-Type": "application/json" });
        res.end(JSON.stringify(body));
      };
      seen.push(`${req.method} ${req.url}`);
      if (req.url === "/health") return json(health.status, health.body);
      if (req.method === "POST" && req.url === "/api/hub/setup/device") {
        deviceBodies.push(raw);
        return json(200, {
          device_code: "dev-code",
          user_code: "ABCD-EFGH",
          verification_uri: `${podUrl}/device`,
          expires_in: 600,
          interval: 5,
        });
      }
      if (req.method === "POST" && req.url === "/api/hub/setup/device/token") return json(200, GRANT);
      if (req.method === "POST" && req.url === "/api/hub/setup/agent") {
        agentBodies.push(JSON.parse(raw));
        // Minted live: the test is about what was ASKED, not the approval wait.
        return json(200, { hubApiKey: "crm-worker-key", agentUserId: "agent-crm", requiresApproval: false });
      }
      if (req.url === "/api/hub/auth/key-state") {
        return json(200, { state: "active", keyId: "11111111-2222-4333-8444-555555555555", agentType: "claude-code" });
      }
      if (req.url === "/api/hub/workspaces/enroll-agent") return json(200, { enrolled: [] });
      return json(404, { error: "no" });
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  podUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(() => {
  server.close();
});

beforeEach(() => {
  deviceBodies = [];
  agentBodies = [];
  seen = [];
  health = { status: 200, body: { status: "ok" } };
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

const qr = async (t: string) => `[QR ${t}]`;
// The literal the backend ships (`AGENT_SEATS_FEATURE`, @synap-core/types/device): pinned here, not imported.
const NEW_POD = { status: 200, body: { status: "ok", features: ["agent-seats"] } };

const EVIDENCE: DeviceSeatEvidence = {
  seat: { seat: "agent", seatId: "s-0123456789abcdef0123456789abcdef" },
  held: [{ keyId: "11111111-2222-4333-8444-555555555555", agentUserId: "agent-7455" }],
};

// ─── the seat ─────────────────────────────────────────────────────────────────

describe("the seat id", () => {
  const machine = (id: string): MachineIdSources => ({
    platform: "linux",
    readFile: () => id,
    run: () => null,
    fallback: () => "fallback",
  });

  it("differs per OS user on one computer, and is stable for one", () => {
    const antoine = deriveSeatId("machine-1", "antoine");
    expect(deriveSeatId("machine-1", "antoine")).toBe(antoine);
    expect(deriveSeatId("machine-1", "agent")).not.toBe(antoine);
    // The same name on another computer is another seat.
    expect(deriveSeatId("machine-2", "antoine")).not.toBe(antoine);
    // The pod's grammar: [A-Za-z0-9_-]{16,128}.
    expect(antoine).toMatch(/^[A-Za-z0-9_-]{16,128}$/);
    // One-way: neither the machine id nor the user name is in it.
    expect(antoine).not.toContain("machine-1");
    expect(antoine).not.toContain("antoine");
  });

  it("thisSeat reads the OS user and this machine's id", () => {
    expect(thisSeat(machine("m-1"), () => "antoine")).toEqual({ seat: "antoine", seatId: deriveSeatId("m-1", "antoine") });
    expect(thisSeat(machine("m-1"), () => "agent")!.seatId).not.toBe(thisSeat(machine("m-1"), () => "antoine")!.seatId);
    expect(thisSeat(machine("m-1"), () => null)).toBeNull();
  });

  it("an OS user name becomes a seat the pod accepts (no colon, no space)", () => {
    expect(normalizeSeat("Ada Lovelace")).toBe("Ada_Lovelace");
    expect(normalizeSeat("a:b")).toBe("a_b");
    expect(normalizeSeat("  ")).toBeNull();
    expect(normalizeSeat("x".repeat(80))).toHaveLength(64);
  });
});

// ─── the device request ───────────────────────────────────────────────────────

describe("the device request", () => {
  const TODAY = JSON.stringify({ clientName: "Synap CLI", hostname: "devbox", platform: "linux", agents: ["claude-code", "codex"] });

  it("today's pod (no feature mark) gets today's body, byte for byte, and no key is looked up", async () => {
    await deviceConnect(podUrl, { agents: ["claude-code", "codex"], hostname: "devbox", platform: "linux" }, { renderQr: qr, timeScale: 0.01 });
    expect(deviceBodies).toEqual([TODAY]);
    // No seat evidence was gathered for it: no key-state lookups.
    expect(seen.filter((s) => s.includes("key-state"))).toEqual([]);
  });

  it("a pod whose /health fails is treated like today's pod", async () => {
    health = { status: 503, body: { error: "down" } };
    await deviceConnect(podUrl, { agents: ["claude-code", "codex"], hostname: "devbox", platform: "linux" }, { renderQr: qr, timeScale: 0.01 });
    expect(deviceBodies).toEqual([TODAY]);
  });

  it("a pod that knows seats gets the seat, its id, the job and `held` (ids only)", async () => {
    health = NEW_POD;
    await deviceConnect(
      podUrl,
      {
        agents: ["claude-code", "codex"],
        hostname: "devbox",
        platform: "linux",
        jobs: { "claude-code": { role: "agent-sessions", roleLabel: "Agent sessions" } },
        evidence: EVIDENCE,
      },
      { renderQr: qr, timeScale: 0.01 }
    );
    expect(JSON.parse(deviceBodies[0]!)).toEqual({
      clientName: "Synap CLI",
      hostname: "devbox",
      platform: "linux",
      agents: ["claude-code", "codex"],
      seat: "agent",
      seatId: "s-0123456789abcdef0123456789abcdef",
      rows: [{ agentType: "claude-code", role: "agent-sessions", roleLabel: "Agent sessions" }],
      held: [{ keyId: "11111111-2222-4333-8444-555555555555", agentUserId: "agent-7455" }],
    });
  });

  it("a job asked of today's pod is refused before anything is sent", async () => {
    await expect(
      deviceConnect(
        podUrl,
        { agents: ["claude-code"], hostname: "devbox", platform: "linux", jobs: { "claude-code": { role: "crm-worker" } } },
        { renderQr: qr, timeScale: 0.01 }
      )
    ).rejects.toBeInstanceOf(DeviceJobRefusedError);
    expect(deviceBodies).toEqual([]);
  });

  it("no job and no evidence: a pod that knows seats gets today's keys only", () => {
    const body = buildDeviceRequestBody({ hostname: "devbox", platform: "linux", agents: ["codex"], evidence: { seat: null, held: [] } });
    expect(Object.keys(body).sort()).toEqual(["agents", "clientName", "hostname", "platform"]);
  });
});

// ─── held: the keys this seat keeps, never a secret ───────────────────────────

describe("held", () => {
  const POD = "https://pod.example.synap.live";
  const ID = (n: number) => `${String(n).padStart(8, "0")}-2222-4333-8444-555555555555`;
  const cfg = {
    pods: {
      home: { podUrl: POD + "/", keyId: ID(1), agentUserId: "computer-1", hubApiKey: "secret-computer" },
      other: { podUrl: "https://other.example", keyId: ID(9), hubApiKey: "secret-other" },
    },
    agents: {
      "crm-worker": { podName: "home", keyId: ID(2), agentUserId: "agent-crm", apiKey: "secret-crm" },
      stray: { podName: "other", keyId: ID(8), apiKey: "secret-stray" },
    },
    agentKeysByPod: { "claude-code": { [POD]: { hubApiKey: "secret-cc", agentUserId: "agent-cc" } } },
    pendingAgentKeys: { codex: { [POD]: { keyId: ID(3), agentUserId: "agent-codex" } } },
  };

  it("collects this pod's keys only, as ids, and looks up an id it does not have", async () => {
    const lookup = vi.fn(async (_pod: string, key: string) => (key === "secret-cc" ? ID(4) : null));
    const held = await collectHeldKeys(POD, { readConfig: () => cfg, lookup });
    expect(held).toEqual([
      { keyId: ID(1), agentUserId: "computer-1" },
      { keyId: ID(2), agentUserId: "agent-crm" },
      { keyId: ID(4), agentUserId: "agent-cc" },
      { keyId: ID(3), agentUserId: "agent-codex" },
    ]);
    expect(lookup).toHaveBeenCalledTimes(1);
    // Never a secret, and never another pod's key.
    const wire = JSON.stringify(held);
    expect(wire).not.toMatch(/secret-/);
    expect(wire).not.toContain(ID(9));
    expect(wire).not.toContain(ID(8));
  });

  it("drops what the pod would refuse and dedups by key id", () => {
    expect(toHeldKeys([{ keyId: "not-a-uuid" }, { keyId: ID(5) }, { keyId: ID(5), agentUserId: "a" }])).toEqual([
      { keyId: ID(5), agentUserId: "a" },
    ]);
    expect(heldKeySources(POD, {})).toEqual([]);
  });

  it("an unreadable config is no evidence, never a crash", async () => {
    expect(
      await collectHeldKeys(POD, {
        readConfig: () => {
          throw new Error("bad json");
        },
      })
    ).toEqual([]);
  });
});

// ─── a job ────────────────────────────────────────────────────────────────────

describe("a job", () => {
  it("--as \"CRM worker\" is the slug crm-worker with its label; a slug sends no label", () => {
    expect(parseAgentJob("CRM worker")).toEqual({ ok: true, job: { role: "crm-worker", roleLabel: "CRM worker" } });
    expect(parseAgentJob("crm-worker")).toEqual({ ok: true, job: { role: "crm-worker" } });
    expect(parseAgentJob("!!!").ok).toBe(false);
  });

  it("init --as gives the job to one engine: the only one, else Claude Code", () => {
    expect(initJobFor("Agent sessions", ["codex"])).toMatchObject({ ok: true, engine: "codex" });
    expect(initJobFor("Agent sessions", ["codex", "claude-code"])).toMatchObject({ ok: true, engine: "claude-code" });
    expect(initJobFor("Agent sessions", ["codex", "cursor"]).ok).toBe(false);
    expect(initJobFor("Agent sessions", []).ok).toBe(false);
  });
});

describe("agents add claude-code --as \"CRM worker\"", () => {
  const saved: Array<[string, AgentProfile]> = [];
  const save = (n: string, p: AgentProfile) => void saved.push([n, p]);
  beforeEach(() => void (saved.length = 0));

  it("asks for agentType claude-code with role crm-worker, with this computer's key, and saves the agent under its job", async () => {
    health = NEW_POD;
    const out = await addRoleAgent(
      { podUrl, computerKey: "computer-key", podName: "home" },
      "claude-code",
      { role: "crm-worker", roleLabel: "CRM worker" },
      {},
      { save, instanceId: (s) => `m-${s}` }
    );
    expect(out).toMatchObject({ ok: true, name: "crm-worker", agentUserId: "agent-crm" });
    expect(agentBodies).toHaveLength(1);
    expect(agentBodies[0]).toMatchObject({
      agentType: "claude-code",
      role: "crm-worker",
      roleLabel: "CRM worker",
      instanceId: "m-claude-code",
      requireApproval: true,
    });
    expect(saved).toEqual([
      [
        "crm-worker",
        expect.objectContaining({ apiKey: "crm-worker-key", agentType: "claude-code", role: "crm-worker", podUrl, podName: "home" }),
      ],
    ]);
  });

  it("today's pod is never asked: it would mint for the plain Claude Code agent", async () => {
    const out = await addRoleAgent({ podUrl, computerKey: "computer-key" }, "claude-code", { role: "crm-worker" }, {}, { save });
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.error).toContain("cannot give an agent a job yet");
    expect(agentBodies).toEqual([]);
    expect(saved).toEqual([]);
  });

  it("a pod that cannot be asked is not read as today's pod, and nothing is minted", async () => {
    health = { status: 502, body: {} };
    const out = await addRoleAgent({ podUrl, computerKey: "computer-key" }, "claude-code", { role: "crm-worker" }, {}, { save });
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.error).toContain("Could not tell");
    expect(agentBodies).toEqual([]);
  });

  it("the mark reader: listed → yes, absent → no, failed → unknown", async () => {
    health = NEW_POD;
    expect(await readPodFeature(podUrl, AGENT_SEATS_FEATURE)).toBe("yes");
    health = { status: 200, body: { status: "ok", features: ["something-else"] } };
    expect(await readPodFeature(podUrl, AGENT_SEATS_FEATURE)).toBe("no");
    health = { status: 500, body: {} };
    expect(await readPodFeature(podUrl, AGENT_SEATS_FEATURE)).toBe("unknown");
  });
});

describe("synap worker --agent <job> on first run", () => {
  it("with --runtime asks for the agent; without, prints the add line and stops", () => {
    expect(workerFirstRunPlan("crm-worker", { runtime: "claude-code" })).toEqual({
      kind: "create",
      engine: "claude-code",
      job: { role: "crm-worker" },
    });
    const stop = workerFirstRunPlan("crm-worker", {});
    expect(stop.kind).toBe("stop");
    if (stop.kind === "stop") expect(stop.message).toContain('synap agents add claude-code --as "crm-worker"');
    expect(workerFirstRunPlan("crm-worker", { runtime: "claude-code", create: false }).kind).toBe("stop");
    // A typo'd engine never files a request.
    expect(workerFirstRunPlan("crm-worker", { runtime: "claude-cod" }).kind).toBe("stop");
  });
});

describe("synap agents adopt crm-worker", () => {
  const held = { hubApiKey: "b419-secret", agentUserId: "7455fd94" };

  it("saves the key this seat holds for claude-code as the agent crm-worker, minting nothing", async () => {
    const saved: Array<[string, AgentProfile]> = [];
    const out = await adoptHeldKey(
      "crm-worker",
      { from: "claude-code", podUrl, podName: "home" },
      {
        heldKey: () => held,
        existing: () => null,
        keyState: async () => ({ state: "active", keyId: "b419f05a-0000-4000-8000-000000000000", agentType: "claude-code" }),
        save: (n, p) => void saved.push([n, p]),
      }
    );
    expect(out).toEqual({ ok: true, agentUserId: "7455fd94", keyId: "b419f05a-0000-4000-8000-000000000000" });
    expect(saved[0]).toEqual([
      "crm-worker",
      expect.objectContaining({ apiKey: "b419-secret", agentUserId: "7455fd94", role: "crm-worker", agentType: "claude-code" }),
    ]);
  });

  it("refuses a dead key, a name already saved, and a seat holding nothing", async () => {
    const base = {
      heldKey: () => held,
      existing: () => null,
      keyState: async () => ({ state: "revoked" as const }),
      save: () => {
        throw new Error("must not save");
      },
    };
    expect((await adoptHeldKey("crm-worker", { from: "claude-code", podUrl }, base)).ok).toBe(false);
    expect(
      (await adoptHeldKey("crm-worker", { from: "claude-code", podUrl }, { ...base, existing: () => ({ podName: "x", apiKey: "k", createdAt: "" }) })).ok
    ).toBe(false);
    expect((await adoptHeldKey("crm-worker", { from: "claude-code", podUrl }, { ...base, heldKey: () => null })).ok).toBe(false);
  });
});

describe("saving what the pod granted", () => {
  it("keeps each key's id (never the secret is sent back) and saves an agent with a job under its job", async () => {
    const { saveDeviceGrant } = await import("../src/lib/device-connect.js");
    const { listPodProfiles } = await import("../src/lib/pod.js");
    const { getAgent } = await import("../src/lib/agents-config.js");
    await saveDeviceGrant(
      "https://pod.save.example",
      {
        computer: { id: "c-1", name: "devbox", apiKey: "computer-secret", keyId: "k-computer", expiresAt: null },
        agents: [
          {
            agentType: "claude-code",
            agentUserId: "agent-sessions-1",
            name: "Agent sessions",
            displayName: "Agent sessions · Claude Code on devbox",
            apiKey: "sessions-secret",
            keyId: "k-sessions",
            expiresAt: null,
            role: "agent-sessions",
            seat: "agent",
            action: "added",
          },
        ],
      },
      { name: "save-test" }
    );
    expect(listPodProfiles().find((p) => p.name === "save-test")?.config.keyId).toBe("k-computer");
    expect(getAgent("agent-sessions")).toMatchObject({
      apiKey: "sessions-secret",
      keyId: "k-sessions",
      agentType: "claude-code",
      role: "agent-sessions",
      podUrl: "https://pod.save.example",
      podName: "save-test",
    });
  });
});
