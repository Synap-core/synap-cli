import chalk from "chalk";
import { log } from "../utils/logger.js";
import { resolveHubConfig, resolveUserId, hubGet, hubPost, hubPatch } from "../lib/hub-client.js";
import { reportWrite } from "../lib/capture-lane.js";

export interface BaseOpts {
  json?: boolean;
  podUrl?: string;
  apiKey?: string;
}

export const parseLimit = (s: string | undefined, def: number): number =>
  s ? parseInt(s, 10) : def;

export function formatHit(hit: Record<string, unknown>): { title: string; type: string; id: string } {
  const doc = (hit.document ?? hit) as Record<string, unknown>;
  return {
    title: String(doc.title ?? doc.id ?? hit.id ?? ""),
    // `type` is the entity's profile (entities carry `type`; search hits carry
    // `entityType`/`collection`). Include `doc.type` or the badge renders blank.
    type: String(
      doc.entityType ?? doc.profileSlug ?? doc.type ?? hit.collection ?? ""
    ),
    id: String(doc.id ?? hit.id ?? "").slice(0, 8),
  };
}

// ─── orient ───────────────────────────────────────────────────────────────────

export async function orient(opts: BaseOpts): Promise<void> {
  try {
    const cfg = await resolveHubConfig(opts);
    const [workspacesRes, meRes] = await Promise.all([
      hubGet("/workspaces", {}, cfg),
      hubGet("/users/me", {}, cfg),
    ]);
    const workspaces = (workspacesRes as { workspaces?: unknown[] }).workspaces ?? (workspacesRes as unknown[]);
    const me = meRes as Record<string, unknown>;
    const userId = String(me.id ?? cfg.userId);
    const wsList = Array.isArray(workspaces) ? workspaces as Record<string, unknown>[] : [];

    // For each workspace, fetch profiles + entity count in parallel.
    // Newer pods return `entityCount` directly on GET /workspaces; for older
    // pods fall back to counting a real page of entities (GET /entities
    // returns a bare array — there is no `total` field on the wire).
    const FALLBACK_PAGE = 100;
    const wsDetails = await Promise.all(
      wsList.map(async (ws) => {
        const wsId = String(ws.id ?? "");
        const declaredCount =
          typeof ws.entityCount === "number" ? ws.entityCount : undefined;
        const [profilesRes, entitiesRes] = await Promise.allSettled([
          hubGet("/profiles", { userId, workspaceId: wsId }, cfg),
          declaredCount === undefined
            ? hubGet("/entities", { userId, workspaceId: wsId, limit: FALLBACK_PAGE }, cfg)
            : Promise.resolve(null),
        ]);
        const profiles = profilesRes.status === "fulfilled"
          ? ((profilesRes.value as { profiles?: unknown[] }).profiles ?? (profilesRes.value as unknown[]))
          : [];
        const profileList = Array.isArray(profiles) ? profiles as Record<string, unknown>[] : [];
        let entityTotal = declaredCount ?? 0;
        let countIsLowerBound = false;
        if (declaredCount === undefined && entitiesRes.status === "fulfilled" && entitiesRes.value) {
          const v = entitiesRes.value as Record<string, unknown> | unknown[];
          const arr = Array.isArray(v) ? v : ((v as Record<string, unknown>).entities as unknown[] ?? []);
          entityTotal = Array.isArray(arr) ? arr.length : 0;
          countIsLowerBound = entityTotal === FALLBACK_PAGE;
        }
        return { ws, profileList, entityTotal, countIsLowerBound };
      })
    );

    if (opts.json) {
      const capabilities = [
        "synap graph --entity <id> --depth 2",
        "synap events --entity <id>",
        "synap subscribe --event entity.*",
        "synap context",
        "synap automation list",
        "synap list views --type whiteboard",
        "synap view create --type kanban --profile task",
        "synap proposals list",
        "synap explain",
      ];
      console.log(JSON.stringify({ userId, podUrl: cfg.podUrl, workspaceId: cfg.workspaceId, workspaces: wsDetails, me, capabilities }, null, 2));
      return;
    }

    log.heading("Pod Orientation");
    log.info(`User     : ${String(me.email ?? me.name ?? userId)}`);
    log.info(`Pod URL  : ${cfg.podUrl}`);
    if (cfg.workspaceId) log.info(`Workspace: ${cfg.workspaceId} ${chalk.dim("(active — use 'synap use <id>' to change)")}`);
    log.blank();
    log.heading("Workspaces");
    if (wsDetails.length === 0) {
      log.dim("No workspaces found.");
    } else {
      for (const { ws, profileList, entityTotal, countIsLowerBound } of wsDetails) {
        const isActive = ws.id === cfg.workspaceId;
        const marker = isActive ? chalk.green("▶ ") : "  ";
        const name = chalk.bold(String(ws.name ?? ws.id));
        const id = chalk.dim(String(ws.id ?? "").slice(0, 8) + "…");
        const count = entityTotal > 0
          ? chalk.dim(`${entityTotal}${countIsLowerBound ? "+" : ""} entities`)
          : chalk.dim("empty");
        log.info(`${marker}${name}  ${id}  ${count}`);
        if (ws.description) log.dim(`     ${String(ws.description)}`);
        if (profileList.length > 0) {
          const slugs = profileList
            .map((p) => String(p.slug ?? p.name ?? ""))
            .filter(Boolean)
            .slice(0, 8)
            .join(chalk.dim(", "));
          log.dim(`     profiles: ${slugs}${profileList.length > 8 ? chalk.dim(" …") : ""}`);
        }
      }
      if (!cfg.workspaceId) {
        log.blank();
        log.dim("Tip: run 'synap use <workspaceId>' to set a default workspace.");
      }
    }

    // ── Capabilities block ─────────────────────────────────────────────────
    log.blank();
    log.heading("Capabilities");
    console.log(`  ${chalk.cyan("Graph traversal")}   synap graph --entity <id> --depth 2`);
    console.log(`  ${chalk.cyan("Event chain")}       synap events --entity <id>`);
    console.log(`  ${chalk.cyan("Subscribe")}         synap subscribe --event entity.*`);
    console.log(`  ${chalk.cyan("Session context")}   synap context`);
    console.log(`  ${chalk.cyan("Automations")}       synap automation list`);
    console.log(`  ${chalk.cyan("Views")}             synap list views --type whiteboard · synap view create --type kanban --profile task`);
    console.log(`  ${chalk.cyan("Governance")}        synap proposals list`);
    log.blank();
    log.dim("For full capability map: synap explain");
  } catch (e) {
    console.error(chalk.red("Error: " + (e as Error).message));
    process.exit(1);
  }
}

