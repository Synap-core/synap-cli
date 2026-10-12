/**
 * ONE diagnosis per key problem, from where the keys are and what the pod says
 * about each. Pure: no IO, so every state is unit-tested.
 *
 * Shared by `synap doctor` (and its `--fix`) and `synap whoami`, so the two can
 * never tell the person two different stories about the same key.
 *
 * Each diagnosis carries the ONE right action and the exact command, because
 * the 2026-10-12 incident was a wrong action taken on a wrong story: a key
 * that was only AWAITING APPROVAL was reported "revoked or expired", and every
 * re-run of `init` / `connect` filed another request instead of finishing the
 * first one.
 */

import type { KeyLocation } from "./key-locations.js";
import type { KeyState } from "./key-state.js";

export type DiagnosisCode =
  | "ok"
  | "awaiting_approval"
  | "replaced_by_other_computer"
  | "replaced_on_this_computer"
  | "revoked"
  | "expired"
  | "unknown_key"
  | "refused"
  | "unverifiable"
  | "stale_copies"
  | "env_shadow"
  | "person_key_dead";

/** The single thing `doctor --fix` does for a diagnosis. */
export type FixAction = "approve_and_wait" | "reprovision" | "rewrite" | "edit_shell_rc" | "login" | "none";

export interface Diagnosis {
  code: DiagnosisCode;
  severity: "ok" | "warn" | "error";
  /** Agent surface (claude-code, codex, …); absent for the person's own key / env. */
  surface?: string;
  /** The surface's display name. */
  label?: string;
  title: string;
  lines: string[];
  /** The exact command that resolves it (what `--fix` runs, or what the person runs). */
  command?: string;
  action: FixAction;
  /** The key the action works with: the one to approve, or the live one to copy. */
  key?: string;
  agentUserId?: string;
  approvalUrl?: string;
  /** The pod's agent type for the surface, when the pod said. */
  agentType?: string;
  /** The copies the diagnosis is about. */
  locations: KeyLocation[];
}

export interface DiagnoseInput {
  locations: KeyLocation[];
  /** The pod's answer per key (by plaintext). A key with no entry reads as unreachable. */
  states: Map<string, KeyState>;
  /** This computer's instance label for a surface. */
  instanceIdFor: (surface: string) => string;
  /** `SYNAP_HUB_API_KEY` as this process sees it. */
  envKey?: string;
  /** A surface's display name (the CLI's target label). Default: the surface id. */
  labelOf?: (surface: string) => string;
}

const day = (iso?: string | null) => (iso ? iso.replace("T", " ").slice(0, 16) + " UTC" : "an unknown time");

function stateOf(input: DiagnoseInput, key: string): KeyState {
  return input.states.get(key) ?? { state: "unreachable", error: "not asked" };
}

/** Why one key does not work, in one sentence. */
export function describeKeyState(s: KeyState): string {
  switch (s.state) {
    case "active":
      return "works";
    case "awaiting_approval":
      return "is waiting for your approval (it was never revoked)";
    case "revoked":
      return s.replacedBy
        ? `was replaced on ${day(s.revokedAt)} by a connection created ${day(s.replacedBy.createdAt)}`
        : `was revoked on ${day(s.revokedAt)}${s.revokedReason ? ` (${s.revokedReason})` : ""}`;
    case "expired":
      return `expired${s.expiresAt ? ` on ${day(s.expiresAt)}` : ""}`;
    case "unknown":
      return "is not a key this pod issued";
    case "inactive":
      return "is refused, and this pod is too old to say why";
    case "unreachable":
      return `could not be checked (${s.error ?? "pod unreachable"})`;
  }
}

const tail = (k: string) => (k.length <= 8 ? "…" : `…${k.slice(-6)}`);

