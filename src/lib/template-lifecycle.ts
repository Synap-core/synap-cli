/**
 * Template lifecycle on the CLI side — two pod answers rendered in plain words.
 *
 *   1. DATA CHANGES that ride a template update (contract C). The pod's update
 *      preview lists conversion ops still owed to this pod's data
 *      (`dataChanges: [{ opKey, description, affected, destructive }]`); a real
 *      apply that does not consent to every one of them is refused with 409
 *      `DATA_CHANGES_NEED_CONSENT` and writes nothing. This module turns that
 *      wire into lines a person reads, and decides which opKeys the person has
 *      ACTUALLY agreed to — never more.
 *   2. RETIRED TEMPLATES (contract A). The pod's template health says, per
 *      workspace, whether its template is `current`, `retired` (replaced by X),
 *      `unlisted` (gone from a COMPLETE catalog read) or `unknown` (the catalog
 *      read was not provably complete — never claimed gone).
 *
 * Every parser here distinguishes "the pod did not send this field" (an older
 * pod: behave exactly as before) from "the pod sent it and it is empty"
 * (nothing to agree to). The two are different facts and are never folded.
 */

import chalk from "chalk";
import { HubError } from "./hub-client.js";

// ── Data changes ────────────────────────────────────────────────────────────

export interface DataChange {
  /** Stable conversion-op key — what `acceptDataChanges` names. */
  opKey: string;
  /** One plain sentence from the pod, e.g. "Deals move their stage to the commercial stage". */
  description: string;
  /** Records the engine's own dry run says the op changes, pod-wide. `null` = not counted (see `error`). */
  affected: number | null;
  /**
   * The op retires data. It is NEVER run by an update and cannot be agreed to
   * here: it is an operator step (`operatorCommand`). The CLI never sends its key.
   */
  destructive: boolean;
  /** Why the count failed, when `affected` is null. */
  error?: string;
  /** Destructive only: the command an operator runs (dry run first). */
  operatorCommand?: string;
}

export const DATA_CHANGES_CONSENT_CODE = "DATA_CHANGES_NEED_CONSENT";

/**
 * Read `dataChanges` off a pod response.
 * - `undefined`: the pod sent no such field (an older pod) — behave as before.
 * - `[]`: the pod checked and nothing is owed.
 * Entries without an `opKey` are dropped: a change with no key cannot be
 * consented to, so it cannot be sent back either.
 */
export function parseDataChanges(raw: unknown): DataChange[] | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const field = (raw as Record<string, unknown>).dataChanges;
  if (!Array.isArray(field)) return undefined;
  const out: DataChange[] = [];
  for (const item of field) {
    if (!item || typeof item !== "object") continue;
    const r = item as Record<string, unknown>;
    const opKey = typeof r.opKey === "string" ? r.opKey.trim() : "";
    if (!opKey) continue;
    const affected =
      typeof r.affected === "number" && Number.isFinite(r.affected) ? r.affected : null;
    out.push({
      opKey,
      description:
        typeof r.description === "string" && r.description.trim()
          ? r.description.trim()
          : opKey,
      affected,
      destructive: r.destructive === true,
      ...(typeof r.error === "string" && r.error.trim() ? { error: r.error.trim() } : {}),
      ...(typeof r.operatorCommand === "string" && r.operatorCommand.trim()
        ? { operatorCommand: r.operatorCommand.trim() }
        : {}),
    });
  }
  return out;
}

/**
 * The data changes a space's update is HELD for, as the pod's health row
 * carries them (Hub `GET /workspaces` `pendingDataChanges`): the stamp waits
 * until a person agrees. The row has no opKeys — the person's door is
 * `synap templates update <slug>`, whose prompt lists them with their keys.
 */
export interface PendingDataChanges {
  /** How many changes the update waits on. 0 only when `unreadable`. */
  count: number;
  /** The pod's own sentence per change (or the one "could not be read" sentence). */
  sentences: string[];
  /** The pod knows the update is held but could not read which changes. Held all the same. */
  unreadable: boolean;
  /** The READER cannot agree themselves: it takes a pod owner or admin. */
  needsPodAdmin: boolean;
}

/**
 * Read `pendingDataChanges` off a health row.
 * - `undefined`: the pod sent no such field (an older pod) — draw nothing new.
 * - `null`: the pod checked and nothing is held.
 * A malformed value reads as `undefined` (unknown), never as "nothing held".
 */