// ─── useWorkspace ─────────────────────────────────────────────────────────────

export async function useWorkspace(
  workspaceId: string,
  opts: BaseOpts
): Promise<void> {
  try {
    const cfg = await resolveHubConfig(opts);
    const userId = await resolveUserId(cfg);
    // Verify the workspace exists and is accessible
    const res = await hubGet("/workspaces", {}, cfg);
    const workspaces = (res as { workspaces?: unknown[] }).workspaces ?? (res as unknown[]);
    const list = Array.isArray(workspaces) ? workspaces as Record<string, unknown>[] : [];
    const match = list.find((w) => w.id === workspaceId || String(w.name).toLowerCase() === workspaceId.toLowerCase());

    if (!match) {
      const names = list.map((w) => `${String(w.name ?? w.id)}`).join(", ");
      console.error(chalk.red(`Workspace '${workspaceId}' not found.`));
      if (names) log.dim(`Available: ${names}`);
      process.exit(1);
    }

    const { setActiveWorkspaceId } = await import("../lib/pod.js");
    setActiveWorkspaceId(String(match.id));

    if (opts.json) {
      console.log(JSON.stringify({ workspaceId: match.id, name: match.name }, null, 2));
      return;
    }
    log.success(`Now in workspace: ${chalk.bold(String(match.name ?? match.id))} ${chalk.dim(String(match.id ?? ""))}`);
  } catch (e) {
    console.error(chalk.red("Error: " + (e as Error).message));
    process.exit(1);
  }
}

// ─── listWorkspaces ───────────────────────────────────────────────────────────

export async function listWorkspaces(opts: BaseOpts): Promise<void> {
  try {
    const cfg = await resolveHubConfig(opts);
    const res = await hubGet("/workspaces", {}, cfg);
    const workspaces = (res as { workspaces?: unknown[] }).workspaces ?? (res as unknown[]);
    const list = Array.isArray(workspaces) ? workspaces : [];

    if (opts.json) {
      console.log(JSON.stringify({ workspaces: list }, null, 2));
      return;
    }

    if (list.length === 0) {
      log.dim("No workspaces found.");
      return;
    }
    for (const ws of list) {
      const w = ws as Record<string, unknown>;
      log.info(`${String(w.name ?? w.id)}  ${chalk.dim(String(w.id ?? ""))}`);
    }
  } catch (e) {
    console.error(chalk.red("Error: " + (e as Error).message));
    process.exit(1);
  }
}

