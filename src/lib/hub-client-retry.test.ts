import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { hubDelete, hubGet, hubPatch, hubPost, type HubConfig } from "./hub-client.js";

const cfg = { podUrl: "https://pod.example.test", apiKey: "k", userId: "cli" } as HubConfig;

/**
 * AbortSignal.timeout() runs on Node's own timers, which fake timers do not
 * move. Rebuild it on setTimeout so the test clock drives it exactly as the
 * real clock drives the real one.
 */
function fakeClockTimeoutSignal() {
  vi.spyOn(AbortSignal, "timeout").mockImplementation((ms: number) => {
    const c = new AbortController();
    setTimeout(() => c.abort(new DOMException("timed out", "TimeoutError")), ms);
    return c.signal;
  });
}

describe("hub calls retry a 429 with a fresh timeout per attempt", () => {
  let calls: number;
  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(console, "error").mockImplementation(() => {});
    fakeClockTimeoutSignal();
    calls = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init: RequestInit) => {
        calls++;
        if (init.signal?.aborted) throw init.signal.reason;
        if (calls === 1) {
          return new Response("slow down", { status: 429, headers: { "Retry-After": "20" } });
        }
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      })
    );
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  const cases: Array<[string, () => Promise<unknown>]> = [
    ["GET", () => hubGet("/x", {}, cfg)],
    ["POST", () => hubPost("/x", {}, cfg)],
    ["PATCH", () => hubPatch("/x", {}, cfg)],
    ["DELETE", () => hubDelete("/x", cfg)],
  ];
  for (const [name, run] of cases) {
    it(`${name} succeeds after waiting 20s on a 429 with a 15s timeout`, async () => {
      const p = run();
      // Settle first so a rejection is never left unhandled while time advances.
      const settled = p.then(
        (v) => ({ v }),
        (e) => ({ e })
      );
      await vi.advanceTimersByTimeAsync(21_000);
      const out = await settled;
      expect(out).toEqual({ v: { ok: true } });
      expect(calls).toBe(2);
    });
  }
});
