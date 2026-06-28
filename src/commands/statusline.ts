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

const CACHE_FILE = "/tmp/synap-statusline-cache.json";
const LOCK_FILE = "/tmp/synap-statusline-refresh.lock";
// The pod sits behind a strict edge rate-limiter (15-min window) shared with
// the agent's own traffic on the same key. Keep statusline cost minimal:
// refresh at most once per 120s, and only 3 GETs per refresh.
const REFRESH_TTL_MS = 120_000;
const LOCK_STALE_MS = 30_000; // a lock older than this is considered dead

// ── ANSI + OSC 8 helpers ───────────────────────────────────────────────

const G = "\x1b[01;32m"; // green bold
const Y = "\x1b[01;33m"; // yellow bold
const R = "\x1b[01;31m"; // red bold
const C = "\x1b[36m"; // cyan
const B = "\x1b[34m"; // blue
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
  workspaces: Array<{ id: string; name: string; count: number }>;
  projectName: string;
  projectId: string;
  skillCount: number;
  proposalCount: number;
  sessionGoal: string;
  sessionId: string;
  totalEntities: number;
}

function emptyCache(): PodCache {
  return { ts: 0, ok: false, workspaces: [], projectName: "", projectId: "", skillCount: 0, proposalCount: 0, sessionGoal: "", sessionId: "", totalEntities: 0 };
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

function triggerRefresh(): void {
  if (lockIsFresh()) return; // a refresh is already running
  try {
    const entry = process.argv[1]; // the CLI entry script
    const child = spawn(process.execPath, [entry, "statusline", "--refresh"], {
      detached: true,
      stdio: "ignore",
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

    // Minimal 3-call burst (the pod's edge limiter is shared with agent
    // traffic). `/workspaces` succeeding doubles as the liveness signal — no
    // separate `/health` call. Project lens is deferred to the aggregation
    // endpoint (a server-side join — free there, 2 extra calls here).
    const [ws, skills, sessions] = await Promise.allSettled([
      hubGet("/workspaces", {}, cfg),
      hubGet("/agent-skills?limit=1", {}, cfg),
      hubGet("/focus-sessions?status=active&limit=1", {}, cfg),
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

    let sessionGoal = prev?.sessionGoal ?? "";
    let sessionId = prev?.sessionId ?? "";
    if (sessions.status === "fulfilled") {
      const s = (sessions.value as { sessions?: Array<{ id: string; goal?: string }> })?.sessions?.[0];
      sessionGoal = s?.goal?.slice(0, 60) ?? "";
      sessionId = s?.id ?? "";
    }

    const out: PodCache = {
      ts: Date.now(),
      ok: true,
      workspaces,
      projectName: "", // deferred to aggregation endpoint
      projectId: "",
      skillCount,
      proposalCount: prev?.proposalCount ?? 0, // deferred to aggregation endpoint
      sessionGoal,
      sessionId,
      totalEntities,
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

  const cache = readCache();
  // Trigger a background refresh if cache is missing or stale.
  if (!cache || Date.now() - cache.ts > REFRESH_TTL_MS) triggerRefresh();

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
  const activeWs = pod.workspaces[0]?.name ?? "synap";
  const activeWsId = pod.workspaces[0]?.id ?? "";

  // ─═─ LINE 1 — model · context bar · branch · vim ─═─────────────────────
  const l1: string[] = [];
  if (modelName) {
    l1.push(`${C}${modelName}${X}`);
    if (branch) l1.push(`${D}${branch}${X}`);
    if (vimMode && vimMode !== "NORMAL") l1.push(`${M}${vimMode}${X}`);
  }
  if (ctxPct !== undefined) l1.push(` ${bar(ctxPct)} ${ctxColor(ctxPct)}${Math.round(ctxPct)}%${X}`);
  if (l1.length) console.log(l1.join("  "));

  // ─═─ LINE 2 — pod dot · workspace · project · session · metrics ─═──────
  const l2: string[] = [dot];
  l2.push(activeWsId ? osc8(`synap://workspace/${activeWsId}`, activeWs) : activeWs);
  if (pod.totalEntities > 0) l2.push(`${compact(pod.totalEntities)} entities`);
  if (pod.skillCount > 0) l2.push(`${pod.skillCount} skills`);
  if (pod.projectName) l2.push(`${D}▸${X} ${B}${pod.projectName}${X}`);
  if (pod.sessionGoal) {
    const sg = pod.sessionId ? osc8(`synap://open/session/${pod.sessionId}`, pod.sessionGoal) : pod.sessionGoal;
    l2.push(`${D}▸${X} ${Y}${sg}${X}`);
  }
  if (pod.proposalCount > 0) l2.push(`${D}↳${X} ${Y}${pod.proposalCount} proposals${X}`);
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