// ─── listEntities ─────────────────────────────────────────────────────────────

export async function listEntities(
  opts: BaseOpts & { workspace?: string; profile?: string; limit?: string }
): Promise<void> {
  try {
    const cfg = await resolveHubConfig(opts);
    const userId = await resolveUserId(cfg);
    const limit = parseLimit(opts.limit, 20);
    const res = await hubGet("/entities", {
      userId,
      workspaceId: opts.workspace ?? cfg.workspaceId,
      profileSlug: opts.profile,
      limit,
    }, cfg);
    const entities = (res as { entities?: unknown[] }).entities ?? (res as unknown[]);
    const list = Array.isArray(entities) ? entities : [];

    if (opts.json) {
      console.log(JSON.stringify({ entities: list, count: list.length, limit, truncated: list.length === limit }, null, 2));
      return;
    }

    if (list.length === 0) {
      log.dim("No entities found.");
      // Whiteboards, kanbans, calendars… are VIEWS, not entity profiles.
      // If the requested profile is actually a view type, point there.
      if (opts.profile) {
        try {
          const viewsRes = await hubGet("/views", {
            userId,
            workspaceId: opts.workspace ?? cfg.workspaceId,
            type: opts.profile,
          }, cfg);
          const views = ((viewsRes as Record<string, unknown>).views as unknown[])
            ?? (Array.isArray(viewsRes) ? viewsRes as unknown[] : []);
          if (views.length > 0) {
            log.blank();
            log.info(`'${opts.profile}' is a ${chalk.bold("view type")}, not an entity profile — found ${views.length} view${views.length !== 1 ? "s" : ""}.`);
            log.dim(`  Run: synap list views --type ${opts.profile}`);
            return;
          }
        } catch {
          // best-effort hint only — never fail the empty-result path
        }
        log.dim(`  Profiles in this workspace: synap list profiles`);
        log.dim(`  Views (whiteboard, kanban, …): synap list views`);
      }
      return;
    }
    for (const entity of list) {
      const e = entity as Record<string, unknown>;
      const name = String(e.title ?? e.id ?? "");
      const profile = e.profileSlug ?? e.profile ?? e.type ?? "";
      const id = String(e.id ?? "").slice(0, 8);
      log.info(`${name} ${chalk.dim(`(${profile})`)} — ${chalk.dim(id)}`);
    }
    if (list.length === limit) {
      log.dim(`${list.length} shown (hit --limit ${limit}; more may exist — raise --limit or filter with --profile)`);
    }
  } catch (e) {
    console.error(chalk.red("Error: " + (e as Error).message));
    process.exit(1);
  }
}

// ─── getEntity ────────────────────────────────────────────────────────────────

export async function getEntity(
  id: string,
  opts: BaseOpts & { workspace?: string }
): Promise<void> {
  try {
    const cfg = await resolveHubConfig(opts);
    const userId = await resolveUserId(cfg);
    const res = await hubGet(`/entities/${id}`, { userId }, cfg);
    const entity = res as Record<string, unknown>;

    if (opts.json) {
      console.log(JSON.stringify(entity, null, 2));
      return;
    }

    log.heading(String(entity.title ?? id));
    log.info(`Profile : ${String(entity.profileSlug ?? entity.profile ?? entity.type ?? "")}`);
    log.info(`ID      : ${String(entity.id ?? id)}`);
    const props = entity.properties as Record<string, unknown> | undefined;
    if (props && Object.keys(props).length > 0) {
      log.blank();
      log.heading("Properties");
      for (const [k, v] of Object.entries(props)) {
        log.info(`${k}: ${String(v)}`);
      }
    }
  } catch (e) {
    console.error(chalk.red("Error: " + (e as Error).message));
    process.exit(1);
  }
}

// ─── noteData ─────────────────────────────────────────────────────────────────

