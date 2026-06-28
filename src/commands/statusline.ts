/**
 * synap statusline — full 3-line ANSI status for the Claude Code statusLine.
 *
 * Reads the Claude Code JSON payload from stdin (model, context%, cost, rate
 * limits, vim mode, git branch, session_id) and cross-references it with live
 * Synap pod data (workspace, project, focus session, entity/skill counts,
 * proposals). Outputs 3 ANSI-colored lines with OSC 8 clickable links for
 * workspace/project/session switching.
 *
 * Architecture: the CLI is the single data bus — it reads stdin (Claude state)
 * AND queries the pod (Synap state), then composes all 3 lines. The shell
 * wrapper (~/.claude/synap-status.sh) is a 2-line pass-through.
 *
 * Cache: pod API results cached in /tmp for 15s (shared across statusline
 * renders in the same refresh cycle).
 */

import fs from "node:fs";
import os from "node:os";
import { execSync } from "node:child_process";
import { resolveHubConfig, hubGet } from "../lib/hub-client.js";

const CACHE_FILE = "/tmp/synap-statusline-cache.json";
const CACHE_TTL_MS = 15_000;

// ── ANSI + OSC 8 helpers ───────────────────────────────────────────────

const G = "\x1b[01;32m"; // green bold
const Y = "\x1b[01;33m"; // yellow bold
const R = "\x1b[01;31m"; // red bold
const C = "\x1b[36m"; // cyan
const M = "\x1b[35m"; // magenta
const B = "\x1b[34m"; // blue
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
  const filled = Math.round((pct / 100) * width);
  const empty = width - filled;
  return ctxColor(pct) + "▰".repeat(filled) + D + "▱".repeat(empty) + X;
}

