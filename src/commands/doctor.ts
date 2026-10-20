/**
 * synap doctor — coherence preflight.
 *
 * Catches CLI-side config drift in ONE call instead of scattered 404/403
 * failures partway through a real command. Checks, in order:
 *   (a) SYNAP_POD_URL resolves — the host is actually served (catches the
 *       classic failure: a stale/migrated domain that still LOOKS configured).
 *   (b) the key authenticates against that pod.
 *   (c) the configured workspace (and project) actually exist on THIS pod —
 *       via `GET /orient`, which is the pod's own answer to "what's valid here".
 *   (d) the Intelligence Service is reachable — the dependency that capture,
 *       import and all AI structuring run through. Without it doctor once
 *       printed "All checks passed" while every import was 502-ing.
 *   (e) the connection broker answers — and when it does not, WHY: broker
 *       kind, relay credential presence + expiry, control-plane issuer trust
 *       and the owner's identity link, with the one fix for that reason.
 *   (f) prints the active lens (pod, workspace, project) so the user sees
 *       exactly where they're pointed.
 *
 * Degrades gracefully on older pods (missing /orient, no dependency probe) — a
 * check that can't run says so and moves on, it never throws. Crucially, a
 * check that could not run reports "could not determine" and is NOT green: an
 * unknown is not a pass. Only a PROVEN failure sets a non-zero exit code.
 */

import chalk from "chalk";
import { log } from "../utils/logger.js";
import { getActivePodConfig, getActiveWorkspaceId, getActiveProjectId, listPodProfiles, checkPodHealth, findPodNameByUrl } from "../lib/pod.js";
import { resolveHubConfig, hubGet, HubError, type HubConfig } from "../lib/hub-client.js";
import { formatKeySource, resolveKeySource } from "../lib/key-source.js";
import { resolveLensProvenance, type LensRung } from "../lib/describe-lens.js";
import { samePodOrigin } from "../lib/project-ref.js";
import { fetchKeyState } from "../lib/key-state.js";
import { describeKeyState, type Diagnosis } from "../lib/key-diagnosis.js";
import { isFixable, type KeyHealthReport } from "../lib/key-doctor.js";
import { connectionLines, type PodConnection } from "../lib/agent-connections.js";
import { thisComputerInstanceIds } from "../lib/machine-instance.js";
import { tildify } from "../lib/key-locations.js";
import { cliBuild, formatCliBuild } from "../lib/cli-build.js";
import { CP_URL, getStoredToken } from "../lib/auth.js";
import { askControlPlaneWherePodIs, POD_MOVED_HINT } from "../lib/pod-moved.js";
import os from "node:os";
import path from "node:path";
import { unwrapList } from "../lib/unwrapList.js";

/**
 * Each agent with a live connection, and the computers it is connected from —
 * one line per agent. Agents with none are ONE summary line (OMIT, with the
 * door to the full list). A failed read says so — never an empty list; an older
 * pod that sends no connections is "cannot tell".
 */
async function printAgentConnections(cfg: HubConfig): Promise<void> {
  let rows: Array<{ name: string | null; agentType: string | null; connections?: PodConnection[] }>;
  try {
    rows = unwrapList(await hubGet("/agent-users?mine=1", {}, cfg));
  } catch (err) {
    console.log(`  ${chalk.yellow("?")} Could not read your agents' connections: ${err instanceof Error ? err.message : String(err)}`);
    return;
  }
  if (rows.length === 0) {
    log.dim("  No agents on this pod for you yet — connect one: synap connect");
    return;
  }
  const live: Array<{ name: string; lines: string[] }> = [];
  let idle = 0;
  let olderPod = false;
  for (const row of rows) {
    // Keys are minted with the SURFACE's hash: compare against every surface
    // minting under this agentType, and only when the pod named the type.
    const mine = row.agentType ? thisComputerInstanceIds(row.agentType) : null;
    const lines = connectionLines(row.connections, { isThisComputer: (id) => !!mine?.has(id) });
    if (lines === null) olderPod = true;
    else if (lines.length === 0) idle++;
    else live.push({ name: row.name ?? row.agentType ?? "Agent", lines });
  }
  const width = Math.min(18, Math.max(0, ...live.map((r) => r.name.length)) + 2);
  for (const r of live) console.log(`  ${r.name.padEnd(width)}${r.lines.join(chalk.dim("   ·   "))}`);
  if (idle) console.log(chalk.dim(`  +${idle} agent${idle === 1 ? "" : "s"} with no live connection — synap agents list`));
  if (olderPod) console.log(chalk.dim("  (this pod predates per-computer connections — update it to see them)"));
}

/** A saved pod address the Control Plane says has moved. */
export interface PodMove {
  from: string;
  to: string;
  /** The saved profile holding `from`, when there is one. */
  profileName?: string;
}

/** Hosted pods (the only ones the Control Plane can move) live under synap.live. */
function isSynapHosted(podUrl: string): boolean {
  try {
    const host = new URL(podUrl).hostname;
    return host === "synap.live" || host.endsWith(".synap.live");
  } catch {
    return false;
  }
}

/**
 * Why a pod host did not answer, when the reason is a move. Null when it is not
 * one (or nothing suggests it), so the caller keeps its generic message. Asks
 * the Control Plane only on a signal: a redirect to another host, or a hosted
 * address that stopped answering.
 */
