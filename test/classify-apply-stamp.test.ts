import { describe, it, expect } from "vitest";
import { classifyApplyResult, summarizeApplyResults } from "../src/commands/market.js";

const entry = { slug: "operations", name: "Operations" } as any;

describe("classifyApplyResult — ground-truth stamp verification", () => {
  // The core fix: once the pod stamps on a content-identical reconcile, the
  // apply response still comes back outcome:"unchanged". The OLD proxy read
  // that as "didn't get stamped" and cried wolf. The re-read is ground truth.
  it("stampVerified:true suppresses the false 'not stamped' warning even when outcome=unchanged", () => {
    const v = classifyApplyResult(entry, { outcome: "unchanged", workspaceId: "w1" } as any, undefined, undefined, {
      remoteVersionSent: "h-abc",
      wasUnstamped: true,
      stampVerified: true,
    });
    expect(v.status).toBe("unchanged");
    expect(v.warnings).toHaveLength(0);
  });

  it("stampVerified:false raises the stamp-contradiction (reached the pod, stamp genuinely missing)", () => {
    const v = classifyApplyResult(entry, { outcome: "unchanged", workspaceId: "w1" } as any, undefined, undefined, {
      remoteVersionSent: "h-abc",
      wasUnstamped: true,
      stampVerified: false,
    });
    expect(v.status).toBe("stamp-contradiction");
  });

  it("no verify result (null/undefined) falls back to the proxy — backward compatible", () => {
    const v = classifyApplyResult(entry, { outcome: "unchanged", workspaceId: "w1" } as any, undefined, undefined, {
      remoteVersionSent: "h-abc",
      wasUnstamped: true,
      // stampVerified omitted — old behavior
    });
    expect(v.status).toBe("stamp-contradiction");
  });

  it("never warns when the workspace was already stamped (wasUnstamped:false)", () => {
    const v = classifyApplyResult(entry, { outcome: "unchanged", workspaceId: "w1" } as any, undefined, undefined, {
      remoteVersionSent: "h-abc",
      wasUnstamped: false,
    });
    expect(v.status).toBe("unchanged");
  });

  it("compose-overlay note points at the updatable path, not 'can't update'", () => {
    const v = classifyApplyResult(entry, { status: "composed", workspaceId: "w1" } as any, undefined, undefined, {
      remoteVersionSent: "h-abc",
      wasUnstamped: false,
    });
    expect(v.status).toBe("composed");
    expect(v.warnings[0]).toContain("synap market update operations");
    expect(v.warnings[0]).not.toContain("isn't independently updatable");
  });
});

describe("summarizeApplyResults — governed proposal is not a failure", () => {
  it("counts 'proposed' in its own bucket, never as failed", () => {
    const s = summarizeApplyResults([
      { slug: "operations", status: "proposed" },
      { slug: "crm", status: "unchanged" },
    ]);
    expect(s.proposed).toBe(1);
    expect(s.failed).toBe(0);
    expect(s.line).toContain("proposed (awaiting review)");
    expect(s.line).not.toContain("failed");
  });

  it("a real failure still counts as failed", () => {
    const s = summarizeApplyResults([{ slug: "x", status: "fetch-failed" }]);
    expect(s.failed).toBe(1);
    expect(s.proposed).toBe(0);
  });
});
