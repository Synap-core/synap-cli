/**
 * Key health for one pod: read every copy, ask the pod about each key, print
 * one diagnosis per problem — and, with `--fix`, do the one right thing.
 *
 * The fix never writes a key the pod has not confirmed live (`assertKeyWritable`),
 * and it ends with a real MCP `initialize` against `/mcp` using the key it
 * wrote: a fix is only reported ✓ when that call succeeds AND every copy it had
 * to rewrite was rewritten.
 *
 * A key is sent to this pod only when something ties it to this pod
 * (`keysToProbe`); keys are asked about ONE AT A TIME. The pod resolves a key it
 * does not know with a bcrypt scan of every key sharing its prefix (~12s on a
 * 4-thread pool, measured 2026-10-12); asked all at once, four unknown keys
 * starved each other past the timeout and read "no answer".
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import chalk from "chalk";
import { log } from "../utils/logger.js";
import { writeFileAtomic } from "./atomic-file.js";
import { collectKeyInventory, keysToProbe, type ClientKeyFile, type KeyLocation, type UncheckedLocation } from "./key-locations.js";
import { diagnoseKeys, type Diagnosis } from "./key-diagnosis.js";
import { fetchKeyState, assertKeyWritable, type FetchLike, type KeyState } from "./key-state.js";
import { machineInstanceId, thisComputerInstanceIds } from "./machine-instance.js";

/** Per-key wait for `/auth/key-state` — an unknown key costs the pod ~12s of bcrypt. */
export const KEY_STATE_TIMEOUT_MS = 30_000;

export interface KeyHealthReport {
  podUrl: string;
  locations: KeyLocation[];
  states: Map<string, KeyState>;
  diagnoses: Diagnosis[];
  /** True when the pod answered the holder door for at least one key (vs an older pod). */
  podDescribesKeys: boolean;
  /** Files the doctor could not read or parse — "not checked", never ✓. */
  unchecked?: UncheckedLocation[];
  /** Copies whose key nothing ties to this pod: listed, never sent to it. */
  notSent?: KeyLocation[];
}

export interface KeyHealthDeps {
  home?: string;
  envKey?: string;
  envPodUrl?: string;
  fetch?: FetchLike;
  instanceIdFor?: (surface: string) => string;
  labelOf?: (surface: string) => string;
  /** Client config files to read. Default: derived from `TARGETS` (`clientKeyFiles`). */
  clients?: ClientKeyFile[];
  timeoutMs?: number;
  /**
   * Only this agent surface: its copies are read and its keys asked about —
   * not the person's key, the env, or another agent's (`confirmSurfaceKey`).
   */
  surface?: string;
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
  const allClients = deps.clients ?? (await import("./targets.js")).clientKeyFiles();
  const clients = deps.surface ? allClients.filter((c) => c.surface === deps.surface) : allClients;
  const all = collectKeyInventory({
    home: deps.home ?? os.homedir(),
    podUrl,
    envKey: "envKey" in deps ? deps.envKey : process.env.SYNAP_HUB_API_KEY,
    envPodUrl: "envPodUrl" in deps ? deps.envPodUrl : process.env.SYNAP_POD_URL,
    clients,
  });
  const inventory = deps.surface
    ? { ...all, locations: all.locations.filter((l) => l.role === "agent" && l.surface === deps.surface) }
    : all;
  const keys = keysToProbe(inventory.locations);
  const probed = new Set(keys);
  const states = new Map<string, KeyState>();
  // One at a time — see the module doc.
  for (const k of keys) states.set(k, await fetchKeyState(podUrl, k, { fetch: deps.fetch, timeoutMs: deps.timeoutMs ?? KEY_STATE_TIMEOUT_MS }));
  const locations = inventory.locations.filter((l) => probed.has(l.key));
  const notSent = inventory.locations.filter((l) => !probed.has(l.key));
  const labels = new Map<string, string>();
  for (const s of new Set(inventory.locations.map((l) => l.surface).filter((x): x is string => !!x)))
    labels.set(s, deps.labelOf ? deps.labelOf(s) : await targetLabel(s));
  const envKey = locations.find((l) => l.kind === "process-env")?.key;
  const idFor = deps.instanceIdFor ?? ((s: string) => machineInstanceId(s));
  const answers = [...states.values()];
  return {
    podUrl,
    locations,
    states,
    unchecked: inventory.unchecked,
    notSent,
    podDescribesKeys: answers.some((a) => !a.legacy && a.state !== "unreachable"),
    diagnoses: diagnoseKeys({
      locations,
      states,
      envKey,
      instanceIdFor: idFor,
      instanceIdsForAgentType: (t) => thisComputerInstanceIds(t, idFor),
      labelOf: (s) => labels.get(s) ?? s,
    }),
  };
}

