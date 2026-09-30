import chalk from "chalk";
import { log } from "../utils/logger.js";
import {
  resolveHubConfig,
  hubGet,
  hubPatch,
  hubPost,
  attachActiveSessionId,
  detachActiveSessionId,
  resolveActiveSessionId,
  renderHubError,
  HubError,
} from "../lib/hub-client.js";
import { type BaseOpts } from "./data.js";
import { readFileSync, existsSync } from "fs";
import { resolve } from "path";

/**
 * The three session-population lenses ("kind"), and their human labels.
 *
 * `@synap-core/types/vocabulary` (`resolveStatusLabel`) is the SSOT for this —
 * `work`/`run`/`receipt` are pinned there verbatim (`.claude/rules/
 * vocabulary.md` forbids a local `charAt(0).toUpperCase()` guess). But this
 * package cannot import it: the CLI links only `@synap-core/workspace-
 * templates` (a real npm dep already), and `@synap-core/types` pulls in
 * drizzle-orm/drizzle-zod/yjs as transitive deps for a globally-installed
 * binary — an install-topology change, not a labelling fix. Same shape as
 * `KIND_HEADINGS` in `market.ts`: a local table, pinned by a source-scan
 * parity test (`test/session-kind-vocabulary-parity.test.ts`) against the
 * registry across the repo boundary, so it cannot silently drift.
 */
const SESSION_KIND_LABELS: Record<string, string> = {
  work: "Work",
  run: "Run",
  receipt: "Receipt",
};

export function sessionKindLabel(kind: string): string {
  return SESSION_KIND_LABELS[kind] ?? kind;
}

const SESSION_KIND_FILTERS = ["work", "run", "receipt", "all"] as const;

/**
 * The name to show for a session: mirrors `resolveSessionTitle` in
 * `synap-backend/packages/types/src/focus-sessions/title.ts` — the
 * platform's ONE resolver (title when set, else the goal's first line,
 * clipped at a word boundary). This package cannot import that file (see the
 * doc comment on `SESSION_KIND_LABELS` above for why), so only the DISPLAY
 * half of the rule is mirrored: the row's `title` already arrives
 * server-normalized (HTML-entity decoded, one line), so the write-path
 * decode step has nothing to do here. Pinned by
 * `test/session-title-resolver-parity.test.ts`, which runs the registry's
 * OWN fixtures (from `title.test.ts`) through this copy.
 */
const SESSION_TITLE_FALLBACK_MAX = 80;