export function parsePendingDataChanges(row: Record<string, unknown>): PendingDataChanges | null | undefined {
  if (!("pendingDataChanges" in row)) return undefined;
  const raw = row.pendingDataChanges;
  if (raw === null) return null;
  if (!raw || typeof raw !== "object") return undefined;
  const r = raw as Record<string, unknown>;
  const sentences = Array.isArray(r.sentences)
    ? r.sentences.filter((s): s is string => typeof s === "string" && s.trim() !== "").map((s) => s.trim())
    : [];
  const count = typeof r.count === "number" && Number.isFinite(r.count) ? r.count : sentences.length;
  return {
    count,
    sentences,
    unreadable: r.unreadable === true,
    // Unknown reads as "you may not be able to agree": the pod's own default.
    needsPodAdmin: r.needsPodAdmin !== false,
  };
}

/** An agent's pending "update this space" proposal (`updateProposal`), or null. */
export function parseUpdateProposal(row: Record<string, unknown>): { id: string } | null {
  const raw = row.updateProposal as { id?: unknown } | null | undefined;
  return raw && typeof raw.id === "string" && raw.id ? { id: raw.id } : null;
}

/** The data changes a 409 consent refusal carries, or null when the error is something else. */
export function dataChangesFromRefusal(err: unknown): DataChange[] | null {
  if (!(err instanceof HubError)) return null;
  const body = err.body as Record<string, unknown> | undefined;
  const code = err.code ?? (typeof body?.code === "string" ? body.code : undefined);
  if (err.status !== 409 || code !== DATA_CHANGES_CONSENT_CODE) return null;
  return parseDataChanges(body) ?? [];
}

/**
 * True when a 409 consent refusal is about WHO asked, not what was agreed: the
 * caller is an agent, and only a person can agree to a data change. The pod
 * says so with `needsPerson`; an older pod is read from its shape — it refuses
 * a person only for a missing agreement, so an empty `missing` beside an owed
 * agreeable change can only be an agent's refusal.
 */
export function consentNeedsPerson(err: unknown): boolean {
  if (dataChangesFromRefusal(err) === null) return false;
  const body = (err as HubError).body as Record<string, unknown> | undefined;
  if (typeof body?.needsPerson === "boolean") return body.needsPerson;
  const owed = parseDataChanges(body) ?? [];
  return Array.isArray(body?.missing) && body.missing.length === 0 && owed.some((d) => !d.destructive);
}

/**
 * The pod's two other data-change refusals, in plain words. `null` for any
 * other error (the caller's generic failure path renders those).
 * - 403 `DATA_CHANGES_NEED_POD_ADMIN`: you agreed, but a data change rewrites
 *   its kind pod-wide, so only a pod owner or admin may run it.
 * - 409 `DATA_CHANGES_FAILED`: a change failed mid-run; the template was NOT
 *   applied. Changes that ran stay applied, so a re-run lists only the rest.
 */
export function dataChangeRefusalMessage(err: unknown): string | null {
  if (!(err instanceof HubError)) return null;
  const body = err.body as Record<string, unknown> | undefined;
  const code = err.code ?? (typeof body?.code === "string" ? body.code : undefined);
  if (err.status === 403 && code === "DATA_CHANGES_NEED_POD_ADMIN") {
    return "Its data changes rewrite records across the whole pod, so only a pod owner or admin can run them. Nothing was written.";
  }
  if (err.status === 409 && code === "DATA_CHANGES_FAILED") {
    const detail = typeof body?.error === "string" && body.error.trim() ? ` ${body.error.trim()}` : "";
    return `A data change failed, so the template was not applied.${detail} The changes that ran stay done; run the update again to finish.`;
  }
  return null;
}

function countPhrase(n: number | null): string {
  if (n === null) return "count not reported";
  return `${n} ${n === 1 ? "record" : "records"}`;
}

/** One line per data change: the pod's own sentence, then its count. */
export function formatDataChange(dc: DataChange): string {
  let line = `${dc.description} ${chalk.dim(`(${countPhrase(dc.affected)} · ${dc.opKey})`)}`;
  if (dc.affected === null && dc.error) {
    line += "\n      " + chalk.yellow(`The pod couldn't count it: ${dc.error}`);
  }
  if (dc.destructive) {
    line += "\n      " + chalk.dim("It retires old data, so it never runs with an update. An operator runs it:");
    if (dc.operatorCommand) line += "\n      " + chalk.dim(dc.operatorCommand);
  }
  return line;
}

