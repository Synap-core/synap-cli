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
  "needs-consent": "Needs your OK",
  "agent-asked": "Asked by an agent",
  current: "Up to date",
} as const;

export type TemplateStep = keyof typeof TEMPLATE_STEP_LABELS;
/** A step a space can be on — every step but `current`. */
export type TemplateUpdateStep = Exclude<TemplateStep, "current">;

/**
 * A step's words inside a CLI line, where the CLI writes them mid-sentence:
 * the same words with the first letter lowered ("needs your OK", never
 * "needs your ok" — an acronym keeps its case).
 */
export function templateStepPhrase(step: TemplateStep): string {
  const label = TEMPLATE_STEP_LABELS[step];
  return label.charAt(0).toLowerCase() + label.slice(1);
}

/**
 * Mirror of `TEMPLATE_STEP_PRECEDENCE` (synap-app `template-step.ts`): when
 * several steps hold, the first one listed is the space's mark and door. A
 * broken space outranks a decision; data changes outrank an agent's ask (it
 * would be held on them too); an agent's ask outranks a second plain update.
 */
export const TEMPLATE_STEP_PRECEDENCE = [
  "unfinished",
  "needs-consent",
  "agent-asked",
  "awaiting-approval",
  "update",
] as const satisfies ReadonlyArray<TemplateUpdateStep>;
type _EveryStepRanked =
  Exclude<TemplateUpdateStep, (typeof TEMPLATE_STEP_PRECEDENCE)[number]> extends never ? true : never;
const _everyStepRanked: _EveryStepRanked = true;
void _everyStepRanked;

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
} as const satisfies Record<string, TemplateUpdateStep | null>;

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
): TemplateUpdateStep | null {
  if (!state) return null;
  const step =
    state in STEP_FOR_STATE
      ? STEP_FOR_STATE[state as keyof typeof STEP_FOR_STATE]
      : "unfinished";
  if (step === "awaiting-approval" && awaitingApproval.length === 0) return "unfinished";
  return step;
}

/** The health-row fields the step is decided from (Hub `GET /workspaces`). */
export interface TemplateStepFields {
  drifted?: boolean;
  state?: string | null;
  awaitingApproval?: readonly string[];
  pendingDataChanges?: unknown;
  updateProposal?: { id: string } | null;
}

/**
 * The space's step by the shared rule (`classifyTemplateHealth`): each step
 * that holds, then the first by `TEMPLATE_STEP_PRECEDENCE`. `null` = current.
 * An older pod sends no `state` / `pendingDataChanges` / `updateProposal`, so
 * only `update` (from `drifted`) can hold there.
 */
export function classifyTemplateStep(row: TemplateStepFields): TemplateUpdateStep | null {
  const fromState = stepFromApplyState(row.state, row.awaitingApproval ?? []);
  const holds: Record<TemplateUpdateStep, boolean> = {
    unfinished: fromState === "unfinished",
    "needs-consent": row.pendingDataChanges != null,
    "agent-asked": row.updateProposal != null,
    "awaiting-approval": fromState === "awaiting-approval",
    update: row.drifted === true,
  };
  return TEMPLATE_STEP_PRECEDENCE.find((step) => holds[step]) ?? null;
}

/**
 * The glyph in front of a step. ⏳ says "wait", so it is kept for the one step
 * where the space waits on decisions already filed; a step the reader acts on
 * (not finished, data changes to agree to) is ⚠ (review2 UX §1 #6: ⏳ was
 * printed on a failed apply); an agent's ask to decide is →, the CLI's mark
 * for "proposed, awaiting review".
 */
export function templateStepGlyph(step: TemplateStep): "⚠" | "⏳" | "→" | null {
  if (step === "awaiting-approval") return "⏳";
  if (step === "unfinished" || step === "needs-consent") return "⚠";
  if (step === "agent-asked") return "→";
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
