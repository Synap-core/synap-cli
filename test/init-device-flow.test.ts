/**
 * `synap init` gets this computer's key for a pod through the pod's device
 * flow (MACHINE-IDENTITY-PLAN W4) — on a synap.live pod too, where it used to
 * go CP sign-in → the retired /api/federation/exchange (W6 deleted that door
 * and `provisionUserOnPod`) → connectIntegration. And a saved
 * computer key is renewed through the same door 7 days before it expires.
 * Driven through the real `init()`, with the pod stubbed at `fetch`.
 */

import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";

const home = fs.mkdtempSync(path.join(os.tmpdir(), "synap-init-device-"));
process.env.HOME = home;
process.env.USERPROFILE = home;
delete process.env.SYNAP_POD_URL;

const asked: Array<{ message: string; choices?: Array<{ title: string; value: string }> }> = [];
vi.mock("prompts", () => ({
  default: vi.fn(async (q: (typeof asked)[number]) => (asked.push(q), {})),
}));
vi.mock("child_process", async (orig) => ({
  ...(await orig<typeof import("child_process")>()),
  execSync: vi.fn(() => {
    throw new Error("no docker here");
  }),
}));
vi.mock("../src/lib/auth.js", async (orig) => ({
  ...(await orig<typeof import("../src/lib/auth.js")>()),
  getStoredToken: () => ({ token: "cp", expiresAt: new Date(Date.now() + 3_600_000).toISOString() }),
  isLoggedIn: async () => ({ valid: true }),
  login: async () => null,
}));
// No agent on this machine: the test is about the pod key, not the installers.
vi.mock("../src/lib/agent-detect.js", () => ({
  detectAgents: () => [{ target: "claude-code", label: "Claude Code", found: false }],
}));
/** Any request to the retired CP→pod handshake (assertion or exchange). */
const retiredHandshake = () =>
  hits.filter((h) => h.includes("/federation/exchange") || h.includes("/federation/assertion"));
// Collapse the pod's 5 s interval: the stub answers at once anyway.
vi.mock("../src/lib/approval-poll.js", async (orig) => {
  const real = await orig<typeof import("../src/lib/approval-poll.js")>();
  return { pollForApproval: (o: Parameters<typeof real.pollForApproval>[0]) => real.pollForApproval({ ...o, intervalMs: 1 }) };
});

const MANAGED = "https://pod.antoinesrvt.synap.live";
const hits: string[] = [];
let tokenAnswer: { status: number; body: unknown };
let authStatus = 200;

const GRANT = {
  access_token: "computer-key",
  token_type: "Bearer",
  expires_in: 7776000,
  computer: { id: "c-1", name: "devbox", apiKey: "computer-key", keyId: "k", expiresAt: "2027-01-09T00:00:00.000Z" },
  agents: [],
};

beforeAll(() => {
  Object.defineProperty(process.stdin, "isTTY", { value: true, configurable: true });
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      const u = new URL(String(url));
      hits.push(`${init?.method ?? "GET"} ${u.pathname}`);
      const json = (status: number, body: unknown) =>
        new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
      if (u.pathname === "/health") return json(200, { status: "ok" });
      if (u.pathname === "/api/hub/auth/status") return json(authStatus, {});
      if (u.pathname === "/api/hub/setup/device")
        return json(200, {
          device_code: "dc",
          user_code: "ABCD-EFGH",
          verification_uri: `${MANAGED}/device`,
          verification_uri_complete: `${MANAGED}/device?code=ABCD-EFGH`,
          expires_in: 600,
          interval: 5,
        });
      if (u.pathname === "/api/hub/setup/device/token") return json(tokenAnswer.status, tokenAnswer.body);
      throw new TypeError("fetch failed");
    })
  );
  vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);
  vi.spyOn(console, "log").mockImplementation(() => undefined);
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});

afterAll(() => {
  vi.unstubAllGlobals();
  fs.rmSync(home, { recursive: true, force: true });
});

