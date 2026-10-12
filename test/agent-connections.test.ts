/**
 * `synap agents list` / `synap doctor`: one line per computer an agent is
 * connected from, named by the POD ("Claude Code on devbox") — and an older
 * pod that sends no list is "cannot tell", never "no connection".
 */
import { describe, it, expect } from "vitest";
import { connectionLines, UNLABELLED_COMPUTER, type PodConnection } from "../src/lib/agent-connections.js";

const NOW = Date.parse("2026-10-12T12:00:00Z");
const c = (o: Partial<PodConnection>): PodConnection => ({
  keyId: "k",
  instanceId: null,
  instanceLabel: null,
  displayName: "Claude Code",
  createdAt: "2026-10-01T00:00:00Z",
  lastUsedAt: null,
  ...o,
});

describe("connectionLines", () => {
  it("one entry per computer — its name, this computer marked, last use; never the agent name again", () => {
    expect(
      connectionLines(
        [
          c({ instanceId: "m-d", instanceLabel: "devbox", displayName: "Claude Code on devbox" }),
          c({ instanceId: "m-l", instanceLabel: "MacBook", displayName: "Claude Code on MacBook", lastUsedAt: "2026-10-12T11:55:00Z" }),
          c({ lastUsedAt: "2026-10-11T19:00:00Z" }),
        ],
        { isThisComputer: (id) => id === "m-l", now: NOW }
      )
    ).toEqual([
      "MacBook (this computer) · 5 minutes ago",
      `${UNLABELLED_COMPUTER} · 17 hours ago`,
      "devbox · never used",
    ]);
    expect(UNLABELLED_COMPUTER).not.toMatch(/older CLI/);
  });
  it("an older pod (no list) is null — not an empty list", () => {
    expect(connectionLines(undefined)).toBeNull();
    expect(connectionLines([])).toEqual([]);
  });
});

describe("this computer's id for a pod agentType (C4)", () => {
  it("hashes the SURFACE the key was minted with — ChatGPT keys are `generic` agents minted as `chatgpt`", async () => {
    const { thisComputerInstanceIds, agentTypeOfSurface } = await import("../src/lib/machine-instance.js");
    const idFor = (s: string) => `id(${s})`;
    expect(agentTypeOfSurface("chatgpt")).toBe("generic");
    expect([...thisComputerInstanceIds("generic", idFor)].sort()).toEqual(["id(chatgpt)", "id(generic)"]);
    expect([...thisComputerInstanceIds("claude-code", idFor)]).toEqual(["id(claude-code)"]);
  });
});