/** Print the "Data changes" block for one template. Prints nothing for an empty list. */
export function printDataChanges(slug: string, changes: DataChange[]): void {
  if (changes.length === 0) return;
  console.log("  " + chalk.bold(`Data changes for ${slug}`) + chalk.dim(" (they run with the update, once you agree)"));
  for (const dc of changes.filter((d) => !d.destructive)) console.log("    • " + formatDataChange(dc));
  const operator = changes.filter((d) => d.destructive);
  if (operator.length > 0) {
    console.log("  " + chalk.bold(`Operator steps for ${slug}`) + chalk.dim(" (never run by an update)"));
    for (const dc of operator) console.log("    • " + formatDataChange(dc));
  }
}

/** `--accept-data-changes a,b c` → ["a","b","c"]. Commander hands a string (or undefined). */
export function parseAcceptList(raw: string | string[] | undefined): string[] {
  if (!raw) return [];
  const parts = Array.isArray(raw) ? raw : [raw];
  return parts
    .flatMap((p) => p.split(/[,\s]+/))
    .map((s) => s.trim())
    .filter(Boolean);
}

export interface ConsentDecision {
  /** opKeys the person agreed to, in the pod's order. Only these are ever sent. */
  accepted: string[];
  /** Agreeable changes the person has NOT agreed to. Non-empty ⇒ the update must not be applied. */
  missing: DataChange[];
  /** Destructive changes the person named: an operator step, so never sent. */
  refusedOperatorSteps: string[];
}

/**
 * Decide consent WITHOUT prompting. Only NON-destructive changes can be agreed
 * to here; a destructive one is an operator step, never sent (the pod refuses
 * an accepted destructive key). `yes` agrees to every agreeable change (the
 * person typed `--yes` on a command that has just printed them); otherwise only
 * the opKeys named in `acceptList` count. A name that is not pending is simply
 * not sent — agreeing to a change the pod did not list means nothing.
 */
export function decideConsent(
  pending: DataChange[],
  input: { yes?: boolean; acceptList?: string[] }
): ConsentDecision {
  const named = new Set(input.acceptList ?? []);
  const accepted: string[] = [];
  const missing: DataChange[] = [];
  const refusedOperatorSteps: string[] = [];
  for (const d of pending) {
    if (d.destructive) {
      if (named.has(d.opKey)) refusedOperatorSteps.push(d.opKey);
      continue;
    }
    if (input.yes || named.has(d.opKey)) accepted.push(d.opKey);
    else missing.push(d);
  }
  return { accepted, missing, refusedOperatorSteps };
}

/** The exact command that re-runs an update with consent to these changes. */
export function consentRerunCommand(slug: string, changes: DataChange[]): string {
  const keys = changes.filter((d) => !d.destructive).map((d) => d.opKey);
  return `synap templates update ${slug} --accept-data-changes ${keys.join(",")}`;
}

/**
 * What the CLI says when the pod refuses an update for its data changes (409
 * `DATA_CHANGES_NEED_CONSENT`). `person` = `consentNeedsPerson`: the refusal is
 * about WHO ran it. The person may well be at this terminal with an agent key
 * configured, so the hint says how to tell: `synap whoami` must say
 * "Is agent: no" for the agreement to count.
 */
export function consentRefusalLines(
  name: string,
  slug: string,
  owed: DataChange[],
  person: boolean
): { warn: string; hints: string[] } {
  const warn = person
    ? `${name} was not updated: only a person can agree to its data changes, and this ran with an agent's key. Nothing was written.`
    : `${name} was not updated: it carries data changes you have not agreed to. Nothing was written.`;
  if (!owed.some((d) => !d.destructive)) return { warn, hints: [] };
  const rerun = consentRerunCommand(slug, owed);
  return {
    warn,
    hints: person
      ? [
          `A person runs, in their own terminal: ${rerun}`,
          "Check the key first: `synap whoami` must say Is agent: no.",
        ]
      : [`To agree and update: ${rerun}`],
  };
}

// ── Template lifecycle (retired / unlisted / unknown) ───────────────────────

export type TemplateLifecycle = "current" | "retired" | "unlisted" | "unknown";

export interface LifecycleInfo {
  lifecycle: TemplateLifecycle;
  replacedBy: string | null;
  retiredReason: string | null;
  /** The pod's own plain sentence (`lifecycleWarning`) — preferred over the CLI's fallback wording. */
  warning: string | null;
}

const LIFECYCLES: ReadonlySet<string> = new Set(["current", "retired", "unlisted", "unknown"]);

