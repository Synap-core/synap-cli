/**
 * `synap track` — a METHOD running inside a project (Hub `/api/hub/tracks`).
 *
 *   list        a project's tracks (defaults to the active project lens)
 *   show        one track, its steps and where it stands
 *   start       start a method (a project-scoped playbook) on a project
 *   advance     move a track to a step — returns the step's session OFFER
 *   status      pause / resume / complete / archive
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
  console.log(`    ${t.status}${paused}`);
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
  opts: BaseOpts & { project?: string; all?: boolean }
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
    const res = (await hubGet(
      "/tracks",
      { projectId, includeArchived: opts.all ? "true" : undefined },
      cfg
    )) as { items?: TrackRow[] };
    const items = res?.items ?? [];
    if (opts.json) {
      console.log(JSON.stringify(items, null, 2));
      return;
    }
    if (items.length === 0) {
      log.info("This project runs no track yet.");
      log.dim("Start a method: synap track start --playbook <id>");
      return;
    }
    for (const t of items) printTrack(t);
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
  opts: BaseOpts & {
    playbook: string;
    project?: string;
    name?: string;
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
    const body: Json = { projectId, playbookId: opts.playbook };
    if (opts.name) body.name = opts.name;
    if (opts.param?.length) body.params = parseParamPairs(opts.param);
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
      if (r.status === "exists") log.info(`This method already runs on the project: ${t.name}`);
      else log.success(`Track started: ${chalk.bold(t.name)}`);
      console.log(`  ID: ${chalk.bold(t.id)}`);
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
  opts: BaseOpts & { reason?: string }
): Promise<void> {
  await run(async () => {
    const cfg = await resolveHubConfig(opts);
    const body: Json = { status };
    if (opts.reason) body.reasoning = opts.reason;
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
