/**
 * synap surfaces <kind> <id>        — every surface one object carries
 * synap view create … --for <kind>:<id>
 * synap doc create … --for <kind>:<id>  — make it FOR that object, in one act
 *
 * A surface is UI anchored to an object: its kind's renderers, its body
 * document, views pinned or attached to it, its home or start page, session
 * outputs and Sites. The pod answers from ONE read (`GET /api/hub/surfaces`,
 * the same service as MCP `synap_find_surfaces` and tRPC
 * `surfaces.forObject`); making one for an object is ONE governed act
 * (`POST /api/hub/surfaces {anchor, body, title, spec}`, the `surface/create`
 * door MCP and tRPC call too): the body and its link to the object land
 * together, or as one proposal, never a body left unattached.
 *
 * A store the pod could not read comes back in `unavailable`. It is printed
 * as its own line and never folded into "no surfaces": an empty list and a
 * failed read are different facts. An answer that is not a surface list at
 * all is a failed read too, never "none yet".
 *
 * Wire: these call the Hub REST doors through the CLI's own `hubGet` /
 * `hubPost`, because `@synap-core/hub-rest-client`'s `listSurfaces` /
 * `createSurface` ship in 1.5.0, which is not on npm yet (latest 1.4.0). The
 * shapes below mirror its `HubSurfacesForObject` / `HubCreateSurfaceResult`;
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

/** The contract's shape: both lists present. Anything else is a failed read. */
export function isSurfacesForObject(res: unknown): res is SurfacesForObject {
  if (!res || typeof res !== "object") return false;
  const r = res as Record<string, unknown>;
  return Array.isArray(r.rows) && Array.isArray(r.unavailable);
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
    const res = await hubGet("/surfaces", params, cfg);
    if (!isSurfacesForObject(res)) {
      log.error(
        `Could not list the surfaces of ${kind} ${id}: the pod's answer is not a surface list (an older pod, or a proxy in the way).`
      );
      process.exit(1);
    }

    if (opts.json) {
      console.log(JSON.stringify(res, null, 2));
      return;
    }

    const { rows, unavailable } = res;

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

/** What `POST /surfaces` makes: a body, with what it holds (hub-rest-client `HubCreateSurfaceInput`). */
export interface CreateSurfaceRequest {
  anchor: { kind: string; id: string };
  body: "view" | "bento" | "whiteboard" | "document" | "html";
  title: string;
  spec?: { viewType?: string; content?: string; workspaceId?: string };
}

/**
 * Make a surface FOR one object (`POST /surfaces`): the body and its link to
 * the object in one governed act. An agent key's create is ONE proposal that
 * carries both. A refusal throws (HubError) with the pod's words.
 */
export async function createSurfaceFor(
  cfg: HubConfig,
  req: CreateSurfaceRequest
): Promise<Record<string, unknown>> {
  return (await hubPost("/surfaces", req, cfg)) as Record<string, unknown>;
}

/** Print the create answer: made (with its link on the object) or proposed. */
export function reportSurfaceCreate(
  res: Record<string, unknown>,
  req: CreateSurfaceRequest,
  podUrl: string
): void {
  const where = `${req.anchor.kind} ${req.anchor.id.slice(0, 8)}…`;
  if (res.status === "proposed") {
    // A proposal is normal: the body and its link land together on approval.
    log.info(`${humanizeToken(req.body)} for ${where}: ${req.title} — proposed (under review)`);
    if (res.proposalId) log.dim(`  proposal: ${String(res.proposalId)}`);
    if (res.reviewUrl) log.dim(`  review: ${String(res.reviewUrl)}`);
    return;
  }
  const surface = res.surface as { id?: unknown } | undefined;
  log.success(`${humanizeToken(req.body)} made for ${where}: ${req.title}`);
  if (surface?.id) log.dim(`  id: ${String(surface.id)}`);
  if (typeof res.openUrl === "string") log.dim(`  open: ${absoluteLink(res.openUrl, podUrl)}`);
}