export async function noteData(
  text: string,
  opts: BaseOpts & { context?: string; json?: boolean }
): Promise<void> {
  try {
    const cfg = await resolveHubConfig(opts);
    const userId = await resolveUserId(cfg);

    // A `note` is the human raw-inbox primitive ("dump now, structure later") —
    // it lands in the active workspace, NOT a private agent-memory ws (that lane
    // was removed). The AI should never write a note: structuring is its job, so
    // it uses `synap capture` (structured) instead.
    const workspaceId = cfg.workspaceId;
    if (!workspaceId) {
      console.error(chalk.red("No workspace set. Run: synap use <workspace-id>"));
      process.exit(1);
    }

    const res = await hubPost("/entities", {
      userId,
      profileSlug: "note",
      title: text.slice(0, 200),
      workspaceId,
      // The `note` profile requires a `content` property — carry the full text
      // (title is truncated). Without this the hub rejects the write (HTTP 500).
      properties: {
        content: text,
        ...(opts.context ? { sourceEntityId: opts.context } : {}),
      },
    }, cfg) as Record<string, unknown>;

    await reportWrite(res, {
      label: `Note saved: "${text.slice(0, 80)}"`,
      lane: "work",
      workspaceId,
      cfg,
      json: opts.json,
    });
  } catch (e) {
    console.error(chalk.red("Error: " + (e as Error).message));
    process.exit(1);
  }
}

// ─── ask (unified knowledge access) ────────────────────────────────────────────
// The ONE read door. Routes a natural-language query to the right substrate(s)
// — semantic (entities), procedural (how-to docs), episodic (captures) — and
// prints a glass-box answer that shows WHICH substrate(s) answered.

interface AskAnswer {
  substrate: string;
  items: Record<string, unknown>[];
  status?: "ok" | "error";
}
interface AskResponse {
  query: string;
  routedTo: string[];
  intent?: string;
  primary: string;
  answers: AskAnswer[];
  degraded?: string[];
  verdict?: string;
}

/** Render one item according to its substrate. */
function formatAskItem(substrate: string, item: Record<string, unknown>): string {
  if (substrate === "procedural") {
    // knowledge_keys rows: addressed by `key`, body in `value`.
    const key = (item.key ?? item.slug ?? item.namespace) as string | undefined;
    const value = (item.value ?? "") as string;
    const snippet = value
      ? " — " + (value.length > 80 ? value.slice(0, 77) + "…" : value).replace(/\s+/g, " ")
      : "";
    return `${key ?? "(untitled)"}${chalk.dim(snippet)}`;
  }
  if (substrate === "episodic") {
    // knowledge_facts rows: text is in `fact` (content/text are wire fallbacks).
    const content = (item.fact ?? item.content ?? item.text ?? "") as string;
    return content.length > 120 ? content.slice(0, 117) + "…" : content || "(empty)";
  }
  // semantic — an entity. Surface a body snippet (not just a pointer): the
  // entity carries its content in `preview` or a description-ish property, so a
  // "how do I…" answer shows the gist inline instead of only an entity title.
  const { title, type, id } = formatHit(item);
  const props = (item.properties ?? {}) as Record<string, unknown>;
  const desc = String(
    item.preview ??
      props.description ??
      props.recipeDescription ??
      props.summary ??
      props.body ??
      props.content ??
      ""
  );
  const snippet = desc
    ? chalk.dim(
        " — " +
          (desc.length > 90 ? desc.slice(0, 87) + "…" : desc).replace(/\s+/g, " ")
      )
    : "";
  return `${title} ${chalk.dim(`[${type}]`)} ${chalk.dim(id)}${snippet}`;
}

