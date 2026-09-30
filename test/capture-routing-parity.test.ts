import { describe, it, expect } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

import {
  captureExecuteRoutingHints,
  deriveWorkspacePlacementView,
  formatWorkspaceRouting,
  headlessPlacementFields,
  projectRoutingHints,
  workspaceRoutingHints,
  type CapturePlacement,
  type WorkspaceSelection,
} from "../src/lib/capture-structure.js";

/**
 * The CLI's structure → execute routing is a VERBATIM mirror of the ONE mapper
 * in `@synap-core/types` (`capture-routing-types.ts`) — the CLI cannot import
 * it until a `@synap-core/types` carrying it is published (see the mirror's
 * docblock). This runs the REAL mapper from the sibling source against the
 * mirror, on a structure answer carrying every routing field, so the two can
 * never drift on what reaches execute. A convergence guard: it proves
 * SAMENESS, not correctness — the shared mapper's own tests own that.
 *
 * Skips (does not fail) when the sibling repo is absent — the CLI is published
 * standalone and this must not turn red in a CLI-only checkout.
 */
const SHARED = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../synap-backend/packages/types/src/capture-routing-types.ts"
);

const WS = "11111111-1111-4111-8111-111111111111";
const FULL = {
  targetWorkspaceId: WS,
  targetWorkspaceReason: "Fits Finance best · Ops next",
  targetWorkspaceConfidence: 0.83,
  targetWorkspaceDecision: {
    decider: "jev" as const,
    model: "typesafe-router-v1",
    probabilities: { [WS]: 0.83, none: 0.17 },
    candidates: [{ id: WS, name: "Finance" }],
  },
  targetProjectId: "33333333-3333-4333-8333-333333333333",
  targetProjectReason: "Acme account",
  targetProjectConfidence: 0.71,
};

describe.skipIf(!existsSync(SHARED))("parity with @synap-core/types captureExecuteRoutingHints", () => {
  it("the mirror maps a full structure answer exactly as the shared mapper does", async () => {
    const shared = (await import(SHARED)) as {
      captureExecuteRoutingHints: typeof captureExecuteRoutingHints;
    };
    const expected = shared.captureExecuteRoutingHints(FULL);
    // Non-vacuity: the shared mapper still emits the decision + project hints.
    expect(Object.keys(expected).length).toBeGreaterThanOrEqual(7);
    expect(expected.aiWorkspaceDecision).toEqual(FULL.targetWorkspaceDecision);
    expect(captureExecuteRoutingHints(FULL)).toEqual(expected);
    // The two halves the doors send partition it — nothing dropped, nothing added.
    expect({ ...workspaceRoutingHints(FULL), ...projectRoutingHints(FULL) }).toEqual(expected);
  });
});

const WS_B = "22222222-2222-4222-8222-222222222222";

/**
 * The placement cases the two derivations could DISAGREE on — not a
 * representative sample. Each row rules out a plausible wrong rule:
 *  • deterministic          → must PIN, must never become a suggestion
 *  • suggestion + headless  → must NOT pre-fill it; records "ignored"
 *  • suggestion + interactive → pre-filled, saving ACCEPTS
 *  • chosen ≠ suggestion    → "changed"; chosen === suggestion → "accepted"
 *  • removed                → stays put, explicitly, as "removed"
 *  • no placement (old pod) → says nothing (empty execute)
 *  • no suggestion at all   → no choice recorded (choice is about a suggestion)
 */
