/**
 * synap cap sync-status [provider] — status of the ONE sync door
 * (`services/event-sync/connection-sync.ts`) per provider × kind × connection.
 *
 * Backend surface: GET /api/hub/connectors/sync-status?provider=&workspaceId=
 * (Hub Protocol REST, `hub-protocol/rest/connectors.ts`).
 */

import chalk from "chalk";
import { resolveHubConfig, hubGet, renderHubError } from "../lib/hub-client.js";
import { log } from "../utils/logger.js";

interface SyncCounts {
  fetched: number;
  created: number;
  merged: number;
  skipped: number;
}

/**
 * Mirrors the backend's `ConnectionSyncStatus` (`services/event-sync/
 * connection-sync.ts`, itself derived from its own `ConnectionSyncStatusSchema`
 * — the ONE definition). This package cannot import that schema directly (see
 * `SYNC_PHASE_LABELS` below for why), so this is a hand-kept mirror — which
 * already drifted once (missing `workspaceId`, which the wire always sends).
 * Keep every field here in sync with the backend schema; do not silently drop
 * a field just because this render doesn't currently use it.
 */
interface SyncStatus {
  provider: string;
  connectionId?: string;
  /** The connection's workspace scope (null = pod-wide). Not currently rendered. */
  workspaceId: string | null;
  kind: string;
  enabled: boolean;
  profileSlugs: string[];
  openableProfileSlugs: string[];
  lastRunAt?: string;
  phase?:
    | "fetching"
    | "mapping"
    | "review_ready"
    | "synced"
    | "failed"
    | "not_connected";
  counts?: SyncCounts;
  proposalId?: string;
  /** The "keep syncing automatically" setting this connection was approved under. */
  keepSyncing?: {
    enabled: boolean;
    ruleId?: string;
    available: boolean;
  };
  error?: string;
}

/**
 * `@synap-core/types/vocabulary` (`resolveStatusLabel`) is the SSOT for these —
 * pinned there verbatim under a comment naming `SyncPhase`. This package
 * cannot import it (see `sessions.ts`'s `SESSION_KIND_LABELS` for why: the CLI
 * links only `@synap-core/workspace-templates`, and `@synap-core/types` pulls
 * in drizzle-orm/drizzle-zod/yjs as transitive deps for a globally-installed
 * binary). Mirrored here and pinned by a source-scan parity test
 * (`test/sync-phase-vocabulary-parity.test.ts`) that DERIVES the phase set
 * from the `SyncPhase` union (`sync-kind-registry.ts`) across the repo
 * boundary, rather than hand-listing it, so a new phase fails the build
 * instead of silently missing a row here.
 */
const SYNC_PHASE_LABELS: Record<string, string> = {
  fetching: "Fetching",
  mapping: "Matching",
  review_ready: "Ready to review",
  synced: "Synced",
  failed: "Failed",
  // No curated STATUS_LABELS entry for this one — this is the vocabulary
  // registry's own humanizeToken("not_connected") fallback, so it can never
  // disagree with what the registry would render either way.
  not_connected: "Not connected",
};

/**
 * Local mirror of `@synap-core/types/vocabulary`'s `humanizeToken` — the
 * fallback for any phase this table hasn't curated a word for. Never print a
 * raw token; a new backend phase should read as a guessed word, not
 * "not_connected" verbatim.
 */
function humanizeToken(token: string): string {
  const words = token
    .replace(/[_-]+/g, " ")
    .trim()
    .toLowerCase();
  return words ? words.charAt(0).toUpperCase() + words.slice(1) : token;
}

function phaseLabel(phase: string | undefined): string {
  if (!phase) return chalk.dim("unknown");
  const label = SYNC_PHASE_LABELS[phase] ?? humanizeToken(phase);
  switch (phase) {
    case "synced":
      return chalk.green(label);
    case "failed":
      return chalk.red(label);
    case "review_ready":
      return chalk.yellow(label);
    case "not_connected":
      return chalk.dim(label); // needs a connect, not a failure
    default:
      return chalk.cyan(label); // fetching / mapping — in progress
  }
}

function countsCell(c?: SyncCounts): string {
  if (!c) return chalk.dim("—");
  return chalk.dim(
    `fetched ${c.fetched} · created ${c.created} · merged ${c.merged} · skipped ${c.skipped}`
  );
}

export interface SyncStatusOpts {
  workspace?: string;
  json?: boolean;
}

export async function capabilitySyncStatus(
  provider: string | undefined,
  opts: SyncStatusOpts
): Promise<void> {
  const cfg = await resolveHubConfig();

  const query: Record<string, string> = {};
  if (provider) query.provider = provider;
  if (opts.workspace ?? cfg.workspaceId) {
    query.workspaceId = opts.workspace ?? cfg.workspaceId!;
  }

  let statuses: SyncStatus[];
  try {
    const res = (await hubGet("/connectors/sync-status", query, cfg)) as {
      statuses?: SyncStatus[];
    };
    // EMPTY ≠ FAILED: `hubGet` throws on a non-2xx response (see renderHubError
    // below) — an empty `statuses` array here is the door's own honest "nothing
    // declared for this provider", never a swallowed fault.
    statuses = res.statuses ?? [];
  } catch (err) {
    renderHubError(err);
    process.exit(1);
  }

  if (opts.json) {
    console.log(JSON.stringify(statuses, null, 2));
    return;
  }

  if (statuses.length === 0) {
    log.heading("Sync status");
    log.dim(
      provider
        ? `No sync configured for "${provider}" on this pod.`
        : "No sync-enabled connectors on this pod."
    );
    return;
  }

  log.heading("Sync status");
  console.log();
  for (const s of statuses) {
    const enabledMark = s.enabled ? chalk.green("●") : chalk.dim("○");
    console.log(
      `  ${enabledMark} ${chalk.bold(s.provider)} ${chalk.dim(`[${s.kind}]`)}  ${phaseLabel(s.phase)}`
    );
    if (s.connectionId) console.log(`      ${chalk.dim("connection")} ${chalk.cyan(s.connectionId)}`);
    if (s.lastRunAt) console.log(`      ${chalk.dim("last run")} ${s.lastRunAt}`);
    // `available` = an approved first import exists — before that, there is
    // nothing yet to keep syncing, so the row is silent rather than showing
    // an "off" that the user cannot flip.
    if (s.keepSyncing?.available) {
      console.log(
        `      ${chalk.dim("keep syncing")} ${s.keepSyncing.enabled ? chalk.green("on") : chalk.dim("off")}`
      );
    }
    if (s.counts) console.log(`      ${countsCell(s.counts)}`);
    if (s.error) console.log(`      ${chalk.red("error")} ${s.error}`);
    if (s.proposalId) {
      console.log(
        `      ${chalk.dim("review")} synap diagnose ${s.proposalId}`
      );
    }
  }
  console.log();
}
