/**
 * `synap diagnose <run>` lookup.
 *
 * The bug this pins: the CLI used to DEFAULT the detail door's `flowType` to
 * "capture", so every automation/capability id printed by the feed 404'd. The
 * flowType must be READ off the feed row, never guessed.
 */

import { describe, it, expect } from "vitest";
import { resolveRunTarget } from "../src/commands/diagnose.js";

// Newest-first, exactly as `GET /runs` returns it.
const feed = [
  {
    id: "65f39343-3c44-47d0-9df7-17686c7ad078",
    flowType: "capability",
    flowName: "ai.generate",
    status: "completed",
    startedAt: "2026-07-31T22:47:00.000Z",
    completedAt: null,
    summary: null,
    error: null,
    channelId: null,
  },
  {
    id: "1ec13e8d-d92c-4446-a909-1f433b2ed368",
    flowType: "automation",
    flowName: "Generate report",
    status: "completed",
    startedAt: "2026-07-31T22:46:00.000Z",
    completedAt: null,
    summary: null,
    error: null,
    channelId: null,
  },
  {
    id: "2ec13e8d-d92c-4446-a909-1f433b2ed368",
    flowType: "automation",
    flowName: "Generate report",
    status: "failed",
    startedAt: "2026-07-30T10:00:00.000Z",
    completedAt: null,
    summary: null,
    error: null,
    channelId: null,
  },
  {
    id: "3ec13e8d-d92c-4446-a909-1f433b2ed368",
    flowType: "automation",
    flowName: "Generate digest",
    status: "completed",
    startedAt: "2026-07-29T10:00:00.000Z",
    completedAt: null,
    summary: null,
    error: null,
    channelId: null,
  },
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
] as any[];

describe("resolveRunTarget", () => {
  it("resolves an id to its OWN flowType (not a guessed default)", () => {
    const r = resolveRunTarget(feed, "1ec13e8d-d92c-4446-a909-1f433b2ed368");
    expect(r.kind).toBe("match");
    if (r.kind !== "match") return;
    expect(r.run.flowType).toBe("automation");
  });

  it("resolves a capability run id — the flow type the old FLOW_TYPES omitted", () => {
    const r = resolveRunTarget(feed, "65f39343-3c44-47d0-9df7-17686c7ad078");
    expect(r.kind).toBe("match");
    if (r.kind !== "match") return;
    expect(r.run.flowType).toBe("capability");
  });

  it("resolves a name to the MOST RECENT run of that flow", () => {
    const r = resolveRunTarget(feed, "Generate report");
    expect(r.kind).toBe("match");
    if (r.kind !== "match") return;
    expect(r.run.id).toBe("1ec13e8d-d92c-4446-a909-1f433b2ed368");
  });

  it("is case-insensitive and accepts an unambiguous prefix", () => {
    const r = resolveRunTarget(feed, "generate rep");
    expect(r.kind).toBe("match");
    if (r.kind !== "match") return;
    expect(r.run.flowName).toBe("Generate report");
  });

  it("lists candidates instead of guessing when a prefix spans flows", () => {
    const r = resolveRunTarget(feed, "Generate");
    expect(r.kind).toBe("ambiguous");
    if (r.kind !== "ambiguous") return;
    expect(r.candidates.map((c) => c.flowName).sort()).toEqual([
      "Generate digest",
      "Generate report",
    ]);
  });

  it("prefers an exact name over a longer flow that contains it", () => {
    const withSuffix = [
      ...feed,
      { ...feed[1], id: "9ec13e8d", flowName: "Generate report v2" },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ] as any[];
    const r = resolveRunTarget(withSuffix, "Generate report");
    expect(r.kind).toBe("match");
    if (r.kind !== "match") return;
    expect(r.run.flowName).toBe("Generate report");
  });

  it("reports none for an unknown argument", () => {
    expect(resolveRunTarget(feed, "nope").kind).toBe("none");
    expect(resolveRunTarget([], "anything").kind).toBe("none");
  });
});
