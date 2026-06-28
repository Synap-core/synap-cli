/**
 * synap statusline — compact ANSI output for the Claude Code statusLine.
 *
 * Fetches pod health, workspace, entity counts, skills — formats one
 * ANSI-colored line. All HTTP calls are timeout-bounded. Results cached
 * in /tmp for 15s to avoid redundant roundtrips per render cycle.
 */

import fs from "node:fs";
import { resolveHubConfig, hubGet } from "../lib/hub-client.js";

const CACHE_FILE = "/tmp/synap-statusline-cache.json";
const CACHE_TTL_MS = 15_000;

interface StatuslineCache {
  ts: number;
  dot: string;
  ws: string;
  entityCount: number;
  skillCount: number;
  sessionGoal: string;
}

function cacheGet(): StatuslineCache | null {
  try {
    const raw = fs.readFileSync(CACHE_FILE, "utf-8");
    const c: StatuslineCache = JSON.parse(raw);
    if (Date.now() - c.ts < CACHE_TTL_MS) return c;
  } catch {}
  return null;
}

function cacheSet(c: Omit<StatuslineCache, "ts">): void {
  try {
    fs.writeFileSync(
      CACHE_FILE,
      JSON.stringify({ ...c, ts: Date.now() })
    );
  } catch {}
}

async function fetchSynapData() {
  const cached = cacheGet();
  if (cached) return cached;

  let dot = "\x1b[90m○\x1b[0m"; // grey circle = not yet checked
  let ws = "synap";
  let entityCount = 0;
  let skillCount = 0;
  let sessionGoal = "";

  try {
    const cfg = await resolveHubConfig({});
    if (!cfg.podUrl || !cfg.apiKey) return { dot, ws, entityCount, skillCount, sessionGoal };

    // Pod health (fast)
    try {
      const health = (await hubGet("", {}, cfg)) as { status?: string };
      if (health?.status === "ok") dot = "\x1b[32m●\x1b[0m";
    } catch {
      dot = "\x1b[31m○\x1b[0m";
    }

    // Workspaces + entity counts
    try {
      const res = (await hubGet("/workspaces", {}, cfg)) as {
        workspaces?: Array<{ name: string; entityCount: number }>;
      };
      const workspaces = res?.workspaces ?? [];
      entityCount = workspaces.reduce((s, w) => s + (w.entityCount ?? 0), 0);
      ws = workspaces[0]?.name ?? "synap";
    } catch {}

    // Skills count
    try {
      const res = (await hubGet("/agent-skills?limit=1", {}, cfg)) as { total?: number };
      skillCount = res?.total ?? 0;
    } catch {}

    // Active focus session goal (brief)
    try {
      const res = (await hubGet("/focus-sessions?status=active&limit=1", {}, cfg)) as {
        sessions?: Array<{ goal?: string }>;
      };
      const goal = res?.sessions?.[0]?.goal;
      if (goal) sessionGoal = goal.slice(0, 50);
    } catch {}
  } catch {}

  const result = { dot, ws, entityCount, skillCount, sessionGoal };
  cacheSet(result);
  return result;
}

export async function statusline(): Promise<void> {
  const d = await fetchSynapData();
  const parts: string[] = [];

  // Pod indicator + workspace name
  parts.push(`${d.dot} ${d.ws}`);

  // Entity count (compact)
  if (d.entityCount > 0) {
    const label =
      d.entityCount >= 1000
        ? `${(d.entityCount / 1000).toFixed(0)}K`
        : String(d.entityCount);
    parts.push(`${label} entities`);
  }

  // Skills
  if (d.skillCount > 0) {
    parts.push(`${d.skillCount} skills`);
  }

  // Active session goal
  if (d.sessionGoal) {
    parts.push(d.sessionGoal);
  }

  console.log(parts.join(" · "));
}
