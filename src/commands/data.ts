import chalk from "chalk";
import { log } from "../utils/logger.js";
import { resolveHubConfig, resolveUserId, hubGet, hubPost, hubPatch, readActiveSessionId, renderHubError } from "../lib/hub-client.js";
import { unwrapList } from "../lib/unwrapList.js";
import { reportWrite } from "../lib/capture-lane.js";
import { renderNextSteps, FLOW } from "../lib/next-steps.js";
import { requireFullId } from "../lib/id.js";

export interface BaseOpts {
  json?: boolean;
  podUrl?: string;
  apiKey?: string;
  details?: boolean;
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
    // Full id, never truncated: this is the handle callers feed straight back
    // into `synap get entity <id>` — an 8-char prefix isn't a valid UUID and
    // 500s on the pod (see `renderHubError`'s uuid-shape hint).
    id: String(doc.id ?? hit.id ?? ""),
  };
}

// ─── orient ───────────────────────────────────────────────────────────────────

interface OrientWorkspace {
  id: string;
  name: string;
  domain: string | null;
  entityCount: number;
  onboarding?: { goal?: string };
  description?: string | null;
  profiles?: Array<{ slug: string; name: string }>;
}
interface OrientProject {
  id: string;
  name: string;
  status: string | null;
  homeWorkspace: string | null;
}
interface OrientResult {
  me?: { userId: string; scopes: string[] };
  detail: "light" | "full";
  projects: OrientProject[];
  workspaces: OrientWorkspace[];
  profiles: Array<{ slug: string; name: string }>;
  note: string;
}

