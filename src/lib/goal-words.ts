/**
 * A GOAL's words as `synap track` prints them — status, verdict, kind of
 * work, uncertainty, criterion marks, what it waits on, who is on it, the
 * end state's label.
 *
 * `@synap-core/types/vocabulary` is the one door for these words, but this
 * package cannot import it (the CLI links only `@synap-core/hub-rest-client`
 * and `@synap-core/workspace-templates`). So each table here is a COPY of the
 * vocabulary's own, held EQUAL — keys and words — by
 * `test/goal-words-parity.test.ts`, which reads the vocabulary's source in
 * the sibling `synap-backend`. Delete this file for a plain import once the
 * CLI depends on a published `@synap-core/types` carrying them.
 */

/** `TRACK_STATUS_LABELS` */
export const TRACK_STATUS_LABELS: Readonly<Record<string, string>> = {
  proposed: "Draft",
  agreed: "Agreed",
  ready: "Ready",
  active: "Active",
  paused: "Paused",
  completed: "Closed",
  archived: "Dropped",
};

/** `TRACK_VERDICT_LABELS` */
export const TRACK_VERDICT_LABELS: Readonly<Record<string, string>> = {
  met: "Met",
  partly_met: "Partly met",
  not_met: "Not met",
  retired: "Retired",
  no_longer_needed: "No longer needed",
  impossible: "Impossible",
  replaced: "Replaced",
  mistake: "Created by mistake",
};

/** `TRACK_WORK_KIND_LABELS` */
export const TRACK_WORK_KIND_LABELS: Readonly<Record<string, string>> = {
  project: "Build",
  flow: "Flow",
  operation: "Operation",
  investigation: "Investigation",
  incident: "Incident",
  commission: "Commission",
  pathway: "Pathway",
};

/** `TRACK_UNCERTAINTY_LABELS` */
export const TRACK_UNCERTAINTY_LABELS: Readonly<Record<string, string>> = {
  clear: "Clear",
  complicated: "Complicated",
  complex: "Complex",
  chaotic: "Chaotic",
  unknown: "Unknown",
};

/** `GOAL_CRITERION_MARK_LABELS` */
export const GOAL_CRITERION_MARK_LABELS: Readonly<Record<string, string>> = {
  met: "Met",
  claimed: "Claimed",
  under_way: "Under way",
  not_met: "Not met",
  not_started: "Not started",
};

/** `WAITING_ON_REASON_LABELS` */
export const WAITING_ON_REASON_LABELS: Readonly<Record<string, string>> = {
  input: "Input",
  approval: "Approval",
  access: "Access",
  another_work: "Other work",
  outside_world: "Outside world",
};

/** `TRACK_PARTICIPANT_ROLE_LABELS` (vocabulary/track-participant-words.ts) */
export const TRACK_PARTICIPANT_ROLE_LABELS: Readonly<Record<string, string>> = {
  owner: "Owner",
  judge: "Judge",
  delegate: "Delegate",
  integrator: "Integrator",
};

/** `TRACK_COMMITMENT_STATE_LABELS` (vocabulary/track-participant-words.ts) */
export const TRACK_COMMITMENT_STATE_LABELS: Readonly<Record<string, string>> = {
  proposed: "Asked",
  accepted: "Accepted",
  countered: "Countered",
  declined: "Declined",
  reported_impossible: "Reported impossible",
  done: "Done",
};

/** `GOAL_FIELD_LABELS` — the goal's stored fields as a person reads them. */
export const GOAL_FIELD_LABELS: Readonly<Record<string, string>> = {
  endState: "What done looks like",
  criteria: "Done when",
  workKind: "Kind of work",
  uncertainty: "How well the way is known",
  dropConditions: "Drop it if",
};

/**
 * The vocabulary's fallback (`humanizeToken`, minus its cased-words list): a
 * value no table names reads as words, never as the raw token.
 */
export function humanizeToken(token: string): string {
  const tail = token.includes(".") ? token.slice(token.lastIndexOf(".") + 1) : token;
  const words = tail
    .replace(/[_-]+/g, " ")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .trim()
    .toLowerCase();
  return words ? words.charAt(0).toUpperCase() + words.slice(1) : "";
}

/** A token through its table, else humanized — `""` for none. */
export function goalWord(
  table: Readonly<Record<string, string>>,
  token: string | null | undefined,
): string {
  if (!token) return "";
  return Object.hasOwn(table, token) ? table[token]! : humanizeToken(token);
}
