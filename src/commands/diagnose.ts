/**
 * `synap diagnose` — see what an AI did, across flows.
 *
 * The CLI face of the unified runs door (LOCKED CONTRACT, base `${podUrl}/api/hub`):
 *   feed:   GET /runs?flowType=&flowId=&limit=
 *   detail: GET /runs/:id?flowType=
 *
 * No args → the recent run feed across every ledger.
 * With a run id OR a flow name → that run's per-NODE story: each node's status,
 * timing, error, resolved inputs and output (an automation run), or the capture
 * decision + trace events with their actionable fixHint. The flowType the detail
 * door needs is READ off the feed, never guessed. `--json` prints the raw payload.
 */

import chalk from "chalk";
import { log } from "../utils/logger.js";
import {
  resolveHubConfig,
  hubGet,
  renderHubError,
  HubError,
  type HubConfig,
} from "../lib/hub-client.js";

/**
 * The ledgers `GET /runs` merges. MUST stay in sync with the pod's
 * `FlowTypeSchema` (synap-backend `routers/hub-protocol/rest/runs.ts`) — this
 * list was missing `capability` and `chat`, so the feed listed ids the detail
 * door was never asked about.
 */
type FlowType =
  | "automation"
  | "playbook"
  | "capture"
  | "capability"
  | "session"
  | "chat";
const FLOW_TYPES: FlowType[] = [
  "automation",
  "playbook",
  "capture",
  "capability",
  "session",
  "chat",
];

interface UnifiedRun {
  id: string;
  flowType: FlowType;
  flowName: string;
  status: string;
  startedAt: string;
  completedAt: string | null;
  summary: string | null;
  error: string | null;
  channelId: string | null;
}

interface RunActivityItem {
  id: string;
  at: string | null;
  kind: string;
  status: string | null;
  label: string;
  hint: string | null;
  /**
   * Per-node execution payload. For an automation step the pod sends
   * `{ nodeId, nodeLabel, nodeType, commandId, errorMessage, startedAt,
   * completedAt, resolvedInputs, output }` — the actual "what happened in this
   * node" the whole command exists for. Other ledgers send their own shape or
   * nothing, so it is read defensively.
   */
  detail?: Record<string, unknown> | null;
}

interface RunDetail {
  run: UnifiedRun;
  activity: RunActivityItem[];
  trigger?: { triggeredBy: string | null; payload: unknown } | null;
  outputSummary?: unknown;
}

/** Colour a status token by lifecycle. */
function statusColor(status: string): string {
  switch (status) {
    case "completed":
      return chalk.green(status);
    case "failed":
      return chalk.red(status);
    case "running":
      return chalk.yellow(status);
    default:
      return chalk.dim(status);
  }
}

function renderFeed(runs: UnifiedRun[]): void {
  if (runs.length === 0) {
    log.dim("(no runs yet)");
    return;
  }
  const flowWidth = Math.max(...runs.map((r) => r.flowType.length));
  for (const r of runs) {
    const when = r.startedAt ? chalk.dim(r.startedAt.slice(0, 16).replace("T", " ")) : "";
    console.log(
      `  ${chalk.cyan(r.flowType.padEnd(flowWidth))}  ${statusColor(
        r.status
      ).padEnd(20)}  ${chalk.bold(r.flowName)}  ${when}`
    );
    console.log(`    ${chalk.dim("id")} ${r.id}`);
    if (r.summary) console.log(`    ${chalk.dim(r.summary)}`);
  }
  log.dim(`\nDiagnose one: synap diagnose <id|name>`);
}

// ── Run lookup: id OR name (no flowType guessing) ────────────────────────────

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function looksLikeId(arg: string): boolean {
  return UUID_RE.test(arg.trim());
}

export type RunLookup =
  | { kind: "match"; run: UnifiedRun }
  | { kind: "ambiguous"; candidates: UnifiedRun[] }
  | { kind: "none" };

/**
 * Resolve a user-typed argument against the run feed.
 *
 * The feed is the ONE listing door and it already carries each run's `flowType`,
 * so the id space a run belongs to is READ, never guessed. `arg` may be a run id
 * or a flow name — exact name, then unambiguous prefix, then substring. Several
 * runs of the SAME flow collapse to the newest (the feed is newest-first); several
 * DISTINCT flows stay ambiguous so the caller can list them instead of guessing.
 */
