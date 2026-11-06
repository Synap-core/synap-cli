/**
 * Every Hub verb shares pacing + 429 retry, and an
 * unreachable pod is never read as an invalid key.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { hubPatch, hubDelete, type HubConfig } from "../src/lib/hub-client.js";
import { probeAuthStatus } from "../src/lib/credential-class.js";

const cfg = { podUrl: "https://pod.example.test", apiKey: "k", userId: "u" } as HubConfig;

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("PATCH and DELETE retry once on 429 with Retry-After", () => {
  for (const [name, call] of [
    ["PATCH", () => hubPatch("/x", { a: 1 }, cfg)],
    ["DELETE", () => hubDelete("/x", cfg)],
  ] as const) {
    it(`${name} waits out a 429 and succeeds on the retry`, async () => {
      vi.useFakeTimers();
      const fetchSpy = vi
        .fn()
        .mockResolvedValueOnce(new Response("{}", { status: 429, headers: { "retry-after": "1" } }))
        .mockResolvedValueOnce(new Response("{}", { status: 200 }));
      vi.stubGlobal("fetch", fetchSpy);
      vi.spyOn(console, "error").mockImplementation(() => {});
      const done = call();
      await vi.advanceTimersByTimeAsync(5_000);
      await expect(done).resolves.toEqual({});
      expect(fetchSpy).toHaveBeenCalledTimes(2);
    });
  }
});

describe("probeAuthStatus: valid / invalid / unreachable", () => {
  it("200 is valid", async () => {
    vi.stubGlobal("fetch", async () => new Response("{}", { status: 200 }));
    expect(await probeAuthStatus(cfg)).toBe("valid");
  });
  it("401 is invalid", async () => {
    vi.stubGlobal("fetch", async () => new Response("{}", { status: 401 }));
    expect(await probeAuthStatus(cfg)).toBe("invalid");
  });
  it("a network error is unreachable, not invalid", async () => {
    vi.stubGlobal("fetch", async () => {
      throw new TypeError("fetch failed");
    });
    expect(await probeAuthStatus(cfg)).toBe("unreachable");
  });
  it("a 502 is unreachable, not invalid", async () => {
    vi.stubGlobal("fetch", async () => new Response("bad gateway", { status: 502 }));
    expect(await probeAuthStatus(cfg)).toBe("unreachable");
  });
});
