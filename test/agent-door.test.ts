/**
 * The one agent door (lib/agent-door.ts) and the `synap connect` umbrella.
 *
 * Pins the two decisions the consolidation exists for, driven through the real
 * command entry points (`agentsAdd` / the deprecated `agentsCreate`) down to the
 * pod calls — nothing hand-built in between:
 *   1. Approval: a custom agent key is minted WITHOUT `requireApproval: false`
 *      (the old `agents create` bypass).
 *   2. Scope: pod-wide by default — enrollment carries NO workspace unless one
 *      was asked for (the old `agents create` always picked one).
 * Plus the two routing tables, each row chosen because a plausible wrong rule
 * would answer it differently.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const provisionAgentKey = vi.fn();
const enrollAgentIfNeeded = vi.fn();
const verifyMcpConnection = vi.fn();
const configureAgentContext = vi.fn();
const addAgent = vi.fn();

vi.mock("../src/lib/targets.js", async (importOriginal) => {
  const real = await importOriginal<typeof import("../src/lib/targets.js")>();
  return {
    ...real,
    provisionAgentKey: (...a: unknown[]) => provisionAgentKey(...a),
    enrollAgentIfNeeded: (...a: unknown[]) => enrollAgentIfNeeded(...a),
    verifyMcpConnection: (...a: unknown[]) => verifyMcpConnection(...a),
    configureAgentContext: (...a: unknown[]) => configureAgentContext(...a),
  };
});

vi.mock("../src/lib/pod.js", async (importOriginal) => {
  const real = await importOriginal<typeof import("../src/lib/pod.js")>();
  return {
    ...real,
    checkPodHealth: async () => ({ healthy: true }),
    getPodOverride: () => null,
    listPodProfiles: () => [
      {
        name: "home",
        active: true,
        config: { podUrl: "https://pod.test", hubApiKey: "human-key", workspaceId: "ws-profile", agentUserId: "", savedAt: "" },
      },
    ],
  };
});

vi.mock("../src/lib/agents-config.js", async (importOriginal) => {
  const real = await importOriginal<typeof import("../src/lib/agents-config.js")>();
  return { ...real, addAgent: (...a: unknown[]) => addAgent(...a) };
});

vi.mock("../src/lib/mcp-snippets.js", () => ({ printMcpConnection: () => {} }));

const { planAgentAdd } = await import("../src/lib/agent-door.js");
const { routeConnect } = await import("../src/commands/connect.js");
const { agentsAdd, agentsCreate } = await import("../src/commands/agents.js");

beforeEach(() => {
  vi.clearAllMocks();
  provisionAgentKey.mockResolvedValue({ hubApiKey: "agent-key", agentUserId: "agent-1", reused: false });
  enrollAgentIfNeeded.mockResolvedValue(undefined);
  verifyMcpConnection.mockResolvedValue({ ok: true, toolCount: 12 });
  configureAgentContext.mockResolvedValue(undefined);
  vi.spyOn(console, "log").mockImplementation(() => {});
  process.exitCode = undefined;
});

describe("planAgentAdd — which way in", () => {
  it.each([
    // a known client is wired, not printed
    ["cursor", {}, { mode: "known", target: "cursor" }],
    // any other word is YOUR agent, named after it (not a tool, not an error)
    ["researcher", {}, { mode: "custom", name: "researcher" }],
    // the literal "custom" is a placeholder, never the agent's name
    ["custom", {}, { mode: "custom", name: undefined }],
    ["custom", { name: "bob" }, { mode: "custom", name: "bob" }],
    // a twin needs no name and no kind
    [undefined, { template: "twin" }, { mode: "custom", name: undefined }],
    // an existing key wins even over a known client name: it mints nothing
    ["cursor", { apiKey: "k" }, { mode: "existing-key" }],
    // nothing named → detect on this machine
    [undefined, {}, { mode: "detect" }],
    [undefined, { template: "custom" }, { mode: "detect" }],
  ] as const)("%s %j → %j", (kind, opts, expected) => {
    expect(planAgentAdd(kind, opts)).toEqual(expected);
  });
});

describe("routeConnect — agent or tool", () => {
  it.each([
    // a known agent client wins the name
    ["cursor", {}, { kind: "agent", target: "cursor" }],
    // anything else is a tool — NOT a custom agent (that door is `agents add --name`)
    ["gmail", {}, { kind: "tool", name: "gmail" }],
    // --tool forces the tool reading of a name that is also a client
    ["cursor", { tool: true }, { kind: "tool", name: "cursor" }],
    [undefined, {}, { kind: "pick" }],
    [undefined, { tool: true }, { kind: "tool", name: undefined }],
    ["  ", {}, { kind: "pick" }],
  ] as const)("%j %j → %j", (thing, opts, expected) => {
    expect(routeConnect(thing, opts)).toEqual(expected);
  });
});

describe("custom agent through the real entry points", () => {
  it("agents add --name: approval is NOT bypassed and enrollment is pod-wide", async () => {
    await agentsAdd(undefined, { name: "Researcher" });

    expect(provisionAgentKey).toHaveBeenCalledTimes(1);
    const [podUrl, humanKey, agentType, mintOpts] = provisionAgentKey.mock.calls[0];
    expect([podUrl, humanKey, agentType]).toEqual(["https://pod.test", "human-key", "researcher"]);
    expect(mintOpts.requireApproval).not.toBe(false);

    expect(enrollAgentIfNeeded).toHaveBeenCalledTimes(1);
    // the profile's own workspace ("ws-profile") must NOT leak in as a pin
    expect(enrollAgentIfNeeded.mock.calls[0][3]).toBeUndefined();
    expect(addAgent.mock.calls[0][0]).toBe("researcher");
    expect(addAgent.mock.calls[0][1].workspaceId).toBeUndefined();
    expect(process.exitCode).toBeUndefined();
  });

  it("deprecated agents create no longer forces a workspace", async () => {
    await agentsCreate({ name: "bob" });
    expect(enrollAgentIfNeeded).toHaveBeenCalledTimes(1);
    expect(enrollAgentIfNeeded.mock.calls[0][3]).toBeUndefined();
    expect(provisionAgentKey.mock.calls[0][3].requireApproval).not.toBe(false);
  });

  it("an asked-for workspace is passed through, with the role", async () => {
    await agentsAdd("researcher", { workspace: "ws-9", role: "viewer" });
    expect(enrollAgentIfNeeded.mock.calls[0][3]).toBe("ws-9");
    expect(enrollAgentIfNeeded.mock.calls[0][4]).toMatchObject({ role: "viewer" });
  });

  it("a name that slugs to a client type is refused before anything is minted", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    await agentsAdd(undefined, { name: "Claude Code" });
    expect(provisionAgentKey).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
  });

  it("ends on the key: printed once, at the bottom, with no template wizard after it", async () => {
    await agentsAdd("deepseek", {});
    // The wizard's template prompt is what scrolled the key off screen.
    expect(configureAgentContext).not.toHaveBeenCalled();
    const lines = (console.log as unknown as { mock: { calls: unknown[][] } }).mock.calls.map((c) =>
      c.map(String).join(" ")
    );
    const withKey = lines.map((l, i) => (l.includes("agent-key") ? i : -1)).filter((i) => i >= 0);
    expect(withKey).toHaveLength(1);
    // only the card's own trailing lines may follow the key
    expect(lines.length - 1 - withKey[0]).toBeLessThanOrEqual(5);
    expect(lines.some((l) => l.includes("https://pod.test/mcp"))).toBe(true);
  });

  it("a failed verification marks the run failed", async () => {
    verifyMcpConnection.mockResolvedValue({ ok: false, error: "401" });
    await agentsAdd("researcher", {});
    expect(process.exitCode).toBe(1);
  });
});
