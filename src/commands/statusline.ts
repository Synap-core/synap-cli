/**
 * synap statusline — full 4-line ANSI status for the Claude Code statusLine.
 *
 * Two modes, both via `synap statusline`:
 *
 *   RENDER (default)   Parse the Claude Code JSON from stdin, read the pod
 *                      cache files and local state (NO network), compose 4
 *                      ANSI lines, print, exit. Always instant. If a cache is
 *                      stale it spawns a detached refresh (fire-and-forget) so
 *                      the NEXT render is fresh — this render never blocks on
 *                      the network.
 *
 *   REFRESH (--refresh) Fetch pod data in parallel bursts and write the caches.
 *                      Lock-guarded so only one refresh of each cache runs at a
 *                      time. On error/429, the last good cache is preserved
 *                      (the dot goes stale, not blank). Also catches the
 *                      conversation's transcript index up (local, no network).
 *
 * Two pod caches: the pod-WIDE fields (workspaces, skills, needs-you, identity,
 * entity totals) in ONE shared file, refreshed at most once per REFRESH_TTL
 * whatever the number of conversations; the CONVERSATION's own fields (its lens
 * workspace, bound session, project) in a file per Claude Code session id, so
 * a conversation never shows the session another conversation refreshed last
 * (each one used to, when all of it lived in the one shared file).
 *
 * The 4th line (lib/now-line.ts) says what the conversation is doing now and
 * what it waits on, from Claude Code's process registry, the transcript index
 * (lib/transcript-index.ts) and `synap wait` state files — all local files.
 *
 * Why: Claude Code calls the statusline on every render (debounced ~300ms +
 * periodic refresh). Fetching live pod data synchronously per render hammers
 * the pod's 100-req/min budget → 429 → red dot. Decoupling render from fetch
 * caps pod traffic at ~1 burst / REFRESH_TTL regardless of render frequency.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawn } from "node:child_process";
import { resolveHubConfig, hubGet } from "../lib/hub-client.js";
import { resolveActiveLens } from "../lib/session-lens.js";
import { describeLens } from "../lib/describe-lens.js";
import { getSurfaceAgentKey, SURFACE_NAMES } from "../lib/pod.js";
import { buildNowLine, readRegistry } from "../lib/now-line.js";
import {
  defaultTranscriptPath,
  indexLockPath,
  loadIndex,
  saveIndex,
  updateIndex,
  type TranscriptIndex,
} from "../lib/transcript-index.js";
import { pidAlive, pruneWaits, readWaits } from "../lib/wait-state.js";

const CACHE_FILE = "/tmp/synap-statusline-cache.json"; // pod-wide fields, shared by every conversation
const LOCK_FILE = "/tmp/synap-statusline-refresh.lock";
/** A session id as a file-name part. */
function convKey(claudeSessionId: string | undefined): string {
  return (claudeSessionId ?? "").replace(/[^A-Za-z0-9_-]/g, "") || "_nosession";
}
export function convCacheFile(claudeSessionId: string | undefined): string {
  return `/tmp/synap-statusline-conv-${convKey(claudeSessionId)}.json`;
}
function convLockFile(claudeSessionId: string | undefined): string {
  return `/tmp/synap-statusline-conv-${convKey(claudeSessionId)}.lock`;
}
/** Render reads at most this many new transcript bytes; more is left to the detached refresh. */
const RENDER_TRANSCRIPT_BYTES = 2 * 1024 * 1024;
// The pod sits behind a strict edge rate-limiter (15-min window) shared with
// the agent's own traffic on the same key. Keep statusline cost minimal:
// refresh at most once per 120s; the burst is ~4-6 GETs (workspaces, skills,
// session, needs-you, + conditional project/identity). Fold new fields into an
// existing call rather than adding to the burst.
const REFRESH_TTL_MS = 120_000;
const LOCK_STALE_MS = 30_000; // a lock older than this is considered dead

// ── ANSI + OSC 8 helpers ───────────────────────────────────────────────

const G = "\x1b[01;32m"; // green bold
const Y = "\x1b[01;33m"; // yellow bold
const R = "\x1b[01;31m"; // red bold
const C = "\x1b[36m"; // cyan
const BB = "\x1b[01;34m"; // bold blue — used for the pinned PROJECT (prominence)
const M = "\x1b[35m"; // magenta
const D = "\x1b[2m"; // dim
const X = "\x1b[0m"; // reset

