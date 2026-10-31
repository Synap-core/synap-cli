/**
 * The device flow (MACHINE-IDENTITY-PLAN W4): the CLI asks the pod to connect
 * this computer, shows where to approve it, and polls RFC 8628-style until it
 * is approved, denied or expired. Driven against a fake pod on loopback with
 * the real fetch and the real shared poll loop; the clock is shrunk with
 * `timeScale` (the pod's 5 s interval → 100 ms).
 */

import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from "vitest";
import http from "http";
import fs from "fs";
import os from "os";
import path from "path";
import type { AddressInfo } from "net";

const home = fs.mkdtempSync(path.join(os.tmpdir(), "synap-device-"));
process.env.HOME = home;
process.env.USERPROFILE = home;

// `claude mcp add` is not on a test box: the installer prints the by-hand line.
vi.mock("child_process", async (orig) => ({
  ...(await orig<typeof import("child_process")>()),
  execFileSync: vi.fn(() => {
    throw new Error("no claude binary");
  }),
}));

import {
  deviceConnect,
  deviceAgentsFor,
  computerKeyNeedsRenewal,
  ensureComputerEnrolled,
} from "../src/lib/device-connect.js";

const SCALE = 0.02; // 5 s → 100 ms

/** What the token endpoint answers, one entry per poll; the last repeats. */
let script: Array<{ status: number; body: unknown }> = [];
let started: Array<Record<string, unknown>> = [];
let tokenPolls: number[] = [];
let other: string[] = [];
let server: http.Server;
let podUrl: string;

const GRANT = {
  access_token: "computer-key",
  token_type: "Bearer",
  expires_in: 7776000,
  computer: { id: "c-1", name: "devbox", apiKey: "computer-key", keyId: "k-c", expiresAt: "2027-01-09T00:00:00.000Z" },
  agents: [
    {
      agentType: "claude-code",
      agentUserId: "a-cc",
      name: "Claude Code",
      displayName: "Claude Code on devbox",
      apiKey: "claude-code-key",
      keyId: "k-cc",
      expiresAt: "2027-01-09T00:00:00.000Z",
    },
  ],
};
const pending = { status: 400, body: { error: "authorization_pending", error_description: "Waiting." } };