export async function diagnosePodMove(
  podUrl: string,
  health: { moved?: boolean },
  activeName: string
): Promise<{ check: CheckResult; move?: PodMove } | null> {
  if (!health.moved && !isSynapHosted(podUrl)) return null;
  const answer = await askControlPlaneWherePodIs({
    podUrl,
    cpUrl: CP_URL,
    cpToken: getStoredToken()?.token,
  });
  const name = "Pod host resolves";
  if (answer.kind === "moved") {
    return {
      check: {
        name,
        ok: false,
        detail: `${podUrl} has a new address: ${answer.podUrl}`,
        fix: POD_MOVED_HINT,
      },
      move: { from: podUrl, to: answer.podUrl, profileName: findPodNameByUrl(podUrl) },
    };
  }
  if (!health.moved) return null;
  return {
    check: {
      name,
      ok: false,
      detail: `${podUrl} sends its requests to another address, and Synap does not follow it`,
      fix:
        answer.kind === "signed-out"
          ? "Sign in so Synap can look up the new address: synap login — then run: synap doctor --fix"
          : `Find the pod's address in your account, then run: synap pods update ${activeName} <new-url>`,
    },
  };
}

/** `doctor --fix` for a moved pod: the same door as `synap pods update`. */
async function fixPodMove(move: PodMove): Promise<boolean> {
  if (!move.profileName) {
    console.log(`  ${chalk.red("✗")} No saved pod uses ${move.from}, so there is nothing to update here.`);
    console.log(chalk.dim(`    → Set SYNAP_POD_URL to ${move.to}, or save it: synap pods add`));
    return false;
  }
  const { podsUpdate } = await import("./pods.js");
  await podsUpdate(move.profileName, move.to);
  return findPodNameByUrl(move.to) === move.profileName;
}

interface DoctorOpts {
  json?: boolean;
  /** Every check with its details, ids and addresses. */
  verbose?: boolean;
  /** Perform the one right action per key problem, then verify with a real MCP initialize. */
  fix?: boolean;
}

interface CheckResult {
  name: string;
  /** true ONLY when the check verified something good. */
  ok: boolean;
  /**
   * true when the check could not run at all — an unknown, not a pass and not
   * a proven failure. It still suppresses "All checks passed" (that green line
   * over an undetermined dependency is the exact lie this file is fixing), but
   * it does NOT set a failing exit code, because nothing was proven broken.
   */
  unknown?: boolean;
  detail: string;
  fix?: string;
}

/**
 * What the pod's dependency probe says about the Intelligence Service.
 *
 * Mirrors the pod's own three states rather than flattening them to a boolean
 * (`packages/api/src/routers/hub-protocol/rest/health-dependencies.ts`):
 *   • `up`         — state "reachable".
 *   • `down`       — state "unreachable": the pod KNOWS the IS URL, the probe failed.
 *   • `unresolved` — the pod could not even work out WHICH IS to call. Still a
 *     real failure (a capture hits the same resolution), but a different fault
 *     with a different fix, so it is never reported as "unreachable".
 *   • `unknown`    — the CLI could not read an answer at all. NOT a pass.
 */
export type IsHealthVerdict = {
  state: "up" | "down" | "unresolved" | "unknown";
  detail: string;
};

/**
 * Read the Intelligence-Service entry out of `GET /api/hub/health/dependencies`.
 *
 * Keys off the pod's real contract: `{ dependencies: [{ name:
 * "intelligence-service", state: "reachable"|"unreachable"|"unresolved",
 * reachable: boolean, reason?, endpoint?, httpStatus?, latencyMs? }] }`.
 *
 * Anything this cannot positively recognise degrades to `unknown` — the CLI
 * ships independently of the pod, so a future field rename must surface as
 * "could not determine", never as a silent green.
 */
/**
 * Describe which lens the pod resolved the IS under, from its `resolution`
 * echo. Silent when the pod did not say — never guess a lens.
 */
function readLens(resolution: unknown): string {
  if (!resolution || typeof resolution !== "object") return "";
  const ws = (resolution as Record<string, unknown>).workspaceId;
  if (typeof ws === "string" && ws) return ` (checked as workspace ${ws})`;
  if (ws === null) return " (checked pod-level)";
  return "";
}

export function readIntelligenceHealth(payload: unknown): IsHealthVerdict {
  if (!payload || typeof payload !== "object") {
    return { state: "unknown", detail: "the pod returned no dependency payload" };
  }

  const root = payload as Record<string, unknown>;
  const deps = root.dependencies;
  if (!Array.isArray(deps)) {
    return { state: "unknown", detail: "the dependency report carried no `dependencies` array" };
  }

  // The pod echoes back the lens it actually resolved under. Report it: a
  // pod-level "reachable" does not prove the workspace the user imports into
  // routes to a live service, and vice versa.
  const lens = readLens(root.resolution);

  const entry = deps.find(
    (d): d is Record<string, unknown> =>
      Boolean(d) && typeof d === "object" && (d as Record<string, unknown>).name === "intelligence-service"
  );
  if (!entry) {
    return {
      state: "unknown",
      detail: "the pod's dependency report listed no intelligence-service entry",
    };
  }

  const reason = typeof entry.reason === "string" ? entry.reason : undefined;
  const where = typeof entry.endpoint === "string" ? entry.endpoint : undefined;
  const suffix = reason ? ` — ${reason}` : "";

  switch (entry.state) {
    case "reachable": {
      const ms = typeof entry.latencyMs === "number" ? ` in ${entry.latencyMs}ms` : "";
      return {
        state: "up",
        detail: `intelligence-service answered${where ? ` at ${where}` : ""}${ms}${lens}`,
      };
    }
    case "unreachable":
      return {
        state: "down",
        detail: `intelligence-service${where ? ` at ${where}` : ""} did not answer${lens}${suffix}`,
      };
    case "unresolved":
      // Determinate, not undetermined: the pod positively told us resolution
      // failed, and a real capture hits that same failure. It is a proven
      // break with a different CAUSE than "the service is down".
      return {
        state: "unresolved",
        detail: `the pod could not determine which Intelligence Service it routes to${lens}${suffix}`,
      };
    default:
      // No readable `state`. Fall back to the boolean mirror ONLY when it is a
      // real boolean — never treat a missing field as healthy.
      if (entry.reachable === true) return { state: "up", detail: "intelligence-service answered" };
      if (entry.reachable === false) {
        return { state: "down", detail: `intelligence-service did not answer${suffix}` };
      }
      return { state: "unknown", detail: "the intelligence-service entry carried no readable state" };
  }
}

