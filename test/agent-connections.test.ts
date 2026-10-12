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
  it("one line per computer, with last use, marking this computer", () => {
    expect(
      connectionLines(
        [
          c({ instanceId: "m-l", instanceLabel: "MacBook", displayName: "Claude Code on MacBook", lastUsedAt: "2026-10-12T11:55:00Z" }),
          c({ instanceId: "m-d", instanceLabel: "devbox", displayName: "Claude Code on devbox" }),
          c({}),
        ],
        { thisInstanceId: "m-l", now: NOW }
      )
    ).toEqual([
      "Claude Code on MacBook · last used 5 minutes ago (this computer)",
      "Claude Code on devbox · never used",
      `Claude Code — ${UNLABELLED_COMPUTER} · never used`,
    ]);
  });
  it("an older pod (no list) is null — not an empty list", () => {
    expect(connectionLines(undefined)).toBeNull();
    expect(connectionLines([])).toEqual([]);
  });
});
