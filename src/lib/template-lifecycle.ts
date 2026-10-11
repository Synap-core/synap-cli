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
  /** Records the engine's own dry run says the op touches. `null` = the pod did not count them. */
  affected: number | null;
  /** The op carries a destructive tail. The tail is NEVER run by an update — it stays an operator step. */
  destructive: boolean;
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
    });
  }
  return out;
}

/** The data changes a 409 consent refusal carries, or null when the error is something else. */
export function dataChangesFromRefusal(err: unknown): DataChange[] | null {
  if (!(err instanceof HubError)) return null;
  const body = err.body as Record<string, unknown> | undefined;
  const code = err.code ?? (typeof body?.code === "string" ? body.code : undefined);
  if (err.status !== 409 || code !== DATA_CHANGES_CONSENT_CODE) return null;
  return parseDataChanges(body) ?? [];
}

function countPhrase(n: number | null): string {
  if (n === null) return "count not reported";
  return `${n} ${n === 1 ? "record" : "records"}`;
}

/** One line per data change: the pod's own sentence, then its count. */
export function formatDataChange(dc: DataChange): string {
  let line = `${dc.description} ${chalk.dim(`(${countPhrase(dc.affected)} · ${dc.opKey})`)}`;
  if (dc.destructive) {
    line += "\n      " + chalk.dim("Its cleanup step deletes old data. It is NOT run here; an operator runs it separately.");
  }
  return line;
}

/** Print the "Data changes" block for one template. Prints nothing for an empty list. */
export function printDataChanges(slug: string, changes: DataChange[]): void {
  if (changes.length === 0) return;
  console.log("  " + chalk.bold(`Data changes for ${slug}`) + chalk.dim(" (they run with the update, once you agree)"));
  for (const dc of changes) console.log("    • " + formatDataChange(dc));
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
  /** Pending changes the person has NOT agreed to. Non-empty ⇒ the update must not be applied. */
  missing: DataChange[];
}

/**
 * Decide consent WITHOUT prompting. `yes` agrees to every listed change (the
 * person typed `--yes` on a command that has just printed them); otherwise only
 * the opKeys named in `acceptList` count. An opKey named but not pending is
 * simply not sent — consenting to a change the pod did not list means nothing.
 */
export function decideConsent(
  pending: DataChange[],
  input: { yes?: boolean; acceptList?: string[] }
): ConsentDecision {
  if (input.yes) return { accepted: pending.map((d) => d.opKey), missing: [] };
  const named = new Set(input.acceptList ?? []);
  const accepted: string[] = [];
  const missing: DataChange[] = [];
  for (const d of pending) {
    if (named.has(d.opKey)) accepted.push(d.opKey);
    else missing.push(d);
  }
  return { accepted, missing };
}

/** The exact command that re-runs an update with consent to these changes. */
export function consentRerunCommand(slug: string, changes: DataChange[]): string {
  return `synap templates update ${slug} --accept-data-changes ${changes.map((d) => d.opKey).join(",")}`;
}

// ── Template lifecycle (retired / unlisted / unknown) ───────────────────────

export type TemplateLifecycle = "current" | "retired" | "unlisted" | "unknown";

export interface LifecycleInfo {
  lifecycle: TemplateLifecycle;
  replacedBy: string | null;
  retiredReason: string | null;
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
  return { lifecycle, replacedBy: str(row.replacedBy), retiredReason: str(row.retiredReason) };
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
        label: info.replacedBy
          ? `Retired: ${slug} is replaced by ${info.replacedBy}`
          : `Retired: ${slug} has no replacement`,
        // Retire-into needs a target; with none there is nothing to move into.
        action: info.replacedBy ? `synap templates retire ${slug}` : null,
      };
    case "unlisted":
      return { label: `No longer in the catalog: ${slug}`, action: null };
    case "unknown":
      return {
        label: `Catalog not fully synced: the pod can't say yet whether ${slug} is still offered`,
        action: null,
      };
  }
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