/**
 * Read lifecycle off a Hub `/workspaces` row. `undefined` = the pod sent no
 * lifecycle (older pod): the caller shows exactly what it showed before. A
 * value this CLI does not know reads as `unknown` — never as `current`.
 */
export function parseLifecycle(row: Record<string, unknown>): LifecycleInfo | undefined {
  const raw = row.lifecycle;
  if (raw === undefined || raw === null) return undefined;
  const lifecycle: TemplateLifecycle =
    typeof raw === "string" && LIFECYCLES.has(raw) ? (raw as TemplateLifecycle) : "unknown";
  const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : null);
  return {
    lifecycle,
    replacedBy: str(row.replacedBy),
    retiredReason: str(row.retiredReason),
    warning: str(row.lifecycleWarning),
  };
}

/**
 * The plain sentence for a template that is not `current`, with the command
 * that acts on it. Null for `current` (nothing to say).
 */
export function lifecycleNotice(
  slug: string,
  info: LifecycleInfo
): { label: string; action: string | null } | null {
  switch (info.lifecycle) {
    case "current":
      return null;
    case "retired":
      return {
        label:
          info.warning ??
          (info.replacedBy
            ? `Retired: ${slug} is replaced by ${info.replacedBy}`
            : `Retired: ${slug} has no replacement`),
        // Retire-into needs a target; with none there is nothing to move into.
        action: info.replacedBy ? `synap templates retire ${slug}` : null,
      };
    case "unlisted":
      return { label: info.warning ?? `No longer in the catalog: ${slug}`, action: null };
    case "unknown":
      return {
        label: `Catalog not fully synced: the pod can't say yet whether ${slug} is still offered`,
        action: null,
      };
  }
}

// ── Overlays (packs composed onto a space) ──────────────────────────────────

export interface OverlayInfo {
  slug: string;
  info: LifecycleInfo;
  /** Retired, and its replacement is already on this space: nothing to move. */
  replacementHere: boolean;
}

/**
 * Read `overlays` off a Hub `/workspaces` row. `undefined` = the pod sent no
 * such field (an older pod): show exactly what was shown before. `[]` = the
 * space has no overlays. An entry with no lifecycle reads as `unknown`.
 */
export function parseOverlays(row: Record<string, unknown>): OverlayInfo[] | undefined {
  const raw = row.overlays;
  if (!Array.isArray(raw)) return undefined;
  const out: OverlayInfo[] = [];
  for (const item of raw) {
    const o = asObj(item);
    const slug = o ? asStr(o.slug) : null;
    if (!o || !slug) continue;
    out.push({
      slug,
      info: parseLifecycle(o) ?? { lifecycle: "unknown", replacedBy: null, retiredReason: null, warning: null },
      replacementHere: o.replacementHere === true,
    });
  }
  return out;
}

/**
 * The notice for an overlay: the SAME label `lifecycleNotice` gives a space
 * (the pod's own sentence first), but never an action — an overlay is not a
 * space, so `synap templates retire` has nothing to move for it.
 */
export function overlayNotice(o: OverlayInfo): { label: string; action: null } | null {
  const n = lifecycleNotice(o.slug, o.info);
  return n ? { label: n.label, action: null } : null;
}

/** An overlay that needs the person: retired, and its replacement is not on the space. */
export function overlayNeedsAttention(o: OverlayInfo): boolean {
  return o.info.lifecycle === "retired" && !o.replacementHere;
}

// ── Retire-into plan ────────────────────────────────────────────────────────

export interface RetireMove {
  kind: string;
  count: number | null;
}
export interface RetireStay {
  kind: string;
  count: number | null;
  reason: string;
}
export interface RetirePlan {
  sourceName: string | null;
  sourceSlug: string | null;
  targetSlug: string | null;
  targetWorkspaceId: string | null;
  targetName: string | null;
  willInstall: boolean;
  moves: RetireMove[];
  stays: RetireStay[];
  willArchive: boolean | null;
}

export type RetireOutcome =
  | { kind: "plan"; plan: RetirePlan }
  | { kind: "applied"; plan: RetirePlan; archived: boolean | null; remaining: RetireStay[] }
  | { kind: "proposed"; plan: RetirePlan | null; proposalId: string | null; reviewUrl: string | null };

const pick = (o: Record<string, unknown> | undefined, ...keys: string[]): unknown => {
  if (!o) return undefined;
  for (const k of keys) if (o[k] !== undefined) return o[k];
  return undefined;
};
const asObj = (v: unknown): Record<string, unknown> | undefined =>
  v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;