const IS_CHECK_NAME = "Intelligence Service reachable";

/**
 * Turn an IS verdict into a check row. Names the CONSEQUENCE, not just the
 * dependency: the incident this fixes had a green doctor while every capture /
 * import was 502-ing, so "IS unreachable" alone does not tell the user that the
 * command they are about to run cannot work.
 */
export function intelligenceCheck(verdict: IsHealthVerdict): CheckResult {
  const consequence =
    "capture / import / AI structuring WILL FAIL (files import as 0 entities, reported degraded)";

  switch (verdict.state) {
    case "up":
      return { name: IS_CHECK_NAME, ok: true, detail: verdict.detail };
    case "down":
      return {
        name: IS_CHECK_NAME,
        ok: false,
        detail: `${verdict.detail} — ${consequence}`,
        fix: "The pod is up but its Intelligence Service is not. Restart/redeploy the IS, then re-run: synap doctor",
      };
    case "unresolved":
      return {
        name: IS_CHECK_NAME,
        ok: false,
        detail: `${verdict.detail} — ${consequence}`,
        // A different fault from "down": nothing to restart, the routing itself
        // is empty/misconfigured, so the fix points at configuration.
        fix: "No Intelligence Service is configured for this pod/workspace. Check the pod's intelligence-service registry, then re-run: synap doctor",
      };
    default:
      return {
        name: IS_CHECK_NAME,
        ok: false,
        unknown: true,
        detail: `could not determine — ${verdict.detail}. If it is down, ${consequence}.`,
        // `import --dry-run` calls POST /capture/structure and stops before
        // /capture/execute — it exercises the exact door that 502s when the IS
        // is down, and writes nothing. (`capture` has no --dry-run.)
        fix: "This pod build may predate GET /api/hub/health/dependencies. Probe by hand (writes nothing): synap import <a-file.md> --dry-run",
      };
  }
}

