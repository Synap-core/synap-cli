/**
 * `login()` on a box with no browser (SSH, a server): the link and the code
 * are printed as THE instruction, whether or not a browser opens. Opening a
 * browser never throws and never decides what gets printed.
 */

import { describe, it, expect, vi, beforeEach, afterAll } from "vitest";

let openFails = true;
vi.mock("node:child_process", async (orig) => ({
  ...(await orig<typeof import("node:child_process")>()),
  execSync: vi.fn(() => {
    if (openFails) throw new Error("xdg-open: not found");
    return Buffer.from("");
  }),
}));
const pollOpts: Array<{ timeoutMs?: number }> = [];
vi.mock("../src/lib/approval-poll.js", () => ({
  pollForApproval: vi.fn(async (o: { timeoutMs?: number }) => {
    pollOpts.push(o);
    throw new Error("timed out");
  }),
}));
let created: Record<string, unknown> = {};

let printed = "";
beforeEach(() => {
  printed = "";
  pollOpts.length = 0;
  created = { requestId: "req-1", pollSecret: "s", userCode: "WXYZ-1234" };
  vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => void (printed += a.join(" ") + "\n"));
  vi.stubGlobal(
    "fetch",
    vi.fn(async () =>
      new Response(JSON.stringify(created), { status: 200 })
    )
  );
});
afterAll(() => vi.unstubAllGlobals());

describe("login() prints the link and the code", () => {
  for (const fails of [true, false]) {
    it(`browser open ${fails ? "fails" : "works"}: link + code still printed`, async () => {
      openFails = fails;
      const { login } = await import("../src/lib/auth.js");
      expect(await login()).toBeNull();
      expect(printed).toMatch(/\/cli\?request=req-1/);
      expect(printed).toMatch(/WXYZ-1234/);
    });
  }

  it("openBrowser never throws", async () => {
    openFails = true;
    const { openBrowser } = await import("../src/lib/auth.js");
    expect(() => openBrowser("https://synap.live/cli")).not.toThrow();
  });

  it("waits until the request expires (the CP's expiresAt), not 2 minutes", async () => {
    created.expiresAt = new Date(Date.now() + 14 * 60_000).toISOString();
    const { login } = await import("../src/lib/auth.js");
    await login();
    expect(pollOpts[0].timeoutMs).toBeGreaterThan(13 * 60_000);
    expect(pollOpts[0].timeoutMs).toBeLessThanOrEqual(14 * 60_000);
  });

  it("without an expiresAt: the CP's 15-minute TTL", async () => {
    const { login } = await import("../src/lib/auth.js");
    await login();
    expect(pollOpts[0].timeoutMs).toBe(15 * 60_000);
  });
});