beforeAll(async () => {
  server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (d) => (raw += d));
    req.on("end", () => {
      const json = (status: number, body: unknown) => {
        res.writeHead(status, { "Content-Type": "application/json" });
        res.end(JSON.stringify(body));
      };
      if (req.method === "POST" && req.url === "/api/hub/setup/device") {
        started.push(JSON.parse(raw));
        return json(200, {
          device_code: "dev-code",
          user_code: "ABCD-EFGH",
          verification_uri: `${podUrl}/device`,
          verification_uri_complete: `${podUrl}/device?code=ABCD-EFGH`,
          expires_in: 600,
          interval: 5,
        });
      }
      if (req.method === "POST" && req.url === "/api/hub/setup/device/token") {
        expect(JSON.parse(raw)).toEqual({ device_code: "dev-code" });
        tokenPolls.push(Date.now());
        const next = script.length > 1 ? script.shift()! : script[0]!;
        return json(next.status, next.body);
      }
      other.push(`${req.method} ${req.url}`);
      if (req.url === "/api/hub/users/me") return json(200, { id: "human-1", scopes: [] });
      if (req.url === "/api/hub/workspaces/enroll-agent") return json(200, { enrolled: [] });
      if (req.url?.startsWith("/mcp")) return json(500, { error: "not in this test" });
      return json(404, { error: "no" });
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  podUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(() => {
  server.close();
  fs.rmSync(home, { recursive: true, force: true });
});

const printed: string[] = [];
beforeEach(() => {
  started = [];
  tokenPolls = [];
  other = [];
  printed.length = 0;
  vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => void printed.push(a.map(String).join(" ")));
  vi.spyOn(console, "error").mockImplementation((...a: unknown[]) => void printed.push(a.map(String).join(" ")));
});

const qr = vi.fn(async (text: string) => `[QR ${text}]`);

describe("deviceConnect", () => {
  it("prints the link + code, waits through pending and slow_down (interval grows), then returns the keys", async () => {
    script = [
      pending,
      { status: 400, body: { error: "slow_down", error_description: "Slow down.", interval: 10 } },
      pending,
      { status: 200, body: GRANT },
    ];
    const outcome = await deviceConnect(
      podUrl,
      { agents: ["claude-code", "legacy-agent", "codex", "claude-code"], hostname: "devbox", platform: "linux" },
      { renderQr: qr, timeScale: SCALE }
    );

    expect(outcome.status).toBe("approved");
    if (outcome.status !== "approved") return;
    expect(outcome.grant.computer.apiKey).toBe("computer-key");
    expect(outcome.grant.agents.map((a) => a.apiKey)).toEqual(["claude-code-key"]);

    // Asked for what the pod accepts: legacy-agent is not a device agent, dupes go.
    expect(started[0]).toMatchObject({ clientName: "Synap CLI", hostname: "devbox", platform: "linux", agents: ["claude-code", "codex"] });

    const out = printed.join("\n");
    expect(out).toContain(`Open ${podUrl}/device on any device and enter ABCD-EFGH`);
    expect(out).toContain(`${podUrl}/device?code=ABCD-EFGH`);
    expect(qr).toHaveBeenCalledWith(`${podUrl}/device?code=ABCD-EFGH`);

    // 4 polls; the gap after slow_down is the new interval (10 s → 200 ms), not 5 s.
    expect(tokenPolls).toHaveLength(4);
    const gapBefore = tokenPolls[1]! - tokenPolls[0]!;
    const gapAfter = tokenPolls[2]! - tokenPolls[1]!;
    expect(gapBefore).toBeLessThan(170);
    expect(gapAfter).toBeGreaterThanOrEqual(185);
  });

  it("asks under this computer's name, the one its keys carry: no `.local`, SYNAP_COMPUTER_NAME honoured", async () => {
    script = [{ status: 200, body: GRANT }];
    vi.stubEnv("SYNAP_COMPUTER_NAME", "MacBook-Pro-de-Antoine");
    await deviceConnect(podUrl, { agents: [] }, { renderQr: qr, timeScale: SCALE });
    vi.unstubAllEnvs();
    expect(started[0]!.hostname).toBe("MacBook-Pro-de-Antoine");
    script = [{ status: 200, body: GRANT }];
    await deviceConnect(podUrl, { agents: [] }, { renderQr: qr, timeScale: SCALE });
    expect(started[1]!.hostname).toBe(os.hostname().split(".")[0]);
  });

  it("denied on the pod → denied, naming the pod", async () => {
    script = [pending, { status: 400, body: { error: "access_denied", error_description: "Denied." } }];
    const outcome = await deviceConnect(podUrl, { agents: [] }, { renderQr: qr, timeScale: SCALE });
    expect(outcome).toEqual({ status: "denied", message: `Denied on ${new URL(podUrl).host}.` });
  });

  it("expired_token → expired, run again", async () => {
    script = [{ status: 400, body: { error: "expired_token", error_description: "Expired." } }];
    const outcome = await deviceConnect(podUrl, { agents: [] }, { renderQr: qr, timeScale: SCALE });
    expect(outcome).toEqual({ status: "expired", message: "Code expired — run again." });
  });

  it("nobody approves before expires_in → expired (polls until then, not a fixed 2 min)", async () => {
    script = [pending];
    const outcome = await deviceConnect(podUrl, { agents: [] }, { renderQr: qr, timeScale: 0.001 });
    expect(outcome.status).toBe("expired");
    // expires_in 600 s * 0.001 = 600 ms: it kept asking until the code died.
    expect(tokenPolls.length).toBeGreaterThan(2);
    expect(tokenPolls.at(-1)! - tokenPolls[0]!).toBeGreaterThanOrEqual(350);
  });
});

describe("saving what the pod returned", () => {
  it("the computer key becomes the pod profile; each agent key lands in its client config", async () => {
    const { saveDeviceGrant, wireApprovedAgents } = await import("../src/lib/device-connect.js");
    const { listPodProfiles, getSurfaceAgentKey } = await import("../src/lib/pod.js");

    await saveDeviceGrant(podUrl, GRANT, { name: "devpod" });
    const profile = listPodProfiles().find((p) => p.name === "devpod")!.config;
    expect(profile).toMatchObject({
      podUrl,
      hubApiKey: "computer-key",
      agentUserId: "c-1",
      credential: "computer",
      computerName: "devbox",
      keyExpiresAt: "2027-01-09T00:00:00.000Z",
    });
    expect(getSurfaceAgentKey("claude-code", podUrl)).toMatchObject({ hubApiKey: "claude-code-key", agentUserId: "a-cc" });

    // The installer `synap connect` runs writes the AGENT's key into Claude
    // Code's settings — and mints nothing (no /setup/agent call).
    await wireApprovedAgents(podUrl, "computer-key", GRANT);
    const settings = JSON.parse(fs.readFileSync(path.join(home, ".claude", "settings.json"), "utf-8"));
    expect(settings.env.SYNAP_HUB_API_KEY).toBe("claude-code-key");
    expect(settings.env.SYNAP_POD_URL).toBe(podUrl);
    expect(other.some((h) => h.includes("/setup/agent"))).toBe(false);
  }, 60_000);
});

describe("agents approved with the computer are not asked for again", () => {
  it("approveAgentKeysAtOnce mints nothing for an agent the device flow already approved", async () => {
    const { presetApprovedKey, approveAgentKeysAtOnce, takePreApprovedKey } = await import("../src/lib/batch-approval.js");
    presetApprovedKey("codex", { hubApiKey: "codex-key", agentUserId: "a-cx" });
    const provision = vi.fn(async () => ({ hubApiKey: "fresh", agentUserId: "x", reused: false }));
    const result = await approveAgentKeysAtOnce(podUrl, "computer-key", ["codex"], { provision });
    expect(provision).not.toHaveBeenCalled();
    expect(result.notApproved).toEqual([]);
    expect(takePreApprovedKey("codex")).toEqual({ hubApiKey: "codex-key", agentUserId: "a-cx" });
  });
});

describe("pure helpers", () => {
  it("deviceAgentsFor keeps only the pod's surface agent types", () => {
    expect(deviceAgentsFor(["legacy-agent", "cursor", "cursor", "nope", "codex"])).toEqual(["cursor", "codex"]);
  });

  it("a computer key is due for renewal 7 days before it expires, and after", () => {
    const now = Date.parse("2026-10-11T00:00:00Z");
    const inDays = (d: number) => new Date(now + d * 86_400_000).toISOString();
    expect(computerKeyNeedsRenewal({ keyExpiresAt: inDays(30) }, now)).toBe(false);
    expect(computerKeyNeedsRenewal({ keyExpiresAt: inDays(8) }, now)).toBe(false);
    expect(computerKeyNeedsRenewal({ keyExpiresAt: inDays(6) }, now)).toBe(true);
    expect(computerKeyNeedsRenewal({ keyExpiresAt: inDays(-1) }, now)).toBe(true);
    expect(computerKeyNeedsRenewal({}, now)).toBe(false); // a pasted key: no expiry known
  });
});

describe("enrol first: an agent belongs on an enrolled computer", () => {
  const pod = "https://pod.test";
  const profile = (credential?: "computer") => ({
    name: "home",
    config: { podUrl: `${pod}/`, hubApiKey: credential ? "computer-key" : "human-key", workspaceId: "", agentUserId: "", savedAt: "", ...(credential ? { credential } : {}) },
  });

  it("enrolled: the computer's own key, nothing asked", async () => {
    const connect = vi.fn();
    const r = await ensureComputerEnrolled(pod, "run this again", { profiles: () => [profile("computer")], interactive: true, connect });
    expect(r).toEqual({ enrolled: true, computerKey: "computer-key" });
    expect(connect).not.toHaveBeenCalled();
  });

  it("a person's key, nobody at the terminal: stops with how to enrol, connects nothing", async () => {
    const connect = vi.fn();
    const r = await ensureComputerEnrolled(pod, "run this again", { profiles: () => [profile()], interactive: false, connect });
    expect(r).toEqual({
      enrolled: false,
      message: expect.stringContaining("This computer is not enrolled on pod.test: run `synap login --reconnect home` to connect it, then run this again."),
    });
    expect(connect).not.toHaveBeenCalled();
  });

  it("no saved pod at all: `synap init`", async () => {
    const r = await ensureComputerEnrolled(pod, "run this again", { profiles: () => [], interactive: true });
    expect(r.enrolled).toBe(false);
    if (!r.enrolled) expect(r.message).toContain("run `synap init`");
  });

  it("a person at the terminal is offered the device flow; approved, the new computer key is used", async () => {
    const connect = vi.fn(async () => ({ ...profile("computer").config, hubApiKey: "new-computer-key", credential: "computer" as const }));
    const r = await ensureComputerEnrolled(pod, "run this again", {
      profiles: () => [profile()],
      interactive: true,
      confirm: async () => true,
      connect,
    });
    expect(connect).toHaveBeenCalledWith(pod, { name: "home" });
    expect(r).toEqual({ enrolled: true, computerKey: "new-computer-key" });
  });

  it("declined, or the device flow did not finish: still not enrolled", async () => {
    const connect = vi.fn(async () => null);
    const no = await ensureComputerEnrolled(pod, "x", { profiles: () => [profile()], interactive: true, confirm: async () => false, connect });
    expect(no.enrolled).toBe(false);
    expect(connect).not.toHaveBeenCalled();
    const failed = await ensureComputerEnrolled(pod, "x", { profiles: () => [profile()], interactive: true, confirm: async () => true, connect });
    expect(failed.enrolled).toBe(false);
  });
});