export function resolveRunTarget(runs: UnifiedRun[], arg: string): RunLookup {
  const raw = arg.trim();
  const byId = runs.find((r) => r.id === raw);
  if (byId) return { kind: "match", run: byId };

  const q = raw.toLowerCase();
  if (!q) return { kind: "none" };
  const name = (r: UnifiedRun) => (r.flowName ?? "").toLowerCase();

  const exact = runs.filter((r) => name(r) === q);
  const prefix = runs.filter((r) => name(r).startsWith(q));
  const substr = runs.filter((r) => name(r).includes(q));
  const pool = exact.length ? exact : prefix.length ? prefix : substr;
  if (pool.length === 0) return { kind: "none" };

  // Group by the FLOW (type + name) — many runs of one automation is not
  // ambiguity, two different automations is.
  const groups = new Map<string, UnifiedRun[]>();
  for (const r of pool) {
    const key = `${r.flowType}:${name(r)}`;
    const g = groups.get(key);
    if (g) g.push(r);
    else groups.set(key, [r]);
  }
  if (groups.size === 1) return { kind: "match", run: pool[0] };
  return {
    kind: "ambiguous",
    candidates: [...groups.values()].map((g) => g[0]),
  };
}

/**
 * Last-resort id lookup when the run is older than the feed window (or lives in
 * a ledger the merged feed omits — a completed `chat` turn). Walks the SAME
 * detail door once per flow type; a 404 just means "not this id space".
 */
async function probeFlowTypes(
  id: string,
  cfg: HubConfig,
  hint?: FlowType
): Promise<{ detail: RunDetail; flowType: FlowType } | null> {
  const order = hint
    ? [hint, ...FLOW_TYPES.filter((f) => f !== hint)]
    : FLOW_TYPES;
  for (const flowType of order) {
    try {
      const detail = (await hubGet(
        `/runs/${id}`,
        { flowType },
        cfg
      )) as RunDetail | null;
      if (detail?.run) return { detail, flowType };
    } catch (err) {
      if (err instanceof HubError && err.status === 404) continue;
      throw err;
    }
  }
  return null;
}

// ── Detail rendering ─────────────────────────────────────────────────────────

/** A JSON value, one line, capped so a large payload never floods the terminal. */
function preview(value: unknown, cap = 400): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "object" && Object.keys(value as object).length === 0)
    return null;
  let json: string;
  try {
    json = JSON.stringify(value);
  } catch {
    return null;
  }
  if (!json || json === "{}" || json === "[]") return null;
  return json.length > cap ? `${json.slice(0, cap)}… (--json for all)` : json;
}

function str(o: Record<string, unknown>, k: string): string | null {
  const v = o[k];
  return typeof v === "string" && v ? v : null;
}

