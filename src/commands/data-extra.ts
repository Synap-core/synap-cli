import chalk from "chalk";
import { log } from "../utils/logger.js";
import { resolveHubConfig, resolveUserId, hubGet, renderHubError } from "../lib/hub-client.js";
import { unwrapList } from "../lib/unwrapList.js";
import { classifyActiveCredential } from "../lib/credential-class.js";
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
        const otherTitle = String(r.targetTitle ?? r.sourceTitle ?? r.title ?? otherId);
        const direction = r.targetEntityId === id ? "←" : "→";
        // Full id — feeds straight into `synap get entity <id>`.
        log.info(`${direction} ${chalk.cyan(type)}  ${otherTitle} ${chalk.dim(otherId)}`);
      }
    } else {
      log.blank();
      log.dim("No relations. Link with: synap create relation --source <id> --target <id> --type <type>");
    }
  } catch (e) {
    renderHubError(e);
    process.exit(1);
  }
}

// ─── listProposals ────────────────────────────────────────────────────────────
// The governance inbox — and, via `--status`, the AUDIT RECEIPT lane.
//
// Every auto-approved agent write already files a proposal row: the pod stores
// it with status `auto_approved` purely so the action is traceable ("Action was
// on the autoApproveFor whitelist — executed immediately, audited here for
// traceability", schema/proposals.ts:25). The data has always existed; this
// surface hardcoded `status: "pending"` and so could never show it. "The agent
// did something on my pod and I have no way to see it" was therefore a missing
// FILTER, not a missing feature.

/**
 * The `--status` vocabulary, mirroring the pod's `PROPOSAL_STATUS_FILTERS`
 * SSOT (`hub-protocol/proposals.ts`) rather than a hand-picked subset — a
 * client narrower than the door it calls is how "the CLI can't show X" bugs
 * get born. `pending` stays the default so the bare command is unchanged.
 *
 * DEPLOY DEPENDENCY: the pod at the time of writing accepts only
 * `pending|approved|rejected|all`; `auto_approved` (and the three terminal
 * states below it) reach the wire correctly but need the widened hub route
 * deployed before they return rows. Passing an unsupported value fails at the
 * pod with its own error — the CLI does not pretend to know which pod version
 * it is talking to.
 */
export const PROPOSAL_STATUS_FILTERS = [
  "pending",
  "approved",
  "auto_approved",
  "rejected",
  "reverted",
  "approval_failed",
  "withdrawn",
  // Never decided — its moment passed. Written by the pod's expiry sweep.
  "expired",
  "all",
] as const;

export type ProposalStatusFilter = (typeof PROPOSAL_STATUS_FILTERS)[number];

/** The default — the actionable queue, and the only status the command sent before `--status` existed. */
export const DEFAULT_PROPOSAL_STATUS: ProposalStatusFilter = "pending";

/**
 * Validate a user-supplied `--status`. Returns the filter, or `null` for an
 * unrecognised value so the caller can name the accepted set instead of
 * forwarding garbage and rendering the pod's 400 as if it were a server fault.
 */
export function parseProposalStatus(value: string | undefined): ProposalStatusFilter | null {
  if (!value) return DEFAULT_PROPOSAL_STATUS;
  const normalized = value.trim().toLowerCase().replace(/-/g, "_");
  return (PROPOSAL_STATUS_FILTERS as readonly string[]).includes(normalized)
    ? (normalized as ProposalStatusFilter)
    : null;
}

/**
 * Is this listing the ACTIONABLE queue, or a record of decisions already made?
 * `pending` rows await review; every other filter returns rows whose outcome is
 * already fixed, so offering "approve / reject" against them is the surface
 * asserting a verb that would do nothing.
 */
export function isActionableStatus(status: ProposalStatusFilter): boolean {
  return status === "pending";
}

/** Heading noun for a listing — "3 pending proposals" vs "3 auto-approved proposals". */
export function proposalStatusLabel(status: ProposalStatusFilter): string {
  return status === "all" ? "" : status.replace(/_/g, "-");
}

