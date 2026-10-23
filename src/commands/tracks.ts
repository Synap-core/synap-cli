/**
 * `synap track` — a goal inside a project (Hub `/api/hub/tracks`).
 * Work in it = `synap session start --track <id>`. A goal stays open as long as
 * it matters, or a person closes it with a verdict. A legacy track also runs a
 * method (a project-scoped playbook) with steps; a new one needs none.
 *
 *   list        a project's tracks (the active project lens, else every goal on the pod)
 *   show        one track, its steps and where it stands
 *   start       start a track on a project (--name; --end-state, --criterion, … say what done is)
 *   update      set a goal's direction, KPI and content
 *   accept      the goal's judge accepts / sends back / rejects a claimed criterion
 *   advance     move a track to a step — returns the step's session OFFER
 *   status      move it through its lifecycle; close (completed) and drop
 *               (archived) carry --verdict
 *   reopen      a closed or dropped goal comes back as a NEW version
 *   convert     (`synap goal convert`) make a goal / objective / OKR entity a goal
 *   params      answer the method's params (merged; `key=null` clears)
 *   start-step  start the work session of one step (default: current step)
 *
 * Same door pattern as `synap session` (hubGet/hubPost/hubPatch). Writes are
 * governed on the pod: `status: "proposed"` is SUCCESS, queued for review —
 * printed as "queued", never as done. The pod's domain advisories
 * (`missingDomains` on start, `domainFallback` on a step session) are printed
 * with the pod's own sentence, never dropped.
 */

import chalk from "chalk";
import { log } from "../utils/logger.js";
import {
  resolveHubConfig,
  hubGet,
  hubPatch,
  hubPost,
  renderHubError,
} from "../lib/hub-client.js";
import { type BaseOpts } from "./data.js";

type Json = Record<string, unknown>;

interface TrackRow {
  id: string;
  name: string;
  status: string;
  pausedBy?: string | null;
  currentStage: string | null;
  playbookId?: string | null;
  stages?: Array<{
    key: string;
    name: string;
    position: string;
    domain?: string;
    gate?: string;
    goal?: string;
  }>;
  params?: Json;
  declaredParams?: unknown[];
  verdict?: string | null;
  verdictReason?: string | null;
  endState?: string | null;
  criteria?: Array<{
    key: string;
    statement?: string;
    mark?: string;
    required?: boolean;
  }>;
  dropConditions?: string[];
  workKind?: string | null;
  uncertainty?: string | null;
  loop?: { on: boolean; perWeek?: number };
  inReview?: boolean | null;
  waitingOn?: Array<{ reason: string; count: number }> | null;
  participants?: Array<{
    role: string;
    displayName?: string | null;
    principalId: string;
    commitment?: string | null;
    commitmentState?: string | null;
  }>;
}

/** The kinds of check a person can name for a criterion (`--criterion "judged: …"`). */
const CRITERION_KINDS = [
  "measured",
  "judged",
  "handed_over",
  "learning",
  "decided_outside",
  "certified",
] as const;

/** The stored evaluator that carries each kind (`CHECK_MEANING_EVALUATORS`, first fit for a typed line). */
const CRITERION_EVALUATOR: Record<(typeof CRITERION_KINDS)[number], string> = {
  measured: "evidence",
  judged: "human",
  handed_over: "human",
  learning: "human",
  decided_outside: "human",
  certified: "human",
};

/**
 * `--criterion "[kind:] statement"` → a goal criterion. Kind defaults to
 * `judged` (a person checks it); the key is a slug of the statement, made
 * unique among `taken`. A `learning` criterion is about the method.
 */
export function parseCriterion(line: string, taken: Set<string>): Json {
  let kind: (typeof CRITERION_KINDS)[number] = "judged";
  let statement = line.trim();
  const colon = statement.indexOf(":");
  if (colon > 0) {
    const head = statement.slice(0, colon).trim();
    if ((CRITERION_KINDS as readonly string[]).includes(head)) {
      kind = head as (typeof CRITERION_KINDS)[number];
      statement = statement.slice(colon + 1).trim();
    }
  }
  if (!statement) throw new Error(`Criterion "${line}" has no statement.`);
  const base =
    statement
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40)
      .replace(/-+$/, "") || "criterion";
  let key = base;
  for (let n = 2; taken.has(key); n++) key = `${base}-${n}`;
  taken.add(key);
  return {
    key,
    statement,
    check: { kind: CRITERION_EVALUATOR[kind] },
    checkKind: kind,
    ...(kind === "learning" ? { about: "method" } : {}),
  };
}

