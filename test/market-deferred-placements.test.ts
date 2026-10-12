/**
 * `deferredPlacementLines` — what `synap market install|update` prints when the
 * pod held back a template's action button because the playbook it launches is
 * waiting on a proposal (`/packages/apply` → `actionPlacements.deferred[]`,
 * synap-backend `package-apply-post-workspace.ts`). Live defect 2026-10-12: the
 * CRM update with an agent key 500'd on exactly this; the pod now defers, and
 * the person must be told which proposal brings the button.
 *
 * Covers the pure line builder; that both apply paths print it is a call each
 * in `market.ts` (marketInstall, applyOnePackage) and is not asserted here.
 */
import { describe, it, expect } from "vitest";
import { deferredPlacementLines } from "../src/commands/market.js";

describe("deferredPlacementLines", () => {
  it("names the button and the proposal that brings it", () => {
    const lines = deferredPlacementLines({
      actionPlacements: {
        status: "proposed",
        count: 0,
        deferred: [
          {
            kind: "playbook",
            ref: "Qualify a lead",
            label: "Qualify lead",
            proposalId: "a99e1d4e-0000-0000-0000-000000000000",
          },
        ],
      },
    });
    expect(lines).toEqual([
      'The "Qualify lead" button appears once you approve proposal a99e1d4e-0000-0000-0000-000000000000 (synap open proposal a99e1d4e-0000-0000-0000-000000000000), then run synap market update again.',
    ]);
  });

  it("falls back to the ref when the placement has no label", () => {
    const [line] = deferredPlacementLines({
      actionPlacements: { deferred: [{ ref: "Win a deal", proposalId: "p1" }] },
    });
    expect(line).toContain('"Win a deal" button');
  });

  it("prints nothing for a placement that merged, or an older pod that sends no deferred[]", () => {
    expect(deferredPlacementLines({ actionPlacements: { status: "merged", count: 1, total: 1 } })).toEqual([]);
    expect(deferredPlacementLines({})).toEqual([]);
  });
});