/** Compact age for a list row. Returns "" for a missing/unparseable date. */
function relativeAge(value: unknown): string {
  if (typeof value !== "string" && typeof value !== "number") return "";
  const then = new Date(value).getTime();
  if (!Number.isFinite(then)) return "";
  const mins = Math.floor((Date.now() - then) / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

export async function listProposals(
  opts: BaseOpts & { workspace?: string; limit?: string; session?: string; status?: string }
): Promise<void> {
  const status = parseProposalStatus(opts.status);
  if (!status) {
    console.error(chalk.red(`Unknown --status "${opts.status}".`));
    log.dim(`Accepted: ${PROPOSAL_STATUS_FILTERS.join(", ")}`);
    process.exit(1);
    return;
  }
  try {
    const cfg = await resolveHubConfig(opts);
    const limit = parseLimit(opts.limit, 20);
    // Governance inbox is USER-WIDE by default — matches the hub's user floor
    // (`GET /proposals` with no workspaceId applies userVisibleWhere across all
    // visible workspaces + pod-wide) AND the app's review board. Defaulting to
    // cfg.workspaceId silently scoped the inbox to the active workspace, hiding
    // every proposal in the user's OTHER workspaces (the same "|| wsIds[0]"
    // fallback the backend already removed, reintroduced client-side). `--workspace`
    // still narrows.
    const workspaceId = opts.workspace;

    // `--session` narrows to ONE agent run. The hub has read a `sessionId` query
    // param since proposals.ts:207 and forwards it to `listProposals`
    // (proposals.ts:225) — the CLI simply never sent it, so the grouping below
    // was the only way to isolate a session's output.
    const res = await hubGet("/proposals", {
      status,
      ...(workspaceId ? { workspaceId } : {}),
      ...(opts.session ? { sessionId: opts.session } : {}),
      limit,
    }, cfg) as Record<string, unknown>;

    const proposals = unwrapList<Record<string, unknown>>(res, ["proposals", "items"]);

    if (opts.json) {
      // Echo the filter that produced this list: a consumer reading an empty
      // `proposals` array otherwise cannot tell "nothing pending" from "asked
      // for a status this pod doesn't populate".
      console.log(JSON.stringify({ status, proposals }, null, 2));
      return;
    }

    const label = proposalStatusLabel(status);
    const noun = label ? `${label} proposal` : "proposal";

    if (proposals.length === 0) {
      log.success(`No ${noun}s.`);
      // The receipt lane is the thing nobody knows to ask for — name it once,
      // from the default view, rather than leaving it undiscoverable.
      if (status === DEFAULT_PROPOSAL_STATUS) {
        log.dim("  Auto-approved agent writes are recorded separately: synap proposals list --status auto_approved");
      }
      return;
    }

    log.heading(`${proposals.length} ${noun}${proposals.length !== 1 ? "s" : ""}`);
    log.blank();

    // Group by the session that produced them. One agent run emits many
    // proposals, and reviewing them one-by-one out of context is what made a
    // 50-row inbox unreadable — the session IS the unit of review. Proposals
    // with no sessionId (direct calls, older rows) fall into one trailing
    // "Unattributed" group rather than being hidden.
    const groups = new Map<string, Record<string, unknown>[]>();
    for (const p of proposals) {
      const key = String((p as Record<string, unknown>).sessionId ?? "");
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key)!.push(p as Record<string, unknown>);
    }
    // Named sessions first, unattributed last.
    const ordered = [...groups.entries()].sort((a, b) => (a[0] ? 0 : 1) - (b[0] ? 0 : 1));

    for (const [sessionId, rows] of ordered) {
      if (groups.size > 1) {
        const header = sessionId
          ? `session ${sessionId.slice(0, 8)} · ${rows.length}`
          : `unattributed · ${rows.length}`;
        log.blank();
        log.info(chalk.dim(`┄ ${header}`));
      }
      for (const prop of rows) {
        // Full id — feeds straight into `synap proposals approve/reject <id>`.
        const id = String(prop.id ?? "");
        // The REAL payload fields. This block previously read `action`,
        // `subjectType`, `entityTitle`, `summary`, `reasoning`, `description`
        // and `reviewUrl` — all seven are absent from `GET /proposals` (verified
        // 0/50 populated), so every fallback fired and all 50 rows rendered the
        // identical constant "entity.write". That label was also a fabrication:
        // 22 of the 50 do not target an entity at all.
        const kind = String(prop.proposalType ?? "");
        const target = String(prop.targetType ?? "");
        const label = kind && target ? `${kind} → ${target}` : kind || target || "proposal";
        // A ready-made human sentence the importer already wrote, when present.
        const data = (prop.data ?? {}) as Record<string, unknown>;
        const quality = (data.quality ?? {}) as Record<string, unknown>;
        const summary = String(quality.summary ?? data.summary ?? "");
        // Under `--status all` the rows are a MIX, so each one must carry its
        // own outcome — a uniform bullet there would be the same fail-open
        // "every row renders the identical label" defect the payload-field fix
        // above closed. For a single-status listing the heading already says it.
        const rowStatus = String(prop.status ?? "");
        const stamp =
          status === "all" && rowStatus
            ? `  ${chalk.dim(rowStatus.replace(/_/g, "-"))}`
            : "";
        log.info(`  ${chalk.yellow("●")} ${label}  ${chalk.dim(id)}  ${chalk.dim(relativeAge(prop.createdAt))}${stamp}`);
        if (summary) log.dim(`    ${summary.slice(0, 110)}`);
      }
    }
    log.blank();
    // The footer must match what these rows can actually accept. Approve/reject
    // apply ONLY to the pending queue; printing them under `--status
    // auto_approved` would advertise a verb that is a no-op on an already-
    // executed write — the same "surface asserts a capability it does not have"
    // defect as offering approve to an agent key.
    if (!isActionableStatus(status)) {
      log.dim(
        status === "all"
          ? "  Mixed outcomes — only `pending` rows can be approved or rejected."
          : `  Already decided — these ${noun}s are a record, not a queue.`
      );
      // Placeholder, not a real id — built literally so `<id>` isn't percent-encoded.
      log.dim(`  Inspect  →  synap open proposal <id>   ·   ${cfg.podUrl.replace(/\/+$/, "")}/open/<id>`);
      if (status === "auto_approved") {
        log.dim("  These executed WITHOUT review — they are the receipt, not a request.");
      }
    } else if ((await classifyActiveCredential(cfg)) === "agent") {
      // Only advertise verbs this credential can actually execute. An agent key
      // is hard-rejected by the pod on approve (`rejectAgentReviewer`), so
      // printing "synap proposals approve <id>" to one is the surface asserting
      // a capability it does not have. `reject` IS allowed for agents
      // (proposals.ts:437-441 — rejection carries no self-approval risk), so it
      // stays on the line either way.
      log.dim(`  Approve is human review — this agent credential cannot approve.`);
      log.dim(`  Review  →  synap open proposal <id>   ·   ${cfg.podUrl.replace(/\/+$/, "")}/open/<id>`);
      log.dim(`  synap proposals reject <id>`);
    } else {
      log.dim(`  synap proposals approve <id>   ·   synap proposals reject <id>`);
    }
  } catch (e) {
    renderHubError(e);
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
      // Full id — feeds straight into `synap get entity <id>`.
      const id = String(entity.id ?? "");
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
    renderHubError(e);
    process.exit(1);
  }
}