/** The goal-content flags shared by `track start` and `track update`. */
interface GoalContentOpts {
  endState?: string;
  criterion?: string[];
  dropCondition?: string[];
  kind?: string;
  uncertainty?: string;
  loop?: string;
}

/** Goal-content flags → the body fields the pod reads (only what was typed). */
export function goalContentBody(opts: GoalContentOpts): Json {
  const body: Json = {};
  if (opts.endState !== undefined) body.endState = opts.endState;
  if (opts.criterion?.length) {
    const taken = new Set<string>();
    body.criteria = opts.criterion.map((c) => parseCriterion(c, taken));
  }
  if (opts.dropCondition?.length) body.dropConditions = opts.dropCondition;
  if (opts.kind) body.workKind = opts.kind;
  if (opts.uncertainty) body.uncertainty = opts.uncertainty;
  if (opts.loop !== undefined) {
    if (opts.loop === "off") body.loop = null;
    else if (opts.loop === "on" || opts.loop === "") body.loop = { on: true };
    else if (/^\d+$/.test(opts.loop)) {
      body.loop = { on: true, perWeek: Number(opts.loop) };
    } else {
      throw new Error(`--loop takes on, off or a number of sessions a week, not "${opts.loop}".`);
    }
  }
  return body;
}

const STAGE_MARK: Record<string, string> = {
  done: chalk.green("✓"),
  active: chalk.cyan("●"),
  not_started: chalk.dim("○"),
};

function trackPath(id: string, suffix = ""): string {
  return `/tracks/${encodeURIComponent(id)}${suffix}`;
}

function isProposed(r: Json): r is Json & { proposalId: string } {
  return r.status === "proposed" && typeof r.proposalId === "string";
}

/** A governed write that became a proposal: queued, not applied. */
function printProposed(r: Json, what: string): void {
  log.warn(`${what} is queued for your review — not applied yet.`);
  if (typeof r.reviewUrl === "string") log.hint(`Review: ${r.reviewUrl}`);
  else log.hint(`Proposal ${String(r.proposalId)} — see: synap proposals list`);
}

/** The pod's domain advisory sentence, when it sent one. */
function printDomainNote(r: Json): void {
  const note =
    typeof r.domainNote === "string"
      ? r.domainNote
      : typeof r.domainsNote === "string"
        ? r.domainsNote
        : undefined;
  if (note) log.warn(note);
}

function printTrack(t: TrackRow): void {
  const paused = t.status === "paused" && t.pausedBy ? ` (held by ${t.pausedBy} gate)` : "";
  console.log(`  ${chalk.bold(t.name)}  ${chalk.dim(t.id)}`);
  const ended = t.verdict
    ? ` — ${t.verdict}${t.verdictReason ? `: ${t.verdictReason}` : ""}`
    : "";
  console.log(`    ${t.status}${paused}${ended}`);
  if (t.endState) console.log(`    ${chalk.dim("Done looks like:")} ${t.endState}`);
  const kindLine = [t.workKind, t.uncertainty].filter(Boolean).join(" · ");
  if (kindLine) console.log(`    ${chalk.dim(kindLine)}`);
  for (const c of t.criteria ?? []) {
    console.log(
      `    ${chalk.dim("▫")} ${c.statement ?? c.key} ${chalk.dim(`(${c.key}${c.mark ? `, ${c.mark}` : ""})`)}`
    );
  }
  if (t.inReview) console.log(`    ${chalk.yellow("In review")} ${chalk.dim("— every required criterion is claimed, none accepted yet")}`);
  for (const w of t.waitingOn ?? []) {
    console.log(`    ${chalk.dim(`Waiting on ${w.reason}${w.count > 1 ? ` (${w.count})` : ""}`)}`);
  }
  if (t.loop?.on) console.log(`    ${chalk.dim(`Loop on — up to ${t.loop.perWeek ?? 3} sessions a week`)}`);
  for (const p of t.participants ?? []) {
    const who = p.displayName ?? "someone (name unknown)";
    const commit = p.commitment ? ` — ${p.commitment}${p.commitmentState ? ` [${p.commitmentState}]` : ""}` : "";
    console.log(`    ${chalk.dim(`${p.role}:`)} ${who}${commit}`);
  }
  for (const s of t.stages ?? []) {
    const mark = STAGE_MARK[s.position] ?? chalk.dim("·");
    const domain = s.domain ? chalk.dim(`  in ${s.domain}`) : "";
    const gate = s.gate ? chalk.dim(`  [${s.gate} gate]`) : "";
    console.log(`    ${mark} ${s.name} ${chalk.dim(`(${s.key})`)}${domain}${gate}`);
  }
}