export async function doctor(opts: DoctorOpts = {}): Promise<void> {
  const checks: CheckResult[] = [];
  const activeName = listPodProfiles().find((p) => p.active)?.name ?? "default";

  // Resolve lens FIRST so `--pod` / env / profile agree on URL + workspace
  // (host check used to use only active profile → `synap --pod team doctor`
  // reported perso's host while Active Lens showed team).
  let cfgResolved: HubConfig | undefined;
  try {
    cfgResolved = await resolveHubConfig();
  } catch {
    /* fall through to profile/env */
  }

  // ── (a) Host resolves — the pod is actually served at this URL ───────────
  const localConfig = getActivePodConfig();
  const podUrl =
    cfgResolved?.podUrl ?? localConfig?.podUrl ?? process.env.SYNAP_POD_URL;

  if (!podUrl) {
    checks.push({
      name: "Pod URL configured",
      ok: false,
      detail: "no pod URL configured",
      fix: "Run: synap init   (or synap pods add, if you already have a pod)",
    });
    return finish(checks, opts, { podUrl: undefined, workspaceId: undefined, projectId: undefined });
  }

  let hostServed = false;
  let podMove: PodMove | undefined;
  const names: { workspace?: string; project?: string; podVersion?: string } = {};
  const health = await checkPodHealth(podUrl);
  names.podVersion = health.version;
  if (health.healthy) {
    hostServed = true;
    checks.push({
      name: "Pod host resolves",
      ok: true,
      detail: `${podUrl} is served${health.version ? ` (v${health.version})` : ""}`,
    });
  } else {
    // A moved pod: the old name redirects elsewhere, or (after the redirect
    // window) no longer answers. Only the Control Plane says where it went.
    const diagnosis = await diagnosePodMove(podUrl, health, activeName);
    if (diagnosis) {
      checks.push(diagnosis.check);
      podMove = diagnosis.move;
    } else {
      // The classic failure this check exists for: a saved profile URL that no
      // longer resolves to a live pod — most often a stale/migrated domain, not
      // a transient network blip (checkPodHealth already retried the timeout).
      checks.push({
        name: "Pod host resolves",
        ok: false,
        detail: `${podUrl} did not answer /health`,
        fix: `Your profile URL may be stale. Run: synap pods list   (see saved pods) — or: synap pods update ${activeName} <new-url>`,
      });
    }
  }

  // ── (b) Key authenticates against this pod ────────────────────────────────
  let keyValid = false;
  if (!hostServed) {
    checks.push({
      name: "API key authenticates",
      ok: false,
      detail: "skipped — pod host is unreachable",
      fix: "Fix the pod host check above first.",
    });
  } else {
    try {
      const cfg = cfgResolved ?? (await resolveHubConfig());
      cfgResolved = cfg;
      await hubGet("/users/me", {}, cfg);
      keyValid = true;
      checks.push({ name: "API key authenticates", ok: true, detail: "key accepted" });
    } catch (err) {
      const is401 = err instanceof HubError ? err.status === 401 : false;
      // Say WHY — awaiting approval, replaced, expired — never a guess.
      const why = is401 && cfgResolved ? describeKeyState(await fetchKeyState(cfgResolved.podUrl, cfgResolved.apiKey)) : null;
      checks.push({
        name: "API key authenticates",
        ok: false,
        detail: is401 ? `the pod rejected this key: it ${why}` : `could not verify (${err instanceof Error ? err.message : String(err)})`,
        fix: is401 ? "See the key health below — run: synap doctor --fix" : `Run: synap login --reconnect ${activeName}`,
      });
    }
  }

  // ── (c) Configured workspace/project exist on THIS pod ────────────────────
  let workspaceOk: boolean | null = null;
  let projectOk: boolean | null = null;
  if (!keyValid || !cfgResolved) {
    checks.push({
      name: "Workspace + project exist on this pod",
      ok: false,
      detail: "skipped — key did not authenticate",
      fix: "Fix the API key check above first.",
    });
  } else {
    try {
      const res = (await hubGet("/orient", {}, cfgResolved)) as {
        workspaces?: Array<{ id: string; name: string }>;
        projects?: Array<{ id: string; name: string }>;
      };
      const workspaces = res.workspaces ?? [];
      const projects = res.projects ?? [];

      if (cfgResolved.workspaceId) {
        const match = workspaces.find((w) => w.id === cfgResolved!.workspaceId);
        workspaceOk = Boolean(match);
        names.workspace = match?.name;
        checks.push({
          name: "Configured workspace exists on this pod",
          ok: workspaceOk,
          detail: workspaceOk
            ? `${match!.name} (${cfgResolved.workspaceId})`
            : `workspace ${cfgResolved.workspaceId} not found among ${workspaces.length} workspace(s) on this pod`,
          fix: workspaceOk ? undefined : "Run: synap orient   (see valid workspaces on this pod), then: synap use <id>",
        });
      } else {
        checks.push({
          name: "Configured workspace exists on this pod",
          ok: true,
          detail: "no workspace pinned — pod-wide lens",
        });
      }

      if (cfgResolved.projectId) {
        const match = projects.find((p) => p.id === cfgResolved!.projectId);
        projectOk = Boolean(match);
        names.project = match?.name;
        checks.push({
          name: "Configured project exists on this pod",
          ok: projectOk,
          detail: projectOk
            ? `${match!.name} (${cfgResolved.projectId})`
            : `project ${cfgResolved.projectId} not found among ${projects.length} project(s) on this pod`,
          fix: projectOk ? undefined : "Run: synap orient   (see valid projects on this pod), then: synap project use <id>",
        });
      }
    } catch (err) {
      // Older pod without /orient (or a transient failure) — degrade, don't fail.
      const is404 = err instanceof HubError && err.status === 404;
      checks.push({
        name: "Workspace + project exist on this pod",
        ok: true,
        detail: is404
          ? "skipped — this pod does not expose /orient (older build)"
          : `skipped — could not check (${err instanceof Error ? err.message : String(err)})`,
      });
    }
  }

  // ── (d) The Intelligence Service the capture/import pipeline depends on ───
  //    Doctor used to stop at config coherence and print "All checks passed"
  //    while POST /api/hub/capture/structure was 502-ing — a diagnostic that
  //    reports all-clear over a dead core dependency actively misdirects.
  if (!keyValid || !cfgResolved) {
    checks.push({
      name: "Intelligence Service reachable",
      ok: false,
      unknown: true,
      detail: "could not determine — the key did not authenticate, so the pod's dependency probe was not called",
      fix: "Fix the API key check above first.",
    });
  } else {
    checks.push(intelligenceCheck(await probeIntelligence(cfgResolved)));
  }

  // ── (e) The connection broker, and why it fails when it does ─────────────
  if (!keyValid || !cfgResolved) {
    checks.push({
      name: BROKER_CHECK_NAME,
      ok: false,
      unknown: true,
      detail: "could not determine — the key did not authenticate",
      fix: "Fix the API key check above first.",
    });
  } else {
    const [providers, diagnostics] = await Promise.all([
      probeBrokerProviders(cfgResolved),
      probeBrokerDiagnostics(cfgResolved),
    ]);
    checks.push(brokerCheck(providers, diagnostics));
  }

  // ── (f) Every key configured for this pod, and why each one fails ───────
  let keyHealth: KeyHealthReport | undefined;
  if (hostServed) {
    const { checkKeyHealth, keyProblems } = await import("../lib/key-doctor.js");
    keyHealth = await checkKeyHealth(cfgResolved?.podUrl ?? podUrl);
    const problems = keyProblems(keyHealth);
    const failing = problems.filter((d) => d.severity === "error");
    const unverifiable = problems.filter((d) => d.code === "unverifiable");
    const why = [...new Set(unverifiable.map((d) => (d.key && keyHealth!.states.get(d.key)?.error) || "no answer"))].join("; ");
    checks.push({
      name: "Keys on this computer",
      ok: problems.length === 0,
      unknown: problems.length > 0 && failing.length === 0 && problems.every((d) => d.code === "unverifiable"),
      detail:
        problems.length === 0
          ? `${keyHealth.locations.length} configured cop${keyHealth.locations.length === 1 ? "y" : "ies"}, all working`
          : unverifiable.length === problems.length
            ? `${unverifiable.length} key${unverifiable.length === 1 ? "" : "s"} could not be checked (${why})`
            : `${problems.length} problem${problems.length === 1 ? "" : "s"}`,
      // Only a problem --fix can act on earns the --fix hint.
      fix: problems.some(isFixable) ? "Run: synap doctor --fix" : undefined,
    });
  }

  await finish(checks, opts, {
    // Prefer the pod resolveHubConfig actually hit — health-check URL can lag
    // the active profile when the shell is env-pinned to another pod.
    podUrl: cfgResolved?.podUrl ?? podUrl,
    workspaceId: cfgResolved?.workspaceId,
    projectId: cfgResolved?.projectId,
    ...names,
  }, keyHealth, cfgResolved, podMove);
}

