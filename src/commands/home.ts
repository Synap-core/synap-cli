/**
 * synap home
 *
 * Show the current bento layout of the active workspace's home screen.
 * Useful at the start of an agent session to understand what's already
 * present before proposing UI changes.
 */

import chalk from "chalk";
import { log } from "../utils/logger.js";
import { resolveHubConfig, hubGet } from "../lib/hub-client.js";
import { getAgentWorkspaceRouting } from "../lib/pod.js";
import type { BaseOpts } from "./data.js";

export interface HomeOpts extends BaseOpts {
  workspace?: string;
}

interface BlockSummary {
  kind: string;
  typeKey: string | null;
  label: string | null;
  id: string | null;
}

interface HomeResponse {
  workspaceId: string;
  homeViewId: string | null;
  homeViewName?: string;
  blocks: Array<Record<string, unknown>>;
  blockSummary: BlockSummary[];
}

export async function showHome(opts: HomeOpts): Promise<void> {
  try {
    const cfg = await resolveHubConfig(opts);
    const routing = getAgentWorkspaceRouting();
    const workspaceId =
      opts.workspace ??
      routing?.memoryWorkspaceId ??
      cfg.workspaceId;

    if (!workspaceId) {
      console.error(
        chalk.red(
          "Error: no workspace resolved. Pass --workspace <id> or run `synap context` to set active workspace."
        )
      );
      process.exit(1);
    }

    const res = (await hubGet(
      `/workspaces/${workspaceId}/home`,
      {},
      cfg
    )) as HomeResponse;

    if (opts.json) {
      console.log(JSON.stringify(res, null, 2));
      return;
    }

    const viewLabel = res.homeViewName
      ? `${res.homeViewName} (${res.homeViewId ?? "no view"})`
      : res.homeViewId ?? chalk.dim("none");

    log.info(`Home layout — workspace ${chalk.bold(workspaceId.slice(0, 8))}`);
    console.log(`  View: ${chalk.cyan(viewLabel)}`);
    console.log(`  Blocks: ${res.blocks.length}`);

    if (res.blockSummary.length === 0) {
      console.log(chalk.dim("  (empty — no bento blocks on home yet)"));
      return;
    }

    console.log("");
    for (const b of res.blockSummary) {
      const kindLabel = chalk.dim(`[${b.kind}]`);
      const typeLabel = b.typeKey ? chalk.cyan(b.typeKey) : "";
      const nameLabel = b.label ? chalk.white(b.label) : chalk.dim("unlabelled");
      const idLabel = b.id ? chalk.dim(` ${b.id.slice(0, 8)}`) : "";
      console.log(`  ${kindLabel} ${typeLabel}  ${nameLabel}${idLabel}`);
    }

    console.log("");
    console.log(
      chalk.dim(
        "Tip: use `create_proposal` with targetType:\"workspace_home\" to propose adding or removing blocks."
      )
    );
  } catch (e) {
    log.error("Error: " + (e as Error).message);
    process.exit(1);
  }
}
