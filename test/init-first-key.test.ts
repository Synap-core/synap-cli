/**
 * A workstation connecting to a pod it does not host (the devbox case,
 * 2026-10-11): linux + docker is not a pod host, and the first key is offered
 * as "Sign in to Synap" first, the advanced ways (paste, PROVISIONING_TOKEN)
 * last. Driven through the real `init()` with the terminal, docker and the
 * Synap account stubbed at their seams.
 */

import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";

// A throwaway HOME before any module reads ~/.synap.
const home = fs.mkdtempSync(path.join(os.tmpdir(), "synap-first-key-"));
process.env.HOME = home;
process.env.USERPROFILE = home;
delete process.env.SYNAP_POD_URL;

type Asked = { type: string; name: string; message: string; choices?: Array<{ value: string }> };
const asked: Asked[] = [];
vi.mock("prompts", () => ({
  default: vi.fn(async (q: Asked) => {
    asked.push(q);
    return {}; // nobody answers: every flow stops at its first question
  }),
}));

// docker info succeeds: this "is" a linux box with docker.
vi.mock("child_process", async (orig) => ({
  ...(await orig<typeof import("child_process")>()),
  execSync: vi.fn(() => Buffer.from("")),
}));

const loginCalls: string[] = [];
vi.mock("../src/lib/auth.js", async (orig) => ({
  ...(await orig<typeof import("../src/lib/auth.js")>()),
  getStoredToken: () => null,
  isLoggedIn: async () => ({ valid: false }),
  login: async () => (loginCalls.push("login"), null),
}));

import { chooseInitFlow, keyChoices } from "../src/lib/init-flow.js";

const MANAGED = "https://pod.antoinesrvt.synap.live";
const realPlatform = process.platform;

beforeAll(() => {
  Object.defineProperty(process, "platform", { value: "linux" });
  Object.defineProperty(process.stdin, "isTTY", { value: true, configurable: true });
  vi.stubGlobal(
    "fetch",
    // Only the two remote pods answer; nothing runs on this machine.
    vi.fn(async (url: string) => {
      const u = new URL(String(url));
      if (u.pathname === "/health" && /synap\.live$|example\.com$/.test(u.hostname)) {
        return new Response(JSON.stringify({ status: "ok" }), { status: 200 });
      }
      throw new TypeError("fetch failed");
    })
  );
  vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);
  vi.spyOn(console, "log").mockImplementation(() => undefined);
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});

afterAll(() => {
  Object.defineProperty(process, "platform", { value: realPlatform });
  vi.unstubAllGlobals();
  fs.rmSync(home, { recursive: true, force: true });
});

beforeEach(() => {
  asked.length = 0;
  loginCalls.length = 0;
});

describe("chooseInitFlow: a server only when a pod runs here", () => {
  const base = { linuxDocker: true, agentsRequested: false };

  it("linux + docker with a synap.live --pod-url is a workstation", () => {
    expect(chooseInitFlow({ ...base, podUrl: MANAGED, localPodUrl: null })).toBe("desktop");
    // even if something answers locally: a synap.live pod is never on this machine
    expect(chooseInitFlow({ ...base, podUrl: MANAGED, localPodUrl: "http://localhost:4000" })).toBe("desktop");
  });

  it("linux + docker with a remote --pod-url and no local pod is a workstation", () => {
    expect(chooseInitFlow({ ...base, podUrl: "https://pod.example.com", localPodUrl: null })).toBe("desktop");
  });

  it("linux + docker with no pod at all is a workstation", () => {
    expect(chooseInitFlow({ ...base, localPodUrl: null })).toBe("desktop");
  });

  it("a pod running on this machine is a server", () => {
    expect(chooseInitFlow({ ...base, localPodUrl: "http://localhost:4000" })).toBe("server");
    expect(
      chooseInitFlow({ ...base, podUrl: "https://pod.example.com", localPodUrl: "http://localhost" })
    ).toBe("server");
  });

  it("--agents, or no docker, is always the desktop flow", () => {
    expect(chooseInitFlow({ ...base, agentsRequested: true, localPodUrl: "http://localhost" })).toBe("desktop");
    expect(chooseInitFlow({ linuxDocker: false, agentsRequested: false, localPodUrl: "http://localhost" })).toBe(
      "desktop"
    );
  });
});

describe("keyChoices: connect this computer first, advanced last", () => {
  const fresh = { deviceTried: false, deviceAvailable: true };

  it("self-hosted pod: connect this computer, then paste — never the bootstrap-only PROVISIONING_TOKEN", () => {
    const c = keyChoices({ managed: false, ...fresh });
    expect(c.map((x) => x.value)).toEqual(["device", "paste"]);
    expect(c[0].title).toMatch(/recommended/);
    expect(c.slice(1).every((x) => /^Advanced/.test(x.title))).toBe(true);
  });

  it("synap.live pod: no PROVISIONING_TOKEN (it has no .env)", () => {
    expect(keyChoices({ managed: true, ...fresh }).map((x) => x.value)).toEqual(["device", "paste"]);
  });

  it("after a denied or expired code: offered again as a retry, first", () => {
    const c = keyChoices({ managed: false, deviceTried: true, deviceAvailable: true });
    expect(c.map((x) => x.value)).toEqual(["device", "paste"]);
    expect(c[0].title).toMatch(/again/);
  });

  it("a pod too old for the device flow: only the advanced ways", () => {
    expect(keyChoices({ managed: false, deviceTried: true, deviceAvailable: false }).map((x) => x.value)).toEqual(["paste"]);
  });
});

describe("synap init on a linux + docker workstation", () => {
  async function runInit(podUrl: string) {
    const { init } = await import("../src/commands/init.js");
    await init({ podUrl });
  }

  it("a synap.live pod: no account sign-in; connects this computer first; never asks for a PROVISIONING_TOKEN", async () => {
    await runInit(MANAGED);
    expect(loginCalls).toEqual([]); // the pod's own device flow, not the CP session
    const select = asked.find((q) => q.type === "select");
    expect(select?.message).toBe("How do you want to connect to this pod?");
    expect(select?.choices?.map((c) => c.value)).toEqual(["device", "paste"]);
    expect(asked.some((q) => /PROVISIONING_TOKEN/.test(q.message))).toBe(false);
  });

  it("a self-hosted pod not on this machine: connect this computer first, advanced last", async () => {
    await runInit("https://pod.example.com");
    expect(loginCalls).toEqual([]);
    expect(asked[0]?.message).toBe("How do you want to connect to this pod?");
    expect(asked[0]?.choices?.map((c) => c.value)).toEqual(["device", "paste"]);
  });
});