/** Human duration from a step's own start/end stamps. */
function duration(o: Record<string, unknown>): string | null {
  const a = str(o, "startedAt");
  const b = str(o, "completedAt");
  if (!a || !b) return null;
  const ms = Date.parse(b) - Date.parse(a);
  if (!Number.isFinite(ms) || ms < 0) return null;
  return ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${ms}ms`;
}

function num(o: Record<string, unknown>, k: string): number | null {
  const v = o[k];
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

/**
 * The AI telemetry suffix for a node line — the whole reason this command
 * exists in its current form.
 *
 * On 2026-08-03 an `ai.generate` step ran 24.5s, returned `""`, and reported
 * `completed`. `diagnose` printed `out (empty)` and could say nothing more, so
 * finding out WHY meant SSH-ing to the IS container and grepping unstructured
 * logs by wall-clock timestamp. `finishReason` is the field that answers it, and
 * the token pair says whether the prompt was even read.
 *
 * Renders as: `finish=length · tokens 4210→0`. Emits nothing when the step made
 * no IS generation, when the run predates migration 0224, or against an IS build
 * that predates the seam telemetry change — never a fabricated 0.
 *
 * Any finish reason other than `stop` is the FINDING, so it prints yellow.
 */
function aiTelemetry(d: Record<string, unknown>): string | null {
  const finish = str(d, "finishReason");
  const tin = num(d, "tokensIn");
  const tout = num(d, "tokensOut");
  const bits: string[] = [];
  if (finish)
    bits.push(
      finish === "stop"
        ? chalk.dim(`finish=${finish}`)
        : chalk.yellow(`finish=${finish}`)
    );
  if (tin !== null || tout !== null)
    bits.push(chalk.dim(`tokens ${tin ?? "?"}→${tout ?? "?"}`));
  return bits.length > 0 ? bits.join(chalk.dim(" · ")) : null;
}

function stepStatus(status: string | null): string {
  switch (status) {
    case "completed":
      return chalk.green("✓ completed");
    case "failed":
      return chalk.red("✗ failed");
    case "running":
      return chalk.yellow("· running");
    case "skipped":
      return chalk.dim("– skipped");
    default:
      return chalk.dim(status ?? "?");
  }
}

/**
 * One node of the run. This is where failures actually live — a failed step, an
 * empty `ai.generate` return, an unresolved template reference — so the node's
 * status, timing, error, resolved inputs and output all print here rather than
 * only in `--json`.
 */
export function renderNode(a: RunActivityItem): void {
  const when = a.at ? chalk.dim(a.at.slice(11, 19)) : chalk.dim("··:··:··");
  const d = (a.detail ?? {}) as Record<string, unknown>;
  const isStep = a.kind === "step";
  // AI decision/trace rows carry the WHY — highlight them (emerald = AI accent).
  const kindTag =
    a.kind === "capture_trace" || a.kind === "ai_decision"
      ? chalk.green(a.kind)
      : chalk.dim(a.kind);
  const head = isStep ? stepStatus(a.status) : kindTag;
  const dur = duration(d);
  console.log(
    `  ${when}  ${head}  ${chalk.bold(a.label)}${dur ? chalk.dim(`  ${dur}`) : ""}`
  );

  const nodeId = str(d, "nodeId");
  const nodeType = str(d, "nodeType");
  const commandId = str(d, "commandId");
  if (nodeId || nodeType || commandId) {
    const bits = [
      nodeId ? `node ${nodeId}` : null,
      nodeType,
      commandId ? `command ${commandId}` : null,
    ].filter(Boolean);
    console.log(`            ${chalk.dim(bits.join(" · "))}`);
  }

  const err = str(d, "errorMessage");
  if (err) console.log(`            ${chalk.red("error")} ${err}`);
  // `hint` duplicates errorMessage for automation steps — don't print it twice.
  if (a.hint && a.hint !== err)
    console.log(`            ${chalk.green("→ " + a.hint)}`);

  const inputs = preview(d.resolvedInputs);
  if (inputs) console.log(`            ${chalk.dim("in ")} ${inputs}`);
  // AI telemetry rides the SAME line as the output, so an empty generation reads
  // as one sentence: `out (empty) · finish=length · tokens 4210→0`.
  const ai = aiTelemetry(d);
  const aiSuffix = ai ? `${chalk.dim(" · ")}${ai}` : "";
  // An `ai.generate` that produced nothing returns the EMPTY STRING, which
  // `preview` faithfully renders as the two characters `""` — technically
  // honest, but it read as a value rather than as the finding it is. Route it
  // to the `(empty)` branch alongside `{}`/`[]`/null. Deliberately checked HERE
  // and not inside `preview`, which also renders the `in` line where a literal
  // `""` input is a legitimate value worth showing.
  const rawOut = d.output;
  const outputIsEmpty =
    rawOut === null ||
    rawOut === undefined ||
    (typeof rawOut === "string" && rawOut.trim() === "");
  const output = outputIsEmpty ? null : preview(rawOut);
  if (output) console.log(`            ${chalk.dim("out")} ${output}${aiSuffix}`);
  else if (isStep && "output" in d)
    // An empty return is a real finding, not a blank line. Shown on a FAILED
    // step too — an empty generation now fails the step (see generateViaIS), and
    // that is exactly the row an operator is reading.
    console.log(
      `            ${chalk.dim("out")} ${chalk.yellow("(empty)")}${aiSuffix}`
    );
  else if (ai)
    // A FAILED AI step has no output at all — but its finish reason is exactly
    // what the operator came for, so it still prints.
    console.log(`            ${chalk.dim("ai ")} ${ai}`);
}

function renderDetail(detail: RunDetail): void {
  const { run, activity } = detail;
  log.heading(`${run.flowType} run — ${run.flowName}`);
  console.log(`  status  ${statusColor(run.status)}`);
  console.log(`  id      ${chalk.dim(run.id)}`);
  if (run.summary) log.info(run.summary);
  if (run.error) console.log(`  ${chalk.red("error")}  ${run.error}`);
  if (run.channelId) log.dim(`  channel ${run.channelId} (open it for the full message story)`);
  const trigger = preview(detail.trigger?.payload, 200);
  if (trigger) console.log(`  trigger ${chalk.dim(trigger)}`);

  log.heading("Nodes");
  if (activity.length === 0) {
    log.dim("(no recorded activity — the story may live in the run's channel)");
  } else {
    for (const a of activity) renderNode(a);
  }

  const out = preview(detail.outputSummary, 600);
  if (out) {
    log.heading("Output");
    console.log(`  ${chalk.dim(out)}`);
  }
}

interface ProvidersEnvelope {
  providers?: Array<{ provider: string; displayName?: string; connected?: boolean }>;
  nangoStatus?: "ok" | "error";
  nangoError?: { reason?: string; message?: string };
}

/**
 * Connector health. A failed connect produces no run, so the run feed alone goes
 * silent on exactly the failure a user runs `diagnose` to understand.
 */
async function renderConnectors(cfg: Awaited<ReturnType<typeof resolveHubConfig>>): Promise<void> {
  log.heading("Connectors");
  let res: ProvidersEnvelope;
  try {
    res = (await hubGet("/connectors/providers", {}, cfg)) as ProvidersEnvelope;
  } catch (err) {
    renderHubError(err);
    return;
  }

  if (res.nangoStatus === "error") {
    console.log(`  ${chalk.red("error")}  ${res.nangoError?.reason ?? "unknown"}`);
    if (res.nangoError?.message) log.dim(res.nangoError.message);
    return;
  }

  const providers = res.providers ?? [];
  if (providers.length === 0) {
    console.log(`  ${chalk.yellow("none")}  no integrations declared in this pod's Nango`);
    log.dim("Declare them in the Nango dashboard — no CLI command can add them.");
    return;
  }

  const connected = providers.filter((p) => p.connected).length;
  console.log(
    `  ${chalk.green("ok")}  ${providers.length} provider${providers.length === 1 ? "" : "s"} declared  ${chalk.dim(
      `${connected} connected`
    )}`
  );
}

