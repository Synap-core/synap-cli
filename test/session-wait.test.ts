/**
 * `synap session wait <sessionId>` — pins:
 *   • an answer arriving on the immediate check, or on a later poll tick,
 *     both resolve without a timeout;
 *   • a timeout while the door keeps returning a clean empty page (never an
 *     error along the way) resolves as TIMEOUT, not FAILURE;
 *   • a 500/non-2xx response is a FAILED read, never folded into "no answer
 *     yet" — it resolves as FAILURE even though the deadline hasn't elapsed;
 *   • `--since` is forwarded to the door on the very first request.
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import { waitForAnswers, SessionWaitReadFailure } from "../src/commands/session-wait.js";
import type { HubConfig } from "../src/lib/hub-client.js";

const CFG: HubConfig = {
  podUrl: "https://pod.example.test",
  apiKey: "test-key",
  userId: "user-1",
};

const SESSION_ID = "11111111-1111-1111-1111-111111111111";

function emptyPage(since: string | null = null) {
  return { sessionId: SESSION_ID, since, answers: [], nextSince: since, hasMore: false };
}

function pageWithAnswer(since: string | null = null) {
  return {
    sessionId: SESSION_ID,
    since,
    answers: [
      {
        id: "msg-1",
        text: "EU, please use the Ireland region.",
        answeredAt: "2026-09-25T16:00:00.000Z",
        answeredBy: "owner-user-1",
        messageId: "msg-1",
        slot: { label: "Stripe key", kind: "document", question: "EU or US?" },
        question: null,
      },
    ],
    nextSince: "2026-09-25T16:00:00.000Z",
    hasMore: false,
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("waitForAnswers", () => {
  it("returns immediately when the first check already has an answer — no poll tick spent", async () => {
    const fetchMock = vi.fn(async () => jsonResponse(pageWithAnswer()));
    vi.stubGlobal("fetch", fetchMock);

    const res = await waitForAnswers(SESSION_ID, CFG, {
      since: "2026-09-25T15:00:00.000Z",
      timeoutMs: 5_000,
      intervalMs: 5_000,
    });

    expect(res.answers).toHaveLength(1);
    expect(res.answers[0]?.text).toContain("Ireland");
    expect(res.nextSince).toBe("2026-09-25T16:00:00.000Z");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("forwards --since on the very first request", async () => {
    const fetchMock = vi.fn(async () => jsonResponse(emptyPage("2026-09-25T15:00:00.000Z")));
    vi.stubGlobal("fetch", fetchMock);

    await waitForAnswers(SESSION_ID, CFG, {
      since: "2026-09-25T15:00:00.000Z",
      timeoutMs: 10,
      intervalMs: 5,
    });

    const firstUrl = String(fetchMock.mock.calls[0]?.[0]);
    expect(firstUrl).toContain(`since=${encodeURIComponent("2026-09-25T15:00:00.000Z")}`);
  });

  it("polls an empty page until an answer lands on a later tick", async () => {
    let call = 0;
    const fetchMock = vi.fn(async () => {
      call++;
      if (call <= 2) return jsonResponse(emptyPage());
      return jsonResponse(pageWithAnswer());
    });
    vi.stubGlobal("fetch", fetchMock);

    const res = await waitForAnswers(SESSION_ID, CFG, {
      timeoutMs: 2_000,
      intervalMs: 5,
    });

    expect(res.answers).toHaveLength(1);
    expect(call).toBeGreaterThan(2);
  });

  it("times out cleanly when the door only ever returns an empty page — no error thrown", async () => {
    const fetchMock = vi.fn(async () => jsonResponse(emptyPage("2026-09-25T15:00:00.000Z")));
    vi.stubGlobal("fetch", fetchMock);

    const res = await waitForAnswers(SESSION_ID, CFG, {
      timeoutMs: 30,
      intervalMs: 10,
    });

    expect(res.answers).toHaveLength(0);
    expect(res.nextSince).toBe("2026-09-25T15:00:00.000Z");
  });

  it("a 500 on the immediate check is a FAILED read, not a timeout", async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ error: "read failed" }, 500));
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      waitForAnswers(SESSION_ID, CFG, { timeoutMs: 5_000, intervalMs: 5_000 })
    ).rejects.toThrow();
    // HubError from hubGet — not our SessionWaitReadFailure, since this is the
    // immediate check going through hubGet directly (surfaces as-is).
  });

  it("repeated 500s during polling raise SessionWaitReadFailure well before the deadline", async () => {
    let call = 0;
    const fetchMock = vi.fn(async () => {
      call++;
      // First call (the immediate check) succeeds empty so we enter the poll loop.
      if (call === 1) return jsonResponse(emptyPage());
      return jsonResponse({ error: "boom" }, 500);
    });
    vi.stubGlobal("fetch", fetchMock);

    const startedAt = Date.now();
    await expect(
      waitForAnswers(SESSION_ID, CFG, { timeoutMs: 5 * 60_000, intervalMs: 5 })
    ).rejects.toThrow(SessionWaitReadFailure);
    // 3 consecutive failures at 5ms apart — nowhere near the 5-minute deadline.
    expect(Date.now() - startedAt).toBeLessThan(2_000);
  });
});