function compact(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1000).toFixed(0)}K`;
  return String(n);
}

// ── Cache ──────────────────────────────────────────────────────────────

interface PodCache {
  ts: number;
  dot: string;
  workspaces: Array<{ id: string; name: string; count: number }>;
  projectName: string;
  projectId: string;
  skillCount: number;
  proposalCount: number;
  sessionGoal: string;
  sessionId: string;
  totalEntities: number;
}

function cacheGet(): PodCache | null {
  try {
    const raw = fs.readFileSync(CACHE_FILE, "utf-8");
    const c: PodCache = JSON.parse(raw);
    if (Date.now() - c.ts < CACHE_TTL_MS) return c;
  } catch {}
  return null;
}
function cacheSet(c: Omit<PodCache, "ts">) {
  fs.writeFileSync(CACHE_FILE, JSON.stringify({ ...c, ts: Date.now() }));
}

// ── Pod data fetcher ───────────────────────────────────────────────────

async function fetchPod(): Promise<Omit<PodCache, "ts">> {
  const cached = cacheGet();
  if (cached) return cached;

  let dot = `${D}○${X}`;
  const workspaces: PodCache["workspaces"] = [];
  let projectName = "";
  let projectId = "";
  let skillCount = 0;
  let proposalCount = 0;
  let sessionGoal = "";
  let sessionId = "";
  let totalEntities = 0;

  try {
    const cfg = await resolveHubConfig({});
    if (!cfg.podUrl || !cfg.apiKey) {
      const r = { dot, workspaces, projectName, projectId, skillCount, proposalCount, sessionGoal, sessionId, totalEntities };
      cacheSet(r);
      return r;
    }

    // Pod health
    try { const h = (await hubGet("/health", {}, cfg)) as { status?: string }; if (h?.status === "ok") dot = `${G}●${X}`; }
    catch { dot = `${R}○${X}`; }

    // Workspaces
    try {
      const res = (await hubGet("/workspaces", {}, cfg)) as { workspaces?: Array<{ id: string; name: string; entityCount: number }> };
      for (const w of res?.workspaces ?? []) {
        workspaces.push({ id: w.id, name: w.name, count: w.entityCount ?? 0 });
        totalEntities += w.entityCount ?? 0;
      }
    } catch {}

    // Skills
    try { const res = (await hubGet("/agent-skills?limit=1", {}, cfg)) as { total?: number }; skillCount = res?.total ?? 0; } catch {}

    // Pending proposals
    try { const res = (await hubGet("/proposals?status=pending&limit=1", {}, cfg)) as { total?: number }; proposalCount = res?.total ?? 0; } catch {}

    // Active focus session
    try {
      const res = (await hubGet("/focus-sessions?status=active&limit=1", {}, cfg)) as { sessions?: Array<{ id: string; goal?: string }> };
      const s = res?.sessions?.[0];
      if (s) { sessionGoal = s.goal?.slice(0, 60) ?? ""; sessionId = s.id; }
    } catch {}

    // Active project (from profile)
    try {
      const me = (await hubGet("/users/me", {}, cfg)) as { settings?: Record<string, unknown> };
      const pid = me?.settings?.activeProjectId as string | undefined;
      if (pid) {
        projectId = pid;
        const projs = (await hubGet(`/projects?ids=${pid}`, {}, cfg)) as { projects?: Array<{ name: string }> };
        projectName = projs?.projects?.[0]?.name?.slice(0, 30) ?? "";
      }
    } catch {}
  } catch {}

  const result = { dot, workspaces, projectName, projectId, skillCount, proposalCount, sessionGoal, sessionId, totalEntities };
  cacheSet(result);
  return result;
}

// ── Main ───────────────────────────────────────────────────────────────

export async function statusline(): Promise<void> {
  // Read Claude Code JSON from stdin (piped by the statusline script)
  let cc: Record<string, unknown> = {};
  try {
    const raw = fs.readFileSync(0, "utf-8"); // fd 0 = stdin
    if (raw?.trim()) cc = JSON.parse(raw);
  } catch {}

  const pod = await fetchPod();

  // ── Parse Claude Code fields ─────────────────────────────────────────
  const modelName = ((cc.model as { display_name?: string })?.display_name ?? "").replace(/\(1M context\)|\(200K context\)/, "").trim();
  const ctxPct = (cc.context_window as { used_percentage?: number })?.used_percentage;
  const cost = (cc.cost as { total_cost_usd?: number })?.total_cost_usd;
  const linesAdd = (cc.cost as { total_lines_added?: number })?.total_lines_added ?? 0;
  const linesDel = (cc.cost as { total_lines_removed?: number })?.total_lines_removed ?? 0;
  const fhPct = (cc.rate_limits as Record<string, { used_percentage?: number }>)?.five_hour?.used_percentage;
  const sdPct = (cc.rate_limits as Record<string, { used_percentage?: number }>)?.seven_day?.used_percentage;
  const fhReset = (cc.rate_limits as Record<string, { resets_at?: number }>)?.five_hour?.resets_at;
  const vimMode = (cc.vim as { mode?: string })?.mode;
  const cwd = (cc.cwd ?? "") as string;

  // Git branch
  let branch = "";
  if (cwd) {
    try { branch = execSync(`git -C ${JSON.stringify(cwd)} --no-optional-locks symbolic-ref --short HEAD`, { encoding: "utf-8", timeout: 1000, stdio: ["ignore", "pipe", "ignore"] }).trim(); }
    catch { /* not a git repo */ }
  }

  // ── Session stats ────────────────────────────────────────────────────
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

  // ── Active workspace name ─────────────────────────────────────────────
  const activeWs = pod.workspaces[0]?.name ?? "synap";
  const activeWsId = pod.workspaces[0]?.id ?? "";

  // ─═─ LINE 1 ─ Claude session: model + context bar + branch + vim ─═───
  const l1: string[] = [];
  if (modelName) {
    l1.push(`${C}${modelName}${X}`);
    if (branch) l1.push(`${D}${branch}${X}`);
    if (vimMode && vimMode !== "NORMAL") l1.push(`${M}${vimMode}${X}`);
  }
  if (ctxPct !== undefined) {
    l1.push(` ${bar(ctxPct)} ${ctxColor(ctxPct)}${Math.round(ctxPct)}%${X}`);
  }
  if (l1.length) console.log(l1.join("  "));

  // ─═─ LINE 2 ─ Synap lenses: workspace · project · session + metrics ─═─
  const l2: string[] = [];
  l2.push(pod.dot);

  // Workspace (clickable: switch to this workspace)
  l2.push(osc8(`synap://workspace/${activeWsId}`, activeWs));

  // Entity count
  if (pod.totalEntities > 0) l2.push(`${compact(pod.totalEntities)} entities`);

  // Skills
  if (pod.skillCount > 0) l2.push(`${pod.skillCount} skills`);

  // Project (if active)
  if (pod.projectName) {
    l2.push(`${D}▸${X} ${B}${pod.projectName}${X}`);
  }

  // Session (if active) — clickable
  if (pod.sessionGoal) {
    l2.push(`${D}▸${X} ${Y}${pod.sessionGoal}${X}`);
  }

  // Proposals
  if (pod.proposalCount > 0) {
    l2.push(`${D}↳${X} ${Y}${pod.proposalCount} proposals${X}`);
  }

  if (l2.length) console.log(l2.join(" · "));

  // ─═─ LINE 3 ─ Cost + rate limits + session stats ─═════════════════───
  const l3: string[] = [];
  if (cost !== undefined && cost > 0) {
    l3.push(`${D}$${cost.toFixed(2)}${X}`);
    if (linesAdd > 0) l3.push(`${D}+${linesAdd}/-${linesDel} lines${X}`);
  }

  if (fhPct !== undefined) {
    if (l3.length) l3.push(`${D}│${X}`);
    l3.push(`${D}5h${X} ${rateColor(fhPct)}${Math.round(fhPct)}%${X}`);
  }
  if (sdPct !== undefined) {
    l3.push(`${D}7d${X} ${rateColor(sdPct)}${Math.round(sdPct)}%${X}`);
  }
  if (fhReset !== undefined && (fhPct ?? 0) >= 60) {
    const rem = fhReset - Math.floor(Date.now() / 1000);
    if (rem > 0) {
      const h = Math.floor(rem / 3600);
      const m = Math.floor((rem % 3600) / 60);
      l3.push(`${D}resets ${h}h${String(m).padStart(2, "0")}${X}`);
    }
  }

  // Session stats
  if (callCount > 0) {
    if (l3.length) l3.push(`${D}│${X}`);
    l3.push(`${D}${compact(callCount)} calls · ${sessionCount} sessions${X}`);
  }

  if (l3.length) console.log(l3.join("  "));
}