/**
 * Call the pod's dependency probe. Every failure mode that is not a positive
 * "the IS is down" answer maps to `unknown` — an older pod that 404s the door
 * must never read as healthy.
 */
async function probeIntelligence(cfg: HubConfig): Promise<IsHealthVerdict> {
  try {
    // Pass the configured workspace so the pod resolves the IS exactly as a
    // capture FROM THAT WORKSPACE would (resolution is capability → workspace →
    // user → pod default). A pod-level probe could pass while the workspace the
    // user actually imports into routes to a dead service.
    return readIntelligenceHealth(
      await hubGet("/health/dependencies", { workspaceId: cfg.workspaceId }, cfg)
    );
  } catch (err) {
    if (err instanceof HubError && err.status === 404) {
      return {
        state: "unknown",
        detail: "this pod does not expose GET /api/hub/health/dependencies (older build)",
      };
    }
    if (err instanceof HubError && err.status === 403) {
      return {
        state: "unknown",
        detail: "this key lacks the hub-protocol.read scope needed to read the dependency probe",
      };
    }
    // The probe itself failing is not proof the IS is down — say only that.
    return {
      state: "unknown",
      detail: `the dependency probe did not answer (${err instanceof Error ? err.message : String(err)})`,
    };
  }
}

const BROKER_CHECK_NAME = "Connection broker";

/**
 * What `GET /api/hub/connectors/providers` says about the broker.
 * `not-configured` is the route's own 503 ("Nango not configured"); every other
 * failure to read is `unknown`, never a pass.
 */
export type BrokerProvidersRead =
  | { state: "ok" }
  | { state: "not-configured" }
  | { state: "error"; reason: string; message?: string }
  | { state: "unknown"; detail: string };

/**
 * `GET /api/hub/connectors/broker-diagnostics` (synap-backend
 * `connectors/broker-trust-diagnostics.ts`). Non-secret by contract.
 */
export interface BrokerTrustReport {
  cpIssuer: { present: boolean; status: string | null; hasSourceConfigWrite: boolean };
  ownerIdentityLink: { present: boolean };
  /** `resolvable` is absent on a pod that predates it. */
  relayCredential: { present: boolean; resolvable?: boolean; validUntil: string | null };
  broker: { kind: string; reason: string | null };
}

export type BrokerDiagnosticsRead =
  | { state: "read"; report: BrokerTrustReport }
  | { state: "unknown"; detail: string };

export function readProvidersEnvelope(payload: unknown): BrokerProvidersRead {
  if (!payload || typeof payload !== "object") {
    return { state: "unknown", detail: "the providers door returned no payload" };
  }
  const p = payload as { nangoStatus?: unknown; nangoError?: { reason?: unknown; message?: unknown } };
  if (p.nangoStatus === "ok") return { state: "ok" };
  if (p.nangoStatus === "error") {
    return {
      state: "error",
      reason: typeof p.nangoError?.reason === "string" ? p.nangoError.reason : "unknown",
      message: typeof p.nangoError?.message === "string" ? p.nangoError.message : undefined,
    };
  }
  return { state: "unknown", detail: "the providers door carried no readable nangoStatus" };
}

export function readBrokerDiagnostics(payload: unknown): BrokerDiagnosticsRead {
  const r = payload as Partial<BrokerTrustReport> | null;
  const readable =
    !!r &&
    typeof r.cpIssuer?.present === "boolean" &&
    typeof r.cpIssuer?.hasSourceConfigWrite === "boolean" &&
    typeof r.ownerIdentityLink?.present === "boolean" &&
    typeof r.relayCredential?.present === "boolean" &&
    typeof r.broker?.kind === "string";
  if (!readable) {
    return { state: "unknown", detail: "the broker diagnostics payload was not readable" };
  }
  return { state: "read", report: r as BrokerTrustReport };
}

/** The one fix for a broker fault, sharpened by the trust diagnostics when readable. */
export function brokerFixHint(reason: string, diagnostics: BrokerDiagnosticsRead, message?: string): string {
  if (reason === "broker-credential-missing") {
    if (diagnostics.state !== "read") {
      return "The pod holds no usable relay key from its control plane. Its trust state is unreadable here (needs a pod owner/admin key on a pod serving /connectors/broker-diagnostics) — check the control plane log for the relay-key delivery refusal, then rotate the pod's relay key from the control plane.";
    }
    return credentialMissingHint(diagnostics.report);
  }
  switch (reason) {
    case "unauthenticated":
      return "The broker rejected this pod's credential. Rotate the pod's relay key from the control plane (or, for a self-brokered pod, re-save its Nango key).";
    case "unreachable":
      return "The broker did not answer. Check that the control plane / Nango host is up and reachable from the pod.";
    case "vault-unreadable":
      return "The pod could not decrypt its broker credential. Check VAULT_SERVER_KEY on the pod.";
    case "vault-unresolved":
      return "The pod holds a relay key from its control plane but cannot read it from its vault. Rotate the pod's relay key from the control plane — it re-delivers a readable key.";
    case "db-unavailable":
      return "The pod could not read its database. Check the pod's health and logs.";
    default:
      return message ?? `The broker reported ${reason}.`;
  }
}

