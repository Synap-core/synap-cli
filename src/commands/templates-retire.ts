/**
 * `synap templates retire <slug|workspace> [--dry-run]` — the safe move off a
 * retired template (contract A, retire-into).
 *
 * The pod owns the plan and the move (`POST /api/hub/workspaces/:id/retire-into`):
 * it installs the replacement if missing, moves the entities whose kind has a
 * home there, and archives the old space ONLY when nothing is left. It never
 * deletes. This command:
 *   1. resolves the argument to ONE workspace (template slug, workspace id or name);
 *   2. asks the pod for the plan (`dryRun: true`) and prints it;
 *   3. without `--dry-run`, asks y/N (or takes `--yes`) and runs it. An agent key
 *      gets a proposal back, and the person approves it with `synap open proposal <id>`.
 *
 * A pod answer this CLI cannot read is reported as unreadable, never as "nothing to move".
 */

import chalk from "chalk";
import prompts from "prompts";
import { log } from "../utils/logger.js";
import { resolveHubConfig, hubPost, renderHubError, type HubConfig } from "../lib/hub-client.js";
import { fetchWorkspaceAttachmentsStrict, type WorkspaceAttachment } from "../lib/installed.js";
import { parseRetireResponse, formatRetirePlan, type RetireOutcome } from "../lib/template-lifecycle.js";
import { resolveWorkspaceQuery } from "./market.js";

export type RetireTargetResolution =
  | { kind: "found"; ws: WorkspaceAttachment }
  | { kind: "none" }
  | { kind: "ambiguous"; matches: WorkspaceAttachment[] };

/** Template slug first (what the notice prints), then workspace id / name. */
export function resolveRetireTarget(query: string, attachments: WorkspaceAttachment[]): RetireTargetResolution {
  const bySlug = attachments.filter((a) => a.packageSlug === query);
  if (bySlug.length === 1) return { kind: "found", ws: bySlug[0]! };
  if (bySlug.length > 1) return { kind: "ambiguous", matches: bySlug };
  return resolveWorkspaceQuery(query, attachments);
}

async function callRetire(cfg: HubConfig, workspaceId: string, dryRun: boolean): Promise<unknown> {
  return hubPost(`/workspaces/${encodeURIComponent(workspaceId)}/retire-into`, { dryRun }, cfg);
}

function printPlan(outcome: RetireOutcome & { kind: "plan" | "applied" }, ws: WorkspaceAttachment): void {
  log.heading(`  Retire "${ws.workspaceName}"${ws.packageSlug ? chalk.dim(` (${ws.packageSlug})`) : ""}`);
  log.blank();
  for (const line of formatRetirePlan(outcome.plan)) console.log("    " + line);
  log.blank();
}