async function run(fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
  } catch (e) {
    renderHubError(e);
    process.exit(1);
  }
}

/** `key=value` pairs → params. Values parse as JSON when they can (`null`, numbers, lists). */
export function parseParamPairs(pairs: string[]): Json {
  const out: Json = {};
  for (const pair of pairs) {
    const eq = pair.indexOf("=");
    if (eq <= 0) {
      throw new Error(`Param "${pair}" is not key=value.`);
    }
    const key = pair.slice(0, eq).trim();
    const raw = pair.slice(eq + 1);
    try {
      out[key] = JSON.parse(raw);
    } catch {
      out[key] = raw;
    }
  }
  return out;
}

export async function listTracks(
  opts: BaseOpts & {
    project?: string;
    all?: boolean;
    everywhere?: boolean;
    limit?: string;
    cursor?: string;
  }
): Promise<void> {
  await run(async () => {
    const cfg = await resolveHubConfig(opts);
    // A project in scope lists that project's goals; none (or --everywhere)
    // lists every goal on the pod, newest first, paged.
    const projectId = opts.everywhere ? undefined : opts.project || cfg.projectId;
    const res = (await hubGet(
      "/tracks",
      {
        projectId,
        includeArchived: opts.all ? "true" : undefined,
        ...(projectId ? {} : { limit: opts.limit, cursor: opts.cursor }),
      },
      cfg
    )) as { items?: TrackRow[]; nextCursor?: string | null };
    const items = res?.items ?? [];
    if (opts.json) {
      console.log(JSON.stringify(projectId ? items : res, null, 2));
      return;
    }
    if (items.length === 0) {
      log.info(projectId ? "This project has no goal yet." : "No goal on this pod yet.");
      log.dim('Start one: synap track start --name "Grow the newsletter"');
      return;
    }
    for (const t of items) printTrack(t);
    if (!projectId && res.nextCursor) {
      log.dim(`More: synap track list --cursor ${res.nextCursor}`);
    }
  });
}

export async function showTrack(id: string, opts: BaseOpts): Promise<void> {
  await run(async () => {
    const cfg = await resolveHubConfig(opts);
    const t = (await hubGet(trackPath(id), {}, cfg)) as TrackRow;
    if (opts.json) {
      console.log(JSON.stringify(t, null, 2));
      return;
    }
    printTrack(t);
    const declared = t.declaredParams ?? [];
    if (declared.length > 0) {
      log.dim(`Params: ${JSON.stringify(t.params ?? {})}`);
    }
  });
}

export async function startTrack(
  opts: BaseOpts &
    GoalContentOpts & {
      playbook?: string;
      project?: string;
      name?: string;
      direction?: string;
      param?: string[];
      reason?: string;
    }
): Promise<void> {
  await run(async () => {
    const cfg = await resolveHubConfig(opts);
    const projectId = opts.project || cfg.projectId;
    if (!projectId) {
      console.error(
        chalk.red("Error: no project in scope — pass --project <id> or set one with 'synap project use'")
      );
      process.exit(1);
      return;
    }
    if (!opts.playbook && !opts.name) {
      console.error(
        chalk.red("Error: name the track — pass --name \"Grow the newsletter\" (a track needs no --playbook)")
      );
      process.exit(1);
      return;
    }
    const body: Json = { projectId };
    if (opts.playbook) body.playbookId = opts.playbook;
    if (opts.name) body.name = opts.name;
    if (opts.direction) body.direction = opts.direction;
    if (opts.param?.length) body.params = parseParamPairs(opts.param);
    Object.assign(body, goalContentBody(opts));
    if (opts.reason) body.reasoning = opts.reason;
    const r = (await hubPost("/tracks", body, cfg)) as Json;
    if (opts.json) {
      console.log(JSON.stringify(r, null, 2));
      return;
    }
    if (isProposed(r)) {
      printProposed(r, "Starting this track");
    } else {
      const t = r.track as TrackRow;
      if (r.status === "exists") log.info(`A live track already has this name: ${t.name}`);
      else log.success(`Track started: ${chalk.bold(t.name)}`);
      console.log(`  ID: ${chalk.bold(t.id)}`);
      log.dim(`Work in it: synap session start --track ${t.id} "<goal>"`);
    }
    printDomainNote(r);
  });
}

