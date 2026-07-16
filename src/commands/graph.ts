/**
 * synap graph
 *
 * BFS graph traversal from a starting entity via the Hub Protocol.
 *
 * Usage:
 *   synap graph --entity <id>            # traversal depth 2
 *   synap graph --entity <id> --depth 3
 *   synap graph --entity <id> --json
 */

import chalk from "chalk";
import { log } from "../utils/logger.js";
import { resolveHubConfig, resolveUserId, hubGet } from "../lib/hub-client.js";
import { unwrapList } from "../lib/unwrapList.js";

export interface GraphTraverseOpts {
  entity: string;
  depth?: string;
  json?: boolean;
  podUrl?: string;
  apiKey?: string;
}

export async function graphTraverse(opts: GraphTraverseOpts): Promise<void> {
  try {
    const cfg = await resolveHubConfig(opts);
    const userId = await resolveUserId(cfg);
    const maxDepth = parseInt(opts.depth ?? "2", 10);

    const results = await hubGet("/graph/traverse", {
      startEntityId: opts.entity,
      maxDepth,
      userId,
    }, cfg);

    if (opts.json) {
      console.log(JSON.stringify(results, null, 2));
      return;
    }

    // The API returns a flat array of records — each record is an entity or
    // relation row from the traversal. Split by whether it has a `sourceEntityId`
    // (relation) or not (node).
    const nodes: Record<string, unknown>[] = [];
    const edges: Record<string, unknown>[] = [];

    for (const row of unwrapList<Record<string, unknown>>(results)) {
      if (row.sourceEntityId || row.targetEntityId) {
        edges.push(row);
      } else {
        nodes.push(row);
      }
    }

    console.log(chalk.bold(`\nGraph from ${opts.entity} (depth ${maxDepth})`));

    console.log(chalk.bold(`\nNodes (${nodes.length}):`));
    if (nodes.length === 0) {
      log.dim("(none)");
    } else {
      for (const n of nodes) {
        const profile = String(n.profileSlug ?? n.entityType ?? n.type ?? "entity").padEnd(14);
        const title = String(n.title ?? n.name ?? "–").slice(0, 40).padEnd(42);
        const id = chalk.dim(String(n.id ?? "").slice(0, 8));
        console.log(`  ${chalk.cyan("•")} ${profile} ${title} ${id}`);
      }
    }

    console.log(chalk.bold(`\nEdges (${edges.length}):`));
    if (edges.length === 0) {
      log.dim("(none)");
    } else {
      for (const e of edges) {
        const relType = String(e.type ?? e.relationType ?? e.relationshipType ?? "–").padEnd(22);
        const src = String(e.sourceEntityId ?? "?").slice(0, 8);
        const tgt = String(e.targetEntityId ?? "?").slice(0, 8);
        console.log(`  ${chalk.dim(relType)}  ${chalk.dim(src)} → ${chalk.dim(tgt)}`);
      }
    }
    console.log("");
  } catch (e) {
    log.error("Error: " + (e as Error).message);
    process.exit(1);
  }
}
