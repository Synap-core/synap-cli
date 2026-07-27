/**
 * synap centrality
 *
 * Window onto the Phase-3 PageRank centrality signal:
 *   - `synap centrality` / `synap centrality status` — has entity_centrality
 *     populated? how fresh? top central entities.
 *   - `synap centrality recompute` — enqueue the PageRank job on demand.
 *
 * Usage:
 *   synap centrality
 *   synap centrality status --json
 *   synap centrality recompute
 */

import chalk from "chalk";
import { log } from "../utils/logger.js";
import { resolveHubConfig, hubGet, hubPost } from "../lib/hub-client.js";

export interface CentralityOpts {
  json?: boolean;
  podUrl?: string;
  apiKey?: string;
}

interface CentralityTop {
  id: string;
  title: string | null;
  score: number;
}

interface CentralityStatusResponse {
  computed: boolean;
  rows: number;
  lastComputedAt: string | null;
  oldestComputedAt: string | null;
  top: CentralityTop[];
  note?: string;
}

function timeAgo(isoDate: string): string {
  const diff = Date.now() - new Date(isoDate).getTime();
  const minutes = Math.floor(diff / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? "" : "s"} ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? "" : "s"} ago`;
  const days = Math.floor(hours / 24);
  return `${days} day${days === 1 ? "" : "s"} ago`;
}

export async function centralityStatus(opts: CentralityOpts): Promise<void> {
  try {
    const cfg = await resolveHubConfig(opts);
    const res = (await hubGet(
      "/centrality/status",
      {},
      cfg
    )) as CentralityStatusResponse;

    if (opts.json) {
      console.log(JSON.stringify(res, null, 2));
      return;
    }

    console.log(chalk.bold("\nPageRank centrality"));

    if (!res.computed) {
      console.log(`  computed:  ${chalk.yellow("no")}`);
      console.log(`  rows:      ${res.rows}`);
      if (res.note) log.dim(`  ${res.note}`);
      console.log("");
      log.dim(
        "  Once the Phase-3 migration is applied and the pod is deployed, run:"
      );
      log.dim("    synap centrality recompute");
      console.log("");
      return;
    }

    console.log(`  computed:  ${chalk.green("yes")}`);
    console.log(`  rows:      ${res.rows}`);
    console.log(
      `  last run:  ${
        res.lastComputedAt ? timeAgo(res.lastComputedAt) : chalk.dim("–")
      }`
    );
    console.log(
      `  oldest:    ${
        res.oldestComputedAt ? timeAgo(res.oldestComputedAt) : chalk.dim("–")
      }`
    );

    console.log(chalk.bold(`\nTop central entities (${res.top.length}):`));
    if (res.top.length === 0) {
      log.dim("  (none)");
    } else {
      for (const t of res.top) {
        const score = chalk.cyan(t.score.toFixed(4).padStart(8));
        const title = String(t.title ?? "–").slice(0, 48).padEnd(50);
        // Full id — feeds straight into `synap get entity <id>`.
        const id = chalk.dim(t.id);
        console.log(`  ${score} · ${title} ${id}`);
      }
    }
    console.log("");
  } catch (e) {
    log.error("Error: " + (e as Error).message);
    process.exit(1);
  }
}

export async function centralityRecompute(opts: CentralityOpts): Promise<void> {
  try {
    const cfg = await resolveHubConfig(opts);
    const res = (await hubPost("/centrality/recompute", {}, cfg)) as {
      triggered: boolean;
      note?: string;
    };

    if (opts.json) {
      console.log(JSON.stringify(res, null, 2));
      return;
    }

    if (res.triggered) {
      log.success(
        "PageRank recompute triggered — runs in the background; re-check with `synap centrality status` in a minute."
      );
    } else {
      log.error(
        "PageRank recompute NOT triggered." + (res.note ? ` (${res.note})` : "")
      );
      process.exit(1);
    }
  } catch (e) {
    log.error("Error: " + (e as Error).message);
    process.exit(1);
  }
}
