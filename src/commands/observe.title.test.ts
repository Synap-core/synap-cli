import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * `synap observe` names the observation through the one title door
 * (`shortenTitle`, `@synap-core/types/titles`): first line, word boundary, no
 * "…" — never `text.slice(0, 80)`. Driven through the real command with the
 * hub POST captured at the client boundary.
 */
const posted: Array<Record<string, unknown>> = [];
vi.mock("../lib/hub-client.js", () => ({
  resolveHubConfig: async () => ({}),
  hubGet: async () => ({}),
  hubPost: async (_path: string, body: Record<string, unknown>) => {
    posted.push(body);
    return { id: "e1", status: "proposed" };
  },
  renderHubError: () => {},
}));
vi.mock("../lib/capture-lane.js", () => ({ reportWrite: async () => {} }));

import { observeWrite } from "./observe.js";

beforeEach(() => {
  posted.length = 0;
});

describe("synap observe — the stored title", () => {
  it("is the first line, cut at a word boundary, never mid-word", async () => {
    const text =
      "Prefers async written updates over meetings for anything that is not urgent or blocking the team\nSeen three times this week.";
    await observeWrite(text, {});
    expect(posted).toHaveLength(1);
    const title = posted[0]!.title as string;
    expect(title.length).toBeLessThanOrEqual(80);
    expect(text.startsWith(title)).toBe(true);
    expect(text[title.length]).toBe(" ");
    expect(title).not.toMatch(/(…|\.\.\.)$/);
    // The full observation is still stored.
    expect(
      (posted[0]!.properties as Record<string, unknown>).uo_observation
    ).toBe(text);
  });
});
