import { describe, expect, it } from "vitest";
import {
  buildWorkerPrompt,
  findMcpServerName,
  parseHandedToYou,
  parseInterval,
  pickNew,
  workerEnv,
  workerVerdict,
} from "./worker.js";
import { lastJsonPayload } from "../lib/mcp-call.js";

const orient = (handed: unknown) =>
  JSON.stringify({ startHere: { pendingReview: { count: 0 }, handedToYou: handed } });

describe("parseHandedToYou", () => {
  it("reads the handed sessions from orient", () => {
    const items = parseHandedToYou(
      orient({ count: 2, items: [{ id: "a", goal: "fix x" }, { id: "b", goal: null }] })
    );
    expect(items).toEqual([
      { id: "a", goal: "fix x" },
      { id: "b", goal: null },
    ]);
  });

  it("an unavailable block is a FAILED read, not an empty list", () => {
    expect(() => parseHandedToYou(orient({ status: "unavailable" }))).toThrow(/unavailable/);
  });

  it("a missing block throws instead of reading as nothing handed", () => {
    expect(() => parseHandedToYou(JSON.stringify({ startHere: {} }))).toThrow(/no handedToYou/);
  });

  it("non-JSON orient text throws", () => {
    expect(() => parseHandedToYou("Error: pod down")).toThrow(/did not return JSON/);
  });
});

describe("pickNew", () => {
  const items = [{ id: "a", goal: null }, { id: "b", goal: null }, { id: "c", goal: null }];
  it("skips sessions already launched and respects free slots", () => {
    const state = { runs: { a: { sessionId: "a", status: "done" as const, startedAt: "t" } } };
    expect(pickNew(items, state, 1).map((i) => i.id)).toEqual(["b"]);
  });
  it("launches nothing when no slot is free", () => {
    expect(pickNew(items, { runs: {} }, 0)).toEqual([]);
  });
});

describe("findMcpServerName", () => {
  it("finds the user-scope server pointing at the pod", () => {
    const cj = { mcpServers: { other: { url: "https://x/mcp" }, "synap-pod": { url: "https://pod.example/mcp/" } } };
    expect(findMcpServerName(cj, "https://pod.example")).toBe("synap-pod");
  });
  it("falls back to a project-scope server", () => {
    const cj = { projects: { "/w": { mcpServers: { s: { url: "https://pod.example/mcp" } } } } };
    expect(findMcpServerName(cj, "https://pod.example/")).toBe("s");
  });
  it("returns null when none matches", () => {
    expect(findMcpServerName({ mcpServers: { s: { url: "https://other/mcp" } } }, "https://pod.example")).toBeNull();
  });
});

describe("workerEnv", () => {
  it("strips API-key billing and sets the chosen Claude config dir", () => {
    const env = workerEnv(
      { PATH: "/bin", ANTHROPIC_API_KEY: "k", ANTHROPIC_AUTH_TOKEN: "t", ANTHROPIC_BASE_URL: "u" },
      "/srv/cc/auto"
    );
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(env.ANTHROPIC_AUTH_TOKEN).toBeUndefined();
    expect(env.ANTHROPIC_BASE_URL).toBeUndefined();
    expect(env.CLAUDE_CONFIG_DIR).toBe("/srv/cc/auto");
    expect(env.PATH).toBe("/bin");
  });
});

describe("prompt + verdict", () => {
  it("the prompt names the session, the MCP server and the branch rule", () => {
    const p = buildWorkerPrompt({ sessionId: "c5a34b78-0000", goal: "g", agentName: "cc-devbox", cwd: "/w", mcpServer: "synap-pod" });
    expect(p).toContain("Session: c5a34b78-0000");
    expect(p).toContain("mcp__synap-pod__synap_*");
    expect(p).toContain("devbox/c5a34b78-");
    expect(p).toContain("WORKER-RESULT:");
  });
  it("reads the last WORKER-RESULT line", () => {
    expect(workerVerdict("work\nWORKER-RESULT: done — posted report")).toBe("done — posted report");
    expect(workerVerdict("no verdict here")).toBeUndefined();
  });
});

describe("parseInterval", () => {
  it("parses units", () => {
    expect(parseInterval("45")).toBe(45_000);
    expect(parseInterval("2m")).toBe(120_000);
    expect(parseInterval(undefined)).toBe(30_000);
    expect(() => parseInterval("soon")).toThrow();
  });
});

describe("lastJsonPayload", () => {
  it("takes the last SSE data line, or the plain body", () => {
    expect(lastJsonPayload('event: message\ndata: {"a":1}\n\ndata: {"b":2}\n')).toBe('{"b":2}');
    expect(lastJsonPayload('{"plain":true}')).toBe('{"plain":true}');
  });
});
