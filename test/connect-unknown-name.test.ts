/**
 * `synap connect <name>`: a name that is not a known client STOPS with the
 * closest client names. It never becomes a tool (plan f61a20a5, W1).
 *
 * On 4 Nov `synap connect --target=generic.` (a typo) was sent to the tools
 * path, which asked the pod's capability catalog and printed "This door does
 * not support scoped keys yet": nothing about the typo. A tool now comes only
 * from `--tool`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const capabilityConnect = vi.fn(async () => undefined);
vi.mock("../src/commands/capability.js", () => ({ capabilityConnect }));
const connectKnownAgent = vi.fn(async () => true);
const resolveAgentPod = vi.fn(async () => ({ podUrl: "https://pod.test", apiKey: "computer-key" }));
vi.mock("../src/lib/agent-door.js", () => ({ connectKnownAgent, resolveAgentPod }));

const { connect, routeConnect } = await import("../src/commands/connect.js");
const { suggestTargets } = await import("../src/lib/target-suggest.js");

let stderr: string[];
beforeEach(() => {
  vi.clearAllMocks();
  stderr = [];
  vi.spyOn(console, "error").mockImplementation((m) => void stderr.push(String(m)));
  vi.spyOn(console, "log").mockImplementation(() => undefined);
  process.exitCode = undefined;
});
afterEach(() => {
  vi.restoreAllMocks();
  process.exitCode = undefined;
});

describe("suggestTargets", () => {
  it.each([
    ["generic.", ["generic"]],
    ["Cursor", ["cursor"]],
    ["claude_code", ["claude-code"]],
    ["curser", ["cursor"]],
    ["claude", ["claude-code", "claude-desktop"]],
    ["gmail", []],
  ] as const)("%j → %j", (name, expected) => {
    expect(suggestTargets(name)).toEqual(expected);
  });
});

describe("routeConnect", () => {
  it("an unknown name is unknown, with its suggestions, never a tool", () => {
    expect(routeConnect("generic.")).toEqual({ kind: "unknown", name: "generic.", suggestions: ["generic"] });
    expect(routeConnect("gmail")).toEqual({ kind: "unknown", name: "gmail", suggestions: [] });
  });

  it("a prototype key is not a client", () => {
    expect(routeConnect("constructor").kind).toBe("unknown");
  });
});

describe("synap connect <unknown>", () => {
  it("stops with exit 1, names the closest client and the way to a tool, and calls nothing", async () => {
    await connect(undefined, { target: "generic." });
    const out = stderr.join("\n");
    expect(process.exitCode).toBe(1);
    expect(out).toContain("Unknown client `generic.`");
    expect(out).toContain("Did you mean: `generic`?");
    expect(out).toContain("synap connect --tool generic.");
    expect(capabilityConnect).not.toHaveBeenCalled();
    expect(connectKnownAgent).not.toHaveBeenCalled();
  });

  it("--tool still reaches the tools path", async () => {
    await connect("gmail", { tool: true });
    expect(capabilityConnect).toHaveBeenCalledWith("gmail", { workspace: undefined });
    expect(process.exitCode).toBeUndefined();
  });

  it("a known client still connects", async () => {
    await connect("cursor", {});
    expect(connectKnownAgent).toHaveBeenCalledTimes(1);
    expect(connectKnownAgent.mock.calls[0][0]).toBe("cursor");
  });
});
