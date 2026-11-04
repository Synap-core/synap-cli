/**
 * `synap mcp url` and `synap mcp ui-setup` reuse the client's live key: a
 * re-run must not mint a fresh key (which, once approved, revokes the key the
 * client already holds) every time. `mcp url`'s client names are the CLI's
 * known clients (`TARGETS`), not a third hand list (plan f61a20a5, W1).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const POD = "https://pod.reuse.example.test";
const provisionAgentKey = vi.fn(async () => ({ hubApiKey: "client-key", agentUserId: "agent-1", reused: false }));
const enrollAgentIfNeeded = vi.fn(async () => undefined);
vi.mock("../src/lib/targets.js", async (orig) => ({
  ...(await orig<typeof import("../src/lib/targets.js")>()),
  provisionAgentKey,
  enrollAgentIfNeeded,
}));
vi.mock("../src/lib/hub-client.js", async (orig) => ({
  ...(await orig<typeof import("../src/lib/hub-client.js")>()),
  resolveHubConfig: vi.fn(async () => ({ podUrl: POD, apiKey: "computer-key", userId: "u" })),
}));
vi.mock("../src/lib/mcp-snippets.js", async (orig) => ({
  ...(await orig<typeof import("../src/lib/mcp-snippets.js")>()),
  printMcpConnection: () => undefined,
}));

const { mcpUrl, mcpUiSetup } = await import("../src/commands/mcp.js");
const { getSurfaceAgentKey } = await import("../src/lib/pod.js");

let stderr: string[];
beforeEach(() => {
  vi.clearAllMocks();
  stderr = [];
  vi.spyOn(console, "error").mockImplementation((m) => void stderr.push(String(m)));
  vi.spyOn(console, "log").mockImplementation(() => undefined);
  vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
    throw new Error(`exit ${code}`);
  }) as never);
});
afterEach(() => vi.restoreAllMocks());

describe("synap mcp url", () => {
  it("mints idempotently under the client's own name, and stores the key so the next run reuses it", async () => {
    await mcpUrl({ client: "cursor" });
    expect(provisionAgentKey).toHaveBeenCalledTimes(1);
    const [, , agentType, opts] = provisionAgentKey.mock.calls[0] as unknown as [string, string, string, Record<string, unknown>];
    expect(agentType).toBe("cursor");
    expect(opts.idempotent).toBe(true);
    expect(opts.surfaceName).toBe("cursor");
    expect(getSurfaceAgentKey("cursor", POD)).toMatchObject({ hubApiKey: "client-key", agentUserId: "agent-1" });
  });

  it("a client minted under another agent type keeps the pod's type (chatgpt → generic)", async () => {
    await mcpUrl({ client: "chatgpt" });
    const [, , agentType, opts] = provisionAgentKey.mock.calls[0] as unknown as [string, string, string, Record<string, unknown>];
    expect(agentType).toBe("generic");
    expect(opts.surfaceName).toBe("chatgpt");
  });

  it("any known client is accepted, not only the old hand list of 7", async () => {
    await mcpUrl({ client: "windsurf" });
    expect(provisionAgentKey.mock.calls[0][2]).toBe("windsurf");
  });

  // The catalog's claude-managed-agents setup runs exactly this command
  // (review bf96d410, lane D): a name the CLI does not know is a display
  // label, minted as the generic client, as before #84.
  it("a name the CLI does not know is a label: it mints the generic client's key, no exit", async () => {
    await mcpUrl({ client: "claude-managed-agents" });
    expect(process.exit).not.toHaveBeenCalled();
    expect(provisionAgentKey).toHaveBeenCalledTimes(1);
    const [, , agentType, opts] = provisionAgentKey.mock.calls[0] as unknown as [string, string, string, Record<string, unknown>];
    expect(agentType).toBe("generic");
    expect(opts.surfaceName).toBe("generic");
    expect(stderr.join("\n")).toContain("`claude-managed-agents` is not one of the CLI's clients: it gets a generic client's key.");
  });

  it("a near-miss of a known name still mints (generic), and hints at the closest names", async () => {
    await mcpUrl({ client: "curser" });
    expect(process.exit).not.toHaveBeenCalled();
    expect(provisionAgentKey.mock.calls[0][2]).toBe("generic");
    expect(stderr.join("\n")).toContain("Did you mean: `cursor`?");
  });

  it("--json keeps stdout and stderr free of the label hint", async () => {
    await mcpUrl({ client: "claude-managed-agents", json: true });
    expect(provisionAgentKey.mock.calls[0][2]).toBe("generic");
    expect(stderr.join("\n")).not.toContain("not one of the CLI's clients");
  });
});

describe("synap mcp ui-setup", () => {
  it("mints idempotently too", async () => {
    await mcpUiSetup("chatgpt", {});
    const [, , agentType, opts] = provisionAgentKey.mock.calls[0] as unknown as [string, string, string, Record<string, unknown>];
    expect(agentType).toBe("generic");
    expect(opts.idempotent).toBe(true);
  });
});
