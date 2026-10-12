/**
 * S4 — a pod's refusal is not "unreachable".
 *
 * The defect: any non-OK answer from /auth/key-state other than 404 read as
 * `unreachable`, which `writeGate` ALLOWS (an unreachable pod is "not
 * evidence"). A guest's key gets 403 there, so the gate wrote a key the pod
 * refuses. Drives the real `fetchKeyState` → `writeGate` with a stubbed fetch.
 */

import { describe, it, expect } from "vitest";
import { fetchKeyState, writeGate, assertKeyWritable, KeyNotLiveError } from "../src/lib/key-state.js";

const POD = "https://pod.example.test";
const answering = (status: number, body: unknown = { error: "x" }) => async () => new Response(JSON.stringify(body), { status });

describe("fetchKeyState: refusal vs unreachable", () => {
  for (const status of [401, 403, 400]) {
    it(`HTTP ${status} is a refusal (inactive) and the write gate refuses it`, async () => {
      const s = await fetchKeyState(POD, "k", { fetch: answering(status) });
      expect(s.state).toBe("inactive");
      expect(s.legacy).toBeFalsy();
      expect(writeGate(s).allow).toBe(false);
      await expect(assertKeyWritable(POD, "k", { fetch: answering(status) })).rejects.toBeInstanceOf(KeyNotLiveError);
    });
  }

  for (const status of [500, 502, 503, 429]) {
    it(`HTTP ${status} is unreachable (not evidence about the key)`, async () => {
      expect((await fetchKeyState(POD, "k", { fetch: answering(status) })).state).toBe("unreachable");
    });
  }

  it("a network error is unreachable", async () => {
    const s = await fetchKeyState(POD, "k", { fetch: async () => { throw new TypeError("fetch failed"); } });
    expect(s.state).toBe("unreachable");
  });

  it("older pod: 403 on the /auth/status fallback is a refusal too", async () => {
    const f = async (url: string) => new Response("{}", { status: url.endsWith("/key-state") ? 404 : 403 });
    const s = await fetchKeyState(POD, "k", { fetch: f });
    expect(s.state).toBe("inactive");
    expect(writeGate(s).allow).toBe(false);
  });

  it("a pod with neither door (404 on both) cannot be asked — unreachable, not a refusal", async () => {
    const s = await fetchKeyState(POD, "k", { fetch: answering(404) });
    expect(s.state).toBe("unreachable");
  });
});
