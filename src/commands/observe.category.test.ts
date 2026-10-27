import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * `synap observe` must only send a `uo_category` the pod accepts. The pod's
 * enum is USER_OBSERVATION_CATEGORIES (synap-backend
 * packages/api/src/services/knowledge/remember-fact.ts); a value outside it is
 * filed as a proposal that then fails on approval ("not in enum"), as five
 * founder preferences did on 2026-10-27 with the old default `preference`.
 * Driven through the real command with the hub POST captured at the client
 * boundary. Not covered: a future change of the pod's enum (this list mirrors
 * it by hand; the pod remains the authority).
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

const POD_ENUM = [
  "working_style",
  "communication",
  "focus",
  "preferences",
  "habits",
  "technical",
];

const categoryOf = (i: number) =>
  (posted[i]!.properties as Record<string, unknown>).uo_category;

beforeEach(() => {
  posted.length = 0;
  vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
    throw new Error(`process.exit(${code})`);
  }) as never);
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

describe("synap observe — the category it sends", () => {
  it("defaults to a category the pod accepts", async () => {
    await observeWrite("Prefers async written updates", {});
    expect(posted).toHaveLength(1);
    expect(POD_ENUM).toContain(categoryOf(0));
    expect(categoryOf(0)).toBe("preferences");
  });

  it("accepts every category of the pod's enum, unchanged", async () => {
    for (const category of POD_ENUM) {
      await observeWrite(`An observation about ${category}`, { category });
    }
    expect(posted.map((_, i) => categoryOf(i))).toEqual(POD_ENUM);
  });

  it("refuses a category the pod would reject, before anything is sent", async () => {
    await expect(observeWrite("x", { category: "preference" })).rejects.toThrow(
      "process.exit(1)"
    );
    expect(posted).toHaveLength(0);
  });
});
