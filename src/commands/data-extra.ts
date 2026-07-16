import chalk from "chalk";
import { log } from "../utils/logger.js";
import { resolveHubConfig, resolveUserId, hubGet } from "../lib/hub-client.js";
import { unwrapList } from "../lib/unwrapList.js";
import { fetchFacets, renderRoles } from "./facet.js";
import { type BaseOpts, parseLimit } from "./data.js";

// ─── showEntity ───────────────────────────────────────────────────────────────
// Entity details + its relations in one shot.

export async function showEntity(
  id: string,
  opts: BaseOpts & { workspace?: string }
): Promise<void> {
  try {
    const cfg = await resolveHubConfig(opts);
    const userId = await resolveUserId(cfg);

    const [entityRes, relationsRes, facetsRes] = await Promise.allSettled([
      hubGet(`/entities/${id}`, { userId }, cfg),
      hubGet(`/entities/${id}/relations`, { userId, limit: 50 }, cfg),
      fetchFacets(id, cfg),
    ]);

    if (entityRes.status === "rejected") {
      console.error(chalk.red(`Entity not found: ${id}`));
      process.exit(1);
    }

    const entity = entityRes.value as Record<string, unknown>;
    const relData = relationsRes.status === "fulfilled"
      ? relationsRes.value as Record<string, unknown>
      : {};
    const relations = unwrapList<Record<string, unknown>>(relData, ["relations", "items"]);
    const facets = facetsRes.status === "fulfilled" ? facetsRes.value : [];

    if (opts.json) {
      console.log(JSON.stringify({ entity, relations, facets }, null, 2));
      return;
    }

    log.heading(String(entity.title ?? id));
    log.info(`Profile : ${String(entity.profileSlug ?? entity.profile ?? "")}`);
    log.info(`ID      : ${String(entity.id ?? id)}`);

    const props = entity.properties as Record<string, unknown> | undefined;
    if (props && Object.keys(props).length > 0) {
      log.blank();
      log.heading("Properties");
      for (const [k, v] of Object.entries(props)) {
        if (v !== null && v !== undefined && v !== "") {
          log.info(`${k}: ${String(v)}`);
        }
      }
    }

    // Roles — one identity, many roles. A role-profile (client, partner, …)
    // attached to this entity, never a second entity — omit the section
    // entirely when there are none rather than print an empty heading.
    if (facets.length > 0) {
      log.blank();
      renderRoles(facets);
    }

    if (relations.length > 0) {
      log.blank();
      log.heading(`Relations (${relations.length})`);
      for (const rel of relations) {
        const r = rel as Record<string, unknown>;
        const type = String(r.type ?? r.relationType ?? "related");
        const otherId = String(r.targetEntityId ?? r.sourceEntityId ?? r.entityId ?? "");
        const otherTitle = String(r.targetTitle ?? r.sourceTitle ?? r.title ?? otherId.slice(0, 8));
        const direction = r.targetEntityId === id ? "←" : "→";
        log.info(`${direction} ${chalk.cyan(type)}  ${otherTitle} ${chalk.dim(otherId.slice(0, 8))}`);
      }
    } else {
      log.blank();
      log.dim("No relations. Link with: synap create relation --source <id> --target <id> --type <type>");
    }
  } catch (e) {
    console.error(chalk.red("Error: " + (e as Error).message));
    process.exit(1);
  }
}

// ─── listProposals ────────────────────────────────────────────────────────────
// Pending proposals attributed to this agent — the governance inbox.

