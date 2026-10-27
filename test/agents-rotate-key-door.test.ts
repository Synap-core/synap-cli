/**
 * `synap agents rotate-key` re-mints through the agent door, never `/trpc`
 * (keys plan D-7).
 *
 * The defect: it listed keys with `GET {pod}/trpc/apiKeys.list` and rotated
 * with `POST {pod}/trpc/apiKeys.rotate`, both with the CLI's Bearer key. The
 * pod's `/trpc` needs a person's session (synap-backend
 * `apps/api/src/trpc-session-gate.ts`), so the list was a 401 on every pod —
 * and where it did answer (LOCAL_MODE) the command rotated whichever of the
 * person's own keys had a name starting with the agent's label, a key that is
 * not the agent's. The agent's key is the agent door's (`/setup/agent`,
 * `provisionAgentKey`), which mints for the agent principal and replaces this
 * computer's earlier key once approved.
 *
 * Both cases are driven through the real `agentsRotateKey` with `fetch`
 * recorded: the 401 a real pod answers, and the 200 of a LOCAL_MODE pod.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const provisionAgentKey = vi.fn();
const addAgent = vi.fn();
const hubGet = vi.fn();

const AGENT = {
  name: "claude-code",
  profile: {
    podName: "home",
    apiKey: "synap_oldagentkey0000",
    label: "Claude Code",
    agentUserId: "agent-1",
    createdAt: "2026-10-01T00:00:00.000Z",
  },
};
const POD = "https://pod.test";
const NEW_KEY = "synap_newagentkey9876";

vi.mock("prompts", () => ({ default: async () => ({ confirmed: true }) }));

vi.mock("../src/lib/agents-config.js", async (importOriginal) => {
  const real = await importOriginal<typeof import("../src/lib/agents-config.js")>();
  return { ...real, listAgents: () => [AGENT], addAgent: (...a: unknown[]) => addAgent(...a) };
});

vi.mock("../src/lib/pod.js", async (importOriginal) => {
  const real = await importOriginal<typeof import("../src/lib/pod.js")>();
  return {
    ...real,
    getPodOverride: () => null,
    listPodProfiles: () => [
      { name: "home", active: true, config: { podUrl: POD, hubApiKey: "computer-key", workspaceId: "", agentUserId: "", savedAt: "" } },
    ],
  };
});

vi.mock("../src/lib/hub-client.js", async (importOriginal) => {
  const real = await importOriginal<typeof import("../src/lib/hub-client.js")>();
  return {
    ...real,
    resolveHubConfig: async () => ({ podUrl: POD, apiKey: "computer-key", userId: "cli" }),
    hubGet: (...a: unknown[]) => hubGet(...a),
  };
});

vi.mock("../src/lib/targets.js", async (importOriginal) => {
  const real = await importOriginal<typeof import("../src/lib/targets.js")>();
  return { ...real, provisionAgentKey: (...a: unknown[]) => provisionAgentKey(...a) };
});

const { agentsRotateKey } = await import("../src/commands/agents.js");

let fetched: string[] = [];
let trpcAnswer: { status: number; body: unknown };
let printed: string[] = [];
const wasTty = process.stdin.isTTY;

beforeEach(() => {
  vi.clearAllMocks();
  fetched = [];
  printed = [];
  provisionAgentKey.mockResolvedValue({ hubApiKey: NEW_KEY, agentUserId: "agent-1", reused: false });
  hubGet.mockResolvedValue([{ id: "agent-1", agentType: "claude-code" }]);
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string | URL) => {
      fetched.push(String(url));
      return new Response(JSON.stringify(trpcAnswer.body), {
        status: trpcAnswer.status,
        headers: { "Content-Type": "application/json" },
      });
    })
  );
  const record = (...a: unknown[]) => void printed.push(a.map(String).join(" "));
  vi.spyOn(console, "log").mockImplementation(record);
  vi.spyOn(console, "error").mockImplementation(record);
  vi.spyOn(process.stdout, "write").mockImplementation(((s: unknown) => (record(s), true)) as typeof process.stdout.write);
  Object.defineProperty(process.stdin, "isTTY", { value: true, configurable: true });
});

afterEach(() => {
  vi.unstubAllGlobals();
  Object.defineProperty(process.stdin, "isTTY", { value: wasTty, configurable: true });
});

describe("synap agents rotate-key", () => {
  it("re-mints the agent's key through the agent door and never asks /trpc (a Bearer key is 401 there)", async () => {
    trpcAnswer = { status: 401, body: { error: { message: "UNAUTHORIZED" } } };
    await agentsRotateKey("claude-code");

    expect(fetched.filter((u) => u.includes("/trpc/"))).toEqual([]);
    expect(provisionAgentKey).toHaveBeenCalledTimes(1);
    expect(provisionAgentKey.mock.calls[0]!.slice(0, 3)).toEqual([POD, "computer-key", "claude-code"]);
    expect(addAgent).toHaveBeenCalledWith("claude-code", expect.objectContaining({ apiKey: NEW_KEY }));
  });

  it("does not rotate one of the person's own keys when a LOCAL_MODE /trpc answers the list", async () => {
    trpcAnswer = {
      status: 200,
      body: { result: { data: [{ id: "person-key-1", keyPrefix: "synap_pp", keyName: "Claude Code laptop", isActive: true }] } },
    };
    await agentsRotateKey("claude-code");

    expect(fetched.filter((u) => u.includes("/trpc/"))).toEqual([]);
    expect(provisionAgentKey).toHaveBeenCalledTimes(1);
    expect(addAgent).toHaveBeenCalledWith("claude-code", expect.objectContaining({ apiKey: NEW_KEY }));
  });

  it("never prints the new key in full unless --show-key", async () => {
    trpcAnswer = { status: 401, body: {} };
    await agentsRotateKey("claude-code");
    expect(printed.join("\n")).not.toContain(NEW_KEY);

    printed = [];
    await agentsRotateKey("claude-code", { showKey: true });
    expect(printed.join("\n")).toContain(NEW_KEY);
  });
});