const SUGGESTING: CapturePlacement = {
  workspaceId: WS,
  workspaceName: "Finance",
  deterministic: false,
  suggestion: {
    workspaceId: WS_B,
    workspaceName: "Ops",
    reason: "Fits Ops best",
    alternatives: [{ workspaceId: WS_B, workspaceName: "Ops", weight: 0.83 }],
  },
};
const DETERMINISTIC: CapturePlacement = {
  workspaceId: WS_B,
  workspaceName: "Ops",
  deterministic: true,
};
const AMBIENT_ONLY: CapturePlacement = {
  workspaceId: WS,
  workspaceName: "Finance",
  deterministic: false,
};
const CASES: Array<{
  name: string;
  placement: CapturePlacement | null;
  selection: WorkspaceSelection;
  interactive: boolean;
}> = [
  { name: "deterministic, headless", placement: DETERMINISTIC, selection: { kind: "default" }, interactive: false },
  { name: "deterministic, interactive", placement: DETERMINISTIC, selection: { kind: "default" }, interactive: true },
  { name: "suggestion, headless", placement: SUGGESTING, selection: { kind: "default" }, interactive: false },
  { name: "suggestion, interactive", placement: SUGGESTING, selection: { kind: "default" }, interactive: true },
  { name: "chosen = the suggestion", placement: SUGGESTING, selection: { kind: "chosen", workspaceId: WS_B, workspaceName: "Ops" }, interactive: true },
  { name: "chosen ≠ the suggestion", placement: SUGGESTING, selection: { kind: "chosen", workspaceId: WS, workspaceName: "Finance" }, interactive: true },
  { name: "removed", placement: SUGGESTING, selection: { kind: "removed" }, interactive: true },
  { name: "no suggestion", placement: AMBIENT_ONLY, selection: { kind: "default" }, interactive: true },
  { name: "old pod: no placement", placement: null, selection: { kind: "default" }, interactive: true },
];

describe.skipIf(!existsSync(SHARED))("parity with @synap-core/types deriveWorkspacePlacementView", () => {
  it.each(CASES)("$name derives identically", async ({ placement, selection, interactive }) => {
    const shared = (await import(SHARED)) as {
      deriveWorkspacePlacementView: typeof deriveWorkspacePlacementView;
    };
    // Non-vacuity: the shared derivation is the real one, not a stub.
    expect(typeof shared.deriveWorkspacePlacementView).toBe("function");
    expect(deriveWorkspacePlacementView(placement, selection, { interactive })).toEqual(
      shared.deriveWorkspacePlacementView(placement, selection, { interactive })
    );
  });

  it("the headless door never pre-fills a suggestion, and pins a deterministic placement", () => {
    // The two facts the CLI depends on, asserted on the VALUE it sends.
    expect(headlessPlacementFields({ placement: SUGGESTING })).toEqual({
      workspaceChoice: "ignored",
    });
    expect(headlessPlacementFields({ placement: DETERMINISTIC })).toEqual({
      targetWorkspaceId: WS_B,
    });
    expect(headlessPlacementFields({ placement: null })).toEqual({});
  });
});

describe("the CLI's execute bodies go through the mirror", () => {
  const src = (f: string) =>
    readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), "../src/commands", f), "utf8");

  for (const file of ["import.ts", "knowledge.ts"]) {
    it(`${file} hand-copies no ai* routing field and never pins the AI's project`, () => {
      const code = src(file);
      // Non-vacuity: the file still builds an execute body.
      expect(code).toMatch(/\/capture\/execute/);
      expect(code).toMatch(/workspaceRoutingHints\(structureRes\)/);
      // The destination comes from the ONE derivation, never a hand-rolled pin.
      expect(code).toMatch(/headlessPlacementFields\(structureRes\)/);
      // The move that never happens: no door may report `movedToWorkspace`.
      expect(code).not.toMatch(/movedToWorkspace/);
      expect(code).not.toMatch(/\bai(?:Workspace|Project)\w*\s*:/);
      // The execute-body spread `{ projectId: projTarget }` (the AI pick as a
      // PIN). Receipts may still REPORT projTarget; only this shape is banned.
      expect(code).not.toMatch(/\{\s*projectId:\s*projTarget\s*\}/);
    });
  }
});

describe("formatWorkspaceRouting", () => {
  it("prints the workspace NAME with the confidence once", () => {
    expect(
      formatWorkspaceRouting({
        targetWorkspaceId: WS,
        targetWorkspaceName: "Finance",
        targetWorkspaceConfidence: 0.83,
      })
    ).toBe("Finance (83%)");
  });

  it("falls back to the id only when the pod named nothing, and omits an absent confidence", () => {
    expect(formatWorkspaceRouting({ targetWorkspaceId: WS })).toBe(WS);
    expect(formatWorkspaceRouting({})).toBeNull();
  });
});