export async function orient(opts: BaseOpts): Promise<void> {
  try {
    const cfg = await resolveHubConfig(opts);
    // ONE canonical shape: the backend `discover()` service (via GET /orient)
    // assembles the lens map — workspaces + projects + profile sample +
    // disclosure (onboarding→goal, entity counts, per-ws profiles under full).
    // The CLI only RENDERS it; `--details` maps to detail:'full'. No client-side
    // assembly, no N+1 fanout — the server does the shaping.
    const res = (await hubGet(
      "/orient",
      opts.details ? { detail: "full" } : {},
      cfg
    )) as OrientResult;
    const userId = String(res.me?.userId ?? cfg.userId);
    const projList = res.projects ?? [];
    const wsList = res.workspaces ?? [];

    if (opts.json) {
      console.log(
        JSON.stringify(
          { ...res, podUrl: cfg.podUrl, workspaceId: cfg.workspaceId, nextSteps: FLOW.afterOrient() },
          null,
          2
        )
      );
      return;
    }

    // Render content rows with console.log (default terminal fg) rather than
    // log.info — log.info wraps every line in chalk.blue, and that blue fg
    // persists through inner bold/dim (they reset weight, not color), flattening
    // the hierarchy. We keep only targeted accents: bold=name, dim=metadata,
    // green ▶ = active.
    log.heading("Pod Orientation");
    console.log(`  User     : ${userId}`);
    console.log(`  Pod URL  : ${cfg.podUrl}`);
    // The per-Claude-session lens (project + workspace + session) — "where am I".
    // Full ids so they can be pasted into 'synap project use' / 'synap use'.
    const { getClaudeSessionId, resolveActiveLens } = await import("../lib/session-lens.js");
    let activeProjectId: string | undefined;
    if (getClaudeSessionId()) {
      const lens = resolveActiveLens();
      activeProjectId = lens?.projectId ?? undefined;
      const proj = lens?.projectId ?? chalk.dim("none");
      const ws = lens?.workspaceId ?? cfg.workspaceId ?? chalk.dim("pod-wide");
      const sess = lens?.focusSessionId ?? chalk.dim("none");
      console.log(`  Lens     : ${chalk.dim("project")} ${proj} · ${chalk.dim("ws")} ${ws} · ${chalk.dim("session")} ${sess}`);
    } else if (cfg.workspaceId) {
      console.log(`  Workspace: ${cfg.workspaceId} ${chalk.dim("(active — use 'synap use <id>' to change)")}`);
    }

    // ── Projects (companies / initiatives) — the primary lens ───────────────
    log.blank();
    log.heading("Projects");
    if (projList.length === 0) {
      log.dim("No projects yet — a project is a company/initiative that ties workspaces together.");
    } else {
      for (const p of projList) {
        const isActive = p.id === activeProjectId;
        const marker = isActive ? chalk.green("▶ ") : "  ";
        const name = chalk.bold(String(p.name ?? p.id));
        const id = chalk.dim(String(p.id ?? ""));
        const status = p.status ? chalk.dim(String(p.status)) : "";
        const homePart = p.homeWorkspace ? chalk.dim(`· ${p.homeWorkspace}`) : "";
        console.log(`  ${marker}${name}  ${id}  ${status}${homePart ? "  " + homePart : ""}`);
      }
    }

    // ── Workspaces (operational domains) ────────────────────────────────────
    log.blank();
    log.heading("Workspaces");
    if (wsList.length === 0) {
      log.dim("No workspaces found.");
    } else if (opts.details) {
      for (const ws of wsList) {
        const isActive = ws.id === cfg.workspaceId;
        const marker = isActive ? chalk.green("▶ ") : "  ";
        const name = chalk.bold(String(ws.name ?? ws.id));
        const id = chalk.dim(String(ws.id ?? ""));
        const count = ws.entityCount > 0
          ? chalk.dim(`${ws.entityCount} entities`)
          : chalk.dim("empty");
        console.log(`  ${marker}${name}  ${id}  ${count}`);
        if (ws.description) log.dim(`     ${String(ws.description)}`);
        if (ws.onboarding?.goal && ws.entityCount === 0) {
          log.dim(`     ${chalk.cyan("→ onboard:")} ${String(ws.onboarding.goal)}`);
        }
        const profiles = ws.profiles ?? [];
        if (profiles.length > 0) {
          const slugs = profiles
            .map((p) => p.slug)
            .filter(Boolean)
            .slice(0, 8)
            .join(chalk.dim(", "));
          log.dim(`     profiles: ${slugs}${profiles.length > 8 ? chalk.dim(" …") : ""}`);
        }
      }
    } else {
      // Light: name + id + domain (operational-domain label = workspaceSubtype
      // falling back to workspaceType, resolved server-side).
      for (const ws of wsList) {
        const isActive = ws.id === cfg.workspaceId;
        const marker = isActive ? chalk.green("▶ ") : "  ";
        const name = chalk.bold(String(ws.name ?? ws.id));
        const id = chalk.dim(String(ws.id ?? ""));
        const domain = ws.domain ? chalk.dim(String(ws.domain)) : "";
        console.log(`  ${marker}${name}  ${id}  ${domain}`);
      }
      log.blank();
      log.dim("Workspaces are operational domains; run 'synap orient --details' for profiles + entity counts.");
    }

    log.blank();
    log.dim("Lenses compose — a project spans workspaces; a workspace spans projects. Omit them to stay pod-wide.");
    renderNextSteps(FLOW.afterOrient());
  } catch (e) {
    renderHubError(e);
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
    const list = unwrapList<Record<string, unknown>>(res, ["workspaces"]);
    const match = list.find((w) => w.id === workspaceId || String(w.name).toLowerCase() === workspaceId.toLowerCase());

    if (!match) {
      const names = list.map((w) => `${String(w.name ?? w.id)}`).join(", ");
      console.error(chalk.red(`Workspace '${workspaceId}' not found.`));
      if (names) log.dim(`Available: ${names}`);
      process.exit(1);
    }

    // In a Claude Code session, scope to THIS session's lens (so concurrent
    // sessions can be on different workspaces). Otherwise set the global default.
    const { getClaudeSessionId, writeLens } = await import("../lib/session-lens.js");
    const claudeSession = getClaudeSessionId();
    if (claudeSession) {
      writeLens(claudeSession, { workspaceId: String(match.id) });
    } else {
      const { setActiveWorkspaceId } = await import("../lib/pod.js");
      setActiveWorkspaceId(String(match.id));
    }

    if (opts.json) {
      console.log(JSON.stringify({ workspaceId: match.id, name: match.name, scope: claudeSession ? "session" : "global" }, null, 2));
      return;
    }
    const scopeNote = claudeSession ? chalk.dim(" (this session)") : "";
    log.success(`Now in workspace: ${chalk.bold(String(match.name ?? match.id))} ${chalk.dim(String(match.id ?? ""))}${scopeNote}`);
  } catch (e) {
    renderHubError(e);
    process.exit(1);
  }
}