export async function advanceTrack(
  id: string,
  toStage: string,
  opts: BaseOpts & { reason?: string }
): Promise<void> {
  await run(async () => {
    const cfg = await resolveHubConfig(opts);
    const body: Json = { toStage };
    if (opts.reason) body.reasoning = opts.reason;
    const r = (await hubPost(trackPath(id, "/advance"), body, cfg)) as Json;
    if (opts.json) {
      console.log(JSON.stringify(r, null, 2));
      return;
    }
    if (isProposed(r)) {
      printProposed(r, "Moving this track");
      return;
    }
    if (r.status === "unchanged") {
      log.info(`The track already stands on ${toStage}.`);
    } else {
      log.success(`Track moved to ${chalk.bold(toStage)}`);
    }
    if (r.paused === true) {
      const check = r.check as { reason?: string } | undefined;
      log.warn(
        check?.reason
          ? `Held by its check gate: ${check.reason}`
          : `Paused at a human gate${typeof r.proposalId === "string" ? ` — approval ${r.proposalId}` : ""}.`
      );
    }
    const offer = r.offer as { name?: string; goal?: string | null } | null;
    if (offer) {
      log.dim(`Offered (not started): ${offer.name ?? toStage}${offer.goal ? ` — ${offer.goal}` : ""}`);
      log.dim(`Start it: synap track start-step ${id}`);
    }
  });
}

export async function setTrackStatus(
  id: string,
  status: string,
  opts: BaseOpts & { reason?: string; verdict?: string; verdictReason?: string }
): Promise<void> {
  await run(async () => {
    const cfg = await resolveHubConfig(opts);
    const body: Json = { status };
    if (opts.reason) body.reasoning = opts.reason;
    if (opts.verdict) body.verdict = opts.verdict;
    if (opts.verdictReason) body.verdictReason = opts.verdictReason;
    const r = (await hubPatch(trackPath(id), body, cfg)) as Json;
    if (opts.json) {
      console.log(JSON.stringify(r, null, 2));
      return;
    }
    if (isProposed(r)) printProposed(r, "Changing this track's status");
    else if (r.status === "unchanged") log.info(`The track is already ${status}.`);
    else log.success(`Track is now ${status}.`);
  });
}

/** A closed or dropped goal comes back as a NEW version — never moved back. */
export async function reopenTrack(
  id: string,
  opts: BaseOpts & { name?: string; reason?: string }
): Promise<void> {
  await run(async () => {
    const cfg = await resolveHubConfig(opts);
    const body: Json = {};
    if (opts.name) body.name = opts.name;
    if (opts.reason) body.reasoning = opts.reason;
    const r = (await hubPost(trackPath(id, "/reopen"), body, cfg)) as Json;
    if (opts.json) {
      console.log(JSON.stringify(r, null, 2));
      return;
    }
    if (isProposed(r)) {
      printProposed(r, "Reopening this goal");
      return;
    }
    const t = r.track as TrackRow;
    if (r.status === "exists") log.info(`The new version is already live: ${t.name}`);
    else log.success(`Goal reopened as a new version: ${chalk.bold(t.name)}`);
    console.log(`  ID: ${chalk.bold(t.id)}`);
    log.dim(`Work in it: synap session start --track ${t.id} "<goal>"`);
  });
}

export async function setTrackParams(
  id: string,
  pairs: string[],
  opts: BaseOpts & { reason?: string }
): Promise<void> {
  await run(async () => {
    const params = parseParamPairs(pairs);
    const cfg = await resolveHubConfig(opts);
    const body: Json = { params };
    if (opts.reason) body.reasoning = opts.reason;
    const r = (await hubPatch(trackPath(id, "/params"), body, cfg)) as Json;
    if (opts.json) {
      console.log(JSON.stringify(r, null, 2));
      return;
    }
    if (isProposed(r)) printProposed(r, "Changing this track's answers");
    else if (r.status === "unchanged") log.info("Nothing changed.");
    else log.success(`Answers saved: ${Object.keys(params).join(", ")}`);
  });
}

