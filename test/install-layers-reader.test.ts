import { describe, it, expect } from "vitest";
import {
  classifyApplyResult,
  hasLayerFailure,
  type WorkspaceApplyResult,
} from "../src/commands/market.js";

/**
 * The CLI must READ the partial-install signal the pod now sends.
 *
 * On 2026-09-06 the pod stopped swallowing post-workspace layer failures and
 * began reporting them as `layers[]`. That only removes the lie if a client
 * consumes it: until this, `market install` printed a bare "✓ Installed" for an
 * install whose capabilities, playbooks and automations had all failed —
 * because the CLI's only failure signal was `seedFailed`, which covers
 * dependency seeding, not the post-workspace layers.
 *
 * Producer-without-consumer is this codebase's dominant defect. This test is
 * the consumer half, pinned.
 */
const ctx = { wasUnstamped: false } as const;
const entry = { slug: "crm", name: "CRM" } as never;

describe("classifyApplyResult reads layers[]", () => {
  it("a failed layer downgrades a created install to installed-with-failures", () => {
    const ws: WorkspaceApplyResult = {
      outcome: "created",
      layers: [
        { layer: "profiles", status: "applied" },
        { layer: "capabilities", status: "failed", detail: "seed timeout" },
      ],
    };
    expect(classifyApplyResult(entry, ws, undefined, undefined, ctx).status).toBe(
      "installed-with-failures",
    );
  });

  it("a failed layer downgrades a reconcile too", () => {
    const ws: WorkspaceApplyResult = {
      outcome: "reconciled",
      layers: [{ layer: "playbooks", status: "failed" }],
    };
    expect(classifyApplyResult(entry, ws, undefined, undefined, ctx).status).toBe(
      "updated-with-failures",
    );
  });

  it("all-applied layers stay a clean success", () => {
    const ws: WorkspaceApplyResult = {
      outcome: "created",
      layers: [{ layer: "capabilities", status: "applied" }],
    };
    expect(classifyApplyResult(entry, ws, undefined, undefined, ctx).status).toBe("installed");
  });

  it("an OLDER pod that sends no layers is not treated as a failure", () => {
    // Absence means "this pod cannot tell me", never "nothing failed" — and it
    // must not invent a failure either. `seedFailed` remains the fallback.
    const ws: WorkspaceApplyResult = { outcome: "created" };
    expect(classifyApplyResult(entry, ws, undefined, undefined, ctx).status).toBe("installed");
    expect(hasLayerFailure(undefined)).toBe(false);
    expect(hasLayerFailure([])).toBe(false);
  });

  it("an unrecognised layer status is not read as failure", () => {
    expect(hasLayerFailure([{ layer: "x", status: "skipped" }])).toBe(false);
    expect(hasLayerFailure([{ layer: "x" }])).toBe(false);
  });
});
