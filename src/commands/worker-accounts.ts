/**
 * `synap worker --accounts <file>`: which Claude account a run uses.
 *
 * The file (default ~/.config/synap-worker/accounts.json, owner-only) lists
 * Claude Code setup-tokens in priority order:
 *
 *   { "version": 1, "reserve": 2,
 *     "accounts": [ { "id": "dev", "label": "Dev", "token": "sk-ant-oat…", "design": true }, … ] }
 *
 * Before a launch every account is MEASURED with a 1-token request whose
 * response headers carry the account's 5-hour and weekly use (the probe is
 * ClaudeSwitch's, main.swift `probeOnce`). A probe that fails is UNMEASURED:
 * it is never read as "has room" and never as "full".
 *
 * A token is a credential. It goes into the launched run's environment and
 * into the probe's Authorization header — nowhere else: no state file, no run
 * log, no line the worker prints. Everything else names an account by id.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export interface AccountSpec {
  id: string;
  label: string;
  token: string;
  /** Design runs (the Artifact tool) publish from this account and no other. */
  design?: boolean;
}

export interface AccountsFile {
  version: 1;
  /** The non-design accounts with the most weekly room left stay unused, for the person. */
  reserve: number;
  accounts: AccountSpec[];
}

export function defaultAccountsFile(): string {
  return path.join(os.homedir(), ".config", "synap-worker", "accounts.json");
}

const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

/**
 * The accounts file, or `null` when the DEFAULT file does not exist (the
 * worker then runs on the environment's token, as before). A file named with
 * `--accounts` that is missing, or any file that does not parse or has the
 * wrong shape, THROWS: a broken accounts file is never "no accounts".
 * Error messages never quote a token.
 */
export function loadAccountsFile(file: string | undefined): AccountsFile | null {
  const explicit = file !== undefined;
  const target = file ?? defaultAccountsFile();
  if (!fs.existsSync(target)) {
    if (explicit) throw new Error(`accounts file ${target} does not exist`);
    return null;
  }
  let data: unknown;
  try {
    data = JSON.parse(fs.readFileSync(target, "utf8"));
  } catch {
    throw new Error(`accounts file ${target} is not valid JSON`);
  }
  const bad = (why: string) => new Error(`accounts file ${target}: ${why}`);
  if (!data || typeof data !== "object") throw bad("not an object");
  const d = data as Record<string, unknown>;
  if (d.version !== 1) throw bad(`version must be 1`);
  const reserve = d.reserve === undefined ? 0 : d.reserve;
  if (typeof reserve !== "number" || !Number.isInteger(reserve) || reserve < 0) throw bad("reserve must be a whole number ≥ 0");
  if (!Array.isArray(d.accounts) || d.accounts.length === 0) throw bad("accounts must be a non-empty list");
  const seen = new Set<string>();
  const accounts = d.accounts.map((raw, i): AccountSpec => {
    const a = (raw ?? {}) as Record<string, unknown>;
    if (typeof a.id !== "string" || !ID_RE.test(a.id)) throw bad(`accounts[${i}].id must match ${ID_RE}`);
    if (seen.has(a.id)) throw bad(`account id "${a.id}" appears twice`);
    seen.add(a.id);
    if (typeof a.token !== "string" || a.token.trim() === "") throw bad(`account "${a.id}" has no token`);
    return {
      id: a.id,
      label: typeof a.label === "string" && a.label.trim() ? a.label : a.id,
      token: a.token.trim(),
      ...(a.design === true ? { design: true } : {}),
    };
  });
  return { version: 1, reserve, accounts };
}

/** True when the file can be read by anyone but its owner. */
export function accountsFileTooOpen(file: string): boolean {
  try {
    return (fs.statSync(file).mode & 0o077) !== 0;
  } catch {
    return false;
  }
}

// ─── measuring ────────────────────────────────────────────────────────────────