/** The problems only — `ok` diagnoses are summarised, not listed. */
export function keyProblems(report: KeyHealthReport): Diagnosis[] {
  return report.diagnoses.filter((d) => d.code !== "ok");
}

/** A problem `--fix` can act on (not merely tell you a command). */
export function isFixable(d: Diagnosis): boolean {
  return d.action !== "none" && d.action !== "login" && d.action !== "edit_shell_rc";
}

/**
 * What setup may say about one agent after writing its config:
 *   active     — the pod confirms the key now in its files works
 *   not-active — anything else, as the doctor's own diagnosis line + command
 *   unchecked  — the target keeps no key the CLI can read back (`keyStore.none`)
 */
export type SetupCheck =
  | { verdict: "active" }
  | { verdict: "not-active"; title: string; command?: string }
  | { verdict: "unchecked"; reason: string };

/**
 * The check behind every "<Agent> connected" line: read back what setup WROTE
 * for `surface` — the same copies `synap doctor` reads — ask the pod about each
 * key, and pass only when the doctor would say "key works". The 2026-10-15
 * devbox printed "✓ Claude Code connected" over a key the pod held as
 * awaiting approval; a success line now comes from this read, never from
 * having written the file.
 */
export async function confirmSurfaceKey(podUrl: string, surface: string, deps: KeyHealthDeps = {}): Promise<SetupCheck> {
  let report: KeyHealthReport;
  try {
    report = await checkKeyHealth(podUrl, { ...deps, surface });
  } catch (err) {
    return { verdict: "not-active", title: `${surface}: could not read back its key (${err instanceof Error ? err.message : String(err)})`, command: "synap doctor" };
  }
  const unread = report.unchecked?.[0];
  if (unread) return { verdict: "not-active", title: `not checked: ${unread.tool} — ${unread.file} ${unread.reason}`, command: "synap doctor" };
  const d = report.diagnoses.find((x) => x.surface === surface);
  if (d?.code === "ok") return { verdict: "active" };
  if (d) return { verdict: "not-active", title: d.title, command: d.command };
  const { TARGETS, isTargetName } = await import("./targets.js");
  const target = isTargetName(surface) ? TARGETS[surface] : undefined;
  if (target && "none" in target.keyStore) return { verdict: "unchecked", reason: target.keyStore.none };
  return { verdict: "not-active", title: `${target?.label ?? surface}: no key for this pod was found where setup writes it`, command: "synap doctor" };
}

const plural = (n: number, one: string, many = one + "s") => `${n} ${n === 1 ? one : many}`;

/**
 * Print what is wrong, and what could not be checked. Working keys are one
 * line (listed with `verbose`); an unverifiable key is "?", never ✓ or ✗.
 */
export function printKeyHealth(report: KeyHealthReport, opts: { fixHint?: boolean; verbose?: boolean; showOk?: boolean; indent?: string } = {}): void {
  const ind = opts.indent ?? "  ";
  const dim = (t: string) => console.log(chalk.dim(`${ind}${t}`));
  const problems = keyProblems(report);
  const ok = report.diagnoses.filter((d) => d.code === "ok");
  const unverifiable = problems.filter((d) => d.code === "unverifiable");
  const broken = problems.filter((d) => d.code !== "unverifiable");
  if (opts.showOk !== false && ok.length) {
    if (opts.verbose) for (const d of ok) console.log(`${ind}${chalk.green("✓")} ${d.title}`);
    else console.log(`${ind}${chalk.green("✓")} ${plural(ok.length, "agent key")} work${ok.length === 1 ? "s" : ""}: ${ok.map((d) => d.label ?? d.surface).join(", ")}`);
  }
  for (const d of broken) {
    const mark = d.severity === "error" ? chalk.red("✗") : chalk.yellow("!");
    console.log(`${ind}${mark} ${chalk.bold(d.title)}`);
    for (const line of d.lines) dim(`    ${line}`);
    if (d.command) dim(`    → ${d.command}`);
  }
  // Group the unverifiable by why — "no answer in 30s" four times is one line.
  const byWhy = new Map<string, Diagnosis[]>();
  for (const d of unverifiable) {
    const why = (d.key && report.states.get(d.key)?.error) || "the pod did not answer";
    byWhy.set(why, [...(byWhy.get(why) ?? []), d]);
  }
  for (const [why, ds] of byWhy) {
    console.log(`${ind}${chalk.yellow("?")} ${plural(ds.length, "key")} not checked — ${why}: ${ds.map((d) => d.label ?? d.surface).join(", ")}`);
    dim("    → run synap doctor again; if it repeats: synap agents list");
  }
  const notSent = report.notSent ?? [];
  if (notSent.length) {
    const keys = new Set(notSent.map((l) => l.key)).size;
    console.log(`${ind}${chalk.yellow("?")} ${plural(keys, "key")} not checked — ${keys === 1 ? "it belongs" : "they belong"} to another pod or nothing says which${opts.verbose ? "" : " (details with -v)"}`);
    if (opts.verbose) for (const l of notSent) dim(`    ${l.label}`);
  }
  for (const u of report.unchecked ?? []) console.log(`${ind}${chalk.yellow("?")} not checked: ${u.tool} — ${u.file} ${u.reason}`);
  if (report.locations.length === 0 && notSent.length === 0) dim("No Synap key is configured for this pod on this computer.");
  if (!report.podDescribesKeys && report.locations.length > 0)
    dim("(This pod predates the key-state door: it can say a key fails, not why. Update the pod for precise reasons.)");
  if (opts.fixHint && problems.some(isFixable)) dim(`Fix it: ${chalk.cyan("synap doctor --fix")}`);
}

