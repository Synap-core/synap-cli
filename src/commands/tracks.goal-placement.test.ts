import { describe, expect, it, vi } from "vitest";

// goalContentBody is pure; the pod clients and vocabulary tables tracks.ts
// imports are not under test, so they are stubbed (they pull in packages).
vi.mock("../lib/hub-client.js", () => ({}));
vi.mock("../lib/goal-words.js", () => ({}));
vi.mock("./data.js", () => ({}));
vi.mock("../utils/logger.js", () => ({ log: {} }));

import { goalContentBody } from "./tracks.js";

describe("goalContentBody: where a goal goes", () => {
  it("--parent becomes parentGoalId", () => {
    expect(goalContentBody({ parent: "g-0" })).toEqual({ parentGoalId: "g-0" });
  });

  it("the first --pillar is primary, the others only list the goal", () => {
    expect(goalContentBody({ pillar: ["ws-1", "ws-2"] })).toEqual({
      pillars: [{ workspaceId: "ws-1", primary: true }, { workspaceId: "ws-2" }],
    });
  });

  it("sends neither field when neither flag was typed (an empty --pillar default is not a clear)", () => {
    expect(goalContentBody({ pillar: [] })).toEqual({});
  });
});