export async function templatesRetire(
  query: string,
  opts: { dryRun?: boolean; yes?: boolean; json?: boolean; podUrl?: string; apiKey?: string }
): Promise<void> {
  let cfg: HubConfig;
  try {
    cfg = await resolveHubConfig(opts);
  } catch (e) {
    renderHubError(e);
    process.exit(1);
  }

  let attachments: WorkspaceAttachment[];
  try {
    attachments = await fetchWorkspaceAttachmentsStrict(cfg);
  } catch (e) {
    process.exitCode = 1;
    if (opts.json) {
      console.log(JSON.stringify({ error: "pod-unreachable" }, null, 2));
      return;
    }
    log.error("Couldn't read your pod's workspaces — nothing was planned or moved.");
    renderHubError(e);
    return;
  }

  const res = resolveRetireTarget(query, attachments);
  if (res.kind !== "found") {
    process.exitCode = 1;
    if (opts.json) {
      console.log(
        JSON.stringify(
          res.kind === "none"
            ? { error: "not-found", query }
            : { error: "ambiguous", query, matches: res.matches.map((m) => ({ id: m.workspaceId, name: m.workspaceName })) },
          null,
          2
        )
      );
      return;
    }
    if (res.kind === "none") {
      log.error(`No workspace on this pod runs a template "${query}" or is named "${query}".`);
      log.hint("See every workspace's template: synap templates");
    } else {
      log.error(`"${query}" matches ${res.matches.length} workspaces — name one by id:`);
      for (const m of res.matches) log.hint(`${m.workspaceId}  ${m.workspaceName}`);
    }
    return;
  }
  const ws = res.ws;

  // Step 1 — the plan, always. The pod decides what moves and what stays.
  let planRaw: unknown;
  try {
    planRaw = await callRetire(cfg, ws.workspaceId, true);
  } catch (e) {
    process.exitCode = 1;
    if (opts.json) {
      console.log(JSON.stringify({ error: "plan-failed", message: e instanceof Error ? e.message : String(e) }, null, 2));
      return;
    }
    log.error(`The pod couldn't plan the move for "${ws.workspaceName}" — nothing was moved.`);
    renderHubError(e);
    return;
  }
  const plan = parseRetireResponse(planRaw);
  if (!plan || plan.kind === "proposed") {
    // A dry run that came back as a proposal, or a body with no plan: we cannot
    // tell the person what would happen, so we do not go on.
    process.exitCode = 1;
    if (opts.json) {
      console.log(JSON.stringify({ error: "unreadable-plan", raw: planRaw }, null, 2));
      return;
    }
    log.error("The pod answered, but its plan couldn't be read — nothing was moved.");
    log.hint("Update the CLI (npm i -g @synap-core/cli) or check the pod version: synap status");
    return;
  }

  if (opts.dryRun) {
    if (opts.json) {
      console.log(JSON.stringify({ workspaceId: ws.workspaceId, dryRun: true, plan: plan.plan }, null, 2));
      return;
    }
    printPlan(plan, ws);
    log.hint(`To move it: synap templates retire ${ws.packageSlug ?? ws.workspaceId}`);
    return;
  }

  if (!opts.json) printPlan(plan, ws);

  // Step 2 — agreement. Moving data is never silent.
  if (!opts.yes) {
    if (opts.json || !process.stdin.isTTY) {
      process.exitCode = 1;
      if (opts.json) {
        console.log(JSON.stringify({ workspaceId: ws.workspaceId, plan: plan.plan, error: "needs-confirmation" }, null, 2));
      } else {
        log.warn("Not moved: confirm with --yes when there is no terminal to ask in.");
      }
      return;
    }
    const answer = await prompts({ type: "confirm", name: "ok", message: "Move this data now?", initial: false });
    if (answer.ok !== true) {
      log.info("Nothing was moved.");
      return;
    }
  }

  // Step 3 — the move, through the pod (governed: an agent key files a proposal).
  let doneRaw: unknown;
  try {
    doneRaw = await callRetire(cfg, ws.workspaceId, false);
  } catch (e) {
    process.exitCode = 1;
    if (opts.json) {
      console.log(JSON.stringify({ error: "retire-failed", message: e instanceof Error ? e.message : String(e) }, null, 2));
      return;
    }
    log.error(`The move for "${ws.workspaceName}" failed.`);
    renderHubError(e);
    return;
  }
  const done = parseRetireResponse(doneRaw);
  if (opts.json) {
    console.log(JSON.stringify({ workspaceId: ws.workspaceId, outcome: done ?? { kind: "unreadable", raw: doneRaw } }, null, 2));
    if (!done) process.exitCode = 1;
    return;
  }
  if (!done) {
    process.exitCode = 1;
    log.warn("The pod accepted the request, but its answer couldn't be read. Check the space before retrying: synap templates");
    return;
  }
  if (done.kind === "proposed") {
    log.info("Filed for your review — nothing moves until it is approved.");
    if (done.proposalId) log.hint(`Review and approve: synap open proposal ${done.proposalId}`);
    else if (done.reviewUrl) log.hint(`Review and approve: ${done.reviewUrl}`);
    return;
  }
  if (done.kind === "applied") {
    log.success(`Moved into ${done.plan.targetSlug ?? "the replacement"}.`);
    if (done.archived === true) log.dim("The old space was empty afterwards and is archived. Nothing was deleted.");
    else if (done.remaining.length > 0) {
      log.dim("The old space stays, because some things have no home in the replacement:");
      for (const r of done.remaining) log.dim(`  • ${r.count ?? "some"} ${r.kind}: ${r.reason}`);
    }
    return;
  }
  // A plan-shaped answer to a real run: the pod did not say it moved anything.
  log.warn("The pod returned a plan but did not confirm the move. Check the space: synap templates");
}