function osc8(url: string, text: string): string {
  if (!url) return text;
  return `\x1b]8;;${url}\x1b\\${text}\x1b]8;;\x1b\\`;
}

function ctxColor(pct: number): string {
  if (pct >= 80) return R;
  if (pct >= 60) return Y;
  return G;
}
function rateColor(pct: number): string {
  if (pct >= 80) return R;
  if (pct >= 50) return Y;
  return G;
}
function bar(pct: number, width = 16): string {
  const filled = Math.max(0, Math.min(width, Math.round((pct / 100) * width)));
  return ctxColor(pct) + "▰".repeat(filled) + D + "▱".repeat(width - filled) + X;
}
function compact(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1000).toFixed(0)}K`;
  return String(n);
}

// ── Cache ──────────────────────────────────────────────────────────────

interface PodCache {
  ts: number; // last SUCCESSFUL fetch
  /**
   * Last refresh ATTEMPT, successful or not — the backoff clock.
   *
   * `ts` may not serve as that clock: it means "last SUCCESS", so while the pod
   * is failing it never advances, every render sees a stale cache, and each one
   * spawns another burst. A pod-side 500 then becomes a request storm that
   * saturates the caller's rate-limit bucket (2026-09-19: /workspaces returned
   * 500 for days and the statusline burned the whole 500-per-15-min budget, so
   * the MCP server sharing that key got 429s). Optional: a cache written by an
   * older CLI has none, and falls back to `ts`.
   */
  attemptedTs?: number;
  ok: boolean; // last fetch reached the pod
  podUrl: string; // this connection's pod — lets render() build /open bounce links with no network
  activeWorkspaceId: string; // the workspace THIS connection is scoped to (cfg.workspaceId)
  workspaces: Array<{ id: string; name: string; count: number }>;
  projectName: string;
  projectId: string;
  skillCount: number;
  needsYouCount: number;
  needsYouTruncated: boolean; // the pod's count is a floor (a scan hit its cap)
  needsYouFetched: boolean; // false only until the first successful refresh ever completes
  sessionGoal: string;
  sessionId: string;
  totalEntities: number;
  // Identity safety (Task: agent-identity visibility). Computed once per
  // refresh so render() stays pod-call-free. See findSurfaceLabelForKey below.
  actingAgentLabel: string; // friendly label for the ACTING agent, only set when it differs from the expected claude-code identity
  identityMismatch: boolean; // true iff we have an expected identity AND the acting one diverges from it
}

/** The conversation's own fields, cached per Claude Code session id. */
type ConvField = "activeWorkspaceId" | "projectName" | "projectId" | "sessionGoal" | "sessionId";
type SharedCache = Omit<PodCache, ConvField>;
interface ConvCache extends Pick<PodCache, ConvField | "ts" | "attemptedTs" | "ok" | "podUrl"> {}

function emptyConv(): ConvCache {
  return { ts: 0, attemptedTs: 0, ok: false, podUrl: "", activeWorkspaceId: "", projectName: "", projectId: "", sessionGoal: "", sessionId: "" };
}

function emptyCache(): PodCache {
  return {
    ts: 0, attemptedTs: 0, ok: false, podUrl: "", activeWorkspaceId: "", workspaces: [], projectName: "", projectId: "",
    skillCount: 0, needsYouCount: 0, needsYouTruncated: false, needsYouFetched: false, sessionGoal: "", sessionId: "", totalEntities: 0,
    actingAgentLabel: "", identityMismatch: false,
  };
}

/** Find which known surface (if any) owns this hub API key — for a friendly acting-agent label. */
function findSurfaceLabelForKey(hubApiKey: string): string | null {
  for (const s of SURFACE_NAMES) {
    if (getSurfaceAgentKey(s)?.hubApiKey === hubApiKey) return s;
  }
  return null;
}

function readJson<T>(file: string): T | null {
  try {
    return JSON.parse(fs.readFileSync(file, "utf-8")) as T;
  } catch {
    return null;
  }
}

/** Missing, or its last attempt is older than the TTL. The backoff clock is the last ATTEMPT, not the last success (see PodCache). */
function isDue(c: { ts: number; attemptedTs?: number } | null): boolean {
  return !c || Date.now() - (c.attemptedTs ?? c.ts) > REFRESH_TTL_MS;
}

// ── Detached refresh trigger (fire-and-forget) ─────────────────────────

function lockIsFresh(file = LOCK_FILE): boolean {
  try {
    return Date.now() - fs.statSync(file).mtimeMs < LOCK_STALE_MS;
  } catch {
    return false;
  }
}

function takeLock(file: string): boolean {
  if (lockIsFresh(file)) return false; // another refresh owns the window
  try {
    fs.writeFileSync(file, String(process.pid));
  } catch {
    /* ignore */
  }
  return true;
}

function dropLock(file: string): void {
  try { fs.unlinkSync(file); } catch {}
}

function triggerRefresh(claudeSessionId: string | undefined, transcriptPath: string): void {
  try {
    const entry = process.argv[1]; // the CLI entry script
    // The detached refresh has no Claude env of its own — forward the session
    // id (from stdin) so its resolveHubConfig/lens picks the right workspace,
    // and the transcript path so it can catch the index up.
    const env: NodeJS.ProcessEnv = { ...process.env };
    if (claudeSessionId) env.SYNAP_LENS_SESSION = claudeSessionId;
    if (transcriptPath) env.SYNAP_STATUSLINE_TRANSCRIPT = transcriptPath;
    const child = spawn(process.execPath, [entry, "statusline", "--refresh"], {
      detached: true,
      stdio: "ignore",
      env,
    });
    child.unref();
  } catch {
    /* best-effort */
  }
}

// ── REFRESH mode: fetch pod, write cache (lock-guarded) ────────────────

/** The conversation this process serves: forwarded by render as SYNAP_LENS_SESSION. */
function refreshSessionId(): string | undefined {
  return process.env.SYNAP_LENS_SESSION || process.env.CLAUDE_CODE_SESSION_ID || undefined;
}

/**
 * Catch the transcript index up (local files only), streaming: render reads at
 * most RENDER_TRANSCRIPT_BYTES, so the first scan of a big transcript happens
 * here. Also prunes this conversation's finished `synap wait` files.
 */
function catchUpTranscript(claudeSessionId: string | undefined): void {
  const transcriptPath = process.env.SYNAP_STATUSLINE_TRANSCRIPT;
  if (!claudeSessionId) return;
  try { pruneWaits(claudeSessionId); } catch {}
  if (!transcriptPath) return;
  const lock = indexLockPath(claudeSessionId);
  try { fs.mkdirSync(path.dirname(lock), { recursive: true }); } catch {}
  if (!takeLock(lock)) return;
  try {
    const { index, changed } = updateIndex(loadIndex(claudeSessionId), transcriptPath, { maxBytes: Infinity });
    if (changed) saveIndex(claudeSessionId, index);
  } catch {
    /* the index is a display aid: the next render retries */
  } finally {
    dropLock(lock);
  }
}

async function refresh(): Promise<void> {
  const claudeSessionId = refreshSessionId();
  catchUpTranscript(claudeSessionId);

  const convFile = convCacheFile(claudeSessionId);
  const convLock = convLockFile(claudeSessionId);
  const prevShared = readJson<PodCache>(CACHE_FILE);
  const prevConv = readJson<ConvCache>(convFile);
  // Each cache is fetched only when IT is due and nobody else is fetching it:
  // N conversations share one pod-wide burst per TTL, plus their own 1–2 GETs.
  const doShared = isDue(prevShared) && takeLock(LOCK_FILE);
  const doConv = isDue(prevConv) && takeLock(convLock);
  if (!doShared && !doConv) return;

  try {
    const cfg = await resolveHubConfig({}).catch(() => null);
    await Promise.all([
      doShared ? refreshShared(cfg, prevShared) : null,
      doConv ? refreshConv(cfg, prevConv, convFile) : null,
    ]);
  } finally {
    if (doShared) dropLock(LOCK_FILE);
    if (doConv) dropLock(convLock);
  }
}

type Cfg = Awaited<ReturnType<typeof resolveHubConfig>>;

/**
 * The needs-you number out of a `GET /needs-you` body: `count.needsYou` is THE
 * rule's headline. Anything else (no `count`, a non-number) is null = not
 * measured, never 0.
 */
export function parseNeedsYouCount(body: unknown): { count: number; truncated: boolean } | null {
  const c = (body as { count?: { needsYou?: unknown; truncated?: unknown } } | null)?.count;
  if (typeof c?.needsYou !== "number" || !Number.isFinite(c.needsYou)) return null;
  return { count: c.needsYou, truncated: c.truncated === true };
}

/** The pod-wide burst: workspaces (doubling as liveness), skills, identity, proposals. */
async function refreshShared(cfg: Cfg | null, prev: PodCache | null): Promise<void> {
  try {
    // Thrown, not returned: the catch below stamps the attempt, so an
    // unconfigured CLI also backs off instead of respawning every render.
    if (!cfg?.podUrl || !cfg.apiKey) throw new Error("statusline: no pod config");

    // Identity safety: compare the AMBIENT SYNAP_HUB_API_KEY against the
    // claude-code surface key pinned to this pod. A cheap string compare
    // covers the common case (no pod call). Only when they diverge do we pay
    // for one extra `/users/me` call — resolved with the RAW ambient key
    // (not `cfg`, which resolveHubConfig may already have self-corrected to
    // the pinned key) so the acting identity we show reflects what this
    // session's environment actually carries, not the corrected value.
    const surfaceKey = getSurfaceAgentKey("claude-code");
    const expectedAgentUserId = surfaceKey?.podUrl === cfg.podUrl ? surfaceKey.agentUserId : "";
    const ambientKey = process.env.SYNAP_HUB_API_KEY;
    const ambientMatchesExpected = Boolean(ambientKey && surfaceKey && ambientKey === surfaceKey.hubApiKey);
    const needsIdentityCheck = Boolean(expectedAgentUserId && ambientKey && !ambientMatchesExpected);
    const identityReq = needsIdentityCheck
      ? hubGet("/users/me", {}, { podUrl: cfg.podUrl, apiKey: ambientKey as string, userId: "cli" })
      : Promise.resolve(null);

    // Needs you — the one actionable ambient signal, counted by the pod's own
    // rule (`GET /needs-you`, `signals.needsYou`; decision E): the same number
    // the badge shows, never re-derived from the pending-proposal list. `limit=1`
    // trims the rows (we read only `count`).
    const needsYouReq = hubGet("/needs-you", { limit: 1 }, cfg);

    // Minimal burst (the pod's edge limiter is shared with agent traffic).
    // `/workspaces` succeeding doubles as the liveness signal — no separate
    // `/health`.
    const [ws, skills, identity, needsYou] = await Promise.allSettled([
      hubGet("/workspaces", {}, cfg),
      hubGet("/agent-skills?limit=1", {}, cfg),
      identityReq,
      needsYouReq,
    ]);

    // Reached the pod iff /workspaces returned a well-formed payload.
    const ok = ws.status === "fulfilled" && Array.isArray((ws.value as { workspaces?: unknown })?.workspaces);
    if (!ok) throw new Error("pod unreachable");

    const workspaces: PodCache["workspaces"] = [];
    let totalEntities = 0;
    const list = (ws.value as { workspaces?: Array<{ id: string; name: string; entityCount: number }> })?.workspaces ?? [];
    for (const w of list) {
      workspaces.push({ id: w.id, name: w.name, count: w.entityCount ?? 0 });
      totalEntities += w.entityCount ?? 0;
    }

    const skillCount =
      skills.status === "fulfilled" ? ((skills.value as { total?: number })?.total ?? 0) : prev?.skillCount ?? 0;

    // Acting identity: clean unless we detected a real divergence.
    let actingAgentLabel = "";
    let identityMismatch = false;
    if (expectedAgentUserId && !ambientMatchesExpected && identity.status === "fulfilled" && identity.value) {
      const actingId = (identity.value as { id?: string })?.id ?? "";
      if (actingId && actingId !== expectedAgentUserId) {
        identityMismatch = true;
        actingAgentLabel = (ambientKey && findSurfaceLabelForKey(ambientKey)) || actingId.slice(0, 8);
      }
    }

    // A failed or malformed read keeps the last-good count (unknown until one
    // has ever succeeded); only a well-shaped `count` is a measurement.
    const read = needsYou.status === "fulfilled" ? parseNeedsYouCount(needsYou.value) : null;
    const needsYouCount = read ? read.count : prev?.needsYouCount ?? 0;
    const needsYouTruncated = read ? read.truncated : prev?.needsYouTruncated ?? false;

    const out: SharedCache = {
      ts: Date.now(),
      attemptedTs: Date.now(),
      ok: true,
      podUrl: cfg.podUrl,
      workspaces,
      skillCount,
      needsYouCount,
      needsYouTruncated,
      needsYouFetched: read !== null || (prev?.needsYouFetched ?? false),
      totalEntities,
      actingAgentLabel,
      identityMismatch,
    };

    fs.writeFileSync(CACHE_FILE, JSON.stringify(out));
  } catch {
    // Preserve last good cache, mark it not-ok so render can dim the dot, and
    // STAMP THE ATTEMPT: without it the next render refreshes immediately and a
    // failing pod turns every redraw into another burst. `ts` stays untouched —
    // it still means "last success", which is what the staleness display reads.
    // With no previous cache at all, write the empty one for the same reason.
    try {
      const failed = { ...(prev ?? emptyCache()), ok: false, attemptedTs: Date.now() };
      fs.writeFileSync(CACHE_FILE, JSON.stringify(failed));
    } catch {}
  }
}

/** This conversation's own fields: its lens workspace, bound session and project (0–2 GETs). */
async function refreshConv(cfg: Cfg | null, prev: ConvCache | null, file: string): Promise<void> {
  try {
    if (!cfg?.podUrl || !cfg.apiKey) throw new Error("statusline: no pod config");

    // This connection's per-Claude-session lens (forwarded as SYNAP_LENS_SESSION
    // by the render process). Drives WHICH project/session we show — the bound
    // ones, not a global guess.
    const lens = resolveActiveLens();

    // The bound focus-session and project are fetched by id only when the
    // lens has them.
    const sessionReq = lens?.focusSessionId
      ? hubGet(`/focus-sessions/${lens.focusSessionId}`, cfg.workspaceId ? { workspaceId: cfg.workspaceId } : {}, cfg)
      : hubGet("/focus-sessions?status=active&limit=1", {}, cfg);
    // Use the FULLY-RESOLVED project id (cfg.projectId = session-lens ?? env ??
    // durable activeProjectId), NOT just the session lens — so a durable
    // `synap project use` shows even in a fresh session with no lens file yet.
    // Mirrors how activeWorkspaceId already uses cfg.workspaceId below.
    const resolvedProjectId = cfg.projectId;
    // Resolve the NAME via the single-project route. `GET /projects` returns a
    // bare array and ignores `?ids=` (only status/limit) — the old call read a
    // nonexistent `.projects` field, so the name never resolved and the line
    // showed the raw UUID. `/projects/:id` returns the row directly ({id,name}).
    const projectReq = resolvedProjectId
      ? hubGet(`/projects/${encodeURIComponent(resolvedProjectId)}`, {}, cfg)
      : Promise.resolve(null);

    const [session, project] = await Promise.allSettled([sessionReq, projectReq]);

    // The session read is this cache's liveness signal (as `/workspaces` is the
    // shared one's): a 429 or a 5xx keeps the last good values (the catch
    // stamps the attempt). Only a 404 on the bound session means it is gone.
    const sessionGone = session.status === "rejected" && (session.reason as { status?: number })?.status === 404;
    if (session.status === "rejected" && !sessionGone) throw session.reason;

    // Bound session — either the by-id fetch (object) or the active-list fallback.
    let sessionGoal = prev?.sessionGoal ?? "";
    let sessionId = prev?.sessionId ?? "";
    if (session.status === "fulfilled" && session.value) {
      const v = session.value as { id?: string; goal?: string; sessions?: Array<{ id: string; goal?: string }> };
      const s = v.sessions ? v.sessions[0] : v; // list-shape vs object-shape
      sessionGoal = s?.goal?.slice(0, 60) ?? "";
      sessionId = s?.id ?? "";
    } else if (lens?.focusSessionId) {
      sessionGoal = "";
      sessionId = "";
    }

    // Bound project (from the fully-resolved id — durable or session).
    let projectName = resolvedProjectId ? prev?.projectName ?? "" : "";
    const projectId = resolvedProjectId ?? "";
    if (project.status === "fulfilled" && project.value) {
      const p = (project.value as { projects?: Array<{ id: string; name: string }> })?.projects?.find((x) => x.id === resolvedProjectId);
      projectName = p?.name?.slice(0, 30) ?? "";
    }

    const out: ConvCache = {
      ts: Date.now(),
      attemptedTs: Date.now(),
      ok: true,
      podUrl: cfg.podUrl,
      activeWorkspaceId: cfg.workspaceId ?? "", // the lens THIS connection resolves to
      projectName,
      projectId,
      sessionGoal,
      sessionId,
    };
    fs.writeFileSync(file, JSON.stringify(out));
  } catch {
    // Same backoff as the shared cache: keep the last good values, stamp the attempt.
    try {
      fs.writeFileSync(file, JSON.stringify({ ...(prev ?? emptyConv()), ok: false, attemptedTs: Date.now() }));
    } catch {}
  }
}

// ── RENDER mode: stdin + caches + local state → 4 lines (no network) ───

/**
 * This conversation's transcript index, brought up to date with what was
 * appended since the last render — at most RENDER_TRANSCRIPT_BYTES: a bigger
 * backlog (the first look at a long conversation) is left to the detached
 * refresh, and this render shows the index as it is. Returns whether that
 * backlog is waiting.
 */
function currentIndex(claudeSessionId: string, transcriptPath: string): { index: TranscriptIndex | null; behind: boolean } {
  try {
    const { index, changed, behind } = updateIndex(loadIndex(claudeSessionId), transcriptPath, { maxBytes: RENDER_TRANSCRIPT_BYTES });
    if (changed) {
      try { saveIndex(claudeSessionId, index); } catch {}
    }
    return { index, behind: behind > 0 };
  } catch {
    return { index: null, behind: false };
  }
}

/** Terminal width when Claude Code (or the shell) says it; the now line caps itself to it. */
function widthOf(cc: Record<string, unknown>): number | undefined {
  for (const v of [cc.terminal_width, cc.columns, (cc.terminal as { columns?: unknown } | undefined)?.columns, process.env.COLUMNS]) {
    const n = Number(v);
    if (Number.isFinite(n) && n > 0) return n;
  }
  return undefined;
}

function render(): void {
  let cc: Record<string, unknown> = {};
  try {
    const raw = fs.readFileSync(0, "utf-8");
    if (raw?.trim()) cc = JSON.parse(raw);
  } catch {}

  // The Claude session id — forwarded to the detached refresh so it resolves
  // THIS session's lens (workspace/project/session), not a global guess.
  const claudeSessionId = (cc.session_id as string | undefined) || process.env.CLAUDE_CODE_SESSION_ID;

  const cwd = (cc.cwd ?? "") as string;
  const transcriptPath =
    (typeof cc.transcript_path === "string" && cc.transcript_path) ||
    (cwd && claudeSessionId ? defaultTranscriptPath(cwd, claudeSessionId) : "");

  const shared = readJson<PodCache>(CACHE_FILE);
  const conv = readJson<ConvCache>(convCacheFile(claudeSessionId));
  const { index, behind } = claudeSessionId && transcriptPath ? currentIndex(claudeSessionId, transcriptPath) : { index: null, behind: false };
  // Trigger a background refresh if a cache is missing or stale, or the
  // transcript backlog is too big for a render — unless that refresh is
  // already running.
  if (
    (isDue(shared) && !lockIsFresh(LOCK_FILE)) ||
    (isDue(conv) && !lockIsFresh(convLockFile(claudeSessionId))) ||
    (behind && claudeSessionId && !lockIsFresh(indexLockPath(claudeSessionId)))
  )
    triggerRefresh(claudeSessionId, transcriptPath);

  // Pod-wide fields from the shared cache; the conversation's own ONLY from its
  // file — a shared cache written by an older CLI carries another
  // conversation's session and project, which must not show here.
  const c = conv ?? emptyConv();
  const pod: PodCache = {
    ...emptyCache(),
    ...(shared ?? {}),
    activeWorkspaceId: c.activeWorkspaceId,
    projectName: c.projectName,
    projectId: c.projectId,
    sessionGoal: c.sessionGoal,
    sessionId: c.sessionId,
    podUrl: shared?.podUrl || c.podUrl,
  };

  // ── Claude Code fields ───────────────────────────────────────────────
  const modelName = ((cc.model as { display_name?: string })?.display_name ?? "").replace(/\s*\((?:1M|200K) context\)/, "").trim();
  const ctxPct = (cc.context_window as { used_percentage?: number })?.used_percentage;
  const cost = (cc.cost as { total_cost_usd?: number })?.total_cost_usd;
  const linesAdd = (cc.cost as { total_lines_added?: number })?.total_lines_added ?? 0;
  const linesDel = (cc.cost as { total_lines_removed?: number })?.total_lines_removed ?? 0;
  const rl = cc.rate_limits as Record<string, { used_percentage?: number; resets_at?: number }> | undefined;
  const fhPct = rl?.five_hour?.used_percentage;
  const sdPct = rl?.seven_day?.used_percentage;
  const fhReset = rl?.five_hour?.resets_at;
  const vimMode = (cc.vim as { mode?: string })?.mode;

  const branch = cwd ? gitBranchOf(cwd) : "";

  // ── Session stats (local file) ───────────────────────────────────────
  let callCount = 0;
  let sessionCount = 0;
  try {
    const ss = JSON.parse(fs.readFileSync(os.homedir() + "/.claude/.session-stats.json", "utf-8"));
    const sessions = ss?.sessions as Record<string, { total_calls?: number }> | undefined;
    if (sessions) {
      sessionCount = Object.keys(sessions).length;
      callCount = Object.values(sessions).reduce((s, v) => s + (v.total_calls ?? 0), 0);
    }
  } catch {}

  // ── Pod dot: green=fresh, yellow=stale, grey=never fetched ───────────
  let dot = `${D}○${X}`;
  if (pod.ts > 0) {
    const stale = !pod.ok || Date.now() - pod.ts > REFRESH_TTL_MS * 3;
    dot = stale ? `${Y}●${X}` : `${G}●${X}`;
  }
  // Show the workspace THIS connection is scoped to. No fallback to
  // workspaces[0] — an unset activeWorkspaceId means pod-wide, and faking an
  // "active" workspace would hide that state from the 4-state lens (pod /
  // project / project×workspace / workspace).
  const activeWsEntry = pod.activeWorkspaceId
    ? pod.workspaces.find((w) => w.id === pod.activeWorkspaceId)
    : undefined;
  const described = describeLens({
    workspace: pod.activeWorkspaceId ? { id: pod.activeWorkspaceId, name: activeWsEntry?.name } : undefined,
    project: pod.projectId ? { id: pod.projectId, name: pod.projectName } : undefined,
  });
  const hasWs = Boolean(described.structured.workspace);
  const hasProject = Boolean(described.structured.project);
  const activeWs = described.structured.workspace?.name;
  const activeWsId = described.structured.workspace?.id ?? "";
  const activeWsCount = activeWsEntry?.count ?? 0;

  // ─═─ LINE 1 — model · context bar · branch · vim ─═─────────────────────
  const l1: string[] = [];
  if (modelName) {
    l1.push(`${C}${modelName}${X}`);
    if (branch) l1.push(`${D}${branch}${X}`);
    if (vimMode && vimMode !== "NORMAL") l1.push(`${M}${vimMode}${X}`);
  }
  if (ctxPct !== undefined) l1.push(` ${bar(ctxPct)} ${ctxColor(ctxPct)}${Math.round(ctxPct)}%${X}`);
  if (l1.length) console.log(l1.join("  "));

  // ─═─ LINE 2 — pod dot · identity warning · lens state (pod/project/project×ws/ws) · session · metrics ─═──
  const l2: string[] = [dot];
  // Identity safety: an inherited/foreign SYNAP_HUB_API_KEY (e.g. another
  // agent's key) is otherwise invisible — surface it loudly, not clean.
  if (pod.identityMismatch) l2.push(`${R}⚠ as ${pod.actingAgentLabel || "unknown"}${X}`);
  // PROJECT leads the lens fields — it's the "what am I working on" answer.
  // cmd/ctrl-click opens the project home in the Synap app via the /open bounce
  // (`project` is registered in apps/api/src/index.ts ALLOWED + handled by the
  // browser deep-link handler, which switches the lens + lands on home).
  // OSC 8 degrades to plain text where the terminal/renderer doesn't support it.
  if (hasProject) {
    const projectLink = pod.podUrl ? `${pod.podUrl}/open/project/${pod.projectId}` : "";
    l2.push(`${BB}${osc8(projectLink, described.structured.project?.name ?? pod.projectId)}${X}`);
  }
  if (hasWs) {
    // Same /open bounce — `workspace` switches the workspace lens + lands on home.
    const wsLink = pod.podUrl && activeWsId ? `${pod.podUrl}/open/workspace/${activeWsId}` : "";
    l2.push(activeWsId ? osc8(wsLink, activeWs ?? "") : activeWs ?? "");
    if (activeWsCount > 0) l2.push(`${compact(activeWsCount)} entities`);
  } else if (described.structured.podWide) {
    l2.push(`${D}pod-wide${X}`);
  }
  if (pod.skillCount > 0) l2.push(`${pod.skillCount} skills`);
  if (pod.sessionGoal) {
    const sg = pod.sessionId ? osc8(`synap://open/session/${pod.sessionId}`, pod.sessionGoal) : pod.sessionGoal;
    l2.push(`${D}▸${X} ${Y}${sg}${X}`);
  }
  if (pod.needsYouCount > 0) {
    // cmd/ctrl-click opens the review queue via the pod's /open bounce (bare
    // `proposals` keyword): the one door the pod URL alone reaches. Pod admin's
    // Home lists every needs-you kind, but it lives on its own host.
    const needsYouLink = pod.podUrl ? `${pod.podUrl}/open/proposals` : "";
    const label = `${pod.needsYouCount}${pod.needsYouTruncated ? "+" : ""} need you`;
    l2.push(`${D}↳${X} ${Y}${needsYouLink ? osc8(needsYouLink, label) : label}${X}`);
  } else if (pod.needsYouFetched) {
    // Genuinely fetched and empty — distinct from "never fetched" so the line
    // never silently omits a signal a user might mistake for "not checked yet".
    l2.push(`${D}↳ 0 need you${X}`);
  } else {
    // No successful refresh has completed yet (fresh cache / all refreshes failed).
    l2.push(`${D}↳ need you —${X}`);
  }
  console.log(l2.join(" · "));

  // ─═─ LINE 3 — cost · rate limits · session stats ─═─────────────────────
  const l3: string[] = [];
  if (cost !== undefined && cost > 0) {
    l3.push(`${D}$${cost.toFixed(2)}${X}`);
    if (linesAdd > 0) l3.push(`${D}+${linesAdd}/-${linesDel}${X}`);
  }
  if (fhPct !== undefined) {
    if (l3.length) l3.push(`${D}│${X}`);
    l3.push(`${D}5h${X} ${rateColor(fhPct)}${Math.round(fhPct)}%${X}`);
  }
  if (sdPct !== undefined) l3.push(`${D}7d${X} ${rateColor(sdPct)}${Math.round(sdPct)}%${X}`);
  if (fhReset !== undefined && (fhPct ?? 0) >= 60) {
    const rem = fhReset - Math.floor(Date.now() / 1000);
    if (rem > 0) l3.push(`${D}resets ${Math.floor(rem / 3600)}h${String(Math.floor((rem % 3600) / 60)).padStart(2, "0")}${X}`);
  }
  if (callCount > 0) {
    if (l3.length) l3.push(`${D}│${X}`);
    l3.push(`${D}${compact(callCount)} calls · ${sessionCount} sessions${X}`);
  }
  if (l3.length) console.log(l3.join("  "));

  // ─═─ LINE 4 — now: working / needs you / waiting on … / stopped ─═──────
  console.log(
    buildNowLine({
      now: Date.now(),
      registry: claudeSessionId ? readRegistry(claudeSessionId) : null,
      open: index ? Object.values(index.open) : [],
      waits: claudeSessionId ? readWaits(claudeSessionId) : [],
      width: widthOf(cc),
      lastActivityAt: index?.lastEventAt || undefined,
      alive: pidAlive,
    })
  );
}

// ── Entry ──────────────────────────────────────────────────────────────

/**
 * The checked-out branch of `cwd`, or "" when it is not a git repo.
 *
 * `cwd` comes from Claude Code's statusline JSON: any directory the person
 * opened, cloned repos included. It goes to git as ONE argv word, no shell:
 * a `JSON.stringify`-quoted path in a shell string still ran `$(…)` and
 * backticks in a directory name, on every statusline refresh.
 */
export function gitBranchOf(cwd: string): string {
  try {
    return execFileSync("git", ["-C", cwd, "--no-optional-locks", "symbolic-ref", "--short", "HEAD"], {
      encoding: "utf-8",
      timeout: 1000,
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return ""; // not a git repo (or git missing): the segment is left out
  }
}

export async function statusline(opts?: { refresh?: boolean }): Promise<void> {
  if (opts?.refresh) {
    await refresh();
  } else {
    render();
  }
}
