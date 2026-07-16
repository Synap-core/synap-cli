/**
 * synap statusline — full 3-line ANSI status for the Claude Code statusLine.
 *
 * Two modes, both via `synap statusline`:
 *
 *   RENDER (default)   Parse the Claude Code JSON from stdin, read the pod
 *                      cache file (NO network), compose 3 ANSI lines, print,
 *                      exit. Always instant. If the cache is stale it spawns a
 *                      detached refresh (fire-and-forget) so the NEXT render is
 *                      fresh — this render never blocks on the network.
 *
 *   REFRESH (--refresh) Fetch pod data in a single parallel burst and write the
 *                      cache. Lock-guarded so only one refresh runs at a time.
 *                      On error/429, the last good cache is preserved (the dot
 *                      goes stale, not blank).
 *
 * Why: Claude Code calls the statusline on every render (debounced ~300ms +
 * periodic refresh). Fetching live pod data synchronously per render hammers
 * the pod's 100-req/min budget → 429 → red dot. Decoupling render from fetch
 * caps pod traffic at ~1 burst / REFRESH_TTL regardless of render frequency.
 */

import fs from "node:fs";
import os from "node:os";
import { execSync, spawn } from "node:child_process";
import { resolveHubConfig, hubGet } from "../lib/hub-client.js";
import { resolveActiveLens } from "../lib/session-lens.js";
import { describeLens } from "../lib/describe-lens.js";
import { getSurfaceAgentKey, SURFACE_NAMES } from "../lib/pod.js";

const CACHE_FILE = "/tmp/synap-statusline-cache.json";
const LOCK_FILE = "/tmp/synap-statusline-refresh.lock";
// The pod sits behind a strict edge rate-limiter (15-min window) shared with
// the agent's own traffic on the same key. Keep statusline cost minimal:
// refresh at most once per 120s; the burst is ~4-6 GETs (workspaces, skills,
// session, proposals, + conditional project/identity). Fold new fields into an
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
  ok: boolean; // last fetch reached the pod
  podUrl: string; // this connection's pod — lets render() build /open bounce links with no network
  activeWorkspaceId: string; // the workspace THIS connection is scoped to (cfg.workspaceId)
  workspaces: Array<{ id: string; name: string; count: number }>;
  projectName: string;
  projectId: string;
  skillCount: number;
  proposalCount: number;
  proposalsFetched: boolean; // false only until the first successful refresh ever completes
  sessionGoal: string;
  sessionId: string;
  totalEntities: number;
  // Identity safety (Task: agent-identity visibility). Computed once per
  // refresh so render() stays pod-call-free. See findSurfaceLabelForKey below.
  actingAgentLabel: string; // friendly label for the ACTING agent, only set when it differs from the expected claude-code identity
  identityMismatch: boolean; // true iff we have an expected identity AND the acting one diverges from it
}