function credentialMissingHint(r: BrokerTrustReport): string {
  if (!r.cpIssuer.present) {
    return "The pod has no control plane issuer, so it cannot accept a relay key. Check CONTROL_PLANE_URL on the pod and restart it, then rotate the relay key from the control plane.";
  }
  if (r.cpIssuer.status !== "approved" || !r.cpIssuer.hasSourceConfigWrite) {
    return "Approve the Synap Control Plane issuer with 'Configure data sources' (source-config:write) in pod-admin → Trust & Keys → Trusted issuers, then rotate the relay key from the control plane.";
  }
  if (!r.ownerIdentityLink.present) {
    return "The pod owner's control plane identity is not linked on this pod, so relay-key delivery is refused. Link it (sign in to this pod through the control plane), then rotate the relay key from the control plane.";
  }
  return "Trust is in place but no valid relay key has been delivered. Rotate the pod's relay key from the control plane.";
}

/** Human summary of the trust facts; "unknown" for any part that could not be read. */
function describeBrokerTrust(diagnostics: BrokerDiagnosticsRead): string {
  if (diagnostics.state !== "read") {
    return `broker kind unknown; credential unknown; issuer unknown; owner link unknown (${diagnostics.detail})`;
  }
  const r = diagnostics.report;
  const credential = !r.relayCredential.present
    ? "credential missing"
    : r.relayCredential.resolvable === false
      ? "credential present but unreadable"
      : `credential present, valid until ${r.relayCredential.validUntil ?? "unknown"}`;
  if (r.broker.kind !== "control-plane") {
    return `broker ${r.broker.kind}`;
  }
  const issuer = !r.cpIssuer.present
    ? "CP issuer missing"
    : r.cpIssuer.status === "approved" && r.cpIssuer.hasSourceConfigWrite
      ? "CP issuer ok"
      : `CP issuer ${r.cpIssuer.status ?? "unknown"}${r.cpIssuer.hasSourceConfigWrite ? "" : " without source-config:write"}`;
  const link = r.ownerIdentityLink.present ? "owner link ok" : "owner link missing";
  return `broker ${r.broker.kind}; ${credential}; ${issuer}; ${link}`;
}

export function brokerCheck(providers: BrokerProvidersRead, diagnostics: BrokerDiagnosticsRead): CheckResult {
  const trust = describeBrokerTrust(diagnostics);
  if (providers.state === "unknown") {
    return {
      name: BROKER_CHECK_NAME,
      ok: false,
      unknown: true,
      detail: `could not determine — ${providers.detail}; ${trust}`,
      fix: "This pod build may predate GET /api/hub/connectors/providers, or the key lacks hub-protocol.read.",
    };
  }
  if (providers.state === "not-configured") {
    return {
      name: BROKER_CHECK_NAME,
      ok: true,
      detail: "no connection broker is configured on this pod — connectors are unavailable",
    };
  }
  if (providers.state === "ok") {
    return { name: BROKER_CHECK_NAME, ok: true, detail: `broker answered; ${trust}` };
  }
  return {
    name: BROKER_CHECK_NAME,
    ok: false,
    detail: `${providers.reason}; ${trust}`,
    fix: brokerFixHint(providers.reason, diagnostics, providers.message),
  };
}

async function probeBrokerProviders(cfg: HubConfig): Promise<BrokerProvidersRead> {
  try {
    return readProvidersEnvelope(await hubGet("/connectors/providers", {}, cfg));
  } catch (err) {
    const body = err instanceof HubError ? (err.body as { error?: unknown } | undefined) : undefined;
    if (err instanceof HubError && err.status === 503 && body?.error === "Nango not configured") {
      return { state: "not-configured" };
    }
    return {
      state: "unknown",
      detail: `the providers door did not answer (${err instanceof Error ? err.message : String(err)})`,
    };
  }
}

async function probeBrokerDiagnostics(cfg: HubConfig): Promise<BrokerDiagnosticsRead> {
  try {
    return readBrokerDiagnostics(await hubGet("/connectors/broker-diagnostics", {}, cfg));
  } catch (err) {
    if (err instanceof HubError && err.status === 404) {
      return { state: "unknown", detail: "this pod does not expose broker diagnostics (older build)" };
    }
    if (err instanceof HubError && err.status === 403) {
      return { state: "unknown", detail: "broker diagnostics need a pod owner/admin key" };
    }
    return {
      state: "unknown",
      detail: `broker diagnostics did not answer (${err instanceof Error ? err.message : String(err)})`,
    };
  }
}

/**
 * Build the same provenance rungs as `synap lens` (session › directory › env ›
 * global), pod-qualified against the active pod so a cross-pod directory lens
 * is not claimed as the origin.
 */