function agentDiagnosis(input: DiagnoseInput, surface: string, group: KeyLocation[]): Diagnosis {
  const label = (input.labelOf ?? ((x: string) => x))(surface);
  const copies = group.filter((l) => l.kind !== "pending");
  const keys = [...new Set(group.map((l) => l.key))];
  const live = keys.filter((k) => stateOf(input, k).state === "active");
  const primaryLoc = group.find((l) => l.kind === "agent-key-by-pod") ?? copies[0] ?? group[0]!;
  const agentUserIdOf = (k: string) => group.find((l) => l.key === k && l.agentUserId)?.agentUserId;

  if (live.length > 0) {
    const liveKey = live.includes(primaryLoc.key) ? primaryLoc.key : live[0]!;
    const stale = copies.filter((l) => l.key !== liveKey);
    if (stale.length === 0)
      return { code: "ok", severity: "ok", surface, label, title: `${label}: key works`, lines: [], action: "none", key: liveKey, locations: copies };
    return {
      code: "stale_copies",
      severity: "warn",
      surface,
      label,
      title: `${label}: ${stale.length} cop${stale.length === 1 ? "y holds" : "ies hold"} an old key`,
      lines: [
        `The working key (${tail(liveKey)}) is in ${copies.filter((l) => l.key === liveKey).map((l) => l.label).join(", ")}.`,
        ...stale.map((l) => `${l.label} has ${tail(l.key)}, which ${describeKeyState(stateOf(input, l.key))}.`),
      ],
      command: "synap doctor --fix",
      action: "rewrite",
      key: liveKey,
      agentUserId: agentUserIdOf(liveKey),
      locations: stale,
    };
  }

  // Nothing works. A request waiting for approval is the whole story: finish it.
  const awaiting = keys.filter((k) => stateOf(input, k).state === "awaiting_approval");
  if (awaiting.length > 0) {
    const recorded = group.find((l) => l.kind === "pending" && awaiting.includes(l.key))?.key;
    const newest = [...awaiting].sort((a, b) =>
      String(stateOf(input, b).createdAt ?? "").localeCompare(String(stateOf(input, a).createdAt ?? ""))
    )[0]!;
    const key = recorded ?? newest;
    const s = stateOf(input, key);
    const holding = copies.filter((l) => l.key === key).map((l) => l.label);
    const lines = [
      `Key ${tail(key)} was filed${s.createdAt ? ` on ${day(s.createdAt)}` : ""} and nobody approved it yet — it was never revoked.`,
      ...(holding.length ? [`It is already written into ${holding.join(", ")}, which is why every call says "Invalid or expired API key".`] : []),
      ...(awaiting.length > 1 ? [`${awaiting.length - 1} other unapproved request${awaiting.length > 2 ? "s" : ""} for ${label} ${awaiting.length > 2 ? "are" : "is"} left over; approving this one is enough.`] : []),
      `Approve it: ${s.approvalUrl ?? "(open your pod's agent approvals)"}`,
    ];
    return {
      code: "awaiting_approval",
      severity: "error",
      surface,
      label,
      title: `${label} is waiting for your approval`,
      lines,
      command: "synap doctor --fix   (opens the link, waits, then writes the key)",
      action: "approve_and_wait",
      key,
      agentUserId: agentUserIdOf(key),
      approvalUrl: s.approvalUrl,
      agentType: s.agentType ?? undefined,
      locations: copies,
    };
  }

  // Every copy is dead. Explain the primary one.
  const s = stateOf(input, primaryLoc.key);
  const base = { surface, label, locations: copies, agentType: s.agentType ?? undefined, command: "synap doctor --fix   (asks the pod for a key for THIS computer, waits for your approval, then writes it everywhere)" };
  const where = copies.map((l) => l.label);
  if (s.state === "revoked" && s.replacedBy !== undefined) {
    const mine = input.instanceIdFor(surface);
    const otherInstance = s.replacedBy?.instanceId ?? null;
    if (otherInstance && otherInstance === mine)
      return {
        ...base,
        code: "replaced_on_this_computer",
        severity: "error",
        title: `${label}: a newer key from this computer replaced it, and was never saved here`,
        lines: [`Key ${tail(primaryLoc.key)} ${describeKeyState(s)} on THIS computer.`, `Stale copies: ${where.join(", ")}.`],
        action: "reprovision",
      };
    return {
      ...base,
      code: "replaced_by_other_computer",
      severity: "error",
      title: `${label}: another computer's connection replaced this computer's key`,
      lines: [
        `Key ${tail(primaryLoc.key)} ${describeKeyState(s)}.`,
        otherInstance
          ? `That connection belongs to another computer (${otherInstance}); approving it switched off every other ${label} key that shared its slot.`
          : `That connection carried no computer label (made by an older CLI), so approving it switched off EVERY ${label} key — this computer's included.`,
        `Give this computer its own connection: keys made now carry this computer's label (${input.instanceIdFor(surface)}), so approving one never switches another computer off.`,
      ],
      action: "reprovision",
    };
  }
  if (s.state === "revoked")
    return { ...base, code: "revoked", severity: "error", title: `${label}: key was revoked`, lines: [`Key ${tail(primaryLoc.key)} ${describeKeyState(s)}.`, `Copies: ${where.join(", ")}.`], action: "reprovision" };
  if (s.state === "expired")
    return { ...base, code: "expired", severity: "error", title: `${label}: key expired`, lines: [`Key ${tail(primaryLoc.key)} ${describeKeyState(s)}.`, `Copies: ${where.join(", ")}.`], action: "reprovision" };
  if (s.state === "unknown")
    return { ...base, code: "unknown_key", severity: "error", title: `${label}: this pod does not know the key`, lines: [`Key ${tail(primaryLoc.key)} ${describeKeyState(s)} — it was made for another pod, or deleted.`, `Copies: ${where.join(", ")}.`], action: "reprovision" };
  if (s.state === "inactive") {
    const recorded = group.find((l) => l.kind === "pending");
    return recorded
      ? { ...base, code: "refused", severity: "error", title: `${label}: key is refused (older pod — likely still awaiting approval)`, lines: [`Key ${tail(primaryLoc.key)} ${describeKeyState(s)}.`, "A request from this computer is recorded; finishing it is safer than filing another."], action: "approve_and_wait", key: recorded.key, agentUserId: recorded.agentUserId, command: "synap doctor --fix" }
      : { ...base, code: "refused", severity: "error", title: `${label}: key is refused`, lines: [`Key ${tail(primaryLoc.key)} ${describeKeyState(s)} (awaiting approval or revoked).`, `Copies: ${where.join(", ")}.`], action: "reprovision" };
  }
  return { ...base, code: "unverifiable", severity: "warn", title: `${label}: could not check the key`, lines: [`Key ${tail(primaryLoc.key)} ${describeKeyState(s)}.`], action: "none", command: "synap doctor   (again, once the pod answers)" };
}