/** One measurement, from the `anthropic-ratelimit-unified-*` headers. Percents; times in ms. */
export interface Meter {
  fiveHour?: number;
  fiveHourReset?: number;
  week?: number;
  weekReset?: number;
  /** The server refused the request on the account's own limit. */
  rejected: boolean;
  reset?: number;
  claim?: string;
  checkedAt: number;
}

export type ProbeResult =
  | { kind: "measured"; meter: Meter }
  | { kind: "unmeasured"; reason: string }
  | { kind: "refused"; reason: string };

/** Tried in order when a model is retired, so the probe outlives any one model name. */
export const PROBE_MODELS = ["claude-haiku-4-5", "claude-haiku-5-5", "claude-sonnet-5-5"];

export function meterFromHeaders(h: Headers, now: number): Meter {
  const get = (name: string) => h.get(`anthropic-ratelimit-unified-${name}`);
  const num = (name: string) => {
    const v = get(name);
    if (v === null || v.trim() === "") return undefined;
    const n = Number(v);
    return Number.isFinite(n) ? n : undefined;
  };
  // Utilization is a fraction of the window (0.15 = 15%) and can pass 1 when over.
  const pct = (name: string) => {
    const n = num(name);
    return n === undefined ? undefined : n * 100;
  };
  const at = (name: string) => {
    const n = num(name);
    return n === undefined ? undefined : n * 1000;
  };
  return {
    fiveHour: pct("5h-utilization"),
    fiveHourReset: at("5h-reset"),
    week: pct("7d-utilization"),
    weekReset: at("7d-reset"),
    rejected: get("status") === "rejected",
    reset: at("reset"),
    claim: get("representative-claim") ?? undefined,
    checkedAt: now,
  };
}

async function probeOnce(
  token: string,
  model: string,
  fetchImpl: typeof fetch,
  now: () => number
): Promise<{ result: ProbeResult; modelMissing: boolean }> {
  let res: Response;
  try {
    res = await fetchImpl("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "anthropic-version": "2023-06-01",
        "anthropic-beta": "oauth-2025-04-20",
        "content-type": "application/json",
      },
      body: JSON.stringify({ model, max_tokens: 1, messages: [{ role: "user", content: "ok" }] }),
      signal: AbortSignal.timeout(15_000),
    });
  } catch (err) {
    return { result: { kind: "unmeasured", reason: `probe failed: ${(err as Error).name}` }, modelMissing: false };
  }
  let error: { type?: string; message?: string } | undefined;
  try {
    error = ((await res.json()) as { error?: { type?: string; message?: string } })?.error;
  } catch {
    error = undefined;
  }
  const message = error?.message ?? `HTTP ${res.status}`;
  const meter = meterFromHeaders(res.headers, now());
  switch (res.status) {
    case 200:
      return { result: { kind: "measured", meter }, modelMissing: false };
    case 429:
      // Without status=rejected it is a short burst limit, not the account's quota.
      return meter.rejected
        ? { result: { kind: "measured", meter }, modelMissing: false }
        : { result: { kind: "unmeasured", reason: "briefly rate limited" }, modelMissing: false };
    case 401:
    case 403:
      return { result: { kind: "refused", reason: message }, modelMissing: false };
    case 400:
    case 404: {
      const modelMissing = error?.type === "not_found_error" || message.toLowerCase().includes("model");
      return { result: { kind: "unmeasured", reason: modelMissing ? `model ${model} unavailable` : message }, modelMissing };
    }
    default:
      return { result: { kind: "unmeasured", reason: message }, modelMissing: false };
  }
}

/** Measure one account: the first probe model that exists answers. */
export async function probeAccount(
  token: string,
  opts: { fetchImpl?: typeof fetch; models?: string[]; now?: () => number } = {}
): Promise<ProbeResult> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const now = opts.now ?? Date.now;
  let last: ProbeResult = { kind: "unmeasured", reason: "no probe model answered" };
  for (const m of opts.models ?? PROBE_MODELS) {
    const { result, modelMissing } = await probeOnce(token, m, fetchImpl, now);
    if (!modelMissing) return result;
    last = result;
  }
  return last;
}