async function activeLensProvenance(podUrl?: string) {
  const { getClaudeSessionId, resolveActiveLensForPod } = await import("../lib/session-lens.js");
  const { resolveDirectoryLensForPod, effectiveDirectoryLens } = await import("../lib/directory-lens.js");
  const session = getClaudeSessionId();
  const sessionLens = resolveActiveLensForPod(podUrl);
  const dir = resolveDirectoryLensForPod(podUrl);

  const rungs: LensRung[] = [
    { source: "session", detail: session ? session.slice(0, 8) : undefined, ...(sessionLens ?? {}) },
    { source: "directory", detail: dir?.file, ...(dir ? effectiveDirectoryLens(dir.lens) : {}) },
    {
      source: "env",
      detail: "SYNAP_WORKSPACE_ID",
      workspaceId: process.env.SYNAP_WORKSPACE_ID,
      projectId: process.env.SYNAP_PROJECT_ID,
    },
    {
      source: "global",
      detail: "~/.synap/config.json",
      workspaceId: getActiveWorkspaceId(),
      projectId: getActiveProjectId(),
    },
  ];
  return resolveLensProvenance(rungs);
}

/** A diagnosis for JSON output — never a key's plaintext. */
function publicDiagnosis(d: Diagnosis) {
  return {
    code: d.code,
    severity: d.severity,
    surface: d.surface,
    title: d.title,
    lines: d.lines,
    command: d.command,
    action: d.action,
    approvalUrl: d.approvalUrl,
    locations: d.locations.map((l) => l.label),
  };
}

/** One word per check for the collapsed "✓ Pod · key · …" line. */
const SHORT_NAME: Record<string, string> = {
  "Pod URL configured": "pod URL",
  "Pod host resolves": "Pod",
  "API key authenticates": "key",
  "Configured workspace exists on this pod": "workspace",
  "Configured project exists on this pod": "project",
  "Workspace + project exist on this pod": "workspace",
  [IS_CHECK_NAME]: "intelligence",
  [BROKER_CHECK_NAME]: "broker",
  "Keys on this computer": "agent keys",
};

const UUID = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;
const ISO = /\b(\d{4}-\d{2}-\d{2})T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?/g;
const INTERNAL_URL = /\s*(?:at\s+)?\bhttps?:\/\/(?:localhost|127\.\d+\.\d+\.\d+|10\.\d+\.\d+\.\d+|192\.168\.\d+\.\d+|172\.(?:1[6-9]|2\d|3[01])\.\d+\.\d+|[a-z0-9-]+(?::\d+)?(?=[\s/)]|$))[^\s)]*/gi;

/**
 * Default output never shows internal addresses, ids or raw timestamps — they
 * are noise to a person and stay one `-v` away. A parenthetical that only
 * carried an id ("(checked as workspace <uuid>)") goes entirely.
 */
export function forDisplay(text: string, verbose = false): string {
  if (verbose) return text;
  return text
    .replace(/\s*\([^()]*\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b[^()]*\)/gi, "")
    .replace(UUID, "…")
    .replace(INTERNAL_URL, "")
    .replace(ISO, "$1")
    .replace(/\s{2,}/g, " ")
    .trim();
}

/** Where a lens field came from, short: "./.synap/lens.json", "SYNAP_WORKSPACE_ID", "this Claude session". */
function lensOrigin(p?: { source: string; detail?: string }): string | undefined {
  if (!p) return undefined;
  if (p.source === "session") return "this Claude session";
  if (p.source === "env") return p.detail ?? "environment";
  if (p.source === "global") return "~/.synap/config.json";
  if (p.detail) {
    const rel = path.relative(process.cwd(), p.detail);
    return rel && !rel.startsWith("..") && !path.isAbsolute(rel) ? `./${rel}` : tildify(p.detail, os.homedir());
  }
  return p.source;
}

