/**
 * FLOW.afterLaunch / afterMarketInstall — after structure exists, hint that
 * filling the (usually empty) workspace is a guided interview, not a second
 * create. Other FLOW edges are out of scope.
 */

import { describe, it, expect } from "vitest";
import { FLOW } from "../src/lib/next-steps.js";

const FILL = {
  command: 'synap ask "help me set up this workspace"',
  why: "guided interview to fill the empty workspace — do not create another",
};

describe("FLOW.afterLaunch", () => {
  it("keeps orient + market --list and adds the fill/interview hint", () => {
    const steps = FLOW.afterLaunch();
    expect(steps).toHaveLength(3);
    expect(steps[0]).toEqual({ command: "synap orient", why: "see the new workspaces" });
    expect(steps[1]).toEqual({ command: "synap market --list", why: "add more packages" });
    expect(steps[2]).toEqual(FILL);
  });

  it("keeps the project-scoped orient why when a project name is known", () => {
    const steps = FLOW.afterLaunch("Acme");
    expect(steps[0]).toEqual({
      command: "synap orient",
      why: "see the new workspaces under Acme",
    });
    expect(steps).toContainEqual(FILL);
  });
});

describe("FLOW.afterMarketInstall", () => {
  it("when live, keeps orient + open and adds the same fill/interview hint", () => {
    const steps = FLOW.afterMarketInstall({ slug: "crm", proposed: false });
    expect(steps).toHaveLength(3);
    expect(steps[0]).toEqual({
      command: "synap orient",
      why: "see crm in your pod",
    });
    expect(steps[1]).toEqual({ command: "synap open", why: "open it in the browser" });
    expect(steps[2]).toEqual(FILL);
  });

  it("uses the project name in the orient why when given", () => {
    const steps = FLOW.afterMarketInstall({
      slug: "crm",
      proposed: false,
      projectName: "Acme",
    });
    expect(steps[0].why).toBe("see crm in Acme");
    expect(steps).toContainEqual(FILL);
  });

  it("when proposed, does not add the fill hint — approval first", () => {
    const steps = FLOW.afterMarketInstall({ slug: "crm", proposed: true });
    expect(steps).toEqual([
      { command: "synap proposals list", why: "approve the queued install of crm" },
    ]);
    expect(steps).not.toContainEqual(FILL);
  });
});