export async function listProposals(
  opts: BaseOpts & { workspace?: string; limit?: string }
): Promise<void> {
  try {
    const cfg = await resolveHubConfig(opts);
    const limit = parseLimit(opts.limit, 20);
    const workspaceId = opts.workspace ?? cfg.workspaceId;

    const res = await hubGet("/proposals", {
      status: "pending",
      ...(workspaceId ? { workspaceId } : {}),
      limit,
    }, cfg) as Record<string, unknown>;

    const proposals = unwrapList<Record<string, unknown>>(res, ["proposals", "items"]);

    if (opts.json) {
      console.log(JSON.stringify({ proposals }, null, 2));
      return;
    }

    if (proposals.length === 0) {
      log.success("No pending proposals.");
      return;
    }

    log.heading(`${proposals.length} pending proposal${proposals.length !== 1 ? "s" : ""}`);
    log.blank();
    for (const p of proposals) {
      const prop = p as Record<string, unknown>;
      const id = String(prop.id ?? "").slice(0, 8);
      const action = String(prop.action ?? prop.type ?? "write");
      const subject = String(prop.subjectType ?? prop.subject ?? "entity");
      // prefer human-readable summary; fall back to action description
      const entityTitle = String(prop.entityTitle ?? prop.title ?? "");
      const summary = String(prop.summary ?? prop.reasoning ?? prop.description ?? "");
      const label = entityTitle
        ? `${entityTitle} — ${subject}.${action}`
        : summary || `${subject}.${action}`;
      const reviewUrl = prop.reviewUrl ? String(prop.reviewUrl) : null;
      log.info(`${chalk.yellow("●")} ${label}  ${chalk.dim(id)}`);
      if (entityTitle && summary) log.dim(`  ${summary.slice(0, 100)}`);
      if (reviewUrl) log.dim(`  Review: ${reviewUrl}`);
    }
  } catch (e) {
    console.error(chalk.red("Error: " + (e as Error).message));
    process.exit(1);
  }
}

// ─── browseEntities ───────────────────────────────────────────────────────────
// Paginated entity list — cleaner than `list entities`, shows title + date.

export async function browseEntities(
  opts: BaseOpts & { workspace?: string; profile?: string; limit?: string; role?: string }
): Promise<void> {
  try {
    const cfg = await resolveHubConfig(opts);
    const userId = await resolveUserId(cfg);
    const limit = parseLimit(opts.limit, 20);
    const workspaceId = opts.workspace ?? cfg.workspaceId;
    // --role resolves facet scope from the workspaceId query param; without a
    // workspace the server can't apply the filter, and an empty result would
    // falsely read as "no entities carry this role". Fail clearly instead.
    if (opts.role && !workspaceId) {
      throw new Error(
        "--role needs an active workspace to resolve the role. Run 'synap use <workspace>' or pass --workspace <id>."
      );
    }

    const params: Record<string, string | number> = { userId, limit };
    if (workspaceId) params.workspaceId = workspaceId;
    if (opts.profile) params.profileSlug = opts.profile;
    // Browse-by-role: the list route resolves facet scope from the
    // `workspaceId` QUERY PARAM (already set above), not the X-Workspace-Id header.
    if (opts.role) params.facetSlug = opts.role;

    const res = await hubGet("/entities", params, cfg) as Record<string, unknown>;
    const entities = unwrapList<Record<string, unknown>>(res, ["entities", "items"]);
    const total = Number(res.total ?? entities.length);

    if (opts.json) {
      console.log(JSON.stringify({ total, entities }, null, 2));
      return;
    }

    if (entities.length === 0) {
      log.dim("Nothing here yet.");
      if (opts.profile) log.dim(`  Profile: ${opts.profile} — no entities of this type.`);
      if (opts.role) log.dim(`  Role: ${opts.role} — no entities carry this role in this workspace.`);
      return;
    }

    const scope = workspaceId ? chalk.dim(` [ws: ${workspaceId.slice(0, 8)}…]`) : chalk.dim(" [pod-wide]");
    const profileFilter = opts.profile ? chalk.dim(` profile: ${opts.profile}`) : "";
    const roleFilter = opts.role ? chalk.dim(` role: ${opts.role}`) : "";
    log.dim(`${total} total${scope}${profileFilter}${roleFilter} — showing ${entities.length}:`);
    log.blank();

    for (const e of entities) {
      const entity = e as Record<string, unknown>;
      const title = String(entity.title ?? entity.name ?? entity.id ?? "");
      const profile = String(entity.profileSlug ?? entity.profile ?? "");
      const id = String(entity.id ?? "").slice(0, 8);
      const updatedAt = entity.updatedAt ?? entity.createdAt;
      const dateStr = updatedAt
        ? chalk.dim(new Date(String(updatedAt)).toLocaleDateString())
        : "";
      log.info(`${title}  ${chalk.dim(`(${profile})`)}  ${chalk.dim(id)}  ${dateStr}`);
    }

    if (total > entities.length) {
      log.blank();
      log.dim(`Showing ${entities.length} of ${total}. Add --limit ${limit * 2} to see more.`);
    }
  } catch (e) {
    console.error(chalk.red("Error: " + (e as Error).message));
    process.exit(1);
  }
}