/**
 * Template behaviour-drift: an installed workspace whose stamped
 * `settings.packageVersion` no longer matches the version its template resolves
 * to today is running STALE behaviour (old views/automations/capabilities). This
 * is the exact "why did the AI behave differently" question `diagnose` exists
 * for, and it produces no run event. REUSES `market`'s ONE drift comparator
 * (`computeUpdates` over `buildMarketCatalog` + `fetchInstalledTemplates`) — no
 * second comparator. Non-fatal: a pod that can't be reached simply omits it.
 */
async function renderDrift(): Promise<void> {
  const { buildMarketCatalog, computeUpdates } = await import("./market.js");
  const { fetchInstalledTemplates } = await import("../lib/installed.js");

  log.heading("Template drift");
  let checks: Awaited<ReturnType<typeof computeUpdates>>;
  try {
    const [cat, installed] = await Promise.all([
      buildMarketCatalog(),
      fetchInstalledTemplates(),
    ]);
    checks = computeUpdates(installed, cat);
  } catch {
    log.dim("(couldn't read installed templates — skipped)");
    return;
  }

  const drifted = checks.filter((c) => c.updateAvailable);
  const unknown = checks.filter((c) => c.noVersionInfo);

  if (drifted.length === 0) {
    console.log(`  ${chalk.green("ok")}  no behaviour-drift across ${checks.length} installed template${checks.length === 1 ? "" : "s"}`);
  } else {
    console.log(
      `  ${chalk.yellow("drift")}  ${drifted.length} workspace${drifted.length === 1 ? "" : "s"} on a stale template version`,
    );
    for (const c of drifted) {
      console.log(
        `    ${chalk.bold(c.slug)}  ${chalk.dim(c.installedVersion || "?")} → ${chalk.dim(c.latestVersion || "?")}`,
      );
    }
    log.dim("Re-apply the current behaviour: synap market update");
  }
  if (unknown.length > 0) {
    log.dim(`${unknown.length} installed template${unknown.length === 1 ? "" : "s"} carry no version stamp — drift can't be checked.`);
  }
}

