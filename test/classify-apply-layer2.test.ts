/**
 * The verdict of one `/packages/apply` must honour the POD's own account of
 * layer 2 (synap-backend `hub-protocol/rest/packages.ts`: `layer2`,
 * `templateApply`, `templateApplyWarning`) — not only `workspace.layers`,
 * which that door never sends.
 *
 * Driven from the wire shape the pod returns, through `classifyApplyResponse`
 * (the one reader both `market install` and `templates update` call) to the
 * printed lines, with nothing hand-built in between.
 *
 * Not covered: the per-item `layers` path (`hasLayerFailure`) and the live
 * pod — the exact sentence a real failed apply serves needs a live run.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const lines: Array<[string, string]> = [];
vi.mock("../src/utils/logger.js", () => {
  const rec = (kind: string) => (msg: string) => lines.push([kind, msg]);
  return {
    log: {
      success: rec("success"),
      warn: rec("warn"),
      info: rec("info"),
      hint: rec("hint"),
      error: rec("error"),
      blank: rec("blank"),
      dim: rec("dim"),
      heading: rec("heading"),
    },
    banner: () => undefined,
  };
});

import { classifyApplyResponse, printApplyVerdict, summarizeApplyResults } from "../src/commands/market.js";

const ENTRY = { slug: "crm", name: "CRM" } as Parameters<typeof classifyApplyResponse>[0];
const ws = (outcome: "created" | "reconciled" | "unchanged") => ({
  status: "created",
  workspaceId: "w-1",
  outcome,
});
const FAILED_SENTENCE = "Not finished: the last update of crm failed. Run `synap templates update crm` to resume.";

beforeEach(() => {
  lines.length = 0;
});

describe("templates update (U3): layer 2 failed is never a green 'Updated'", () => {
  const res = {
    workspace: ws("reconciled"),
    layer2: { status: "failed", error: "Layer 2 did not apply." },
    versionStamped: false,
    templateApplyWarning: FAILED_SENTENCE,
  };

  it("classifies as not finished", () => {
    const v = classifyApplyResponse(ENTRY, res, { remoteVersionSent: "h-1", wasUnstamped: false });
    expect(v.status).toBe("not-finished");
  });

  it("prints a warning headline plus the pod's next step — no success line", () => {
    printApplyVerdict(ENTRY, classifyApplyResponse(ENTRY, res, { remoteVersionSent: "h-1", wasUnstamped: false }));
    expect(lines.some(([k]) => k === "success")).toBe(false);
    expect(lines[0][0]).toBe("warn");
    expect(lines[0][1]).toContain("not finished");
    expect(lines.map(([, m]) => m)).toContain(FAILED_SENTENCE);
  });

  it("an older pod that sends no sentence still gets the next step", () => {
    const { templateApplyWarning: _drop, ...bare } = res;
    printApplyVerdict(ENTRY, classifyApplyResponse(ENTRY, bare, { wasUnstamped: false }));
    expect(lines.some(([k]) => k === "success")).toBe(false);
    expect(lines.map(([, m]) => m).join("\n")).toContain("synap templates update crm");
  });

  it("counts in the batch summary as not clean", () => {
    const s = summarizeApplyResults([{ slug: "crm", status: "not-finished" }]);
    expect(s.withFailures).toBe(1);
    expect(s.updated).toBe(0);
  });
});

describe("templates update: only proposals filed = waiting on approval", () => {
  const res = {
    workspace: ws("reconciled"),
    versionStamped: false,
    templateApply: { state: "awaiting-approval", version: "h-1", at: "t", proposals: ["p-1"] },
    templateApplyWarning: "Waiting on your approval of 1 proposal, then run `synap templates update crm`.",
  };

  it("classifies as awaiting approval and prints no success line", () => {
    const v = classifyApplyResponse(ENTRY, res, { remoteVersionSent: "h-1", wasUnstamped: false });
    expect(v.status).toBe("awaiting-approval");
    printApplyVerdict(ENTRY, v);
    expect(lines.some(([k]) => k === "success")).toBe(false);
    expect(lines[0][1]).toContain("approval");
  });

  it("counts with proposals, not as a failure", () => {
    const s = summarizeApplyResults([{ slug: "crm", status: "awaiting-approval" }]);
    expect(s.proposed).toBe(1);
    expect(s.failed).toBe(0);
    expect(s.withFailures).toBe(0);
  });

  it("an item that errored inside layer 2 (partial) is not finished", () => {
    const partial = {
      ...res,
      templateApply: { state: "partial", version: "h-1", at: "t", failures: ["x"] },
      templateApplyWarning: "Not finished: part of crm did not apply. Run `synap templates update crm` to retry.",
    };
    expect(classifyApplyResponse(ENTRY, partial, { wasUnstamped: false }).status).toBe("not-finished");
  });
});

describe("templates update: converged = updated", () => {
  it("prints the green 'Updated'", () => {
    const v = classifyApplyResponse(ENTRY, { workspace: ws("reconciled"), versionStamped: true }, {
      remoteVersionSent: "h-1",
      wasUnstamped: false,
    });
    expect(v.status).toBe("updated");
    printApplyVerdict(ENTRY, v);
    expect(lines).toEqual([["success", "Updated CRM."]]);
  });
});

describe("market install (U4): a failed layer 2 is 'not finished', never 'redeploy'", () => {
  it("a stamp the re-read finds missing is NOT a stamp contradiction when the pod reported layer 2 failed", () => {
    const res = {
      workspace: ws("created"),
      layer2: { status: "failed", error: "Layer 2 did not apply." },
      versionStamped: false,
      templateApplyWarning: FAILED_SENTENCE,
    };
    const v = classifyApplyResponse(ENTRY, res, {
      remoteVersionSent: "h-1",
      wasUnstamped: true,
      stampVerified: false,
    });
    expect(v.status).toBe("not-finished");
    printApplyVerdict(ENTRY, v);
    const text = lines.map(([, m]) => m).join("\n");
    expect(text).not.toMatch(/redeploy/i);
    expect(text).not.toMatch(/older version/i);
    expect(text).toContain(FAILED_SENTENCE);
  });

  it("with no pod state at all, a missing stamp still reads as the old-pod contradiction", () => {
    const v = classifyApplyResponse(ENTRY, { workspace: ws("unchanged") }, {
      remoteVersionSent: "h-1",
      wasUnstamped: true,
      stampVerified: false,
    });
    expect(v.status).toBe("stamp-contradiction");
  });
});