export async function startStep(
  id: string,
  opts: BaseOpts & { stage?: string; title?: string; goal?: string }
): Promise<void> {
  await run(async () => {
    const cfg = await resolveHubConfig(opts);
    let stageKey = opts.stage;
    if (!stageKey) {
      // The Hub route names the step in its path: read where the track stands.
      const t = (await hubGet(trackPath(id), {}, cfg)) as TrackRow;
      if (!t.currentStage) {
        console.error(chalk.red(`Error: track "${t.name}" stands on no step — pass --stage <key>.`));
        process.exit(1);
        return;
      }
      stageKey = t.currentStage;
    }
    const body: Json = {};
    if (opts.title) body.title = opts.title;
    if (opts.goal) body.goal = opts.goal;
    const r = (await hubPost(
      trackPath(id, `/stages/${encodeURIComponent(stageKey)}/sessions`),
      body,
      cfg
    )) as Json;
    if (opts.json) {
      console.log(JSON.stringify(r, null, 2));
      return;
    }
    if (isProposed(r)) {
      printProposed(r, "Starting this step's session");
    } else {
      const session = (r.session ?? {}) as { id?: string };
      if (r.status === "existing" || r.status === "deduped") {
        log.info(`This step already has an open session.`);
      } else {
        log.success(`Step session started (${stageKey})`);
      }
      if (session.id) console.log(`  ID: ${chalk.bold(session.id)}`);
      if (session.id) log.dim(`Attach it: synap session attach ${session.id}`);
    }
    printDomainNote(r);
  });
}

/** Set where a goal is heading, its KPI and what it holds (PATCH /tracks/:id/direction). */
export async function updateTrack(
  id: string,
  opts: BaseOpts &
    GoalContentOpts & {
      direction?: string;
      kpiCurrent?: string;
      kpiTarget?: string;
      reason?: string;
    }
): Promise<void> {
  await run(async () => {
    const cfg = await resolveHubConfig(opts);
    const body: Json = goalContentBody(opts);
    if (opts.direction !== undefined) body.direction = opts.direction;
    const kpi: Json = {};
    if (opts.kpiCurrent !== undefined) kpi.current = Number(opts.kpiCurrent);
    if (opts.kpiTarget !== undefined) kpi.target = Number(opts.kpiTarget);
    if (Object.values(kpi).some((n) => Number.isNaN(n))) {
      throw new Error("--kpi-current and --kpi-target take a number.");
    }
    if (Object.keys(kpi).length) body.kpi = kpi;
    if (Object.keys(body).length === 0) {
      throw new Error("Nothing to change — pass --direction, --end-state, --criterion, --kind, …");
    }
    if (opts.reason) body.reasoning = opts.reason;
    const r = (await hubPatch(trackPath(id, "/direction"), body, cfg)) as Json;
    if (opts.json) {
      console.log(JSON.stringify(r, null, 2));
      return;
    }
    if (isProposed(r)) printProposed(r, "Changing this goal");
    else if (r.status === "unchanged") log.info("Nothing changed.");
    else log.success("Goal updated.");
  });
}

/** The goal's JUDGE decides a claimed criterion (a person's act — an agent key is refused). */
export async function acceptCriterion(
  id: string,
  key: string,
  decision: string,
  opts: BaseOpts & { note?: string }
): Promise<void> {
  await run(async () => {
    const cfg = await resolveHubConfig(opts);
    const body: Json = { decision };
    if (opts.note) body.note = opts.note;
    const r = (await hubPost(
      trackPath(id, `/criteria/${encodeURIComponent(key)}/acceptance`),
      body,
      cfg
    )) as Json;
    if (opts.json) {
      console.log(JSON.stringify(r, null, 2));
      return;
    }
    if (r.status === "unchanged") log.info(`Criterion ${key} is already ${decision}.`);
    else log.success(`Criterion ${key}: ${decision}.`);
  });
}

/** "Make it a goal" — a goal / objective / okr entity becomes a goal, once. */
export async function convertToGoal(
  entityId: string,
  opts: BaseOpts & { project?: string; name?: string; reason?: string }
): Promise<void> {
  await run(async () => {
    const cfg = await resolveHubConfig(opts);
    const body: Json = { entityId };
    if (opts.project) body.projectId = opts.project;
    if (opts.name) body.name = opts.name;
    if (opts.reason) body.reasoning = opts.reason;
    const r = (await hubPost("/tracks/convert", body, cfg)) as Json;
    if (opts.json) {
      console.log(JSON.stringify(r, null, 2));
      return;
    }
    if (isProposed(r)) {
      printProposed(r, "Making this a goal");
      return;
    }
    const t = r.track as TrackRow;
    log.success(`Now a goal: ${chalk.bold(t.name)}`);
    console.log(`  ID: ${chalk.bold(t.id)}`);
    const notCarried = r.notCarried as string[] | undefined;
    if (notCarried?.length) log.dim(`Not carried over: ${notCarried.join(", ")}`);
  });
}