export async function askKnowledge(
  query: string,
  opts: BaseOpts & { workspace?: string; limit?: string; json?: boolean }
): Promise<void> {
  try {
    const cfg = await resolveHubConfig(opts);
    const limit = parseLimit(opts.limit, 10);
    const workspaceId = opts.workspace ?? cfg.workspaceId;

    const res = (await hubPost(
      "/knowledge/ask",
      { query, ...(workspaceId ? { workspaceId } : {}), limit },
      cfg
    )) as AskResponse;

    if (opts.json) {
      console.log(JSON.stringify(res, null, 2));
      return;
    }

    const routed = (res.routedTo ?? []).join(", ");
    const verdict = res.verdict ? chalk.dim(` · ${res.verdict}`) : "";
    // Honest routing: if the query's cue suggested one substrate but another
    // actually answered (e.g. "how to…" cued procedural but the runbook is an
    // entity), say so instead of dangling a "primary" that returned nothing.
    const routeNote =
      res.intent && res.intent !== res.primary
        ? `${chalk.bold(routed)} · asked-for ${res.intent}, answered by ${chalk.bold(res.primary)}`
        : `${chalk.bold(routed)} (primary: ${chalk.bold(res.primary)})`;
    log.dim(`"${query}" → routed to ${routeNote}${verdict}`);
    log.blank();

    const answers = res.answers ?? [];
    const total = answers.reduce((n, a) => n + (a.items?.length ?? 0), 0);
    const anyErrored = (res.degraded?.length ?? 0) > 0;
    // Only claim a clean "no results" when every store actually answered. If one
    // errored, fall through to the per-substrate loop so the outage is shown.
    if (total === 0 && !anyErrored) {
      log.dim(`No results across ${routed || "any substrate"}.`);
      log.dim(`  Try broader terms, or capture knowledge with: synap capture`);
      return;
    }

    for (const answer of answers) {
      const items = answer.items ?? [];
      // Glass-box: an errored store is NOT "found nothing" — say so, never hide it.
      if (answer.status === "error") {
        log.info(
          chalk.bold(answer.substrate.toUpperCase()) +
            chalk.yellow(" — store unavailable (not searched)")
        );
        log.blank();
        continue;
      }
      if (items.length === 0) continue;
      log.info(chalk.bold(answer.substrate.toUpperCase()) + chalk.dim(` (${items.length})`));
      for (const item of items) {
        log.info("  " + formatAskItem(answer.substrate, item));
      }
      log.blank();
    }
  } catch (e) {
    console.error(chalk.red("Error: " + (e as Error).message));
    process.exit(1);
  }
}

// ─── graph-impact feedback (impact-aware writes) ───────────────────────────────
// The backend now returns ADDITIVE `resolution` (on create) / `impact` (on
// update) blocks so external agents get the same graph-impact feedback the IS
// agent already gets. SHALLOW (exact-name only) and graceful when absent.

interface ResolutionRef {
  id?: string;
  name?: string;
  profileSlug?: string;
  relation?: string;
}
interface ResolutionBlock {
  existingSameProfile?: ResolutionRef;
  autoConnected?: ResolutionRef[];
  suggestions?: ResolutionRef[];
}

const refLabel = (r: ResolutionRef): string =>
  `${String(r.name ?? r.id ?? "?")}${r.profileSlug ? ` [${r.profileSlug}]` : ""}`;

/** Print 1-3 dim graph-impact lines for a create response. No-op if absent. */
function reportResolution(res: Record<string, unknown>): void {
  const resolution = res.resolution as ResolutionBlock | undefined;
  if (!resolution) return;

  const existing = resolution.existingSameProfile;
  if (existing) {
    log.dim(
      `⚠ an entity named "${String(existing.name ?? "?")}" already exists as profile ${String(existing.profileSlug ?? "?")} (${String(existing.id ?? "?").slice(0, 8)}) — consider updating it instead of duplicating`
    );
  }

  const autoConnected = resolution.autoConnected ?? [];
  if (autoConnected.length > 0) {
    const names = autoConnected.map(refLabel).join(", ");
    log.dim(`→ auto-linked to ${autoConnected.length} existing same-name entit${autoConnected.length === 1 ? "y" : "ies"}: ${names}`);
  }

  // suggestions beyond what was already auto-connected
  const autoIds = new Set(autoConnected.map((r) => r.id).filter(Boolean));
  const suggestions = (resolution.suggestions ?? []).filter((s) => !autoIds.has(s.id));
  if (suggestions.length > 0) {
    log.dim(`· you may want to link: ${suggestions.map(refLabel).join(", ")}`);
  }
}

// ─── createEntity ─────────────────────────────────────────────────────────────

export async function createEntity(
  opts: BaseOpts & { profile: string; name: string; workspace?: string; props?: string }
): Promise<void> {
  try {
    const cfg = await resolveHubConfig(opts);
    const userId = await resolveUserId(cfg);
    const properties = JSON.parse(opts.props ?? "{}") as Record<string, unknown>;
    const res = await hubPost("/entities", {
      userId,
      profileSlug: opts.profile,
      title: opts.name,
      workspaceId: opts.workspace,
      properties,
    }, cfg);

    const entity = res as Record<string, unknown>;

    await reportWrite(entity, {
      label: `Created: ${opts.name}`,
      lane: "work",
      workspaceId: opts.workspace ?? cfg.workspaceId,
      cfg,
      json: opts.json,
    });

    // Graph-impact feedback — human output only (the `--json` path already
    // passed the raw response, including `resolution`, through reportWrite).
    if (!opts.json) reportResolution(entity);
  } catch (e) {
    console.error(chalk.red("Error: " + (e as Error).message));
    process.exit(1);
  }
}