const asStr = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : null);
const asNum = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

function parseGroups<T>(raw: unknown, map: (r: Record<string, unknown>) => T | null): T[] {
  if (!Array.isArray(raw)) return [];
  return raw.map((r) => (asObj(r) ? map(asObj(r)!) : null)).filter((x): x is T => x !== null);
}

function kindOf(r: Record<string, unknown>): string | null {
  return asStr(pick(r, "kind", "profileSlug", "profile", "slug"));
}

/**
 * Parse the retire-into response defensively. Returns null when the body has
 * no recognisable plan AND no proposal — a caller must then say "the pod's
 * answer couldn't be read", never "nothing to move".
 */
export function parseRetireResponse(raw: unknown): RetireOutcome | null {
  const body = asObj(raw);
  if (!body) return null;
  const planObj = asObj(body.plan) ?? (body.moves !== undefined ? body : undefined);
  let plan: RetirePlan | null = null;
  if (planObj) {
    const source = asObj(planObj.source);
    const target = asObj(planObj.target);
    plan = {
      sourceName: asStr(pick(source, "name", "workspaceName")),
      sourceSlug: asStr(pick(source, "slug", "packageSlug")),
      targetSlug: asStr(pick(target, "slug", "replacedBy")) ?? asStr(planObj.replacedBy),
      targetWorkspaceId: asStr(pick(target, "workspaceId", "id")),
      targetName: asStr(pick(target, "name", "workspaceName")),
      willInstall: pick(target, "willInstall", "install") === true,
      moves: parseGroups(planObj.moves, (r) => {
        const kind = kindOf(r);
        return kind ? { kind, count: asNum(pick(r, "count", "affected")) } : null;
      }),
      stays: parseGroups(planObj.stays, (r) => {
        const kind = kindOf(r);
        return kind
          ? { kind, count: asNum(pick(r, "count", "affected")), reason: asStr(r.reason) ?? "no reason given" }
          : null;
      }),
      willArchive:
        typeof pick(planObj, "willArchive", "archiveSource") === "boolean"
          ? (pick(planObj, "willArchive", "archiveSource") as boolean)
          : null,
    };
  }
  const status = asStr(body.status);
  if (status === "proposed" || body.proposalId !== undefined) {
    return {
      kind: "proposed",
      plan,
      proposalId: asStr(body.proposalId),
      reviewUrl: asStr(body.reviewUrl),
    };
  }
  if (!plan) return null;
  if (status === "applied" || status === "done" || status === "completed") {
    const archived = typeof body.archived === "boolean" ? body.archived : null;
    const remaining = parseGroups(body.remaining, (r) => {
      const kind = kindOf(r);
      return kind
        ? { kind, count: asNum(pick(r, "count", "affected")), reason: asStr(r.reason) ?? "no reason given" }
        : null;
    });
    return { kind: "applied", plan, archived, remaining: remaining.length ? remaining : plan.stays };
  }
  return { kind: "plan", plan };
}

function countOf(n: number | null): string {
  return n === null ? "some" : String(n);
}

/** The plan in plain lines (no trailing hints). */
export function formatRetirePlan(plan: RetirePlan): string[] {
  const lines: string[] = [];
  const target = plan.targetSlug ?? "(no replacement named)";
  if (plan.targetWorkspaceId) {
    lines.push(`Target: ${target}, already installed${plan.targetName ? ` as "${plan.targetName}"` : ""} (${plan.targetWorkspaceId})`);
  } else if (plan.willInstall) {
    lines.push(`Target: ${target}, not installed yet. It will be installed first.`);
  } else {
    lines.push(`Target: ${target}`);
  }
  if (plan.moves.length === 0) {
    lines.push("Moves: nothing to move.");
  } else {
    lines.push("Moves:");
    for (const m of plan.moves) lines.push(`  • ${countOf(m.count)} ${m.kind}`);
  }
  if (plan.stays.length > 0) {
    lines.push("Stays in the old space:");
    for (const s of plan.stays) lines.push(`  • ${countOf(s.count)} ${s.kind}: ${s.reason}`);
  }
  if (plan.willArchive === true) lines.push("The old space will be archived once it is empty. Nothing is deleted.");
  else if (plan.willArchive === false)
    lines.push("The old space stays (something remains in it). Nothing is deleted.");
  else lines.push("Nothing is deleted.");
  return lines;
}