function oneLine(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function clipAtWordBoundary(line: string, max: number): string {
  if (line.length <= max) return line;
  let cut = line.slice(0, Math.max(1, max - 1));
  const lastSpace = cut.lastIndexOf(" ");
  // Only back off to a word boundary when it keeps most of the budget; a
  // single very long first word is cut mid-word rather than reduced to
  // nothing.
  if (lastSpace >= Math.floor(max / 2)) cut = cut.slice(0, lastSpace);
  return `${cut.replace(/[\s,;:.\-–—]+$/, "")}…`;
}

export function resolveSessionTitle(
  session: { title?: unknown; goal?: unknown },
  opts: { maxLength?: number } = {}
): string {
  const title =
    typeof session.title === "string" ? oneLine(session.title) : "";
  if (title) return title;
  const goal = typeof session.goal === "string" ? session.goal : "";
  const firstLine =
    goal
      .split(/\r?\n/)
      .map(oneLine)
      .find((l) => l.length > 0) ?? "";
  return clipAtWordBoundary(firstLine, opts.maxLength ?? SESSION_TITLE_FALLBACK_MAX);
}

/**
 * Session-evaluation verdicts (`session_evaluations.verdict`). SSOT is
 * `@synap-core/types/vocabulary`'s `STATUS_LABELS` (`pass`/`fail`/
 * `unmeasured`) — same cross-boundary constraint as `SESSION_KIND_LABELS`
 * above, mirrored here and pinned by
 * `test/verdict-label-vocabulary-parity.test.ts`.
 */
const VERDICT_LABELS: Record<string, string> = {
  pass: "Passed",
  fail: "Failed",
  unmeasured: "Not checked",
};

function verdictLabel(verdict: string): string {
  return VERDICT_LABELS[verdict] ?? verdict;
}

/** Shape of `SessionVerdict` (`@synap-core/types/focus-sessions`), as the wire sends it. */
interface SessionVerdictWire {
  total?: number;
  passed?: number;
  failed?: number;
  unmeasured?: number;
  requiredUnmet?: number;
  state?: string;
}

/**
 * One-glance verdict summary for a list/detail row: "1 unmet" when a
 * required criterion is failing or unmeasured (the thing worth flagging),
 * else "2/3 ✓". `null` when the session carries no criteria at all — most
 * sessions don't, and a bare session shouldn't grow a verdict column.
 */
function verdictSummary(v: unknown): string | null {
  const verdict = v as SessionVerdictWire | undefined;
  if (!verdict || typeof verdict.total !== "number" || verdict.total === 0) {
    return null;
  }
  if (verdict.requiredUnmet && verdict.requiredUnmet > 0) {
    return `${verdict.requiredUnmet} unmet`;
  }
  return `${verdict.passed ?? 0}/${verdict.total} ✓`;
}

/** Human phrasing for where an attach landed — so scope is never a mystery. */
function describeAttachTarget(target: "session-lens" | "directory-lens"): string {
  return target === "session-lens"
    ? "in this Claude Code session (~/.synap/lenses)"
    : "in this working tree (.synap/lens.json)";
}

// ─── startSession ─────────────────────────────────────────────────────────────

export async function startSession(
  opts: BaseOpts & {
    goal: string;
    workspace?: string;
    project?: string;
    taskId?: string;
    /** `--track <id>`: born inside a track (a project's method). */
    track?: string;
    // `string` when `--template <id>` names one; `false` when `--no-template`
    // opts out (commander pairs a `--no-` flag with a same-named value option
    // — see index.ts); `undefined` when neither was given, which lets the pod
    // auto-match.
    template?: string | false;
    parent?: string;
    suspendedIntent?: string;
    criteria?: string;
  }
): Promise<void> {
  try {
    const cfg = await resolveHubConfig(opts);

    // LENS PARITY. `resolveHubConfig` already resolves the active project
    // ("write paths should consume resolveHubConfig().projectId" —
    // lib/hub-client.ts), and `synap lens` / `synap capture` both honour it.
    // This door read `cfg.workspaceId` and dropped `cfg.projectId` on the
    // floor, so the same terminal answered differently depending on which
    // command you used: capture filed into the project, `session start` wrote
    // projectId: null. The value was one field away the whole time.
    // A track names its own project (the pod refuses a different projectId):
    // with `--track`, only an EXPLICIT --workspace / --project is sent, never
    // the ambient lens, which may point at another project.
    const workspaceId = opts.track ? opts.workspace : opts.workspace || cfg.workspaceId;
    const projectId = opts.track ? opts.project : opts.project || cfg.projectId;

    // The POD accepts workspaceId OR projectId ("Provide a workspaceId or a
    // projectId" — rest/focus-sessions.ts). Requiring a workspace here was a
    // CLI-only rule, stricter than the contract, and it made a project-scoped
    // session unreachable from the terminal.
    if (!workspaceId && !projectId && !opts.track) {
      console.error(
        chalk.red(
          "Error: no workspace or project in scope — pass --workspace <id> or --project <id>, or set one with 'synap use' / 'synap project use'"
        )
      );
      process.exit(1);
    }

    // Resolve caller userId from the hub key
    const me = (await hubGet("/users/me", {}, cfg)) as { id?: string };
    const userId = me?.id;
    if (!userId) {
      console.error(chalk.red("Error: could not resolve userId from /users/me"));
      process.exit(1);
    }

    const body: Record<string, unknown> = { userId, goal: opts.goal };
    // Send only what is in scope: the pod's refine accepts either, and sending
    // an undefined workspaceId would fail the "min(1)" on the wire.
    if (workspaceId) body.workspaceId = workspaceId;
    if (projectId) body.projectId = projectId;
    if (opts.track) body.trackId = opts.track;
    if (opts.taskId) body.correlationId = `task:${opts.taskId}`;
    // `--no-template` → opts.template === false → send an explicit `null`,
    // which SKIPS matching (`TEMPLATE_OPT_OUT` in match-session-template.ts).
    // `--template <id>` → send that id, the one way a playbook binds. Neither
    // → omit, so the start comes back with the pod's playbooks to choose from
    // (suggestions; nothing is applied).
    if (opts.template === false) body.templateId = null;
    else if (opts.template) body.templateId = opts.template;
    // Detour push: the pod records `session --spawned_from--> session` and (with
    // --suspended-intent) writes the "what were you about to do" line onto the
    // PARENT and a `parent --blocked_by--> this session` edge. The parent is
    // NOT closed or paused — it waits, and popping back is `synap session attach <parent>`.
    if (opts.parent) body.parentSessionId = opts.parent;
    if (opts.suspendedIntent) body.suspendedIntent = opts.suspendedIntent;

    if (opts.criteria) {
      const path = resolve(process.cwd(), opts.criteria);
      if (!existsSync(path)) {
        console.error(chalk.red(`Error: --criteria file not found: ${path}`));
        process.exit(1);
        return;
      }
      try {
        body.criteria = JSON.parse(readFileSync(path, "utf-8"));
      } catch (parseErr) {
        console.error(
          chalk.red(`Error: --criteria file is not valid JSON — ${(parseErr as Error).message}`)
        );
        process.exit(1);
        return;
      }
    }

    const session = (await hubPost("/focus-sessions", body, cfg)) as Record<string, unknown>;

    if (opts.json) {
      console.log(JSON.stringify(session, null, 2));
      return;
    }

    // A governed start comes back as a PROPOSAL, not a session: say so, and
    // attach nothing — there is no session id to attach yet.
    if (session.status === "proposed" && typeof session.proposalId === "string") {
      log.warn("Starting this session is queued for your review — not started yet.");
      if (typeof session.reviewUrl === "string") log.hint(`Review: ${session.reviewUrl}`);
      else log.hint(`Proposal ${session.proposalId} — see: synap proposals list`);
      return;
    }

    const id = String(session.id ?? "");
    // Auto-attach: make this session active so the statusline and every scoped
    // call reflect it. Lands on the Claude-session lens inside Claude Code,
    // otherwise on this working tree's directory lens.
    const target = attachActiveSessionId(id);
    log.success(`Session started and attached`);
    console.log(`  ID:      ${chalk.bold(id)}`);
    console.log(`  Name:    ${chalk.white(resolveSessionTitle(session))}`);
    console.log(`  Goal:    ${chalk.white(opts.goal)}`);
    if (opts.taskId) console.log(`  Task:    ${chalk.dim(opts.taskId)}`);
    if (opts.parent) console.log(`  Forked from: ${chalk.dim(opts.parent)}`);
    if (session.adopted === true) {
      log.dim(`  Continued your auto-opened session`);
    }
    // `playbooks` (SessionPlaybookCandidates) is present iff matching ran —
    // see match-session-template.ts. SUGGESTIONS ONLY: nothing was applied, so
    // say what fits and how to bind one, never that one is in force.
    const playbooks = session.playbooks as
      | { candidates: Array<{ id: string; name: string; reason: string }> }
      | undefined;
    if (playbooks?.candidates?.length) {
      log.dim(`  Playbooks that fit this goal (none applied):`);
      for (const c of playbooks.candidates) {
        log.dim(`    - ${c.name}  (${c.reason})`);
        log.dim(`      ${chalk.dim(`--template ${c.id}`)}`);
      }
    }
    log.dim(`  Active ${describeAttachTarget(target)}`);
    console.log();
    // Print the ID alone on a final line so scripts can grab it easily
    console.log(id);
  } catch (e) {
    renderHubError(e);
    process.exit(1);
  }
}

// ─── listSessions ─────────────────────────────────────────────────────────────

export async function listSessions(
  opts: BaseOpts & {
    workspace?: string;
    project?: string;
    status?: string;
    limit?: string;
    kind?: string;
  }
): Promise<void> {
  try {
    // Validate at the edge, same reasoning as `--progress` above: a typo should
    // fail here with the legal values, not reach the pod and bounce as a raw
    // zod echo.
    if (
      opts.kind !== undefined &&
      !(SESSION_KIND_FILTERS as readonly string[]).includes(opts.kind)
    ) {
      console.error(
        chalk.red(
          `Error: --kind must be one of ${SESSION_KIND_FILTERS.join(" | ")} (got ${JSON.stringify(opts.kind)}).`
        )
      );
      process.exit(1);
    }

    const cfg = await resolveHubConfig(opts);
    const params: Record<string, string | number | undefined> = {};
    // Fall back to the active workspace (config/env) like `start` does — the
    // focus-sessions REST requires workspaceId, and an operator with an active
    // workspace shouldn't have to repeat --workspace on every session command.
    // `--project` is a scope of its own (the pod accepts projectId alone,
    // project-member floor): a project's sessions span spaces, so with it only
    // an EXPLICIT --workspace narrows — never the ambient one, which would hide
    // every session the project runs in another space.
    const wsId = opts.project ? opts.workspace : opts.workspace || cfg.workspaceId;
    if (wsId) params.workspaceId = wsId;
    if (opts.project) params.projectId = opts.project;
    if (opts.status) params.status = opts.status;
    if (opts.limit) params.limit = parseInt(opts.limit, 10);
    // Population lens (`services/focus-sessions/session-kind.ts` on the pod).
    // The Hub REST door defaults to "all" itself, so omit rather than send a
    // redundant param when the flag isn't given.
    if (opts.kind && opts.kind !== "all") params.kind = opts.kind;

    // The Hub REST GET /focus-sessions returns a bare array of sessions.
    // (Tolerate a { sessions: [...] } envelope too, for forward-compat.)
    const res = await hubGet("/focus-sessions", params, cfg);
    const sessions: unknown[] = Array.isArray(res)
      ? res
      : ((res as { sessions?: unknown[] })?.sessions ?? []);

    if (opts.json) {
      console.log(JSON.stringify(sessions, null, 2));
      return;
    }

    if (!sessions.length) {
      log.dim("No sessions found");
      return;
    }

    for (const s of sessions as Array<Record<string, unknown>>) {
      const status = String(s.status ?? "");
      const statusColor =
        status === "active"
          ? chalk.green(status)
          : status === "paused"
            ? chalk.yellow(status)
            : chalk.dim(status);
      const progress =
        typeof s.progress === "number" ? ` ${chalk.dim(`[${s.progress}%]`)}` : "";
      // `kind` is projected on every row by the Hub REST door regardless of the
      // `--kind` filter — an older pod without the kind wave simply omits it.
      const kindLabel = typeof s.kind === "string" ? sessionKindLabel(s.kind) : null;
      const kindCol = kindLabel ? ` ${chalk.dim(`[${kindLabel}]`)}` : "";
      // Present only when the door lifts `verdict` onto the row (today: the
      // single-session GET, not this list) — `verdictSummary` returns null on
      // an absent field, so an older/list door just omits the marker.
      const verdict = verdictSummary(s.verdict);
      const verdictCol = verdict ? ` ${chalk.dim(`(${verdict})`)}` : "";
      // Full id — feeds straight into `synap session get/update/attach <id>`.
      console.log(
        `  ${chalk.bold(String(s.id ?? ""))}  ${statusColor}${kindCol}${progress}  ${chalk.white(resolveSessionTitle(s))}${verdictCol}`
      );
    }
  } catch (e) {
    renderHubError(e);
    process.exit(1);
  }
}

// ─── getSession ───────────────────────────────────────────────────────────────

/**
 * Fetch a focus session by id.
 *
 * Prefer GET without workspaceId so project-scoped sessions (workspaceId null)
 * resolve. Older pods still require the query param — if the bare GET fails
 * with 400 and we have a workspace, retry with it.
 */
async function fetchSessionById(
  id: string,
  cfg: Awaited<ReturnType<typeof resolveHubConfig>>,
  workspaceHint?: string
): Promise<Record<string, unknown>> {
  try {
    return (await hubGet(`/focus-sessions/${id}`, {}, cfg)) as Record<
      string,
      unknown
    >;
  } catch (e) {
    const wsId = workspaceHint || cfg.workspaceId;
    if (e instanceof HubError && e.status === 400 && wsId) {
      return (await hubGet(
        `/focus-sessions/${id}`,
        { workspaceId: wsId },
        cfg
      )) as Record<string, unknown>;
    }
    throw e;
  }
}

export async function getSession(
  id: string,
  opts: BaseOpts & { workspace?: string }
): Promise<void> {
  try {
    const cfg = await resolveHubConfig(opts);
    const res = await fetchSessionById(id, cfg, opts.workspace);

    if (opts.json) {
      console.log(JSON.stringify(res, null, 2));
      return;
    }

    const s = res;
    log.info(`Session  ${chalk.bold(String(s.id ?? ""))}`);
    console.log(`  Name:       ${chalk.white(resolveSessionTitle(s))}`);
    console.log(`  Goal:       ${chalk.white(String(s.goal ?? ""))}`);
    console.log(`  Status:     ${chalk.cyan(String(s.status ?? ""))}`);
    if (typeof s.kind === "string")
      console.log(`  Kind:       ${chalk.dim(sessionKindLabel(s.kind))}`);
    // `verdict` (SessionVerdict) is present iff the session carries criteria —
    // see `test/verdict-label-vocabulary-parity.test.ts` for the label SSOT.
    const verdict = s.verdict as SessionVerdictWire | undefined;
    if (verdict && typeof verdict.total === "number" && verdict.total > 0) {
      const summary = verdictSummary(verdict);
      console.log(
        `  Criteria:   ${chalk.white(`${verdict.passed ?? 0}/${verdict.total}`)}` +
          (summary && verdict.requiredUnmet
            ? `  ${chalk.yellow(summary)}`
            : "")
      );
    }
    // Project-scoped sessions have workspaceId null — show scope honestly.
    if (s.workspaceId != null && s.workspaceId !== "") {
      console.log(`  Workspace:  ${chalk.dim(String(s.workspaceId))}`);
    } else if (s.projectId) {
      console.log(`  Project:    ${chalk.dim(String(s.projectId))}  ${chalk.dim("(no workspace)")}`);
    } else {
      console.log(`  Scope:      ${chalk.dim("project/unscoped (workspace null)")}`);
    }
    if (s.projectId && s.workspaceId)
      console.log(`  Project:    ${chalk.dim(String(s.projectId))}`);
    if (typeof s.progress === "number") console.log(`  Progress:   ${s.progress}%`);
    if (s.templateId) console.log(`  Template:   ${chalk.dim(String(s.templateId))}`);
    if (Array.isArray(s.agentIds) && s.agentIds.length)
      console.log(`  Agents:     ${(s.agentIds as string[]).join(", ")}`);
    if (Array.isArray(s.expectedOutputs) && s.expectedOutputs.length)
      console.log(
        `  Outputs:    ${(s.expectedOutputs as Array<{ label: string }>).map((o) => o.label).join(", ")}`
      );
    if (s.correlationId)
      console.log(`  CorrelationId: ${chalk.dim(String(s.correlationId))}`);
  } catch (e) {
    renderHubError(e);
    process.exit(1);
  }
}

// ─── updateSession ────────────────────────────────────────────────────────────

export async function updateSession(
  id: string,
  opts: BaseOpts & { workspace?: string; progress?: string; status?: string; stage?: string; goal?: string }
): Promise<void> {
  try {
    const cfg = await resolveHubConfig(opts);

    // The session is identified by `id` in the URL and `workspaceId` is
    // `.optional()` on the pod's UpdateBodySchema — so demanding one here was a
    // CLI-only rule that made an already-attached (or project-scoped) session
    // un-updatable without re-stating a lens the terminal already holds.
    const wsId = opts.workspace || cfg.workspaceId;

    const body: Record<string, string | number | undefined> = {};
    if (wsId) body.workspaceId = wsId;

    // `progress` is `z.number().int().min(0).max(100)` on the pod. `parseInt`
    // on prose yields NaN, which serialized to the wire and came back as a raw
    // zod echo — an unreadable error for a mistake the CLI could name here.
    // Validate at the edge and say what the flag actually takes.
    if (opts.progress !== undefined) {
      const pct = Number(opts.progress);
      if (!Number.isInteger(pct) || pct < 0 || pct > 100) {
        console.error(
          chalk.red(
            `Error: --progress takes a whole number 0-100 (got ${JSON.stringify(opts.progress)}).`
          )
        );
        log.hint(
          "For a free-text note, use --goal to restate the goal, or capture the note: synap capture --type lesson --claim \"...\""
        );
        process.exit(1);
      }
      body.progress = pct;
    }
    if (opts.status) body.status = opts.status;
    if (opts.stage) body.currentStage = opts.stage;
    if (opts.goal) body.goal = opts.goal;

    const res = await hubPatch(`/focus-sessions/${id}`, body, cfg);

    if (opts.json) {
      console.log(JSON.stringify(res, null, 2));
      return;
    }

    log.success(`Session updated  ${chalk.dim(id.slice(0, 8))}`);
    if (opts.progress !== undefined) log.dim(`  progress → ${opts.progress}%`);
    if (opts.status) log.dim(`  status → ${opts.status}`);
    if (opts.stage) log.dim(`  stage → ${opts.stage}`);
  } catch (e) {
    renderHubError(e);
    process.exit(1);
  }
}

// ─── attachSession ────────────────────────────────────────────────────────────

export async function attachSession(
  id: string,
  opts: BaseOpts
): Promise<void> {
  // Validate the session exists before attaching (project-scoped OK — no workspace required)
  try {
    const cfg = await resolveHubConfig(opts);
    await fetchSessionById(id, cfg, opts.workspace);
  } catch (e) {
    console.error(chalk.red("Error: session not found — " + (e as Error).message));
    process.exit(1);
  }
  const target = attachActiveSessionId(id);
  if (opts.json) {
    console.log(JSON.stringify({ ok: true, sessionId: id, scope: target }));
    return;
  }
  log.success(`Session attached  ${chalk.dim(id.slice(0, 8))}`);
  log.dim(`  Active ${describeAttachTarget(target)}`);
  log.dim(`  All hub calls in this terminal will tag X-Session-Id: ${id.slice(0, 8)}…`);
}

// ─── detachSession ────────────────────────────────────────────────────────────

export function detachSession(opts: { json?: boolean }): void {
  const current = detachActiveSessionId();
  if (opts.json) {
    console.log(JSON.stringify({ ok: true }));
    return;
  }
  if (current) {
    log.success(`Session detached  ${chalk.dim(current.slice(0, 8))}`);
  } else {
    log.dim("No active session to detach");
  }
}

// ─── sessionStatus ────────────────────────────────────────────────────────────

export function sessionStatus(opts: { json?: boolean }): void {
  const id = resolveActiveSessionId();
  if (opts.json) {
    console.log(JSON.stringify({ sessionId: id ?? null }));
    return;
  }
  if (id) {
    log.info(`Active session: ${chalk.bold(id.slice(0, 8))}…  ${chalk.dim("(SYNAP_SESSION_ID, session lens, or .synap/lens.json)")}`);
  } else {
    log.dim("No active session — run `synap session start` or `synap session attach <id>`");
  }
}

// ─── closeSession ─────────────────────────────────────────────────────────────

/** Pack shape returned by POST /focus-sessions/:id/complete (Gate 2). */
type CompletePackResult = {
  session?: Record<string, unknown>;
  pendingProposals?: Array<Record<string, unknown>>;
  counts?: { pending?: number; unfinishedOutputs?: number };
  warnings?: string[];
  status?: string;
  note?: string;
  // Close NEVER blocks on criteria — a failed/unmeasured required criterion
  // just flags the close (complete-session.ts).
  verdict?: SessionVerdictWire;
};

/**
 * Close a focus session via Hub complete (proposal pack).
 *
 * Prefer POST /focus-sessions/:id/complete with `{ summary }` from `--recap`.
 * On 404 (older pods without the route) fall back to PATCH status=closed and
 * write verificationReport.summary — graceful degrade, pack unavailable.
 *
 * --workspace is optional: complete loads the row by id; PATCH also scopes
 * from the row (workspaceId body is back-compat only).
 */
export async function closeSession(
  id: string,
  opts: BaseOpts & { workspace?: string; recap?: string; as?: string }
): Promise<void> {
  try {
    const cfg = await resolveHubConfig(opts);
    const wsId = opts.workspace || cfg.workspaceId;

    let pack: CompletePackResult | null = null;
    let usedPack = false;

    try {
      // Canonical close: completeFocusSession — returns proposal pack.
      // Map CLI --recap → body.summary (server field; there is no `recap` key).
      const body: Record<string, unknown> = {};
      if (opts.recap) body.summary = opts.recap;
      // How the session ended. Validated at the edge (see index.ts) so a typo
      // fails here with the three legal values, rather than reaching the pod
      // and being rejected by a zod enum the user cannot see.
      if (opts.as) body.terminalStatus = opts.as;
      pack = (await hubPost(
        `/focus-sessions/${id}/complete`,
        body,
        cfg
      )) as CompletePackResult;
      usedPack = true;
    } catch (e) {
      if (!(e instanceof HubError) || e.status !== 404) throw e;

      // Older pod: no complete route — close via PATCH and warn that pack is
      // unavailable. verificationReport.summary is the field the complete path
      // writes (complete-session.ts); UpdateBodySchema accepts it as z.unknown().
      log.dim(
        "Pack unavailable on this pod (POST …/complete → 404); falling back to status close."
      );
      const patchBody: Record<string, unknown> = {
        status: opts.as ?? "closed",
      };
      if (wsId) patchBody.workspaceId = wsId;
      if (opts.recap) patchBody.verificationReport = { summary: opts.recap };
      await hubPatch(`/focus-sessions/${id}`, patchBody, cfg);
    }

    // Detach if this was the active terminal session
    if (resolveActiveSessionId(cfg.podUrl) === id) detachActiveSessionId(cfg.podUrl);

    if (opts.json) {
      if (usedPack && pack) {
        console.log(JSON.stringify(pack, null, 2));
      } else {
        console.log(
          JSON.stringify(
            {
              ok: true,
              status: "closed",
              pack: false,
              summary: opts.recap ?? null,
            },
            null,
            2
          )
        );
      }
      return;
    }

    const sessionStatus =
      (pack?.session && String(pack.session.status ?? "")) ||
      pack?.status ||
      "closed";
    // Close never blocks on criteria — a required-but-unmet criterion is a
    // flag on the closed session, never a refusal.
    const closeVerdict =
      pack?.verdict && pack.verdict.requiredUnmet
        ? `  · ${pack.verdict.requiredUnmet} criteri${pack.verdict.requiredUnmet === 1 ? "on" : "a"} not met`
        : "";
    log.success(
      `Session closed  ${chalk.dim(id.slice(0, 8))}  ${chalk.cyan(sessionStatus)}${chalk.yellow(closeVerdict)}`
    );
    if (opts.recap) log.dim(`  recap: ${opts.recap}`);

    if (usedPack && pack) {
      const pending =
        pack.counts?.pending ??
        (Array.isArray(pack.pendingProposals) ? pack.pendingProposals.length : 0);
      const unfinished = pack.counts?.unfinishedOutputs ?? 0;
      console.log(
        `  Pack:       ${chalk.white(String(pending))} pending proposal(s)` +
          (unfinished > 0
            ? `  ${chalk.yellow(`${unfinished} unfinished output(s)`)}`
            : "")
      );
      if (Array.isArray(pack.warnings)) {
        for (const w of pack.warnings) {
          log.warn(String(w));
        }
      }
      if (pack.note) log.dim(`  ${pack.note}`);
      if (pending > 0) {
        log.dim(
          `  Review: synap proposals list --session ${id}`
        );
      }
    }
  } catch (e) {
    renderHubError(e);
    process.exit(1);
  }
}

// ─── evidenceSession / evaluateSession ─────────────────────────────────────────

/** Resolve the target session: `--session <id>`, else this terminal's active one. */
function resolveTargetSessionId(opts: { session?: string }, cfg: { podUrl: string }): string {
  const id = opts.session || resolveActiveSessionId(cfg.podUrl);
  if (!id) {
    console.error(
      chalk.red(
        "Error: no session in scope — pass --session <id> or attach one with 'synap session attach <id>'"
      )
    );
    process.exit(1);
  }
  return id;
}

/** `EvaluateResult` shape (`services/focus-sessions/evaluations/evaluate.ts`). */
interface EvaluateResultWire {
  status: "evaluated" | "not_found";
  results?: Array<{
    key: string;
    status: "recorded" | "skipped";
    verdict?: string;
    reason?: string;
    escalated?: boolean;
  }>;
  resumed?: boolean;
  verdict?: SessionVerdictWire;
}

function printEvaluateResult(result: EvaluateResultWire): void {
  if (result.status === "not_found") {
    log.warn("Session not found");
    return;
  }
  for (const r of result.results ?? []) {
    if (r.status === "recorded" && r.verdict) {
      const label = verdictLabel(r.verdict);
      const colored =
        r.verdict === "pass"
          ? chalk.green(label)
          : r.verdict === "fail"
            ? chalk.red(label)
            : chalk.dim(label);
      console.log(`  ${chalk.bold(r.key)}: ${colored}${r.escalated ? chalk.yellow("  (escalated)") : ""}`);
    } else {
      console.log(`  ${chalk.bold(r.key)}: ${chalk.dim(`skipped — ${r.reason ?? "not applicable"}`)}`);
    }
  }
  const summary = verdictSummary(result.verdict);
  if (summary) log.dim(`  Verdict: ${summary}`);
  if (result.resumed) log.dim(`  Resumed a paused check-gate`);
}

/**
 * `synap session evidence <key> --passed|--failed [--detail "…"]`
 *
 * POST /focus-sessions/:id/evidence — the agent's own deterministic report
 * for an `evidence`-checked criterion. Grades ONLY evidence-checked
 * criteria; never spends a judge call or runs a capability
 * (`rest/focus-sessions.ts`, the `onlyEvidence` branch).
 */
export async function evidenceSession(
  key: string,
  opts: BaseOpts & { session?: string; passed?: boolean; failed?: boolean; detail?: string }
): Promise<void> {
  try {
    const cfg = await resolveHubConfig(opts);
    const id = resolveTargetSessionId(opts, cfg);

    if (opts.passed === opts.failed) {
      // Both or neither given — commander gives us two independent booleans,
      // not an enum, so this is the edge check for "exactly one".
      console.error(chalk.red("Error: pass exactly one of --passed or --failed"));
      process.exit(1);
      return;
    }

    const evidence: Record<string, { passed: boolean; detail?: string }> = {
      [key]: { passed: !!opts.passed, ...(opts.detail ? { detail: opts.detail } : {}) },
    };
    const result = (await hubPost(
      `/focus-sessions/${id}/evidence`,
      { evidence },
      cfg
    )) as EvaluateResultWire;

    if (opts.json) {
      console.log(JSON.stringify(result, null, 2));
      return;
    }

    log.success(`Evidence recorded  ${chalk.dim(id.slice(0, 8))}`);
    printEvaluateResult(result);
  } catch (e) {
    renderHubError(e);
    process.exit(1);
  }
}

/**
 * `synap session evaluate [--session <id>]`
 *
 * POST /focus-sessions/:id/evaluations — runs every PENDING criterion check
 * (evidence already posted, then capability, then judge) and prints the
 * per-criterion verdicts.
 */
export async function evaluateSession(
  opts: BaseOpts & { session?: string }
): Promise<void> {
  try {
    const cfg = await resolveHubConfig(opts);
    const id = resolveTargetSessionId(opts, cfg);

    const result = (await hubPost(
      `/focus-sessions/${id}/evaluations`,
      {},
      cfg
    )) as EvaluateResultWire;

    if (opts.json) {
      console.log(JSON.stringify(result, null, 2));
      return;
    }

    log.success(`Session evaluated  ${chalk.dim(id.slice(0, 8))}`);
    printEvaluateResult(result);
  } catch (e) {
    renderHubError(e);
    process.exit(1);
  }
}
