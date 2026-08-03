/**
 * Unit tests for `synap project use <uuid>` validation (`classifyProjectLookup`).
 *
 * The bug this guards: the existence check was wrapped in a bare try/catch that
 * "accepted the id regardless", so a typo'd or foreign-pod uuid was pinned
 * silently and every subsequent scoped call was wrong. The two failure modes
 * are NOT the same:
 *   - pod reachable + answered, project not in the list → definitive absent
 *   - no parseable answer at all                        → inconclusive, never
 *     "absent" (never infer pod state from a body you couldn't parse)
 *
 * Pure function → no disk, no network.
 */
import { describe, it, expect } from "vitest";
import { classifyProjectLookup } from "../src/commands/lens.js";

const ID = "d4b84ad8-1111-2222-3333-444455556666";
const OTHER = "00000000-9999-8888-7777-666655554444";

describe("classifyProjectLookup", () => {
  it("finds the project in the legacy { projects: [...] } envelope", () => {
    expect(classifyProjectLookup({ projects: [{ id: ID, name: "Synap" }] }, ID)).toEqual({
      kind: "found",
      name: "Synap",
    });
  });

  it("finds it in a BARE ARRAY — what deployed pods actually return", () => {
    expect(classifyProjectLookup([{ id: ID, name: "Synap" }], ID)).toEqual({
      kind: "found",
      name: "Synap",
    });
  });

  it("finds it in the { data: [...] } standard envelope", () => {
    expect(classifyProjectLookup({ data: [{ id: ID }] }, ID)).toEqual({ kind: "found", name: ID });
  });

  it("FAILS CLOSED: pod answered a list without this project → absent", () => {
    expect(classifyProjectLookup([{ id: OTHER, name: "Other" }], ID)).toEqual({ kind: "absent" });
  });

  it("FAILS CLOSED: a successful EMPTY list is a definitive absent, not inconclusive", () => {
    expect(classifyProjectLookup([], ID)).toEqual({ kind: "absent" });
    expect(classifyProjectLookup({ projects: [] }, ID)).toEqual({ kind: "absent" });
    expect(classifyProjectLookup({ data: [] }, ID)).toEqual({ kind: "absent" });
  });

  it("FAILS OPEN: an unrecognised body is inconclusive — never reported as absent", () => {
    // unwrapList flattens "unparseable" and "empty" to [] — these must not be
    // treated as proof the project doesn't exist.
    for (const body of [null, undefined, "not json", 42, { error: "boom" }, { projects: "nope" }]) {
      const out = classifyProjectLookup(body, ID);
      expect(out.kind, `body: ${JSON.stringify(body)}`).toBe("inconclusive");
    }
  });
});
