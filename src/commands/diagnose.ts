/**
 * `synap diagnose` — see what an AI did, across flows.
 *
 * The CLI face of the unified runs door (LOCKED CONTRACT, base `${podUrl}/api/hub`):
 *   feed:   GET /runs?flowType=&flowId=&limit=
 *   detail: GET /runs/:id?flowType=
 *
 * No args → the recent run feed across automation / playbook / capture / session.
 * With a run id → that run's activity timeline. For a CAPTURE run that is its
 * decision + trace events — WHY a facet/entity dropped or a route was chosen,
 * each with an actionable fixHint. `--json` prints the raw payload.
 */

import chalk from "chalk";
import { log } from "../utils/logger.js";
import { resolveHubConfig, hubGet } from "../lib/hub-client.js";

type FlowType = "automation" | "playbook" | "capture" | "session";
const FLOW_TYPES: FlowType[] = ["automation", "playbook", "capture", "session"];

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
  log.dim(`\nDiagnose one: synap diagnose <id> --flow <${FLOW_TYPES.join("|")}>`);
}

function renderDetail(run: UnifiedRun, activity: RunActivityItem[]): void {
  log.heading(`${run.flowType} run — ${run.flowName}`);
  console.log(`  status  ${statusColor(run.status)}`);
  if (run.summary) log.info(run.summary);
  if (run.error) console.log(`  ${chalk.red("error")}  ${run.error}`);
  if (run.channelId) log.dim(`  channel ${run.channelId} (open it for the full message story)`);

  log.heading("Activity");
  if (activity.length === 0) {
    log.dim("(no recorded activity — the story may live in the run's channel)");
    return;
  }
  for (const a of activity) {
    const when = a.at ? chalk.dim(a.at.slice(11, 19)) : chalk.dim("··:··:··");
    // AI decision/trace rows carry the WHY — highlight the fixHint (emerald =
    // the AI accent) so "what happened & what to do" reads at a glance.
    const kindTag =
      a.kind === "capture_trace" || a.kind === "ai_decision"
        ? chalk.green(a.kind)
        : chalk.dim(a.kind);
    console.log(`  ${when}  ${kindTag}  ${a.label}`);
    if (a.hint) console.log(`            ${chalk.green("→ " + a.hint)}`);
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

  // ── Detail: a specific run's activity ──────────────────────────────────────
  if (runId) {
    // Capture is the primary diagnose case and a capture's id IS its
    // correlationId, so default --flow to capture when omitted (named default).
    const flowType = flow ?? "capture";
    const detail = (await hubGet(`/runs/${runId}`, { flowType }, cfg)) as {
      run: UnifiedRun;
      activity: RunActivityItem[];
    } | null;

    if (opts.json) {
      console.log(JSON.stringify(detail, null, 2));
      return;
    }
    if (!detail) {
      log.error(`Run '${runId}' not found for flow '${flowType}'. Try --flow <${FLOW_TYPES.join("|")}>.`);
      process.exit(1);
    }
    renderDetail(detail.run, detail.activity);
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
}