/** Diagnose every key for one pod: the person's own key, each agent surface, the env var. */
export function diagnoseKeys(input: DiagnoseInput): Diagnosis[] {
  const out: Diagnosis[] = [];

  // 1. The person's / this computer's own CLI key (pod profile).
  for (const loc of input.locations.filter((l) => l.kind === "profile")) {
    const s = stateOf(input, loc.key);
    if (s.state === "active" || s.state === "unreachable") continue;
    out.push({
      code: "person_key_dead",
      severity: "error",
      title: `Your CLI key for this pod ${describeKeyState(s)}`,
      lines: [
        `${loc.label} holds ${tail(loc.key)}. Agent keys cannot be re-made without it.`,
        ...(s.state === "revoked" && s.replacedBy !== undefined
          ? [
              s.replacedBy?.instanceId && s.replacedBy.instanceId !== input.instanceIdFor(s.agentType ?? "")
                ? `It was an agent key: approving another computer's connection (${s.replacedBy.instanceId}) switched it off.`
                : "It was an agent key: approving a connection with no computer label (made by an older CLI, likely on another computer) switched off every key of that agent, this one included.",
            ]
          : []),
      ],
      command: `synap login --reconnect${loc.ref ? ` ${loc.ref}` : ""}`,
      action: "login",
      locations: [loc],
    });
  }

  // 2. One diagnosis per agent surface.
  const bySurface = new Map<string, KeyLocation[]>();
  for (const l of input.locations) {
    if (l.role !== "agent" || !l.surface) continue;
    bySurface.set(l.surface, [...(bySurface.get(l.surface) ?? []), l]);
  }
  const surfaceDiags = new Map<string, Diagnosis>();
  for (const [surface, group] of bySurface) {
    const d = agentDiagnosis(input, surface, group);
    surfaceDiags.set(surface, d);
    out.push(d);
  }

  // 3. The ambient SYNAP_HUB_API_KEY beats the CLI profile — name who sets it
  //    when it is not the working key it is meant to be.
  if (input.envKey) {
    const envState = stateOf(input, input.envKey);
    const setBy = input.locations.filter((l) => (l.kind === "claude-settings-env" || l.kind === "shell-rc") && l.key === input.envKey);
    const liveAgentKeys = [...surfaceDiags.values()].filter((d) => d.code === "ok" || d.code === "stale_copies").map((d) => d.key);
    const profileKeys = input.locations.filter((l) => l.kind === "profile").map((l) => l.key);
    const designed = envState.state === "active" && (liveAgentKeys.includes(input.envKey) || profileKeys.includes(input.envKey));
    if (!designed) {
      const shell = setBy.filter((l) => l.kind === "shell-rc");
      const fixedWithSurface = setBy.some((l) => l.kind === "claude-settings-env") && shell.length === 0;
      const who = setBy.length ? setBy.map((l) => l.label).join(" and ") : "something outside the files the doctor reads (your terminal or launcher)";
      out.push({
        code: "env_shadow",
        severity: envState.state === "active" ? "warn" : "error",
        title: `SYNAP_HUB_API_KEY overrides your CLI profile key${envState.state === "active" ? "" : " — and it does not work"}`,
        lines: [
          `It is set by ${who}.`,
          `Its key ${tail(input.envKey)} ${describeKeyState(envState)}; every command run with it set uses it instead of ${profileKeys.length ? "the profile key" : "any profile"}.`,
          ...(shell.length ? [`Edit ${shell.map((l) => l.label).join(", ")}: remove that line, or set it to the working key, then open a new shell.`] : []),
          ...(fixedWithSurface ? ["`synap doctor --fix` rewrites it together with the Claude Code key; restart Claude Code afterwards."] : []),
        ],
        command: shell.length ? `edit ${shell[0]!.label}` : fixedWithSurface ? "synap doctor --fix" : "unset SYNAP_HUB_API_KEY",
        action: shell.length ? "edit_shell_rc" : "none",
        locations: setBy,
      });
    }
  }
  return out;
}