// ─── --fix ────────────────────────────────────────────────────────────────

/**
 * Replace `oldKey` with `newKey` in one file, atomically, mode kept. Works for
 * every client format (JSON, JSONC with its comments, TOML, YAML) because a key
 * is a unique opaque token: the edit touches exactly the copies of that key and
 * nothing else. Throws when the file no longer holds the old key.
 */
function replaceKeyInFile(file: string, oldKey: string, newKey: string): void {
  const text = fs.readFileSync(file, "utf8");
  if (!text.includes(oldKey)) throw new Error("the old key is no longer in the file");
  writeFileAtomic(file, text.split(oldKey).join(newKey));
}

export interface RewriteResult {
  /** Every copy that now holds the live key (rewritten or already there). */
  done: string[];
  /** Copies that should hold it and could not be rewritten — with why. */
  failed: string[];
}

/** The agent a key belongs to, from the pod's own status door. Throws when the pod does not say. */
async function agentOfKey(podUrl: string, key: string, f: FetchLike): Promise<string> {
  const res = await f(`${podUrl.replace(/\/+$/, "")}/api/hub/auth/status`, {
    headers: { Authorization: `Bearer ${key}` },
    signal: AbortSignal.timeout(15_000),
  }).catch((err: unknown) => {
    throw new Error(`could not ask the pod whose key this is (${(err as Error).message})`);
  });
  const userId = res.ok ? ((await res.json().catch(() => ({}))) as { userId?: string }).userId : undefined;
  if (!userId) throw new Error(`could not ask the pod whose key this is (HTTP ${res.status} from /auth/status)`);
  return userId;
}

/**
 * Write `key` into every rewritable copy of `surface` for this pod — ONLY after
 * the pod confirms it is live. A copy that cannot be rewritten is reported in
 * `failed`, never dropped.
 */
export async function rewriteSurfaceKey(
  report: KeyHealthReport,
  surface: string,
  key: string,
  agentUserId: string | undefined,
  deps: { fetch?: FetchLike; home?: string } = {}
): Promise<RewriteResult> {
  await assertKeyWritable(report.podUrl, key, deps);
  const pod = await import("./pod.js");
  // A blank agent id saved next to a key breaks every later lookup — ask, or stop.
  const agentId = agentUserId || (await agentOfKey(report.podUrl, key, deps.fetch ?? fetch));
  const configFile = path.join(deps.home ?? os.homedir(), ".synap", "config.json");
  const mine = report.locations.filter((l) => l.surface === surface);
  const done = mine.filter((l) => l.key === key && l.kind !== "pending").map((l) => l.label);
  const failed: string[] = [];
  pod.setSurfaceAgentKey(surface as import("./pod.js").SurfaceName, { hubApiKey: key, agentUserId: agentId, podUrl: report.podUrl });
  pod.clearPendingAgentKey(surface, report.podUrl);
  if (!mine.some((l) => l.file === configFile && l.key === key && l.kind !== "pending")) done.push(`~/.synap/config.json → agentKeysByPod.${surface}`);
  // The CLI config is handled above; every other file gets a precise text edit.
  for (const loc of mine.filter((l) => l.rewritable && l.key !== key && l.file && l.file !== configFile)) {
    try {
      replaceKeyInFile(loc.file!, loc.key, key);
      done.push(loc.label);
    } catch (err) {
      failed.push(`${loc.label}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return { done: [...new Set(done)], failed };
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
    const { done: rewritten, failed } = await rewriteSurfaceKey(report, surface, key, agentUserId, { fetch: deps.fetch });
    const name = d.label ?? surface;
    if (failed.length)
      return { diagnosis: d, ok: false, message: `${name}: live key written to ${rewritten.join(", ")}, but NOT to: ${failed.join("; ")}` };
    const v = await verify(report.podUrl, key);
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