// ─── standing + selection ─────────────────────────────────────────────────────

/** An account counts as full once its 5-hour or weekly window reaches this percent. */
export const FULL_AT_PERCENT = 95;
/** A measurement is reused this long before the account is measured again. */
export const MEASURE_TTL_MS = 3 * 60_000;

export type Standing =
  | { kind: "room"; meter: Meter }
  | { kind: "full"; until: number; meter?: Meter }
  | { kind: "refused"; reason: string }
  | { kind: "unmeasured"; reason: string };

export function isFull(m: Meter, threshold = FULL_AT_PERCENT): boolean {
  return m.rejected || (m.fiveHour ?? 0) >= threshold || (m.week ?? 0) >= threshold;
}

/** When the window that makes it full resets; a quarter of an hour when the server gave no time. */
export function fullUntil(m: Meter, threshold = FULL_AT_PERCENT): number {
  const dates: number[] = [];
  if ((m.week ?? 0) >= threshold && m.weekReset) dates.push(m.weekReset);
  if ((m.fiveHour ?? 0) >= threshold && m.fiveHourReset) dates.push(m.fiveHourReset);
  if (!dates.length && m.rejected) {
    const r = m.reset ?? m.fiveHourReset ?? m.weekReset;
    if (r) dates.push(r);
  }
  return dates.length ? Math.max(...dates) : m.checkedAt + 15 * 60_000;
}

/**
 * What one account can take now, from its last probe and any "full until"
 * mark a run left on it (a run that ended on a usage limit). A full window
 * whose reset has passed is UNMEASURED until it is measured again — never room.
 */
export function standingOf(
  probe: ProbeResult | undefined,
  markedFullUntil: number | undefined,
  now: number,
  threshold = FULL_AT_PERCENT
): Standing {
  if (markedFullUntil !== undefined && markedFullUntil > now) {
    return { kind: "full", until: markedFullUntil, ...(probe?.kind === "measured" ? { meter: probe.meter } : {}) };
  }
  if (!probe) return { kind: "unmeasured", reason: "not measured yet" };
  if (probe.kind === "refused") return { kind: "refused", reason: probe.reason };
  if (probe.kind === "unmeasured") return { kind: "unmeasured", reason: probe.reason };
  const m = probe.meter;
  if (isFull(m, threshold)) {
    const until = fullUntil(m, threshold);
    return until > now ? { kind: "full", until, meter: m } : { kind: "unmeasured", reason: "full window has reset; not measured since" };
  }
  return { kind: "room", meter: m };
}

/** Weekly room left in percent, when the account was measured. */
function weeklyLeft(s: Standing): number | undefined {
  const m = s.kind === "room" || s.kind === "full" ? s.meter : undefined;
  if (!m || m.week === undefined) return undefined;
  return 100 - m.week;
}

/**
 * The reserve: the `reserve` NON-design accounts with the most weekly room
 * left — kept for the person's own morning. Only MEASURED accounts are ranked
 * (an unmeasured one cannot be launched on anyway); a measured account whose
 * weekly figure is missing ranks last. Ties go to file order.
 */
export function reserveIds(accounts: AccountSpec[], standings: Map<string, Standing>, reserve: number): Set<string> {
  if (reserve <= 0) return new Set();
  const ranked = accounts
    .map((a, order) => ({ a, order, s: standings.get(a.id) }))
    .filter((x) => !x.a.design && x.s && (x.s.kind === "room" || x.s.kind === "full"))
    .map((x) => ({ ...x, left: weeklyLeft(x.s as Standing) }))
    .sort((x, y) => (y.left ?? -Infinity) - (x.left ?? -Infinity) || x.order - y.order);
  return new Set(ranked.slice(0, reserve).map((x) => x.a.id));
}

export interface Selection {
  account?: AccountSpec;
  /** Why nothing was picked (no token in it). */
  reason?: string;
}

