import chalk from "chalk";
import { log } from "../utils/logger.js";
import { resolveHubConfig, hubGet, hubPost, hubDelete, type HubConfig, renderHubError } from "../lib/hub-client.js";
import { resolveActiveLens } from "../lib/session-lens.js";
import { reportWrite } from "../lib/capture-lane.js";
import { unwrapList } from "../lib/unwrapList.js";
import { type BaseOpts } from "./data.js";

// ─── Roles (facets) ─────────────────────────────────────────────────────────
// One identity, many roles: a `client`/`partner`/`contact` is not a separate
// entity, it's a role-profile attached to an existing entity via a facet. This
// command family is the CLI's governed door onto that — user-facing output
// says "Role", never "Facet" (facet stays in code/URLs only).

export interface EffectiveFacet {
  facet: {
    id: string;
    entityId: string;
    profileId: string;
    workspaceId?: string | null;
    status?: string | null;
    properties?: Record<string, unknown>;
  };
  profile?: {
    slug: string;
    displayName: string;
  };
}

/** Fetch an entity's attached roles. Shared with `show <id>`'s Roles section. */
export async function fetchFacets(entityId: string, cfg: HubConfig): Promise<EffectiveFacet[]> {
  const res = (await hubGet(`/entities/${entityId}/facets`, {}, cfg)) as Record<string, unknown>;
  return unwrapList<EffectiveFacet>(res, ["facets"]);
}

/** Render the "Roles (n)" heading + each role's name/status/properties. */
export function renderRoles(facets: EffectiveFacet[]): void {
  log.heading(`Roles (${facets.length})`);
  for (const item of facets) {
    const name = item.profile?.displayName ?? item.profile?.slug ?? "role";
    const status = item.facet.status ? chalk.dim(` [${item.facet.status}]`) : "";
    log.info(`${chalk.bold(name)}${status}  ${chalk.dim(item.facet.id.slice(0, 8))}`);
    for (const [k, v] of Object.entries(item.facet.properties ?? {})) {
      if (v !== null && v !== undefined && v !== "") log.dim(`  ${k}: ${String(v)}`);
    }
  }
}

// ─── facet attach ─────────────────────────────────────────────────────────────

export async function attachFacet(
  entityId: string,
  roleSlug: string,
  opts: BaseOpts & { property?: string[]; workspace?: string }
): Promise<void> {
  try {
    const cfg = await resolveHubConfig(opts);
    const workspaceId = opts.workspace ?? resolveActiveLens()?.workspaceId ?? cfg.workspaceId;

    const properties: Record<string, string> = {};
    for (const kv of opts.property ?? []) {
      const idx = kv.indexOf("=");
      if (idx === -1) continue;
      properties[kv.slice(0, idx)] = kv.slice(idx + 1);
    }

    const res = (await hubPost(
      `/entities/${entityId}/facets`,
      {
        profileSlug: roleSlug,
        ...(Object.keys(properties).length > 0 ? { properties } : {}),
        ...(workspaceId ? { workspaceId } : {}),
      },
      cfg
    )) as Record<string, unknown>;

    // Same governed-write reporter every other write uses (destination line,
    // "proposed" copy, --json `outcome`/lane fields) — no bespoke messaging.
    await reportWrite(res, {
      label: `Attached role: ${chalk.bold(roleSlug)}`,
      lane: "work",
      workspaceId,
      cfg,
      json: opts.json,
    });
  } catch (e) {
    renderHubError(e);
    process.exit(1);
  }
}

// ─── facet list ───────────────────────────────────────────────────────────────

export async function listFacets(entityId: string, opts: BaseOpts): Promise<void> {
  try {
    const cfg = await resolveHubConfig(opts);
    const facets = await fetchFacets(entityId, cfg);

    if (opts.json) {
      console.log(JSON.stringify({ facets }, null, 2));
      return;
    }

    if (facets.length === 0) {
      log.dim("No roles attached to this entity.");
      log.dim(`  Attach one with: synap facet attach ${entityId} <role-slug>`);
      return;
    }

    renderRoles(facets);
  } catch (e) {
    renderHubError(e);
    process.exit(1);
  }
}

// ─── facet detach ─────────────────────────────────────────────────────────────

export async function detachFacet(
  facetOrEntityId: string,
  opts: BaseOpts & { entity?: string; role?: string }
): Promise<void> {
  try {
    const cfg = await resolveHubConfig(opts);

    let facetId = facetOrEntityId;
    let roleLabel = ""; // known only in the `--entity <id> --role <slug>` form
    if (opts.entity && opts.role) {
      const facets = await fetchFacets(opts.entity, cfg);
      const match = facets.find((f) => f.profile?.slug === opts.role);
      if (!match) {
        console.error(chalk.red(`No role '${opts.role}' attached to entity ${opts.entity}`));
        process.exit(1);
      }
      facetId = match.facet.id;
      roleLabel = opts.role;
    }

    const res = (await hubDelete(`/facets/${facetId}`, cfg)) as Record<string, unknown>;

    // Name the role when we know it; only the bare `detach <facetId>` form falls
    // back to the id prefix.
    const label = roleLabel
      ? `Detached role: ${chalk.bold(roleLabel)}`
      : `Detached role ${chalk.dim(facetId.slice(0, 8))}`;
    await reportWrite(res, {
      label,
      lane: "work",
      workspaceId: resolveActiveLens()?.workspaceId ?? cfg.workspaceId,
      cfg,
      json: opts.json,
    });
  } catch (e) {
    renderHubError(e);
    process.exit(1);
  }
}