// ─── listWorkspaces ───────────────────────────────────────────────────────────

export async function listWorkspaces(opts: BaseOpts): Promise<void> {
  try {
    const cfg = await resolveHubConfig(opts);
    const res = await hubGet("/workspaces", {}, cfg);
    const list = unwrapList<Record<string, unknown>>(res, ["workspaces"]);

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
    renderHubError(e);
    process.exit(1);
  }
}

// ─── listEntities ─────────────────────────────────────────────────────────────

export async function listEntities(
  opts: BaseOpts & { workspace?: string; profile?: string; limit?: string; role?: string }
): Promise<void> {
  try {
    const cfg = await resolveHubConfig(opts);
    const userId = await resolveUserId(cfg);
    const limit = parseLimit(opts.limit, 20);
    const workspaceId = opts.workspace ?? cfg.workspaceId;
    // --role needs a workspace to resolve facet scope (see browseEntities);
    // without one the filter is silently dropped and "no entities" would lie.
    if (opts.role && !workspaceId) {
      throw new Error(
        "--role needs an active workspace to resolve the role. Run 'synap use <workspace>' or pass --workspace <id>."
      );
    }
    const res = await hubGet("/entities", {
      userId,
      workspaceId,
      profileSlug: opts.profile,
      // Browse-by-role: the list route resolves facet scope from the
      // `workspaceId` QUERY PARAM (already threaded above), not the
      // X-Workspace-Id header — verified against the live pod.
      facetSlug: opts.role,
      limit,
    }, cfg);
    const list = unwrapList<Record<string, unknown>>(res, ["entities"]);

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
          const views = unwrapList(viewsRes, ["views"]);
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
      // Full id — this is the handle `synap get entity <id>` expects next.
      const id = String(e.id ?? "");
      log.info(`${name} ${chalk.dim(`(${profile})`)} — ${chalk.dim(id)}`);
    }
    if (list.length === limit) {
      log.dim(`${list.length} shown (hit --limit ${limit}; more may exist — raise --limit or filter with --profile)`);
    }
  } catch (e) {
    renderHubError(e);
    process.exit(1);
  }
}

// ─── getEntity ────────────────────────────────────────────────────────────────

