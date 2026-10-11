/**
 * A sign-in that yields no key must say WHY: "no access" only for a 401/403
 * from the pod's sign-in exchange; any other failure is the pod's own fault.
 * Folding the two once told the founder "your account may not have access"
 * while his pod was answering 503 POD_SESSION_MINT_FAILED (2026-10-11).
 */

import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";

const home = fs.mkdtempSync(path.join(os.tmpdir(), "synap-pod-error-"));
process.env.HOME = home;
process.env.USERPROFILE = home;
delete process.env.SYNAP_POD_URL;

vi.mock("prompts", () => ({ default: vi.fn(async () => ({})) }));
vi.mock("child_process", async (orig) => ({
  ...(await orig<typeof import("child_process")>()),
  execSync: vi.fn(() => Buffer.from("")),
}));
vi.mock("../src/lib/auth.js", async (orig) => ({
  ...(await orig<typeof import("../src/lib/auth.js")>()),
  getStoredToken: () => ({ token: "cp", expiresAt: new Date(Date.now() + 3_600_000).toISOString() }),
  isLoggedIn: async () => ({ valid: true }),
  login: async () => null,
}));

let exchangeStatus = 503;
vi.mock("../src/lib/pod.js", async (orig) => {
  const real = await orig<typeof import("../src/lib/pod.js")>();
  return {
    ...real,
    provisionUserOnPod: vi.fn(async () => {
      throw new real.PodExchangeError(exchangeStatus, `Pod issuer assertion exchange failed (HTTP ${exchangeStatus})`);
    }),
  };
});

const printed: string[] = [];
const MANAGED = "https://pod.antoinesrvt.synap.live";
const realPlatform = process.platform;

beforeAll(() => {
  Object.defineProperty(process, "platform", { value: "linux" });
  Object.defineProperty(process.stdin, "isTTY", { value: true, configurable: true });
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      const u = new URL(String(url));
      if (u.pathname === "/health" && /synap\.live$/.test(u.hostname)) {
        return new Response(JSON.stringify({ status: "ok" }), { status: 200 });
      }
      throw new TypeError("fetch failed");
    })
  );
  vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);
  const capture = (...a: unknown[]) => void printed.push(a.map(String).join(" "));
  vi.spyOn(console, "log").mockImplementation(capture);
  vi.spyOn(console, "warn").mockImplementation(capture);
  vi.spyOn(console, "error").mockImplementation(capture);
});

afterAll(() => {
  Object.defineProperty(process, "platform", { value: realPlatform });
  vi.unstubAllGlobals();
  fs.rmSync(home, { recursive: true, force: true });
});

beforeEach(() => {
  printed.length = 0;
});

async function runInit() {
  const { init } = await import("../src/commands/init.js");
  await init({ podUrl: MANAGED });
}

describe("a failed key after sign-in names its cause", () => {
  it("a 5xx from the pod is a pod problem, not missing access", async () => {
    exchangeStatus = 503;
    await runInit();
    const out = printed.join("\n");
    expect(out).toMatch(/pod failed to issue a key/);
    expect(out).not.toMatch(/no access to this pod/);
  });

  it("a 403 from the pod is missing access", async () => {
    exchangeStatus = 403;
    await runInit();
    const out = printed.join("\n");
    expect(out).toMatch(/no access to this pod/);
    expect(out).not.toMatch(/pod failed to issue a key/);
  });
});
