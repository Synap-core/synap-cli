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
import { resolveHubConfig, hubGet, renderHubError } from "../lib/hub-client.js";

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

  // Only on the unfiltered feed: a `--flow`-scoped view asked for that flow.
  if (!flow) {
    await renderConnectors(cfg);
    await renderDrift();
  }
}
