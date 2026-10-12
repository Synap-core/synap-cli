/**
 * Key health for one pod: read every copy, ask the pod about each key, print
 * one diagnosis per problem — and, with `--fix`, do the one right thing.
 *
 * The fix never writes a key the pod has not confirmed live (`assertKeyWritable`),
 * and it ends with a real MCP `initialize` against `/mcp` using the key it
 * wrote: a fix is only reported ✓ when that call succeeds.
 */

import fs from "node:fs";
import os from "node:os";
import chalk from "chalk";
import { log } from "../utils/logger.js";
import { collectKeyLocations, type KeyLocation } from "./key-locations.js";
import { diagnoseKeys, type Diagnosis } from "./key-diagnosis.js";
import { fetchKeyState, assertKeyWritable, type FetchLike, type KeyState } from "./key-state.js";
import { machineInstanceId } from "./machine-instance.js";

export interface KeyHealthReport {
  podUrl: string;
  locations: KeyLocation[];
  states: Map<string, KeyState>;
  diagnoses: Diagnosis[];
  /** True when the pod answered the holder door for at least one key (vs an older pod). */
  podDescribesKeys: boolean;
}

export interface KeyHealthDeps {
  home?: string;
  envKey?: string;
  envPodUrl?: string;
  fetch?: FetchLike;
  instanceIdFor?: (surface: string) => string;
  labelOf?: (surface: string) => string;
}

async function targetLabel(surface: string): Promise<string> {
  try {
    const { TARGETS } = await import("./targets.js");
    return (TARGETS as Record<string, { label?: string }>)[surface]?.label ?? surface;
  } catch {
    return surface;
  }
}

export async function checkKeyHealth(podUrl: string, deps: KeyHealthDeps = {}): Promise<KeyHealthReport> {
  const locations = collectKeyLocations({
    home: deps.home ?? os.homedir(),
    podUrl,
    envKey: "envKey" in deps ? deps.envKey : process.env.SYNAP_HUB_API_KEY,
    envPodUrl: "envPodUrl" in deps ? deps.envPodUrl : process.env.SYNAP_POD_URL,
  });
  const keys = [...new Set(locations.map((l) => l.key))];
  const answers = await Promise.all(keys.map((k) => fetchKeyState(podUrl, k, { fetch: deps.fetch })));
  const states = new Map(keys.map((k, i) => [k, answers[i]!]));
  const labels = new Map<string, string>();
  for (const s of new Set(locations.map((l) => l.surface).filter((x): x is string => !!x)))
    labels.set(s, deps.labelOf ? deps.labelOf(s) : await targetLabel(s));
  const envKey = locations.find((l) => l.kind === "process-env")?.key;
  return {
    podUrl,
    locations,
    states,
    podDescribesKeys: answers.some((a) => !a.legacy && a.state !== "unreachable"),
    diagnoses: diagnoseKeys({
      locations,
      states,
      envKey,
      instanceIdFor: deps.instanceIdFor ?? ((s) => machineInstanceId(s)),
      labelOf: (s) => labels.get(s) ?? s,
    }),
  };
}

/** The problems only — `ok` diagnoses are summarised, not listed. */
export function keyProblems(report: KeyHealthReport): Diagnosis[] {
  return report.diagnoses.filter((d) => d.code !== "ok");
}

export function printKeyHealth(report: KeyHealthReport, opts: { fixHint?: boolean } = {}): void {
  const problems = keyProblems(report);
  const ok = report.diagnoses.filter((d) => d.code === "ok");
  for (const d of ok) console.log(`  ${chalk.green("✓")} ${d.title}`);
  for (const d of problems) {
    const mark = d.severity === "error" ? chalk.red("✗") : chalk.yellow("!");
    console.log(`  ${mark} ${chalk.bold(d.title)}`);
    for (const line of d.lines) log.dim(`     ${line}`);
    if (d.command) log.dim(`     → ${d.command}`);
  }
  if (report.locations.length === 0) log.dim("  No Synap key is configured for this pod on this computer.");
  if (!report.podDescribesKeys && report.locations.length > 0)
    log.dim("  (This pod predates the key-state door: it can say a key fails, not why. Update the pod for precise reasons.)");
  if (opts.fixHint && problems.some((d) => d.action !== "none" && d.action !== "login" && d.action !== "edit_shell_rc"))
    log.dim(`  Fix it: ${chalk.cyan("synap doctor --fix")}`);
}

