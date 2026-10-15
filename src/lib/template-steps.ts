/**
 * Where a space stands with its template, in the words every surface uses.
 *
 * The product's ONE table for these words is `TEMPLATE_STEP_LABELS` in
 * `@synap-core/types/vocabulary`, and the ONE rule that sorts a pod health row
 * into a step is `classifyTemplateHealth` in `@synap-core/web/marketplace`.
 * This package cannot import either (it links only `@synap-core/hub-rest-client`
 * and `@synap-core/workspace-templates`), so both are MIRRORED here, and
 * `test/template-step-vocabulary-parity.test.ts` reads the two sources across
 * the repo boundary and fails when either side moves. Edit both sides.
 */

/** Mirror of `TEMPLATE_STEP_LABELS` (synap-backend `packages/types/src/vocabulary/index.ts`). */
export const TEMPLATE_STEP_LABELS = {
  update: "Update available",
  unfinished: "Not finished",
  "awaiting-approval": "Waiting for approval",
  current: "Up to date",
} as const;

export type TemplateStep = keyof typeof TEMPLATE_STEP_LABELS;

/** A step's words inside a CLI line, where the CLI writes lower case: the same words. */
export function templateStepPhrase(step: TemplateStep): string {
  return TEMPLATE_STEP_LABELS[step].toLowerCase();
}

/**
 * Two marks the vocabulary does not carry yet (FIX-WAVE-2 lane cli): the
 * update waits on the person to agree to data changes (`pendingDataChanges`),
 * and an agent asked to update the space (`updateProposal`). CLI-only words
 * until the vocabulary names them; the parity test keeps them out of the
 * mirror so they can never pass for vocabulary rows.
 */
export const NEEDS_YOUR_OK = "Needs your OK";
export const ASKED_BY_AN_AGENT = "Asked by an agent";

/**
 * Mirror of `STEP_FOR_STATE` (synap-app `packages/web/src/marketplace/utils/template-step.ts`):
 * every apply state the pod reports, sorted into a step. `null` = no step of
 * its own (a build in flight, or a finished apply).
 */
export const STEP_FOR_STATE = {
  building: null,
  active: null,
  "awaiting-approval": "awaiting-approval",
  partial: "unfinished",
  "layer-2-not-run": "unfinished",
  failed: "unfinished",
} as const satisfies Record<string, Exclude<TemplateStep, "current"> | null>;

/**
 * The step the pod's apply `state` puts a space on, by the same rule as
 * `classifyTemplateHealth`: a state this CLI does not know reads as unfinished
 * (never current), and waiting on nothing is not waiting — once every proposal
 * is decided, the update finishes the apply (review2 UX-M4). `null` = the state
 * says nothing (absent on an older pod, `active`, or `building`); the caller
 * falls back to drift.
 */
export function stepFromApplyState(
  state: string | null | undefined,
  awaitingApproval: readonly string[]
): Exclude<TemplateStep, "current"> | null {
  if (!state) return null;
  const step =
    state in STEP_FOR_STATE
      ? STEP_FOR_STATE[state as keyof typeof STEP_FOR_STATE]
      : "unfinished";
  if (step === "awaiting-approval" && awaitingApproval.length === 0) return "unfinished";
  return step;
}

/**
 * The glyph in front of a step. ⏳ says "wait", so it is kept for the one step
 * where the space waits on someone else's decision; a step the reader acts on
 * (not finished) is ⚠ (review2 UX §1 #6: ⏳ was printed on a failed apply).
 */
export function templateStepGlyph(step: TemplateStep): "⚠" | "⏳" | null {
  if (step === "awaiting-approval") return "⏳";
  if (step === "unfinished") return "⚠";
  return null;
}

/**
 * The one door to the proposals a template apply waits on: the proposal itself
 * when there is one, the review queue when there are several. `null` = none.
 */
export function proposalsDoor(ids: readonly string[]): string | null {
  if (ids.length === 0) return null;
  return ids.length === 1 ? `synap open proposal ${ids[0]}` : "synap proposals";
}
