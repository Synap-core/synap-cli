/**
 * Pod-wide vocabulary — ONE canonical spelling for "not scoped to a workspace".
 *
 * The CLI had four different spellings of the pod-wide idea:
 *
 *   1. `--global`            boolean flag on `capture` (index.ts:648 → knowledge.ts:628)
 *   2. omitting `--workspace` documented as "(omit for pod-wide)" on ask/capture/
 *                            knowledge/cell (index.ts:318, 623, 896, 1858)
 *   3. omitting `--pin-workspace` documented as "(default: pod-wide lens)" (index.ts:116)
 *   4. `__pod_wide__`        internal sentinel in the launch picker (launch.ts:576)
 *
 * Only #1 is a knob the user TYPES to opt in; #2 and #3 are absences (a
 * different mechanism — you cannot alias "not passing a flag"), and #4 never
 * leaves the process. So the unification here is narrow and honest: canonicalise
 * the typed opt-in, and leave the absences alone rather than pretend they are
 * spellings of the same switch.
 *
 * CANONICAL: `--pod-wide`. Chosen over `--global` because "global" is already
 * overloaded in this CLI to mean "durable rather than per-session" — `synap use`
 * and `synap project use` both report `scope: "global"` for exactly that other
 * meaning (data.ts:229,281; lens.ts:227,355,396). "Pod-wide" is the term the
 * data model and every help string already use for the scope axis, so it is the
 * one that cannot be misread.
 *
 * `--global` remains an accepted ALIAS — it is what every existing script and
 * the `synap capture --global` line in CLAUDE.md types, and breaking that to win
 * a naming argument would be a worse defect than the inconsistency.
 */

/** Every accepted spelling of the pod-wide opt-in. First entry is canonical. */
export const POD_WIDE_FLAGS = ["pod-wide", "global"] as const;

/** Accepted string tokens meaning "pod-wide" where a scope VALUE is parsed. */
const POD_WIDE_TOKENS = new Set(["pod", "pod-wide", "podwide", "pod_wide", "global"]);

/** True when a user-supplied scope value spells "pod-wide" rather than naming a workspace. */
export function isPodWideToken(value: string | undefined | null): boolean {
  if (!value) return false;
  return POD_WIDE_TOKENS.has(value.trim().toLowerCase());
}

/**
 * Resolve the pod-wide opt-in from parsed options, accepting every spelling.
 * Commander camel-cases `--pod-wide` to `podWide`.
 */
export function resolvePodWide(opts: { podWide?: boolean; global?: boolean }): boolean {
  return Boolean(opts.podWide || opts.global);
}