// ─── --fix ────────────────────────────────────────────────────────────────

function editJson(file: string, edit: (j: Record<string, any>) => boolean): boolean {
  let json: Record<string, any>;
  try {
    json = JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, any>;
  } catch {
    return false;
  }
  if (!edit(json)) return false;
  const mode = (() => {
    try {
      return fs.statSync(file).mode & 0o777;
    } catch {
      return 0o600;
    }
  })();
  fs.writeFileSync(file, JSON.stringify(json, null, 2) + "\n", { mode });
  return true;
}

/**
 * Write `key` into every rewritable copy of `surface` for this pod — ONLY after
 * the pod confirms it is live. Returns the labels rewritten.
 */
/** Returns every copy that now holds the live key (rewritten or already there). */
export async function rewriteSurfaceKey(
  report: KeyHealthReport,
  surface: string,
  key: string,
  agentUserId: string | undefined,
  deps: { fetch?: FetchLike } = {}
): Promise<string[]> {
  await assertKeyWritable(report.podUrl, key, deps);
  const pod = await import("./pod.js");
  let agentId = agentUserId;
  if (!agentId) {
    // The pod names the key's owner — the agent — on its own status door.
    const res = await (deps.fetch ?? fetch)(`${report.podUrl.replace(/\/+$/, "")}/api/hub/auth/status`, {
      headers: { Authorization: `Bearer ${key}` },
      signal: AbortSignal.timeout(15_000),
    }).catch(() => null);
    if (res?.ok) agentId = ((await res.json().catch(() => ({}))) as { userId?: string }).userId;
  }
  const done: string[] = report.locations.filter((l) => l.surface === surface && l.key === key && l.kind !== "pending").map((l) => l.label);
  pod.setSurfaceAgentKey(surface as import("./pod.js").SurfaceName, { hubApiKey: key, agentUserId: agentId ?? "", podUrl: report.podUrl });
  pod.clearPendingAgentKey(surface, report.podUrl);
  if (!done.some((l) => l.includes(".synap/config.json"))) done.push("~/.synap/config.json → agentKeysByPod." + surface);
  for (const loc of report.locations.filter((l) => l.surface === surface && l.rewritable && l.key !== key)) {
    if (loc.kind === "claude-settings-env" && loc.file)
      editJson(loc.file, (j) => {
        if (!j.env || typeof j.env !== "object") return false;
        j.env.SYNAP_HUB_API_KEY = key;
        return true;
      }) && done.push(loc.label);
    if (loc.kind === "claude-mcp-header" && loc.file && loc.ref)
      editJson(loc.file, (j) => {
        const s = j.mcpServers?.[loc.ref!];
        if (!s?.headers) return false;
        s.headers.Authorization = `Bearer ${key}`;
        delete s.headers.authorization;
        return true;
      }) && done.push(loc.label);
  }
  return [...new Set(done)];
}

export interface FixDeps {
  fetch?: FetchLike;
  openUrl?: (url: string) => void;
  /** Wait for a pending key (default `waitForKeyLive`). */
  wait?: (args: { podUrl: string; pendingKey: string }) => Promise<"approved" | "rejected" | "timeout">;
  /** Make a new key for this computer (default `provisionAgentKey`, which waits for approval). */
  provision?: (podUrl: string, mintingKey: string, agentType: string, surface: string) => Promise<{ hubApiKey: string; agentUserId: string }>;
  verify?: (podUrl: string, key: string) => Promise<{ ok: boolean; toolCount?: number; error?: string }>;
}

export interface FixOutcome {
  diagnosis: Diagnosis;
  ok: boolean;
  message: string;
}

