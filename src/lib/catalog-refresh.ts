/**
 * Ask the pod to refresh its copy of the official catalog BEFORE reading an
 * update verdict.
 *
 * The pod's "has an update" verdict (`GET /package-updates`, the template
 * health on `GET /workspaces` / `GET /installed`) compares against its local
 * copy of the catalog, which the pod refreshes every 10 minutes. Without this
 * call, a template published a minute ago reads "up to date" for up to 10
 * minutes (founder, 3 Nov 2026). Hub `POST /catalog/refresh` runs that same
 * refresh now (single-flight on the pod, with a 20 s floor).
 *
 * Best effort, never a blocker: the update check goes on whatever happens
 * here. But a refresh that did not happen is SAID, so a clean verdict after it
 * never reads as verified against the latest catalog.
 */

import { hubPost, HubError, resolveHubConfig, type HubConfig } from "./hub-client.js";

export type CatalogRefresh =
  /** The pod refreshed its catalog (or shared a refresh that just ran). */
  | { state: "refreshed"; refreshedAt: string | null; reused: boolean }
  /** The pod predates `POST /catalog/refresh`: it refreshes on its 10-min schedule only. */
  | { state: "unsupported" }
  /** The refresh was asked and did not happen; `reason` says why. */
  | { state: "failed"; reason: string };

/**
 * Generous: the pod pages every catalog kind from the Control Plane before it
 * answers.
 */
const REFRESH_TIMEOUT_MS = 60_000;

export async function refreshPodCatalog(cfg: HubConfig): Promise<CatalogRefresh> {
  try {
    const body = (await hubPost("/catalog/refresh", {}, cfg, REFRESH_TIMEOUT_MS)) as {
      ok?: unknown;
      refreshedAt?: unknown;
      reused?: unknown;
    } | null;
    if (body?.ok !== true) {
      return { state: "failed", reason: "the pod did not confirm the refresh" };
    }
    return {
      state: "refreshed",
      refreshedAt: typeof body.refreshedAt === "string" ? body.refreshedAt : null,
      reused: body.reused === true,
    };
  } catch (err) {
    if (err instanceof HubError && (err.status === 404 || err.status === 405)) {
      return { state: "unsupported" };
    }
    if (err instanceof HubError) {
      return { state: "failed", reason: err.detail ?? `HTTP ${err.status}` };
    }
    return { state: "failed", reason: err instanceof Error ? err.message : String(err) };
  }
}

/** `refreshPodCatalog` for a command that has not resolved its pod yet. */
export async function refreshPodCatalogFor(opts: { podUrl?: string; apiKey?: string }): Promise<CatalogRefresh> {
  let cfg: HubConfig;
  try {
    cfg = await resolveHubConfig(opts);
  } catch (err) {
    return { state: "failed", reason: err instanceof Error ? err.message : String(err) };
  }
  return refreshPodCatalog(cfg);
}

/**
 * The one line a person reads about the refresh, or null when there is
 * nothing to say (it refreshed).
 */
export function catalogRefreshLine(r: CatalogRefresh): string | null {
  switch (r.state) {
    case "refreshed":
      return null;
    case "unsupported":
      return "This pod refreshes its catalog every 10 minutes: a template published in the last few minutes may not show yet.";
    case "failed":
      return `Could not refresh the pod's catalog (${r.reason}). The check below uses the pod's last copy, so a template published in the last 10 minutes may not show yet.`;
  }
}