// ─── listProfiles ─────────────────────────────────────────────────────────────

export async function listProfiles(
  opts: BaseOpts & { workspace?: string; json?: boolean }
): Promise<void> {
  try {
    const cfg = await resolveHubConfig(opts);
    const userId = await resolveUserId(cfg);
    const workspaceId = opts.workspace ?? cfg.workspaceId;
    if (!workspaceId) {
      console.error(chalk.red("No workspace set. Run: synap use <workspace-id>"));
      process.exit(1);
    }
    const res = await hubGet("/profiles", { userId, workspaceId }, cfg);
    const profiles = ((res as Record<string, unknown>).profiles as unknown[] ?? (Array.isArray(res) ? res : [])) as Record<string, unknown>[];

    if (opts.json) {
      console.log(JSON.stringify(profiles, null, 2));
      return;
    }

    if (!profiles.length) {
      log.dim("No profiles found in this workspace.");
      return;
    }

    log.heading(`Profiles in workspace ${workspaceId}`);
    for (const p of profiles) {
      const scope = String(p.entityScope ?? "workspace");
      const desc = p.description ? chalk.dim(` — ${String(p.description).slice(0, 60)}`) : "";
      log.info(`${chalk.bold(String(p.slug ?? ""))}  ${chalk.dim(scope)}${desc}`);
    }
  } catch (e) {
    console.error(chalk.red("Error: " + (e as Error).message));
    process.exit(1);
  }
}

// ─── createRelation ───────────────────────────────────────────────────────────

export async function createRelation(
  opts: BaseOpts & { source: string; target: string; type: string; workspace?: string }
): Promise<void> {
  try {
    const cfg = await resolveHubConfig(opts);
    const userId = await resolveUserId(cfg);
    const res = await hubPost("/relations", {
      userId,
      workspaceId: opts.workspace,
      sourceEntityId: opts.source,
      targetEntityId: opts.target,
      type: opts.type,
    }, cfg);

    const relation = res as Record<string, unknown>;

    await reportWrite(relation, {
      label: `Relation: ${opts.type} (${opts.source} → ${opts.target})`,
      lane: "work",
      workspaceId: opts.workspace ?? cfg.workspaceId,
      cfg,
      json: opts.json,
    });
  } catch (e) {
    console.error(chalk.red("Error: " + (e as Error).message));
    process.exit(1);
  }
}

// ─── updateEntity ─────────────────────────────────────────────────────────────

export async function updateEntity(
  id: string,
  opts: BaseOpts & { props: string; workspace?: string }
): Promise<void> {
  try {
    const cfg = await resolveHubConfig(opts);
    const workspaceId = opts.workspace ?? cfg.workspaceId;
    // parse props as unknown then cast — user-supplied JSON
    const metadata = JSON.parse(opts.props) as Record<string, unknown>;
    const body: Record<string, unknown> = { userId: cfg.userId, metadata };
    // backend reads body.workspaceId to scope automation matching — without it
    // the update lands pod-wide and workspace-gated automations never fire
    if (workspaceId) body.workspaceId = workspaceId;
    const res = await hubPatch(`/entities/${id}`, body, cfg);

    const entity = res as Record<string, unknown>;

    if (opts.json) {
      console.log(JSON.stringify(entity, null, 2));
      return;
    }

    log.success(`Updated: ${id}`);

    // Graph-impact feedback — shallow immediate neighbors the edit may touch.
    // Additive + graceful: absent on older backends, so output is unchanged.
    const impact = entity.impact as ResolutionRef[] | undefined;
    if (Array.isArray(impact) && impact.length > 0) {
      log.dim(`→ ${impact.length} connected entit${impact.length === 1 ? "y" : "ies"} may be affected: ${impact.map(refLabel).join(", ")}`);
    }
  } catch (e) {
    console.error(chalk.red("Error: " + (e as Error).message));
    process.exit(1);
  }
}
