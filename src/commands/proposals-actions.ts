import chalk from "chalk";
import { log } from "../utils/logger.js";
import { resolveHubConfig, hubPost } from "../lib/hub-client.js";
import { type BaseOpts } from "./data.js";

// ─── approveProposal ──────────────────────────────────────────────────────────

export async function approveProposal(
  id: string,
  opts: BaseOpts & { reason?: string }
): Promise<void> {
  try {
    const cfg = await resolveHubConfig(opts);

    const res = await hubPost(
      `/proposals/${id}/approve`,
      { reason: opts.reason },
      cfg
    ) as Record<string, unknown>;

    if (opts.json) {
      console.log(JSON.stringify(res, null, 2));
      return;
    }

    log.success(`Proposal approved  ${chalk.dim(id.slice(0, 8))}`);
    if (opts.reason) log.dim(`  reason: ${opts.reason}`);
  } catch (e) {
    console.error(chalk.red("Error: " + (e as Error).message));
    process.exit(1);
  }
}

// ─── rejectProposal ───────────────────────────────────────────────────────────

export async function rejectProposal(
  id: string,
  opts: BaseOpts & { reason?: string }
): Promise<void> {
  try {
    const cfg = await resolveHubConfig(opts);

    const res = await hubPost(
      `/proposals/${id}/reject`,
      { reason: opts.reason },
      cfg
    ) as Record<string, unknown>;

    if (opts.json) {
      console.log(JSON.stringify(res, null, 2));
      return;
    }

    log.success(`Proposal rejected  ${chalk.dim(id.slice(0, 8))}`);
    if (opts.reason) log.dim(`  reason: ${opts.reason}`);
  } catch (e) {
    console.error(chalk.red("Error: " + (e as Error).message));
    process.exit(1);
  }
}