beforeEach(() => {
  hits.length = 0;
  asked.length = 0;
  authStatus = 200;
  fs.rmSync(path.join(home, ".synap"), { recursive: true, force: true });
});

async function savedProfile() {
  const { listPodProfiles } = await import("../src/lib/pod.js");
  return listPodProfiles().find((p) => p.config.podUrl === MANAGED)?.config;
}

async function saveProfile(keyExpiresAt: string) {
  const { addPodProfile } = await import("../src/lib/pod.js");
  addPodProfile("pod.antoinesrvt.synap.live", {
    podUrl: MANAGED,
    workspaceId: "",
    agentUserId: "c-1",
    hubApiKey: "old-computer-key",
    credential: "computer",
    keyExpiresAt,
    savedAt: new Date().toISOString(),
  });
}

const inDays = (d: number) => new Date(Date.now() + d * 86_400_000).toISOString();

describe("synap init on a managed pod", () => {
  it("connects this computer through the pod's device flow — not the retired exchange — and saves its key", async () => {
    tokenAnswer = { status: 200, body: GRANT };
    const { init } = await import("../src/commands/init.js");
    await init({ podUrl: MANAGED });

    expect(hits).toContain("POST /api/hub/setup/device");
    expect(hits).toContain("POST /api/hub/setup/device/token");
    expect(retiredHandshake()).toEqual([]);
    expect(await savedProfile()).toMatchObject({
      hubApiKey: "computer-key",
      credential: "computer",
      agentUserId: "c-1",
      keyExpiresAt: "2027-01-09T00:00:00.000Z",
    });
  });

  it("denied: nothing saved, the advanced ways are offered after a retry", async () => {
    tokenAnswer = { status: 400, body: { error: "access_denied" } };
    const { init } = await import("../src/commands/init.js");
    await init({ podUrl: MANAGED });
    expect(hits).toContain("POST /api/hub/setup/device/token");
    expect(await savedProfile()).toBeUndefined();
    expect(retiredHandshake()).toEqual([]);
    const menu = asked.find((q) => q.message === "How do you want to connect to this pod?");
    expect(menu?.choices?.map((c) => c.value)).toEqual(["device", "paste"]);
    expect(menu?.choices?.[0]?.title).toMatch(/again/);
  });
});

describe("renewing a computer key", () => {
  it("within 7 days of expiry: init connects this computer again and replaces the key", async () => {
    await saveProfile(inDays(3));
    tokenAnswer = { status: 200, body: GRANT };
    const { init } = await import("../src/commands/init.js");
    await init({ podUrl: MANAGED });
    expect(hits).toContain("POST /api/hub/setup/device");
    expect((await savedProfile())?.hubApiKey).toBe("computer-key");
  });

  it("expired (the pod refuses it): connects again", async () => {
    await saveProfile(inDays(-2));
    authStatus = 401;
    tokenAnswer = { status: 200, body: GRANT };
    const { init } = await import("../src/commands/init.js");
    await init({ podUrl: MANAGED });
    expect(hits).toContain("POST /api/hub/setup/device");
    expect((await savedProfile())?.hubApiKey).toBe("computer-key");
  });

  it("30 days left: the saved key is used, no device flow", async () => {
    await saveProfile(inDays(30));
    const { init } = await import("../src/commands/init.js");
    await init({ podUrl: MANAGED });
    expect(hits).not.toContain("POST /api/hub/setup/device");
    expect((await savedProfile())?.hubApiKey).toBe("old-computer-key");
  });

  it("unattended (--yes) and due: keeps the working key, never starts a device flow", async () => {
    await saveProfile(inDays(3));
    const { init } = await import("../src/commands/init.js");
    await init({ podUrl: MANAGED, yes: true });
    expect(hits).not.toContain("POST /api/hub/setup/device");
    expect((await savedProfile())?.hubApiKey).toBe("old-computer-key");
  });
});
