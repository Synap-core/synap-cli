/**
 * synap subscribe
 *
 * Long-poll the pod's Pulse/subscription feed and stream events as NDJSON.
 * Polls GET /api/hub/subscriptions every 3 seconds with a cursor.
 *
 * Usage:
 *   synap subscribe                       # all events
 *   synap subscribe --event proposal.*    # filter by eventType pattern
 *   synap subscribe --limit 50            # events per poll
 */

import { log } from "../utils/logger.js";
import { resolveHubConfig, hubGet } from "../lib/hub-client.js";
import { unwrapList } from "../lib/unwrapList.js";

export interface SubscribeOpts {
  event?: string;
  limit?: string;
  json?: boolean;
  podUrl?: string;
  apiKey?: string;
}

/** Simple glob match: "proposal.*" matches "proposal.approved", "proposal.created", etc. */
function matchesPattern(eventType: string, pattern: string): boolean {
  if (pattern === "*") return true;
  if (pattern.endsWith(".*")) {
    const prefix = pattern.slice(0, -2);
    return eventType === prefix || eventType.startsWith(prefix + ".");
  }
  // Escape regex special chars except * which we convert to .*
  const regexStr = pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
  return new RegExp(`^${regexStr}$`).test(eventType);
}

export async function subscribeEvents(opts: SubscribeOpts): Promise<void> {
  const cfg = await resolveHubConfig(opts);
  const limit = parseInt(opts.limit ?? "20", 10);

  if (!opts.json) {
    log.dim("Subscribing to pod events... (Ctrl+C to stop)");
    if (opts.event) {
      log.dim(`  filter: ${opts.event}`);
    }
  }

  // Seen-event deduplication cache (keep last 500 ids)
  const seenIds = new Set<string>();
  const MAX_SEEN = 500;

  // Start cursor at now so we only get future events
  let cursor = new Date().toISOString();

  let intervalHandle: ReturnType<typeof setInterval> | null = null;
  let stopped = false;
  let consecutiveErrors = 0;

  const poll = async () => {
    if (stopped) return;
    try {
      const params: Record<string, string | number> = { limit, since: cursor };
      const res = await hubGet("/subscriptions", params, cfg) as Record<string, unknown>;
      consecutiveErrors = 0;

      const events = unwrapList<Record<string, unknown>>(res, ["events", "items"]);

      for (const event of events) {
        const id = String(event.id ?? "");
        if (id && seenIds.has(id)) continue;
        if (id) {
          seenIds.add(id);
          if (seenIds.size > MAX_SEEN) {
            const first = seenIds.values().next().value;
            if (first !== undefined) seenIds.delete(first);
          }
        }

        const eventType = String(event.eventType ?? event.type ?? "");
        if (opts.event && eventType && !matchesPattern(eventType, opts.event)) continue;

        const createdAt = String(event.createdAt ?? event.timestamp ?? "");
        if (createdAt && createdAt > cursor) cursor = createdAt;

        console.log(JSON.stringify(event));
      }
    } catch {
      consecutiveErrors++;
      if (consecutiveErrors === 3 && !opts.json) {
        log.dim("  Pod unreachable — retrying...");
      }
    }
  };

  // Graceful shutdown on SIGINT (Ctrl+C)
  process.on("SIGINT", () => {
    stopped = true;
    if (intervalHandle !== null) clearInterval(intervalHandle);
    process.exit(0);
  });

  // Run immediately then every 3 seconds
  await poll();
  intervalHandle = setInterval(() => { void poll(); }, 3_000);
}
