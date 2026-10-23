/**
 * `synap pods update` recreates a rejected key through the pod's device flow
 * (MACHINE-IDENTITY-PLAN W6) — it used to open the retired loopback
 * `browser-auth` flow. The new computer key is saved at the NEW url, the
 * profile's other fields are kept, and nothing is written when the person
 * does not approve. Driven through the real `podsUpdate()`, pod stubbed at `fetch`.
 *
 * Without a terminal it asks nothing and resolves false, naming the command to
 * run: a prompt on a closed stdin never answers, node then exited 0 mid-await,
 * and `synap doctor --fix` reported a fix that never happened (pod names v2
 * rehearsal, 2026-10-22).
 */

import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from "vitest";
import fs from "fs";
import prompts from "prompts";
import os from "os";
import path from "path";

const home = fs.mkdtempSync(path.join(os.tmpdir(), "synap-pods-update-"));
process.env.HOME = home;
process.env.USERPROFILE = home;
delete process.env.SYNAP_POD_URL;

vi.mock("prompts", () => ({ default: vi.fn(async () => ({ recreate: true })) }));
vi.mock("../src/lib/agent-detect.js", () => ({
  detectAgents: () => [{ target: "claude-code", label: "Claude Code", found: false }],
}));
vi.mock("../src/lib/approval-poll.js", async (orig) => {
  const real = await orig<typeof import("../src/lib/approval-poll.js")>();
  return { pollForApproval: (o: Parameters<typeof real.pollForApproval>[0]) => real.pollForApproval({ ...o, intervalMs: 1 }) };
});

const OLD = "https://pod.old.example";
const NEW = "https://pod.new.example";
const hits: string[] = [];
let tokenAnswer: { status: number; body: unknown };

const GRANT = {
  access_token: "computer-key",
  token_type: "Bearer",
  expires_in: 7776000,
  computer: { id: "c-2", name: "devbox", apiKey: "computer-key", keyId: "k", expiresAt: "2027-01-09T00:00:00.000Z" },
  agents: [],
};

beforeAll(() => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      const u = new URL(String(url));
      hits.push(`${init?.method ?? "GET"} ${u.origin}${u.pathname}`);
      const json = (status: number, body: unknown) =>
        new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
      if (u.pathname === "/health") return json(200, { status: "ok" });
      if (u.pathname === "/api/hub/users/me") return json(401, {});
      if (u.pathname === "/api/hub/auth/status") return json(200, {});
      if (u.pathname === "/api/hub/setup/device")
        return json(200, {
          device_code: "dc",
          user_code: "ABCD-EFGH",
          verification_uri: `${NEW}/device`,
          verification_uri_complete: `${NEW}/device?code=ABCD-EFGH`,
          expires_in: 600,
          interval: 5,
        });
      if (u.pathname === "/api/hub/setup/device/token") return json(tokenAnswer.status, tokenAnswer.body);
      throw new TypeError("fetch failed");
    })
  );
  vi.spyOn(console, "log").mockImplementation(() => undefined);
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});

const ttyBefore = Object.getOwnPropertyDescriptor(process.stdin, "isTTY");
function stdinIsTTY(value: boolean) {
  Object.defineProperty(process.stdin, "isTTY", { value, configurable: true });
}
afterAll(() => {
  if (ttyBefore) Object.defineProperty(process.stdin, "isTTY", ttyBefore);
  else delete (process.stdin as { isTTY?: boolean }).isTTY;
});

afterAll(() => {
  vi.unstubAllGlobals();
  fs.rmSync(home, { recursive: true, force: true });
});

beforeEach(async () => {
  hits.length = 0;
  stdinIsTTY(true);
  vi.mocked(prompts).mockClear();
  fs.rmSync(path.join(home, ".synap"), { recursive: true, force: true });
  const { addPodProfile } = await import("../src/lib/pod.js");
  // Another pod is active, so the update never propagates to surfaces here.
  addPodProfile("other", { podUrl: "https://pod.other.example", workspaceId: "", agentUserId: "", hubApiKey: "x", savedAt: "" });
  addPodProfile("team", {
    podUrl: OLD,
    podId: "pod-1",
    workspaceId: "ws-1",
    agentUserId: "c-1",
    hubApiKey: "old-key",
    label: "team pod",
    savedAt: "",
  });
});

async function team() {
  const { listPodProfiles } = await import("../src/lib/pod.js");
  return listPodProfiles().find((p) => p.name === "team")?.config;
}

describe("synap pods update with a rejected key", () => {
  it("connects this computer to the NEW url through the device flow and keeps the profile", async () => {
    tokenAnswer = { status: 200, body: GRANT };
    const { podsUpdate } = await import("../src/commands/pods.js");
    expect(await podsUpdate("team", NEW)).toBe(true);

    expect(hits).toContain(`POST ${NEW}/api/hub/setup/device`);
    expect(hits).toContain(`POST ${NEW}/api/hub/setup/device/token`);
    expect(hits.filter((h) => h.includes("/federation/") || h.includes("127.0.0.1"))).toEqual([]);
    expect(await team()).toMatchObject({
      podUrl: NEW,
      podId: "pod-1",
      label: "team pod",
      hubApiKey: "computer-key",
      agentUserId: "c-2",
      credential: "computer",
      keyExpiresAt: "2027-01-09T00:00:00.000Z",
    });
  });

  it("denied: the old profile is left exactly as it was", async () => {
    tokenAnswer = { status: 400, body: { error: "access_denied" } };
    const { podsUpdate } = await import("../src/commands/pods.js");
    expect(await podsUpdate("team", NEW)).toBe(false);

    expect(hits).toContain(`POST ${NEW}/api/hub/setup/device/token`);
    expect(await team()).toMatchObject({ podUrl: OLD, hubApiKey: "old-key", agentUserId: "c-1" });
  });
});

describe("synap pods update with a rejected key and no terminal", () => {
  function printed(): string {
    return vi
      .mocked(console.log)
      .mock.calls.map((c) => c.join(" "))
      .join("\n");
  }

  it("asks nothing, writes nothing, resolves false and names the command to run", async () => {
    stdinIsTTY(false);
    vi.mocked(console.log).mockClear();
    const { podsUpdate } = await import("../src/commands/pods.js");

    expect(await podsUpdate("team", NEW)).toBe(false);

    expect(prompts).not.toHaveBeenCalled();
    expect(hits.filter((h) => h.includes("/setup/device"))).toEqual([]);
    expect(await team()).toMatchObject({ podUrl: OLD, hubApiKey: "old-key", agentUserId: "c-1" });
    expect(printed()).toContain(`synap pods update team ${NEW}`);
  });

  it("--yes: the same, even in a terminal", async () => {
    const { podsUpdate } = await import("../src/commands/pods.js");

    expect(await podsUpdate("team", NEW, { yes: true })).toBe(false);

    expect(prompts).not.toHaveBeenCalled();
    expect(await team()).toMatchObject({ podUrl: OLD, hubApiKey: "old-key" });
  });
});