/** Perform each diagnosis's one action, then verify with a real MCP initialize. */
export async function fixKeyHealth(report: KeyHealthReport, deps: FixDeps = {}): Promise<FixOutcome[]> {
  const outcomes: FixOutcome[] = [];
  const openUrl = deps.openUrl ?? (await import("./targets.js")).openBrowserUrl;
  const verify =
    deps.verify ??
    (async (podUrl: string, key: string) => (await import("./targets.js")).verifyMcpConnection(podUrl, key, { timeoutMs: 20_000 }));
  const wait =
    deps.wait ??
    (async (a: { podUrl: string; pendingKey: string }) => (await import("./key-approval.js")).waitForKeyLive({ ...a, fetch: deps.fetch }));
  const provision =
    deps.provision ??
    (async (podUrl: string, mintingKey: string, agentType: string, surface: string) =>
      (await import("./targets.js")).provisionAgentKey(podUrl, mintingKey, agentType, { surfaceName: surface }));

  const mintingKey = report.locations.find((l) => l.kind === "profile" && report.states.get(l.key)?.state === "active")?.key;

  const finish = async (d: Diagnosis, surface: string, key: string, agentUserId?: string): Promise<FixOutcome> => {
    const rewritten = await rewriteSurfaceKey(report, surface, key, agentUserId, { fetch: deps.fetch });
    const v = await verify(report.podUrl, key);
    const name = d.label ?? surface;
    return v.ok
      ? { diagnosis: d, ok: true, message: `${name}: live key in ${rewritten.join(", ")} — MCP initialize OK${v.toolCount !== undefined ? ` (${v.toolCount} tools)` : ""}${rewritten.some((l) => l.includes(".claude")) ? ". Restart Claude Code to pick it up." : ""}` }
      : { diagnosis: d, ok: false, message: `${name}: key written, but MCP verification failed: ${v.error ?? "unknown error"}` };
  };

  for (const d of keyProblems(report)) {
    try {
      if (d.action === "approve_and_wait" && d.surface && d.key) {
        const { openAndWait } = await import("./key-approval.js");
        const outcome = d.approvalUrl
          ? await openAndWait(d.label ?? d.surface, d.approvalUrl, report.podUrl, () => wait({ podUrl: report.podUrl, pendingKey: d.key! }), openUrl)
          : await wait({ podUrl: report.podUrl, pendingKey: d.key });
        if (outcome === "approved") outcomes.push(await finish(d, d.surface, d.key, d.agentUserId));
        else if (outcome === "rejected")
          outcomes.push({ diagnosis: d, ok: false, message: `${d.label ?? d.surface}: the request was declined on the pod. Run \`synap doctor --fix\` again to ask anew.` });
        else
          outcomes.push({ diagnosis: d, ok: false, message: `${d.label ?? d.surface}: still waiting for approval — nothing was changed. Approve ${d.approvalUrl ?? "it on your pod"}, then run \`synap doctor --fix\` again.` });
      } else if (d.action === "reprovision" && d.surface) {
        if (!mintingKey) {
          outcomes.push({ diagnosis: d, ok: false, message: `${d.label ?? d.surface}: your CLI key for this pod does not work either — run \`synap login --reconnect\` first, then \`synap doctor --fix\`.` });
          continue;
        }
        const fresh = await provision(report.podUrl, mintingKey, d.agentType ?? d.surface, d.surface);
        outcomes.push(await finish(d, d.surface, fresh.hubApiKey, fresh.agentUserId));
      } else if (d.action === "rewrite" && d.surface && d.key) {
        outcomes.push(await finish(d, d.surface, d.key, d.agentUserId));
      } else if (d.action === "login" || d.action === "edit_shell_rc") {
        outcomes.push({ diagnosis: d, ok: false, message: `${d.title}. Not something --fix can do for you — run: ${d.command}` });
      }
    } catch (err) {
      outcomes.push({ diagnosis: d, ok: false, message: `${d.surface ?? "key"}: ${err instanceof Error ? err.message : String(err)}` });
    }
  }
  return outcomes;
}
