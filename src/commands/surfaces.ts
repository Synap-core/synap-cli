/**
 * synap surfaces <kind> <id>        — every surface one object carries
 * synap view create … --for <kind>:<id>
 * synap doc create … --for <kind>:<id>  — attach what you just made to that object
 *
 * A surface is UI anchored to an object: its kind's renderers, its body
 * document, views pinned or attached to it, its home or start page, session
 * outputs and Sites. The pod answers from ONE read (`GET /api/hub/surfaces`,
 * the same service as MCP `synap_find_surfaces` and tRPC
 * `surfaces.forObject`); attaching goes through ONE door
 * (`POST /api/hub/surfaces/attach`, MCP `synap_attach_surface`).
 *
 * A store the pod could not read comes back in `unavailable`. It is printed
 * as its own line and never folded into "no surfaces": an empty list and a
 * failed read are different facts.
 *
 * Wire: these call the Hub REST doors through the CLI's own `hubGet` /
 * `hubPost`, because `@synap-core/hub-rest-client`'s `listSurfaces` /
 * `attachSurface` ship in 1.5.0, which is not on npm yet (latest 1.4.0). The
 * shapes below mirror its `HubSurfacesForObject` / `HubAttachSurfaceResult`;
 * switch to `makeHubClient(cfg).listSurfaces` once the CLI can depend on it.
 */

import chalk from "chalk";
import { humanizeToken } from "@synap-core/types/vocabulary";
import { log } from "../utils/logger.js";
import {
  hubGet,
  hubPost,
  renderHubError,
  resolveHubConfig,
  HubError,
  HubNetworkError,
  type HubConfig,
} from "../lib/hub-client.js";

/** Mirror of hub-rest-client `HubSurfaceRow` (fields this command reads). */
export interface SurfaceRow {
  id: string;
  body: string;
  relation: string;
  anchor: { kind: string; id: string };
  title: string;
  viewType?: string;
  cellKey?: string;
  slot?: string;
  openUrl: string;
  readOnly: boolean;
  source: string;
}

/** Mirror of hub-rest-client `HubSurfacesForObject`. */
export interface SurfacesForObject {
  rows: SurfaceRow[];
  unavailable: { source: string; error: string }[];
}

export interface SurfacesListOpts {
  workspace?: string;
  json?: boolean;
  podUrl?: string;
  apiKey?: string;
}

/** A pod-relative link (`/open/…`) made absolute on this pod. */
function absoluteLink(url: string, podUrl: string): string {
  return url.startsWith("/") ? `${podUrl.replace(/\/+$/, "")}${url}` : url;
}

/** One line per surface: body (view type), relation, title, open link. */
export function formatSurfaceRow(row: SurfaceRow, podUrl: string): string {
  const body = row.viewType && row.viewType !== row.body
    ? `${humanizeToken(row.body)} (${humanizeToken(row.viewType)})`
    : humanizeToken(row.body);
  const marks = [row.slot ? `slot ${row.slot}` : "", row.readOnly ? "read-only" : ""]
    .filter(Boolean)
    .join(", ");
  return (
    `  ${chalk.cyan(body.padEnd(18))} ${humanizeToken(row.relation).padEnd(15)} ${row.title}` +
    (marks ? chalk.dim(`  [${marks}]`) : "") +
    `\n      ${chalk.dim(absoluteLink(row.openUrl, podUrl))}`
  );
}

/** What the pod could not read: one line each, never "nothing there". */
export function formatUnavailable(u: { source: string; error: string }): string {
  return `  unavailable: ${u.source} could not be read (${u.error})`;
}

export async function surfacesList(
  kind: string,
  id: string,
  opts: SurfacesListOpts
): Promise<void> {
  try {
    const cfg = await resolveHubConfig(opts);
    const params: Record<string, string> = { kind, id };
    const workspaceId = opts.workspace;
    if (workspaceId) params.workspaceId = workspaceId;
    const res = (await hubGet("/surfaces", params, cfg)) as SurfacesForObject;

    if (opts.json) {
      console.log(JSON.stringify(res, null, 2));
      return;
    }

    const rows = Array.isArray(res.rows) ? res.rows : [];
    const unavailable = Array.isArray(res.unavailable) ? res.unavailable : [];

    log.heading(`Surfaces on ${kind} ${id.slice(0, 8)}…`);
    if (rows.length === 0) {
      log.dim(
        unavailable.length > 0
          ? "None found in the stores that answered; the ones below could not be read."
          : "None yet. Make one for it: synap view create --for " +
              `${kind}:${id} …  or  synap doc create --for ${kind}:${id} …`
      );
    }
    for (const row of rows) console.log(formatSurfaceRow(row, cfg.podUrl));
    for (const u of unavailable) log.warn(formatUnavailable(u).trim());
    console.log("");
  } catch (e) {
    if (e instanceof HubError || e instanceof HubNetworkError) {
      log.error(`Could not list the surfaces of ${kind} ${id}.`);
      renderHubError(e);
      process.exit(1);
    }
    log.error("Error: " + (e as Error).message);
    process.exit(1);
  }
}

/** `--for <kind>:<id>` → the anchor, or null when malformed. */
export function parseForAnchor(value: string): { kind: string; id: string } | null {
  const at = value.indexOf(":");
  if (at <= 0 || at === value.length - 1) return null;
  return { kind: value.slice(0, at), id: value.slice(at + 1) };
}

/**
 * Put a surface the CLI just made on one object (`POST /surfaces/attach`).
 * An agent key's attach is a proposal: reported as such, not as a failure.
 * A refused or failed attach comes back as `{ error }`, so the caller can
 * still report what it made before saying the attach did not happen.
 */
export async function attachSurfaceFor(
  cfg: HubConfig,
  anchor: { kind: string; id: string },
  surface: { type: "view" | "document"; id: string }
): Promise<Record<string, unknown>> {
  try {
    return (await hubPost(
      "/surfaces/attach",
      { anchor, surface },
      cfg
    )) as Record<string, unknown>;
  } catch (e) {
    return { error: (e as Error).message };
  }
}

/** Print the attach answer: attached / already there / proposed / failed. */
export function reportAttach(
  res: Record<string, unknown>,
  anchor: { kind: string; id: string },
  podUrl: string
): void {
  const where = `${anchor.kind} ${anchor.id.slice(0, 8)}…`;
  if (typeof res.error === "string") {
    log.error(`Not attached to ${where}: ${res.error}`);
    process.exitCode = 1;
    return;
  }
  if (res.status === "proposed") {
    log.info(`Attach to ${where}: proposed (under review)`);
    if (res.proposalId) log.dim(`  proposal: ${String(res.proposalId)}`);
    if (res.reviewUrl) log.dim(`  review: ${String(res.reviewUrl)}`);
    return;
  }
  log.success(
    res.status === "exists" ? `Already attached to ${where}` : `Attached to ${where}`
  );
  if (typeof res.openUrl === "string") log.dim(`  open: ${absoluteLink(res.openUrl, podUrl)}`);
}