export async function diagnose(
  runId: string | undefined,
  opts: {
    flow?: string;
    flowId?: string;
    limit?: string;
    json?: boolean;
    podUrl?: string;
    apiKey?: string;
  }
): Promise<void> {
  const cfg = await resolveHubConfig(opts);

  const flow = opts.flow as FlowType | undefined;
  if (flow && !FLOW_TYPES.includes(flow)) {
    log.error(`--flow must be one of: ${FLOW_TYPES.join(", ")}`);
    process.exit(1);
  }

  // ── Detail: a specific run's nodes ─────────────────────────────────────────
  // The id space differs per ledger, so the detail door needs a flowType. It is
  // READ off the feed (the one listing door, which already carries it) or probed
  // — NEVER defaulted, which is what made every non-capture id 404.
  if (runId) {
    let detail: RunDetail | null = null;

    // Resolve id-or-name against the feed first: one call, and it is also what
    // makes `synap diagnose "Generate report"` work.
    const feedQuery: Record<string, string> = { limit: "100" };
    if (flow) feedQuery.flowType = flow;
    let lookup: RunLookup = { kind: "none" };
    try {
      const feed = (await hubGet("/runs", feedQuery, cfg)) as {
        runs: UnifiedRun[];
      };
      lookup = resolveRunTarget(feed.runs ?? [], runId);
    } catch (err) {
      // A feed failure must not hide a perfectly good id — fall through to probe.
      if (!looksLikeId(runId)) throw err;
    }

    if (lookup.kind === "ambiguous") {
      log.error(`'${runId}' matches several flows — pick one:`);
      for (const c of lookup.candidates) {
        console.log(
          `  ${chalk.cyan(c.flowType)}  ${chalk.bold(c.flowName)}  ${chalk.dim(c.id)}`
        );
      }
      process.exit(1);
    }

    if (lookup.kind === "match") {
      const run = lookup.run;
      detail = (await hubGet(
        `/runs/${run.id}`,
        { flowType: run.flowType },
        cfg
      )) as RunDetail | null;
    } else if (looksLikeId(runId)) {
      // Older than the feed window, or a ledger the merged feed omits.
      const probed = await probeFlowTypes(runId, cfg, flow);
      detail = probed?.detail ?? null;
    }

    if (opts.json) {
      console.log(JSON.stringify(detail, null, 2));
      return;
    }
    if (!detail?.run) {
      log.error(
        looksLikeId(runId)
          ? `No run with id '${runId}' in any flow (${FLOW_TYPES.join(", ")}).`
          : `No run matching '${runId}'. Run \`synap diagnose\` to see the feed.`
      );
      process.exit(1);
    }
    renderDetail(detail);
    return;
  }

  // ── Feed: recent runs across flows ─────────────────────────────────────────
  const query: Record<string, string> = {};
  if (flow) query.flowType = flow;
  if (opts.flowId) query.flowId = opts.flowId;
  if (opts.limit) query.limit = opts.limit;

  const res = (await hubGet("/runs", query, cfg)) as { runs: UnifiedRun[] };

  if (opts.json) {
    console.log(JSON.stringify(res, null, 2));
    return;
  }
  log.heading(flow ? `${flow} runs` : "Recent runs");
  renderFeed(res.runs ?? []);

  // Only on the unfiltered feed: a `--flow`-scoped view asked for that flow.
  if (!flow) {
    await renderConnectors(cfg);
    await renderDrift();
  }
}