function emptyCache(): PodCache {
  return {
    ts: 0, ok: false, podUrl: "", activeWorkspaceId: "", workspaces: [], projectName: "", projectId: "",
    skillCount: 0, proposalCount: 0, proposalsFetched: false, sessionGoal: "", sessionId: "", totalEntities: 0,
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

function readCache(): PodCache | null {
  try {
    return JSON.parse(fs.readFileSync(CACHE_FILE, "utf-8")) as PodCache;
  } catch {
    return null;
  }
}

// ── Detached refresh trigger (fire-and-forget) ─────────────────────────

function lockIsFresh(): boolean {
  try {
    return Date.now() - fs.statSync(LOCK_FILE).mtimeMs < LOCK_STALE_MS;
  } catch {
    return false;
  }
}

function triggerRefresh(claudeSessionId?: string): void {
  if (lockIsFresh()) return; // a refresh is already running
  try {
    const entry = process.argv[1]; // the CLI entry script
    // The detached refresh has no Claude env of its own — forward the session
    // id (from stdin) so its resolveHubConfig/lens picks the right workspace.
    const env = claudeSessionId
      ? { ...process.env, SYNAP_LENS_SESSION: claudeSessionId }
      : process.env;
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

async function refresh(): Promise<void> {
  if (lockIsFresh()) return; // another refresh owns the window
  try {
    fs.writeFileSync(LOCK_FILE, String(process.pid));
  } catch {
    /* ignore */
  }

  const prev = readCache();
  try {
    const cfg = await resolveHubConfig({});
    if (!cfg.podUrl || !cfg.apiKey) return;

    // This connection's per-Claude-session lens (forwarded as SYNAP_LENS_SESSION
    // by the render process). Drives WHICH project/session we show — the bound
    // ones, not a global guess.
    const lens = resolveActiveLens();

    // Minimal burst (the pod's edge limiter is shared with agent traffic).
    // `/workspaces` succeeding doubles as the liveness signal — no separate
    // `/health`. The bound focus-session and project are fetched by id only
    // when the lens has them (0–2 extra calls).
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

    // Pending proposals — the one actionable ambient signal. No dedicated
    // count endpoint exists yet (verified: `/proposals` returns `{ proposals: [] }`,
    // no `total`); a high `limit` on the pending-only list is the cheapest
    // accurate count within the burst budget (a personal pod won't realistically
    // clear 1000 pending proposals before this undercounts).
    const proposalsReq = hubGet("/proposals", { status: "pending", limit: 1000 }, cfg);

    const [ws, skills, session, project, identity, proposals] = await Promise.allSettled([
      hubGet("/workspaces", {}, cfg),
      hubGet("/agent-skills?limit=1", {}, cfg),
      sessionReq,
      projectReq,
      identityReq,
      proposalsReq,
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
    let projectId = resolvedProjectId ?? "";
    if (project.status === "fulfilled" && project.value) {
      const p = (project.value as { projects?: Array<{ id: string; name: string }> })?.projects?.find((x) => x.id === resolvedProjectId);
      projectName = p?.name?.slice(0, 30) ?? "";
    }

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

    // Only a well-shaped array counts as "fetched" — a malformed 200 must not
    // masquerade as "0 pending"; it falls back to the last-good count instead.
    const proposalsRaw =
      proposals.status === "fulfilled"
        ? (proposals.value as { proposals?: unknown[] })?.proposals
        : undefined;
    const proposalsFetched = Array.isArray(proposalsRaw);
    const proposalCount = Array.isArray(proposalsRaw)
      ? proposalsRaw.length
      : prev?.proposalCount ?? 0;

    const out: PodCache = {
      ts: Date.now(),
      ok: true,
      podUrl: cfg.podUrl,
      activeWorkspaceId: cfg.workspaceId ?? "", // the lens THIS connection resolves to
      workspaces,
      projectName,
      projectId,
      skillCount,
      proposalCount,
      proposalsFetched: proposalsFetched || (prev?.proposalsFetched ?? false),
      sessionGoal,
      sessionId,
      totalEntities,
      actingAgentLabel,
      identityMismatch,
    };

    fs.writeFileSync(CACHE_FILE, JSON.stringify(out));
  } catch {
    // Preserve last good cache, just mark it not-ok so render can dim the dot.
    if (prev) {
      try { fs.writeFileSync(CACHE_FILE, JSON.stringify({ ...prev, ok: false })); } catch {}
    }
  } finally {
    try { fs.unlinkSync(LOCK_FILE); } catch {}
  }
}

// ── RENDER mode: stdin + cache → 3 lines (no network) ──────────────────

function render(): void {
  let cc: Record<string, unknown> = {};
  try {
    const raw = fs.readFileSync(0, "utf-8");
    if (raw?.trim()) cc = JSON.parse(raw);
  } catch {}

  // The Claude session id — forwarded to the detached refresh so it resolves
  // THIS session's lens (workspace/project/session), not a global guess.
  const claudeSessionId = (cc.session_id as string | undefined) || process.env.CLAUDE_CODE_SESSION_ID;

  const cache = readCache();
  // Trigger a background refresh if cache is missing or stale.
  if (!cache || Date.now() - cache.ts > REFRESH_TTL_MS) triggerRefresh(claudeSessionId);

  const pod = cache ?? emptyCache();

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
  const cwd = (cc.cwd ?? "") as string;

  let branch = "";
  if (cwd) {
    try { branch = execSync(`git -C ${JSON.stringify(cwd)} --no-optional-locks symbolic-ref --short HEAD`, { encoding: "utf-8", timeout: 1000, stdio: ["ignore", "pipe", "ignore"] }).trim(); }
    catch { /* not a git repo */ }
  }

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
  if (pod.proposalCount > 0) {
    // cmd/ctrl-click opens the Proposals review app via the /open bounce
    // (bare `proposals` keyword → synap://open/proposals → browser opens the app).
    const proposalsLink = pod.podUrl ? `${pod.podUrl}/open/proposals` : "";
    const label = `${pod.proposalCount} proposals`;
    l2.push(`${D}↳${X} ${Y}${proposalsLink ? osc8(proposalsLink, label) : label}${X}`);
  } else if (pod.proposalsFetched) {
    // Genuinely fetched and empty — distinct from "never fetched" so the line
    // never silently omits a signal a user might mistake for "not checked yet".
    l2.push(`${D}↳ 0 proposals${X}`);
  } else {
    // No successful refresh has completed yet (fresh cache / all refreshes failed).
    l2.push(`${D}↳ proposals —${X}`);
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
}

// ── Entry ──────────────────────────────────────────────────────────────

export async function statusline(opts?: { refresh?: boolean }): Promise<void> {
  if (opts?.refresh) {
    await refresh();
  } else {
    render();
  }
}
