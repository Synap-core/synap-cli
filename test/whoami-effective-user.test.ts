/**
 * `synap whoami` must show the EFFECTIVE user, not just the key owner.
 *
 * Ground truth (synap-backend/packages/api/src/routers/hub-protocol-rest.ts:
 * 407-408) — for an agent key the Hub middleware sets:
 *
 *     c.set("userId",      keyRecord.linkedUserId); // human owns the entities
 *     c.set("agentUserId", keyRecord.userId);       // agent performed the action
 *
 * and `GET /users/me` (rest/users.ts:36-46) returns that `userId` plus a
 * server-derived `isAgent`. So `/auth/status` and `/users/me` answer DIFFERENT
 * questions. `whoami` previously printed only `/auth/status`'s `userEmail`,
 * labelled "Identity" — for an agent key that is the AGENT, which is exactly
 * what made an earlier analysis conclude the CLI and MCP were different people.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const hubGet = vi.fn();

vi.mock("../src/lib/hub-client.js", () => ({
  hubGet,
  hubPost: vi.fn(async () => ({})),
  resolveHubConfig: vi.fn(async () => ({
    podUrl: "http://127.0.0.1:1",
    apiKey: "agent-key-abcdef",
    workspaceId: "ws-1",
  })),
  renderHubError: vi.fn(),
  HubError: class HubError extends Error {
    status?: number;
  },
}));

vi.mock("../src/lib/pod.js", () => ({
  getSurfaceAgentKey: vi.fn(() => undefined),
}));

/** An AGENT key: the pod attributes its writes to the linked HUMAN. */
const AGENT_AUTH_STATUS = {
  keyIdPrefix: "sk_ag_1234",
  keyType: "agent",
  userId: "agent-user-id",
  userEmail: "agent-claude-code-a1b2@synap.agent",
  scopes: ["hub-protocol.read", "hub-protocol.write"],
  isActive: true,
};
const HUMAN_EFFECTIVE = { id: "human-user-id", scopes: ["hub-protocol.read"], isAgent: true };

function routeHub(status: unknown, me: unknown) {
  hubGet.mockImplementation(async (path: string) => {
    if (path === "/auth/status") return status;
    if (path === "/users/me") return me;
    throw new Error(`unexpected path ${path}`);
  });
}

let out: string[];

beforeEach(() => {
  hubGet.mockReset();
  out = [];
  vi.spyOn(console, "log").mockImplementation((s?: unknown) => {
    out.push(String(s));
  });
  vi.spyOn(console, "error").mockImplementation((s?: unknown) => {
    out.push(String(s));
  });
});

describe("whoami --json", () => {
  it("reports key owner, effective user, and isAgent as three distinct facts", async () => {
    routeHub(AGENT_AUTH_STATUS, HUMAN_EFFECTIVE);
    const { whoami } = await import("../src/commands/whoami.js");
    await whoami({ json: true });

    const parsed = JSON.parse(out.join("\n")) as {
      keyOwner: { userId: string; email: string };
      effectiveUser: { userId: string };
      isAgent: boolean;
    };

    expect(parsed.keyOwner.userId).toBe("agent-user-id");
    expect(parsed.effectiveUser.userId).toBe("human-user-id");
    // The whole defect: these two are NOT the same person for an agent key, and
    // reading either one as "who am I" gives the wrong answer.
    expect(parsed.keyOwner.userId).not.toBe(parsed.effectiveUser.userId);
    expect(parsed.isAgent).toBe(true);
  });

  it("actually calls GET /users/me — the effective identity door", async () => {
    routeHub(AGENT_AUTH_STATUS, HUMAN_EFFECTIVE);
    const { whoami } = await import("../src/commands/whoami.js");
    await whoami({ json: true });

    expect(hubGet.mock.calls.map((c) => c[0])).toContain("/users/me");
  });

  it("keeps the Can-approve verdict", async () => {
    routeHub(AGENT_AUTH_STATUS, HUMAN_EFFECTIVE);
    const { whoami } = await import("../src/commands/whoami.js");
    await whoami({ json: true });

    // The synthetic @synap.agent email classifies this key as an agent, which
    // the pod's `rejectAgentReviewer` will enforce on approve.
    expect(JSON.parse(out.join("\n")).canApprove).toBe("agent");
  });

  it("degrades to null rather than failing when /users/me is unavailable", async () => {
    hubGet.mockImplementation(async (path: string) => {
      if (path === "/auth/status") return AGENT_AUTH_STATUS;
      throw new Error("404 not found");
    });
    const { whoami } = await import("../src/commands/whoami.js");
    await whoami({ json: true });

    const parsed = JSON.parse(out.join("\n"));
    // An older pod without the route must not break `whoami` — but it must also
    // not silently render the key owner as if it were the effective user.
    expect(parsed.effectiveUser).toBeNull();
    expect(parsed.isAgent).toBeNull();
    expect(parsed.keyOwner.userId).toBe("agent-user-id");
  });
});

describe("whoami human-readable output", () => {
  it("prints all three lines, distinctly labelled", async () => {
    routeHub(AGENT_AUTH_STATUS, HUMAN_EFFECTIVE);
    const { whoami } = await import("../src/commands/whoami.js");
    await whoami();

    const text = out.join("\n");
    expect(text).toContain("Key owner");
    expect(text).toContain("Effective");
    expect(text).toContain("Is agent");
    // Both identities are visible, not just the key owner.
    expect(text).toContain("agent-claude-code-a1b2@synap.agent");
    expect(text).toContain("human-user-id");
    // The old, ambiguous label is gone.
    expect(text).not.toContain("Identity   :");
  });

  it("says so when the key acts as its own owner (a plain human key)", async () => {
    routeHub(
      { ...AGENT_AUTH_STATUS, keyType: "user_pat", userId: "u1", userEmail: "sam@example.test" },
      { id: "u1", scopes: [], isAgent: false }
    );
    const { whoami } = await import("../src/commands/whoami.js");
    await whoami();

    const text = out.join("\n");
    expect(text).toContain("same — this key acts as its own owner");
  });
});