async function finish(
  checks: CheckResult[],
  opts: DoctorOpts,
  lens: { podUrl?: string; workspaceId?: string; projectId?: string; workspace?: string; project?: string; podVersion?: string },
  keyHealth?: KeyHealthReport,
  hubCfg?: HubConfig,
  podMove?: PodMove
): Promise<void> {
  // Green requires every check to have VERIFIED something. An undetermined
  // check suppresses green (it is not a pass) but does not fail the run — only
  // a proven failure sets a non-zero exit code.
  const allOk = checks.every((c) => c.ok);
  const anyFailed = checks.some((c) => !c.ok && !c.unknown);
  const anyUnknown = checks.some((c) => c.unknown);
  const activeName = listPodProfiles().find((p) => p.active)?.name ?? "default";
  const keySource = resolveKeySource();
  const provenance = await activeLensProvenance(lens.podUrl);

  if (opts.json) {
    console.log(
      JSON.stringify(
        {
          ok: allOk,
          undetermined: anyUnknown,
          checks,
          keyHealth: keyHealth ? keyHealth.diagnoses.map(publicDiagnosis) : null,
          keysNotChecked: keyHealth
            ? {
                unreadable: keyHealth.unchecked ?? [],
                notSentToThisPod: (keyHealth.notSent ?? []).map((l) => l.label),
              }
            : null,
          cli: cliBuild(),
          lens: {
            pod: activeName,
            podUrl: lens.podUrl,
            workspaceId: lens.workspaceId,
            projectId: lens.projectId,
            keySource,
            provenance,
          },
        },
        null,
        2
      )
    );
    if (anyFailed) process.exitCode = 1;
    return;
  }

  const v = !!opts.verbose;
  const show = (t: string) => forDisplay(t, v);

  // ── Header: which pod, which lens — names, not ids ──────────────────────
  const lensPodName =
    (lens.podUrl &&
      listPodProfiles().find((p) => p.config.podUrl.replace(/\/$/, "") === lens.podUrl!.replace(/\/$/, ""))?.name) ||
    activeName;
  let host = lens.podUrl ?? "no pod";
  try {
    if (lens.podUrl) host = new URL(lens.podUrl).host;
  } catch {
    /* keep raw */
  }
  log.blank();
  console.log(
    `${chalk.bold("synap doctor")} ${chalk.dim("·")} ${lensPodName} ${chalk.dim("·")} ${host}${lens.podVersion ? chalk.dim(` (v${lens.podVersion})`) : ""}`
  );
  const wsName = lens.workspaceId ? lens.workspace ?? (v ? lens.workspaceId : "a workspace this pod does not list") : "pod-wide";
  const lensText = lens.projectId ? `${wsName} › ${lens.project ?? (v ? lens.projectId : "a project this pod does not list")}` : wsName;
  const origin = lensOrigin(provenance.project ?? provenance.workspace);
  console.log(`${chalk.dim("Lens")}   ${lensText}${origin && (lens.workspaceId || lens.projectId) ? chalk.dim(`   (from ${origin})`) : ""}`);
  // Which build is talking: a stale CLI is the first thing to rule out.
  console.log(`${chalk.dim("CLI")}    ${formatCliBuild(cliBuild())}`);
  if (v) {
    console.log(`${chalk.dim("Key")}    ${formatKeySource(keySource)}`);
    if (lens.podUrl) console.log(`${chalk.dim("URL")}    ${lens.podUrl}`);
  }
  log.blank();

  // ── Checks: passes collapse to one line, failures/unknowns in full ───────
  const keyRow = checks.find((c) => c.name === "Keys on this computer");
  const printRow = (c: CheckResult) => {
    const mark = c.ok ? chalk.green("✓") : c.unknown ? chalk.yellow("?") : chalk.red("✗");
    console.log(`${mark} ${chalk.bold(c.name)} — ${show(c.detail)}`);
    if (!c.ok && c.fix) console.log(chalk.dim(`    → ${show(c.fix)}`));
  };
  const passed = checks.filter((c) => c.ok);
  if (v) for (const c of checks) printRow(c);
  else if (passed.length) {
    const words = [...new Set(passed.map((c) => SHORT_NAME[c.name] ?? c.name))];
    console.log(`${chalk.green("✓")} ${words.join(" · ")}${chalk.dim("      (details with -v)")}`);
  }
  if (!v) for (const c of checks.filter((c) => !c.ok && c !== keyRow)) printRow(c);

  // The key row's problems are the key-health lines themselves — no second copy.
  if (keyHealth) {
    const { printKeyHealth, fixKeyHealth, keyProblems } = await import("../lib/key-doctor.js");
    printKeyHealth(keyHealth, { fixHint: !opts.fix, verbose: v, showOk: v, indent: "" });
    if (opts.fix && keyProblems(keyHealth).some(isFixable)) {
      log.blank();
      console.log(chalk.bold("Fixing"));
      const outcomes = await fixKeyHealth(keyHealth);
      for (const o of outcomes) console.log(`  ${o.ok ? chalk.green("✓") : chalk.red("✗")} ${o.message}`);
      // Every problem fixed AND verified live over MCP: the key row is green now.
      if (keyRow && outcomes.length > 0 && outcomes.every((o) => o.ok)) {
        keyRow.ok = true;
        keyRow.unknown = false;
        keyRow.detail = "fixed and verified (MCP initialize)";
      }
    }
  }

  // ── A moved pod: rewrite the saved address through the one door ──────────
  if (podMove && opts.fix) {
    log.blank();
    console.log(chalk.bold("Fixing"));
    const hostRow = checks.find((c) => c.name === "Pod host resolves");
    if (await fixPodMove(podMove)) {
      if (hostRow) {
        hostRow.ok = true;
        hostRow.detail = `updated to ${podMove.to} — run synap doctor again to check the rest`;
      }
    }
  }

  // ── One agent, several computers ─────────────────────────────────────────
  if (hubCfg) {
    log.blank();
    console.log(chalk.bold("Connected agents"));
    await printAgentConnections(hubCfg);
  }

  // Env pin beats the active profile in resolveHubConfig — same divergence
  // `synap pods list` already names. Surface it here so doctor alone is enough
  // to catch "profile says perso, every write goes to team".
  const envPod = process.env.SYNAP_POD_URL?.trim();
  const activeProfile = listPodProfiles().find((p) => p.active);
  if (envPod && activeProfile && !samePodOrigin(envPod, activeProfile.config.podUrl)) {
    log.blank();
    log.warn(
      `SYNAP_POD_URL overrides the active profile — commands are talking to ${envPod}, not ${activeProfile.config.podUrl}.`
    );
    log.dim("  The env var wins over the ● active profile. Unset it (or open a fresh shell) for the profile to apply.");
  }

  // ── Verdict: the last line. Recomputed: --fix may have turned keys green.
  const finalOk = checks.every((c) => c.ok);
  const finalFailed = checks.some((c) => !c.ok && !c.unknown);
  log.blank();
  if (finalOk) {
    console.log(chalk.green("✓ All checks passed."));
  } else if (finalFailed) {
    const n = checks.filter((c) => !c.ok && !c.unknown).length;
    console.log(chalk.red(`✗ ${n} check${n === 1 ? "" : "s"} failed — the actions above fix ${n === 1 ? "it" : "them"}.`));
    process.exitCode = 1;
  } else {
    // Not green: something could not be determined. Saying "all clear" here is
    // the failure mode this command exists to avoid.
    console.log(chalk.yellow("? Nothing failed, but not everything could be checked — see the ? lines."));
  }
}