/**
 * Pick the account a run launches on.
 *
 * - A DESIGN run: only an account flagged `design` (the artifact belongs to
 *   the publishing account). None with room ⇒ nothing: wait, never another one.
 * - Any other run: leave out the reserve; among the rest with room, the one
 *   whose 5-hour window resets SOONEST (use it or lose it); ties → file order.
 * An unmeasured, refused or full account is never picked.
 */
export function selectAccount(
  file: AccountsFile,
  standings: Map<string, Standing>,
  opts: { design: boolean }
): Selection {
  const pool = opts.design
    ? file.accounts.filter((a) => a.design)
    : (() => {
        const reserved = reserveIds(file.accounts, standings, file.reserve);
        return file.accounts.filter((a) => !reserved.has(a.id));
      })();
  if (opts.design && pool.length === 0) return { reason: "no account is flagged design:true" };
  const withRoom = pool
    .map((a, order) => ({ a, order, s: standings.get(a.id) }))
    .filter((x): x is { a: AccountSpec; order: number; s: Extract<Standing, { kind: "room" }> } => x.s?.kind === "room");
  if (!withRoom.length) {
    const why = pool.map((a) => `${a.id}: ${describeStanding(standings.get(a.id))}`).join(", ");
    return { reason: `no ${opts.design ? "design " : ""}account with room (${why || "all reserved"})` };
  }
  withRoom.sort(
    (x, y) => (x.s.meter.fiveHourReset ?? Infinity) - (y.s.meter.fiveHourReset ?? Infinity) || x.order - y.order
  );
  return { account: withRoom[0].a };
}

export function describeStanding(s: Standing | undefined): string {
  if (!s) return "not measured";
  switch (s.kind) {
    case "room":
      return `room (5h ${Math.round(s.meter.fiveHour ?? 0)}%, 7d ${Math.round(s.meter.week ?? 0)}%)`;
    case "full":
      return `full until ${new Date(s.until).toISOString()}`;
    case "refused":
      return "token refused";
    case "unmeasured":
      return `unmeasured (${s.reason})`;
  }
}

// ─── the pool: cache + marks ──────────────────────────────────────────────────

/**
 * The accounts plus what the worker knows about each: the last probe (reused
 * for MEASURE_TTL_MS) and a "full until" mark left by a run that ended on a
 * usage limit. In memory only: a restart measures again.
 */
export class AccountPool {
  private probes = new Map<string, ProbeResult>();
  private marks = new Map<string, number>();

  constructor(
    readonly file: AccountsFile,
    private readonly probe: (token: string) => Promise<ProbeResult>,
    private readonly now: () => number = Date.now
  ) {}

  byId(id: string | undefined): AccountSpec | undefined {
    return id ? this.file.accounts.find((a) => a.id === id) : undefined;
  }

  /** Measure every account whose measurement is stale (in parallel), skipping marked-full ones. */
  async measure(): Promise<Map<string, Standing>> {
    const t = this.now();
    await Promise.all(
      this.file.accounts.map(async (a) => {
        const mark = this.marks.get(a.id);
        if (mark !== undefined && mark > t) return;
        const last = this.probes.get(a.id);
        const fresh =
          last?.kind === "measured" && t - last.meter.checkedAt < MEASURE_TTL_MS && !(isFull(last.meter) && fullUntil(last.meter) <= t);
        if (fresh) return;
        this.probes.set(a.id, await this.probe(a.token));
      })
    );
    return this.standings();
  }

  standings(): Map<string, Standing> {
    const t = this.now();
    return new Map(this.file.accounts.map((a) => [a.id, standingOf(this.probes.get(a.id), this.marks.get(a.id), t)]));
  }

  /** A run on this account ended on a usage limit: full until then, measured afresh after. */
  markFull(id: string, until: number): void {
    this.marks.set(id, until);
    this.probes.delete(id);
  }

  select(opts: { design: boolean }): Selection {
    return selectAccount(this.file, this.standings(), opts);
  }
}
