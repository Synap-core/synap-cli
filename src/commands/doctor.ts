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
 *   (d) prints the active lens (pod, workspace, project) so the user sees
 *       exactly where they're pointed.
 *
 * Degrades gracefully on older pods (missing /orient, no release/status route)
 * — a check that can't run says so and moves on, it never throws.
 */

import chalk from "chalk";
import { log, banner } from "../utils/logger.js";
import { getActivePodConfig, listPodProfiles, checkPodHealth } from "../lib/pod.js";
import { resolveHubConfig, hubGet, HubError, type HubConfig } from "../lib/hub-client.js";

interface DoctorOpts {
  json?: boolean;
}

interface CheckResult {
  name: string;
  ok: boolean;
  detail: string;
  fix?: string;
}

export async function doctor(opts: DoctorOpts = {}): Promise<void> {
  const checks: CheckResult[] = [];
  const activeName = listPodProfiles().find((p) => p.active)?.name ?? "default";

  // ── (a) Host resolves — the pod is actually served at this URL ───────────
  const localConfig = getActivePodConfig();
  const podUrl = localConfig?.podUrl ?? process.env.SYNAP_POD_URL;

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
  let cfgResolved: HubConfig | undefined;
  if (!hostServed) {
    checks.push({
      name: "API key authenticates",
      ok: false,
      detail: "skipped — pod host is unreachable",
      fix: "Fix the pod host check above first.",
    });
  } else {
    try {
      const cfg = await resolveHubConfig();
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

  await finish(checks, opts, {
    podUrl,
    workspaceId: cfgResolved?.workspaceId,
    projectId: cfgResolved?.projectId,
  });
}

async function finish(
  checks: CheckResult[],
  opts: DoctorOpts,
  lens: { podUrl?: string; workspaceId?: string; projectId?: string }
): Promise<void> {
  const allOk = checks.every((c) => c.ok);
  const activeName = listPodProfiles().find((p) => p.active)?.name ?? "default";

  if (opts.json) {
    console.log(
      JSON.stringify(
        {
          ok: allOk,
          checks,
          lens: { pod: activeName, podUrl: lens.podUrl, workspaceId: lens.workspaceId, projectId: lens.projectId },
        },
        null,
        2
      )
    );
    if (!allOk) process.exitCode = 1;
    return;
  }

  banner();
  log.heading("Coherence Preflight");
  for (const c of checks) {
    const mark = c.ok ? chalk.green("✓") : chalk.red("✗");
    console.log(`  ${mark} ${chalk.bold(c.name)}`);
    log.dim(`     ${c.detail}`);
    if (!c.ok && c.fix) log.dim(`     → ${c.fix}`);
  }

  log.blank();
  log.heading("Active Lens");
  console.log(`  Pod       : ${chalk.bold(activeName)}${lens.podUrl ? `  ${chalk.dim(lens.podUrl)}` : ""}`);
  console.log(`  Workspace : ${lens.workspaceId ? lens.workspaceId : chalk.dim("none (pod-wide)")}`);
  console.log(`  Project   : ${lens.projectId ? lens.projectId : chalk.dim("none")}`);

  log.blank();
  if (allOk) {
    log.success("All checks passed.");
  } else {
    log.warn("One or more checks failed — see the fixes above.");
    process.exitCode = 1;
  }
  log.blank();
}
