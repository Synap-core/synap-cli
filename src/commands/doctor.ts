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
 *   (e) prints the active lens (pod, workspace, project) so the user sees
 *       exactly where they're pointed.
 *
 * Degrades gracefully on older pods (missing /orient, no dependency probe) — a
 * check that can't run says so and moves on, it never throws. Crucially, a
 * check that could not run reports "could not determine" and is NOT green: an
 * unknown is not a pass. Only a PROVEN failure sets a non-zero exit code.
 */

import chalk from "chalk";
import { log, banner } from "../utils/logger.js";
import { getActivePodConfig, getActiveWorkspaceId, getActiveProjectId, listPodProfiles, checkPodHealth } from "../lib/pod.js";
import { resolveHubConfig, hubGet, HubError, type HubConfig } from "../lib/hub-client.js";
import { formatKeySource, resolveKeySource } from "../lib/key-source.js";
import { resolveLensProvenance, type LensRung } from "../lib/describe-lens.js";
import { samePodOrigin } from "../lib/project-ref.js";

interface DoctorOpts {
  json?: boolean;
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
  const health = await checkPodHealth(podUrl);
  if (health.healthy) {
    hostServed = true;
    checks.push({
      name: "Pod host resolves",
      ok: true,
      detail: `${podUrl} is served${health.version ? ` (v${health.version})` : ""}`,
    });
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
      checks.push({
        name: "API key authenticates",
        ok: false,
        detail: is401 ? "the pod rejected this key (expired or revoked)" : `could not verify (${err instanceof Error ? err.message : String(err)})`,
        fix: `Run: synap login --reconnect ${activeName}`,
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

  await finish(checks, opts, {
    // Prefer the pod resolveHubConfig actually hit — health-check URL can lag
    // the active profile when the shell is env-pinned to another pod.
    podUrl: cfgResolved?.podUrl ?? podUrl,
    workspaceId: cfgResolved?.workspaceId,
    projectId: cfgResolved?.projectId,
  });
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

/**
 * Build the same provenance rungs as `synap lens` (session › directory › env ›
 * global), pod-qualified against the active pod so a cross-pod directory lens
 * is not claimed as the origin.
 */
async function activeLensProvenance(podUrl?: string) {
  const { getClaudeSessionId, resolveActiveLensForPod } = await import("../lib/session-lens.js");
  const { resolveDirectoryLensForPod } = await import("../lib/directory-lens.js");
  const session = getClaudeSessionId();
  const sessionLens = resolveActiveLensForPod(podUrl);
  const dir = resolveDirectoryLensForPod(podUrl);

  const rungs: LensRung[] = [
    { source: "session", detail: session ? session.slice(0, 8) : undefined, ...(sessionLens ?? {}) },
    { source: "directory", detail: dir?.file, ...(dir?.lens ?? {}) },
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

async function finish(
  checks: CheckResult[],
  opts: DoctorOpts,
  lens: { podUrl?: string; workspaceId?: string; projectId?: string }
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

  banner();
  log.heading("Coherence Preflight");
  for (const c of checks) {
    const mark = c.ok ? chalk.green("✓") : c.unknown ? chalk.yellow("?") : chalk.red("✗");
    console.log(`  ${mark} ${chalk.bold(c.name)}`);
    log.dim(`     ${c.detail}`);
    if (!c.ok && c.fix) log.dim(`     → ${c.fix}`);
  }

  log.blank();
  log.heading("Active Lens");
  // Prefer the pod we actually talked to (cfg / --pod), not only ● active profile.
  const lensPodName =
    (lens.podUrl &&
      listPodProfiles().find(
        (p) =>
          p.config.podUrl.replace(/\/$/, "") === lens.podUrl!.replace(/\/$/, "")
      )?.name) ||
    activeName;
  console.log(
    `  Pod       : ${chalk.bold(lensPodName)}${lens.podUrl ? `  ${chalk.dim(lens.podUrl)}` : ""}`
  );
  console.log(`  Key       : ${formatKeySource(keySource)}`);
  // Prefer resolved cfg ids (what writes use) over provenance of global config.
  const resolvedWs = lens.workspaceId;
  const resolvedProj = lens.projectId;
  const ws = provenance.workspace;
  const proj = provenance.project;
  console.log(
    `  Workspace : ${
      resolvedWs
        ? `${resolvedWs}${ws?.origin ? `  ${chalk.dim(`(${ws.origin})`)}` : ""}`
        : chalk.dim("— (pod-wide)")
    }`
  );
  console.log(
    `  Project   : ${
      resolvedProj
        ? `${resolvedProj}${proj?.origin ? `  ${chalk.dim(`(${proj.origin})`)}` : ""}`
        : chalk.dim("— none")
    }`
  );

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

  log.blank();
  if (allOk) {
    log.success("All checks passed.");
  } else if (anyFailed) {
    log.warn("One or more checks failed — see the fixes above.");
    process.exitCode = 1;
  } else {
    // Not green: something could not be determined. Saying "all clear" here is
    // the failure mode this command exists to avoid.
    log.warn("Not all checks could be determined — see the '?' rows above.");
  }
  log.blank();
}