export async function getEntity(
  id: string,
  opts: BaseOpts & { workspace?: string }
): Promise<void> {
  // `synap ask`/`synap list entities` now print full UUIDs, so an 8-char
  // value here is almost always a leftover short id from before this fix.
  requireFullId(id, "entity", chalk, log);
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
    renderHubError(e);
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
interface RankedItem {
  id: string;
  title: string;
  score: number;
  rank: number;
}
interface MovedItem {
  id: string;
  title: string;
  baselineRank: number;
  horizonRank: number;
}
interface RankComparison {
  baseline: RankedItem[];
  horizon: RankedItem[];
  diff: { overlapAtN: number; moved: MovedItem[] };
}
interface AskResponse {
  query: string;
  routedTo: string[];
  intent?: string;
  primary: string;
  answers: AskAnswer[];
  degraded?: string[];
  verdict?: string;
  /** Present only when `--compare` was requested. */
  comparison?: RankComparison;
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
  // Full id trails at the end (never truncated — it's what `synap get entity`
  // expects next) so it doesn't push the snippet off-screen on a narrow terminal.
  return `${title} ${chalk.dim(`[${type}]`)}${snippet} ${chalk.dim(id)}`;
}

/**
 * Render the A/B ranker diagnostic: baseline vs Horizon top-N side-by-side,
 * then the diff. Comparison is by RANK POSITION (not score magnitude) — the two
 * strategies score on different scales, so only the ordering is comparable.
 */
function renderComparison(query: string, comparison?: RankComparison): void {
  if (!comparison) {
    log.dim(`"${query}" → no ranker comparison returned (semantic pool empty?).`);
    return;
  }
  const { baseline, horizon, diff } = comparison;
  const n = Math.max(baseline.length, horizon.length);

  log.dim(`"${query}" → A/B ranker comparison (by RANK, not score magnitude)`);
  log.blank();

  // Side-by-side: rank · title for each column.
  const trunc = (s: string, w: number): string =>
    (s.length > w ? s.slice(0, w - 1) + "…" : s).padEnd(w, " ");
  const COL = 38;
  log.info(
    "  " + chalk.bold("BASELINE".padEnd(COL + 5)) + chalk.bold("HORIZON")
  );
  for (let i = 0; i < n; i++) {
    const b = baseline[i];
    const h = horizon[i];
    const bCell = b ? `${chalk.dim(`#${b.rank}`)} ${trunc(b.title, COL)}` : "".padEnd(COL + 4);
    const hCell = h ? `${chalk.dim(`#${h.rank}`)} ${trunc(h.title, COL)}` : "";
    log.info("  " + bCell + " " + hCell);
  }
  log.blank();

  // Diff — overlap@N + items that moved rank between the two strategies.
  const topN = Math.max(baseline.length, horizon.length);
  log.info(
    chalk.bold("DIFF") +
      chalk.dim(` · overlap@${topN}: ${diff.overlapAtN}/${topN} shared ids`)
  );
  if (diff.moved.length === 0) {
    log.dim("  No shared item changed rank between the two rankers.");
  } else {
    for (const m of diff.moved) {
      const dir = m.horizonRank < m.baselineRank ? chalk.green("↑") : chalk.red("↓");
      log.info(
        `  ${dir} ${m.title} ${chalk.dim(`(baseline #${m.baselineRank} → horizon #${m.horizonRank})`)}`
      );
    }
  }
  log.blank();
}

export async function askKnowledge(
  query: string,
  opts: BaseOpts & { workspace?: string; limit?: string; json?: boolean; session?: boolean; compare?: boolean }
): Promise<void> {
  try {
    const cfg = await resolveHubConfig(opts);
    const limit = parseLimit(opts.limit, 10);
    const workspaceId = opts.workspace ?? cfg.workspaceId;
    const sessionId = opts.session ? readActiveSessionId() : undefined;

    const res = (await hubPost(
      "/knowledge/ask",
      {
        query,
        ...(workspaceId ? { workspaceId } : {}),
        ...(sessionId ? { sessionId } : {}),
        limit,
        ...(opts.compare ? { compare: true } : {}),
      },
      cfg
    )) as AskResponse;

    if (opts.json) {
      console.log(JSON.stringify(res, null, 2));
      return;
    }

    // A/B ranker diagnostic — render the comparison and STOP. This is a
    // ranking diff (baseline vs Horizon on the same candidate pool), not the
    // normal answer, so it replaces the substrate listing when requested.
    if (opts.compare) {
      renderComparison(query, res.comparison);
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

    // res.degraded was only ever checked as a boolean (anyErrored) above —
    // surface which substrate(s) actually degraded, verbatim, so the answer's
    // incompleteness is visible rather than just its existence.
    if (res.degraded && res.degraded.length > 0) {
      log.dim(`Degraded: ${res.degraded.join(", ")}`);
    }
  } catch (e) {
    renderHubError(e);
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
      `⚠ an entity named "${String(existing.name ?? "?")}" already exists as profile ${String(existing.profileSlug ?? "?")} (${String(existing.id ?? "?")}) — consider updating it instead of duplicating`
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
    renderHubError(e);
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
    const res = await hubGet(
      "/profiles",
      { userId, workspaceId, ...(opts.json ? { detail: "full" } : {}) },
      cfg
    );
    const profiles = unwrapList<Record<string, unknown>>(res, ["profiles"]);

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
      // A role-profile (client, partner, …) is a hat an existing entity wears
      // via `synap facet attach` — never created as its own entity. Label it
      // distinctly so it's never confused with a primary kind.
      const applicableKinds = p.applicableKinds as string[] | undefined;
      const kindLabel = p.profileKind === "role"
        ? chalk.magenta(`[Role${applicableKinds?.length ? ` of ${applicableKinds.join("/")}` : ""}]`)
        : chalk.green("[Kind]");
      log.info(`${chalk.bold(String(p.slug ?? ""))}  ${kindLabel}  ${chalk.dim(scope)}${desc}`);
    }
  } catch (e) {
    renderHubError(e);
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
    renderHubError(e);
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
    renderHubError(e);
    process.exit(1);
  }
}
