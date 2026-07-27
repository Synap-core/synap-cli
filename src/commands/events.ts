/**
 * synap events
 *
 * Show the event chain for an entity or recent pod-wide events.
 *
 * Usage:
 *   synap events --entity <id>            # last 20 events for entity
 *   synap events --entity <id> --limit 50
 *   synap events --entity <id> --json
 *   synap events --limit 20               # recent pod-wide events
 *
 * API: GET /api/hub/events
 * Query params: userId (pinned server-side), subjectId, type, subjectType,
 *               fromDate, limit (default 50, max 200).
 * Response: { events: WireEvent[] }  — newest first.
 * WireEvent shape: { id, type, subjectType?, subjectId?, userId?, workspaceId?,
 *                    data?, timestamp? }
 */

import chalk from "chalk";
import { log } from "../utils/logger.js";
import { resolveHubConfig, hubGet } from "../lib/hub-client.js";
import { unwrapList } from "../lib/unwrapList.js";

export interface ListEventsOpts {
  entity?: string;
  limit?: string;
  json?: boolean;
  podUrl?: string;
  apiKey?: string;
}

export async function listEvents(opts: ListEventsOpts): Promise<void> {
  try {
    const cfg = await resolveHubConfig(opts);
    const limit = parseInt(opts.limit ?? "20", 10);

    const params: Record<string, string | number | undefined> = { limit };
    if (opts.entity) params.subjectId = opts.entity;

    const res = await hubGet("/events", params, cfg) as Record<string, unknown>;
    const events = unwrapList<Record<string, unknown>>(res, ["events", "items"]);

    if (opts.json) {
      console.log(JSON.stringify(events, null, 2));
      return;
    }

    const scope = opts.entity
      ? `entity: ${opts.entity.slice(0, 8)}…`
      : "pod-wide";
    console.log(chalk.bold(`\nRecent events (${scope})`));
    console.log("");

    if (events.length === 0) {
      log.dim("(no events found)");
      console.log("");
      return;
    }

    for (const ev of events) {
      // Normalise timestamp — may be ISO string or Date
      const raw = ev.timestamp ?? ev.createdAt ?? "";
      let ts = String(raw);
      try {
        if (ts) {
          const d = new Date(ts);
          ts = d.toISOString().replace("T", " ").slice(0, 16);
        }
      } catch { /* leave as-is */ }

      const evType = String(ev.eventType ?? ev.type ?? "–");
      const subjectType = ev.subjectType ? chalk.dim(` [${ev.subjectType}]`) : "";
      // Full id — the event's subject is usually an entity; feeds straight
      // into `synap get entity <id>`.
      const subjectId = ev.subjectId ? chalk.dim(`  → ${String(ev.subjectId)}`) : "";

      console.log(
        `  ${chalk.dim(ts.padEnd(17))}  ${chalk.cyan(evType.padEnd(36))}${subjectType}${subjectId}`
      );
    }
    console.log("");
  } catch (e) {
    log.error("Error: " + (e as Error).message);
    process.exit(1);
  }
}
