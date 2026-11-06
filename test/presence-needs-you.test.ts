/**
 * A pod that enforces proof of presence (W3, 6 Nov 2026) refuses a sensitive
 * act from a key — rotating an agent's key, minting an app key, changing how
 * an agent's changes land — with 403 and `code` (Hub) or `data.reasonCode`
 * (tRPC) PRESENCE_REQUIRED. A key can never give that proof, so the CLI says
 * "this needs you", names the pod admin page and opens it, instead of
 * printing the raw refusal.
 *
 * Driven through the REAL `ensureAgentGovernance` and `renderHubError` (a
 * stubbed fetch is the pod); only the browser opener is a spy.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const opened = vi.hoisted(() => [] as string[]);
vi.mock("../src/lib/safe-open.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/lib/safe-open.js")>();
  return {
    ...actual,
    openPodPage: (url: string, podUrl: string) => {
      if (actual.podPageRefusal(url, podUrl)) return false;
      opened.push(url);
      return true;
    },
  };
});

import { ensureAgentGovernance } from "../src/lib/targets.js";
import { HubError, renderHubError } from "../src/lib/hub-client.js";
import { isPresenceRefusal } from "../src/lib/presence-refusal.js";

const POD = "https://antoine.pod.synap.live";
const AGENT = "22222222-2222-4222-8222-222222222222";
const REFUSAL = {
  error: "This needs the person, not a key: do it in pod admin, where you confirm it is you.",
  code: "PRESENCE_REQUIRED",
};

let printed: string[] = [];
beforeEach(() => {
  printed = [];
  opened.length = 0;
  const capture = (...args: unknown[]) => {
    printed.push(args.map(String).join(" "));
  };
  vi.spyOn(console, "log").mockImplementation(capture);
  vi.spyOn(console, "error").mockImplementation(capture);
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("a sensitive act refused for want of the person", () => {
  it("changing how an agent's changes land: says this needs you and opens the agent's pod admin page", async () => {
    const patches: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        if (url.endsWith("/users/me")) return json(200, { id: "human-1" });
        if (init?.method === "PATCH") {
          patches.push(url);
          return json(403, REFUSAL);
        }
        return json(200, { posture: null, configured: false });
      })
    );
    await ensureAgentGovernance({ podUrl: POD, apiKey: "k" }, AGENT, "creates");
    expect(patches).toHaveLength(1);
    const out = printed.join("\n");
    expect(out).toMatch(/This needs you: choose how this agent's changes land in pod admin/);
    expect(out).not.toMatch(/Could not apply agent governance/);
    expect(opened).toEqual([`https://admin.antoine.pod.synap.live/agents/${AGENT}`]);
  });

  it("any Hub command's refusal reads as plain words, never the raw JSON", () => {
    renderHubError(
      new HubError({
        message: "Hub POST /apps/x/key failed (403)",
        status: 403,
        code: "PRESENCE_REQUIRED",
        rawBody: JSON.stringify(REFUSAL),
        body: REFUSAL,
        path: "/apps/x/key",
        method: "POST",
        podUrl: POD,
      })
    );
    const out = printed.join("\n");
    expect(out).toMatch(/This needs you/);
    expect(out).toMatch(/pod admin \(https:\/\/admin\.antoine\.pod\.synap\.live\)/);
    expect(out).not.toMatch(/"code"/);
  });

  it("a tRPC refusal is recognised by its reasonCode, a Hub one by its code", () => {
    expect(isPresenceRefusal({ reasonCode: "PRESENCE_REQUIRED" })).toBe(true);
    expect(isPresenceRefusal({ code: "PRESENCE_REQUIRED" })).toBe(true);
    expect(isPresenceRefusal({ code: "FORBIDDEN" })).toBe(false);
    expect(isPresenceRefusal(null)).toBe(false);
  });
});
