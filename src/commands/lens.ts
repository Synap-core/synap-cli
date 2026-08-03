/**
 * Per-Claude-session lens commands: `synap project use/clear` and `synap lens`.
 *
 * These bind the cross-cutting "project" dimension and let you inspect the
 * full lens (workspace + project + focus session) for the current Claude Code
 * session. All state lives in ~/.synap/lenses/<session_id>.json — no backend
 * change; the pod stays agnostic.
 */

import chalk from "chalk";
import { resolveHubConfig, hubGet, renderHubError } from "../lib/hub-client.js";
import { getClaudeSessionId, writeLens, clearLensField, resolveActiveLens } from "../lib/session-lens.js";
import {
  setActiveProjectId,
  clearActiveProjectId,
  getActiveProjectId,
  setActiveProjectBinding,
  setActivePod,
  addPodProfile,
  listPodProfiles,
  provisionUserOnPod,
  setupAgentViaPod,
} from "../lib/pod.js";
import { getStoredToken } from "../lib/auth.js";
import {
  resolveProjectRef,
  sessionScopeRefusal,
  samePodOrigin,
  candidateLabel,
  type CpProjectResolution,
} from "../lib/project-ref.js";
import { fetchProjects, createProject } from "../lib/project.js";
import { unwrapList } from "../lib/unwrapList.js";
import { renderNextSteps, FLOW } from "../lib/next-steps.js";
import { log } from "../utils/logger.js";
import { type BaseOpts } from "./data.js";

function requireClaudeSession(): string {
  const id = getClaudeSessionId();
  if (!id) {
    console.error(chalk.red("Not in a Claude Code session (CLAUDE_CODE_SESSION_ID unset)."));
    log.dim("--session scoping is per-Claude-session. Drop --session to persist the project globally instead.");
    process.exit(1);
  }
  return id;
}

/**
 * Pin the active project — a peer lens to `synap use <workspace>`.
 *
 * `ref` goes through the ONE resolution door (`lib/project-ref.ts`):
 *   - uuid → today's behavior exactly: pinned against the ACTIVE pod.
 *   - slug / <pod>/<slug> → resolved via the Control Plane directory; when the
 *     project lives on another pod, the CLI switches activePod AND the project
 *     together (auto-provisioning access on the pod if it isn't saved locally).
 *
 * Default: DURABLE — persists to ~/.synap/config.json (activeProjectId), same
 * tier as `synap use`. Composes with a Claude session: when one is active, the
 * session lens is ALSO updated so `resolveActiveLens()` reflects it immediately.
 * `--session`: ephemeral — scopes only this Claude Code session. Cross-pod refs
 * are REFUSED there: `--session` never switches the active pod, so the pin
 * would name a project the session can't reach. Every write stamps the lens's
 * `podUrl` so a later `synap pods use` can't leave it pointing at a foreign id.
 */
export async function useProject(
  ref: string,
  opts: BaseOpts & { session?: boolean; global?: boolean }
): Promise<void> {
  if (opts.session && opts.global) {
    log.error("--session and --global are opposite scopes — pass at most one.");
    process.exit(1);
  }
  const resolution = await resolveProjectRef(ref);

  switch (resolution.kind) {
    case "invalid":
      log.error(resolution.reason);
      process.exit(1);
      break;
    case "not-logged-in":
      log.error(`Cross-pod project refs resolve via your Synap account — run: synap login`);
      log.hint("Or pin by uuid against the active pod: synap project use <projectId> (see: synap project list)");
      process.exit(1);
      break;
    case "not-active":
      log.error(`Project "${ref}" exists but is ${resolution.status} — it cannot be focused.`);
      log.hint("Reactivate it on its pod first, or pick an active project: synap project list");
      process.exit(1);
      break;
    case "not-found":
      log.error(`Project "${ref}" was not found in the directory.`);
      log.hint("Check the slug with: synap project list — or use the full <pod-subdomain>/<slug> form.");
      process.exit(1);
      break;
    case "cp-error":
      log.error(`Could not resolve "${ref}": ${resolution.message}`);
      log.hint("The directory is an accelerator, not a dependency — uuid refs keep working: synap project use <projectId>");
      process.exit(1);
      break;
    case "ambiguous": {
      if (opts.json) {
        console.log(JSON.stringify({ ambiguous: true, candidates: resolution.candidates }, null, 2));
        process.exit(1);
      }
      log.warn(`"${ref}" matches ${resolution.candidates.length} projects — use the full <pod-subdomain>/<slug> form:`);
      for (const c of resolution.candidates) {
        console.log(`    ${chalk.bold(candidateLabel(c))}${c.name ? chalk.dim(`  ${c.name}`) : ""}`);
      }
      process.exit(1);
      break;
    }
    case "local":
      await useProjectOnActivePod(resolution.projectId, opts);
      return;
    case "resolved":
      await useCrossPodProject(ref, resolution.project, resolution.refPod, opts);
      return;
  }
}

/**
 * Did the pod actually ANSWER with a project list? `unwrapList` flattens both
 * "empty list" and "shape I don't recognise" to `[]`, and the two mean opposite
 * things here: an empty list is a definitive "no such project on this pod",
 * an unrecognised body proves nothing. Never infer pod state from the shape of
 * a response you couldn't parse.
 */
function isProjectListEnvelope(res: unknown): boolean {
  if (Array.isArray(res)) return true;
  if (!res || typeof res !== "object") return false;
  const obj = res as Record<string, unknown>;
  return Array.isArray(obj.data) || Array.isArray(obj.projects);
}

export type ProjectCheck =
  | { kind: "found"; name: string }
  /** The pod answered a list, and this project is not in it. */
  | { kind: "absent" }
  /** We never got a parseable answer — the pin is unvalidated, not disproven. */
  | { kind: "inconclusive"; detail: string };

/**
 * Classify what a pod's GET /projects body says about `projectId` — PURE, so
 * the fail-open/fail-closed rule is unit-testable.
 *
 * Deployed pods return a BARE ARRAY from GET /projects (and may ignore `ids`),
 * so read it through `unwrapList` exactly like `fetchProjects` and the
 * cross-pod path do — matching on `res.projects` alone would call every
 * project absent on those pods.
 */
export function classifyProjectLookup(res: unknown, projectId: string): ProjectCheck {
  if (!isProjectListEnvelope(res)) {
    return { kind: "inconclusive", detail: "the pod returned an unrecognised /projects response" };
  }
  const match = unwrapList<{ id: string; name?: string }>(res, ["projects"]).find((p) => p.id === projectId);
  return match ? { kind: "found", name: String(match.name ?? projectId) } : { kind: "absent" };
}

/** Ask the pod whether `projectId` exists. Transport failure → inconclusive. */
async function checkProjectOnPod(
  projectId: string,
  cfg: Awaited<ReturnType<typeof resolveHubConfig>>
): Promise<ProjectCheck> {
  try {
    const res = await hubGet(`/projects?ids=${encodeURIComponent(projectId)}`, {}, cfg);
    return classifyProjectLookup(res, projectId);
  } catch (e) {
    return { kind: "inconclusive", detail: (e as Error).message };
  }
}

/** uuid path — pin against the active pod, after asking the pod if it exists. */
async function useProjectOnActivePod(
  projectId: string,
  opts: BaseOpts & { session?: boolean; global?: boolean }
): Promise<void> {
  let name = projectId;
  let podUrl: string | undefined;
  let unvalidated: string | undefined;

  let cfg: Awaited<ReturnType<typeof resolveHubConfig>> | undefined;
  try {
    cfg = await resolveHubConfig(opts);
    podUrl = cfg.podUrl;
  } catch (e) {
    unvalidated = (e as Error).message;
  }

  if (cfg) {
    const check = await checkProjectOnPod(projectId, cfg);
    if (check.kind === "found") {
      name = check.name;
    } else if (check.kind === "absent") {
      // The pod REACHED and ANSWERED: this id is not a project here. Pinning it
      // would silently mis-scope every subsequent call — fail instead.
      log.error(`Project ${projectId} does not exist on ${cfg.podUrl}.`);
      log.hint("List what's there: synap project list — or switch pods: synap pods use <name>");
      process.exit(1);
    } else {
      unvalidated = check.detail;
    }
  }

  // Unreachable pod → best-effort accept (offline pinning stays possible), but
  // SAY SO rather than pretending the id was validated.
  if (unvalidated) {
    log.warn(`could not verify project ${projectId} against the pod (${unvalidated}) — pinning it unvalidated.`);
  }

  const steps = FLOW.afterProjectUse(name);

  if (opts.session) {
    const session = requireClaudeSession();
    writeLens(session, { projectId, podUrl });
    if (opts.json) {
      console.log(JSON.stringify({ projectId, name, scope: "session", nextSteps: steps }, null, 2));
      return;
    }
    log.success(`Project focus: ${chalk.bold(name)} ${chalk.dim("(this session)")}`);
    renderNextSteps(steps);
    return;
  }

  // Default: mirror `synap use <workspace>` EXACTLY — inside a Claude Code
  // session, scope to THIS session's lens (concurrent sessions stay
  // independent); otherwise the per-DIRECTORY lens, which is the ratified
  // durable default for a working tree. `--global` opts back into the
  // machine-wide config; `--session` (above) forces session-scope and errors
  // when there's no session. Project and workspace stay symmetric so a pin
  // doesn't unexpectedly leak pod-wide from a session.
  const session = opts.global ? undefined : getClaudeSessionId();
  let scope: "session" | "directory" | "global";
  let where: string | undefined;
  if (session) {
    writeLens(session, { projectId, podUrl });
    scope = "session";
  } else if (opts.global) {
    setActiveProjectId(projectId);
    scope = "global";
  } else {
    const { writeDirectoryLens } = await import("../lib/directory-lens.js");
    const written = writeDirectoryLens({ projectId, ...(podUrl ? { podUrl } : {}) });
    scope = "directory";
    where = written.file;
  }
  if (opts.json) {
    console.log(JSON.stringify({ projectId, name, scope, ...(where ? { lensFile: where } : {}), nextSteps: steps }, null, 2));
    return;
  }
  const scopeNote =
    scope === "session" ? "(this session)" : scope === "global" ? "(global default)" : "(this directory)";
  log.success(`Project focus: ${chalk.bold(name)} ${chalk.dim(scopeNote)}`);
  if (where) log.dim(`  ${where}`);
  renderNextSteps(steps);
}

/**
 * Directory-resolved path: the project may live on ANOTHER pod. Switch
 * activePod AND the project together; auto-provision the pod locally when it
 * isn't in ~/.synap yet (existing doors: provisionUserOnPod + setupAgentViaPod).
 */
async function useCrossPodProject(
  ref: string,
  project: CpProjectResolution,
  refPod: string | undefined,
  opts: BaseOpts & { session?: boolean }
): Promise<void> {
  const profiles = listPodProfiles();
  const activeProfile = profiles.find((p) => p.active);
  let target = profiles.find((p) => samePodOrigin(p.config.podUrl, project.podUrl));

  // ── --session: the session lens has no pod field — refuse cross-pod refs.
  if (opts.session) {
    const refusal = sessionScopeRefusal(project, activeProfile?.config.podUrl);
    if (refusal) {
      log.error(refusal);
      process.exit(1);
    }
    const session = requireClaudeSession();
    writeLens(session, { projectId: project.projectId, podUrl: project.podUrl });
    const steps = FLOW.afterProjectUse(project.name);
    if (opts.json) {
      console.log(JSON.stringify({ projectId: project.projectId, name: project.name, scope: "session", nextSteps: steps }, null, 2));
      return;
    }
    log.success(`Project focus: ${chalk.bold(project.name)} ${chalk.dim("(this session)")}`);
    renderNextSteps(steps);
    return;
  }

  const podHost = (() => {
    try {
      return new URL(project.podUrl).hostname;
    } catch {
      return project.podUrl;
    }
  })();

  // ── Pod not saved locally → auto-provision via the existing doors.
  if (!target) {
    const creds = getStoredToken();
    if (!creds?.token) {
      // resolveProjectRef required a login, so this only happens if the creds
      // file vanished mid-command — same remedy either way.
      log.error("Not logged in — run: synap login");
      process.exit(1);
    }
    log.dim(`Pod ${podHost} isn't configured locally — provisioning access…`);
    try {
      const { sessionToken } = await provisionUserOnPod(project.podUrl, creds.token);
      if (!sessionToken) {
        throw new Error("the pod returned no session from the federation handshake");
      }
      const agent = await setupAgentViaPod(project.podUrl, sessionToken, "cli");
      const name = refPod && !profiles.some((p) => p.name === refPod) ? refPod : podHost;
      const config = {
        podUrl: project.podUrl,
        podId: project.podId,
        workspaceId: agent.workspaceId,
        agentUserId: agent.agentUserId,
        hubApiKey: agent.hubApiKey,
        label: `added by synap project use ${ref}`,
        savedAt: new Date().toISOString(),
      };
      addPodProfile(name, config);
      target = { name, config, active: false };
      log.success(`Pod saved: ${chalk.bold(name)} ${chalk.dim(`(${podHost})`)}`);
    } catch (e) {
      log.error(`Could not provision access on ${project.podUrl}: ${(e as Error).message}`);
      log.hint("Add the pod manually with: synap pods add — then re-run this command.");
      process.exit(1);
    }
  }

  // ── Switch pod + project TOGETHER, and store the binding for drift warnings.
  const switched = target.name !== activeProfile?.name;
  if (switched) setActivePod(target.name);
  setActiveProjectBinding({ projectId: project.projectId, podName: target.name });
  const session = getClaudeSessionId();
  if (session) writeLens(session, { projectId: project.projectId, podUrl: target.config.podUrl });

  // Env pinning beats the config switch in resolveHubConfig — warn loudly.
  const envPinned = Boolean(process.env.SYNAP_POD_URL && process.env.SYNAP_HUB_API_KEY);

  // ── Liveness: same post-resolve check the uuid path does, but aimed at the
  // NEW pod directly (resolveHubConfig would let env pinning aim it at the old
  // one). Deployed pods return a BARE ARRAY from GET /projects (and may ignore
  // `ids`), so read it through unwrapList like fetchProjects does.
  let name = project.name || project.slug || project.projectId;
  let stale = false;
  try {
    const cfg = {
      podUrl: target.config.podUrl,
      apiKey: target.config.hubApiKey,
      userId: target.config.agentUserId || "cli",
    };
    const res = await hubGet(`/projects?ids=${encodeURIComponent(project.projectId)}`, {}, cfg);
    const list = unwrapList<{ id: string; name?: string }>(res, ["projects"]);
    const match = list.find((p) => p.id === project.projectId);
    if (match) name = String(match.name ?? name);
    else stale = true;
  } catch {
    /* liveness is best-effort — the pin already happened */
  }

  const steps = FLOW.afterProjectUse(name);
  if (opts.json) {
    console.log(
      JSON.stringify(
        {
          projectId: project.projectId,
          name,
          slug: project.slug,
          pod: { name: target.name, url: target.config.podUrl },
          switchedPod: switched,
          envPinned,
          staleDirectoryEntry: stale,
          scope: "global",
          nextSteps: steps,
        },
        null,
        2
      )
    );
    return;
  }

  if (switched) {
    log.success(`switched pod: ${activeProfile?.name ?? "(none)"} → ${chalk.bold(target.name)} ${chalk.dim(`(${podHost})`)}`);
  }
  log.success(`Project focus: ${chalk.bold(name)} ${chalk.dim("(persisted)")}`);
  if (stale) {
    log.warn(`stale directory entry: the pod at ${target.config.podUrl} does not report project ${project.projectId} — the directory may be out of date.`);
  }
  if (envPinned) {
    log.warn(
      "this shell is env-pinned: SYNAP_POD_URL / SYNAP_HUB_API_KEY are set, and they override the pod switch for hub calls made from THIS environment. Unset them (or open a fresh shell) for the switch to apply here."
    );
  }
  renderNextSteps(steps);
}

export async function clearProject(opts: BaseOpts & { session?: boolean }): Promise<void> {
  if (opts.session) {
    const session = requireClaudeSession();
    clearLensField(session, "projectId");
    if (opts.json) {
      console.log(JSON.stringify({ cleared: "projectId", scope: "session" }));
      return;
    }
    log.success("Project focus cleared (this session)");
    return;
  }

  // Clear EVERY rung the CLI can write — global config, session lens, and the
  // directory lens `project use` now writes by default. Leaving that last rung
  // standing would report success while the scope survived.
  clearActiveProjectId();
  const session = getClaudeSessionId();
  if (session) clearLensField(session, "projectId");
  const { clearDirectoryLensField } = await import("../lib/directory-lens.js");
  const clearedFile = clearDirectoryLensField("projectId");
  if (opts.json) {
    console.log(JSON.stringify({ cleared: "projectId", scope: "global", ...(clearedFile ? { lensFile: clearedFile } : {}) }));
    return;
  }
  log.success("Project focus cleared");
  if (clearedFile) log.dim(`  also cleared in ${clearedFile}`);
}

/**
 * `synap lens` — what am I scoped to, and WHICH rung decided that.
 *
 * It no longer bails out with "Not in a Claude Code session": since the
 * per-directory lens became the durable default, a session is one rung of
 * several and its absence says nothing about whether a scope is in force.
 * Every bound field is printed with its origin ("directory lens:
 * /path/.synap/lens.json") because a silently-resolved scope is precisely what
 * makes a later 403 unexplainable.
 */
export async function showLens(opts: BaseOpts): Promise<void> {
  const session = getClaudeSessionId();
  const { resolveLensProvenance } = await import("../lib/describe-lens.js");
  const { resolveDirectoryLensForPod, findDirectoryLens } = await import("../lib/directory-lens.js");
  const { getActiveWorkspaceId } = await import("../lib/pod.js");

  // Which pod are we resolving against? Needed to pod-qualify both lenses the
  // same way `resolveHubConfig` does. An unreachable/unconfigured pod is not
  // fatal — `lensMatchesPod` treats an unknown target pod as matching.
  let podUrl: string | undefined;
  try {
    podUrl = (await resolveHubConfig(opts)).podUrl;
  } catch {
    /* not configured — provenance still renders */
  }

  const { resolveActiveLensForPod } = await import("../lib/session-lens.js");
  const sessionLens = resolveActiveLensForPod(podUrl);
  const dir = resolveDirectoryLensForPod(podUrl);
  // A lens that EXISTS but belongs to another pod is the single most confusing
  // state (`synap pods use` leaves it behind), so name it rather than silently
  // skipping the rung.
  const ignoredDir = !dir ? findDirectoryLens() : null;

  // Highest precedence first — same order as the ladder in hub-client.ts.
  const provenance = resolveLensProvenance([
    { source: "session", detail: session ? session.slice(0, 8) : undefined, ...(sessionLens ?? {}) },
    { source: "directory", detail: dir?.file, ...(dir?.lens ?? {}) },
    {
      source: "env",
      detail: "SYNAP_WORKSPACE_ID",
      workspaceId: process.env.SYNAP_WORKSPACE_ID,
      projectId: process.env.SYNAP_PROJECT_ID,
    },
    { source: "global", detail: "~/.synap/config.json", workspaceId: getActiveWorkspaceId(), projectId: getActiveProjectId() },
  ]);

  if (opts.json) {
    console.log(
      JSON.stringify(
        {
          session,
          podUrl,
          lens: sessionLens,
          directoryLens: dir ? { file: dir.file, lens: dir.lens } : null,
          ignoredDirectoryLens: ignoredDir ? { file: ignoredDir.file, podUrl: ignoredDir.lens.podUrl } : null,
          resolved: provenance,
        },
        null,
        2
      )
    );
    return;
  }

  console.log(chalk.bold("Lens"), session ? chalk.dim(`session ${session.slice(0, 8)}`) : chalk.dim("(no Claude session)"));
  const rows: Array<[string, { id: string; origin: string } | undefined]> = [
    ["Workspace", provenance.workspace],
    ["Project", provenance.project],
    ["Session", provenance.session],
  ];
  for (const [label, field] of rows) {
    const pad = " ".repeat(Math.max(1, 10 - label.length));
    if (!field) {
      console.log(`  ${label}:${pad}${chalk.dim(label === "Workspace" ? "— (pod-wide)" : "— none")}`);
      continue;
    }
    console.log(`  ${label}:${pad}${chalk.white(field.id)}  ${chalk.dim(`(${field.origin})`)}`);
  }
  if (ignoredDir) {
    log.warn(
      `ignoring ${ignoredDir.file} — it is stamped for ${ignoredDir.lens.podUrl ?? "another pod"}, not ${podUrl ?? "the active pod"}.`
    );
  }
}

/** The active project — session lens first, then the durable global default. */
function activeProjectId(): string | undefined {
  return resolveActiveLens()?.projectId || getActiveProjectId();
}

/**
 * List the projects on the active pod (mirrors `synap pods`) with an ACTIVE
 * marker on the currently-pinned one. Full ids are shown so they paste straight
 * into `synap project use <id>`. Degrades to an empty list offline.
 */
export async function projectList(opts: BaseOpts): Promise<void> {
  let projects: Awaited<ReturnType<typeof fetchProjects>> = [];
  try {
    const cfg = await resolveHubConfig(opts);
    projects = await fetchProjects(cfg);
  } catch (e) {
    if (opts.json) {
      console.log(JSON.stringify({ projects: [], activeProjectId: activeProjectId() ?? null, nextSteps: FLOW.afterProjectList() }, null, 2));
      return;
    }
    renderHubError(e);
    return;
  }

  const active = activeProjectId();
  const steps = FLOW.afterProjectList();

  if (opts.json) {
    console.log(
      JSON.stringify(
        {
          projects: projects.map((p) => ({ id: p.id, name: p.name, active: p.id === active })),
          activeProjectId: active ?? null,
          nextSteps: steps,
        },
        null,
        2
      )
    );
    return;
  }

  log.heading("Projects");
  if (projects.length === 0) {
    log.dim("No projects yet — a project is a company/initiative that ties workspaces together.");
    log.dim("Create one: synap project new <name>");
    return;
  }
  for (const p of projects) {
    const marker = p.id === active ? chalk.green("▶ ") : "  ";
    console.log(`  ${marker}${chalk.bold(p.name)}  ${chalk.dim(p.id)}`);
  }
  renderNextSteps(steps);
}

/**
 * Create a project on the active pod. Governance may queue it as a proposal
 * instead of creating it live — we distinguish and message accordingly. On a
 * live create, guides the user to pin it + add to it.
 */
export async function projectNew(
  name: string,
  opts: BaseOpts & { description?: string }
): Promise<void> {
  let created: Awaited<ReturnType<typeof createProject>>;
  try {
    const cfg = await resolveHubConfig(opts);
    created = await createProject(cfg, { name, description: opts.description });
  } catch (e) {
    renderHubError(e);
    process.exit(1);
  }

  const proposed = !created.id && Boolean(created.proposalId);
  const steps = created.id
    ? FLOW.afterProjectNew(name, created.id)
    : [{ command: "synap proposals list", why: `approve the queued creation of ${name}` }];

  if (opts.json) {
    console.log(
      JSON.stringify(
        { id: created.id ?? null, proposalId: created.proposalId ?? null, name, status: created.status ?? null, nextSteps: steps },
        null,
        2
      )
    );
    return;
  }

  if (proposed) {
    log.warn(`Project "${name}" isn't live yet — governance queued it for your approval.`);
    if (created.proposalId) log.hint(`Approve proposal ${created.proposalId}, then retry pinning it.`);
    renderNextSteps(steps);
    return;
  }

  log.success(`Project created: ${chalk.bold(name)}${created.id ? chalk.dim(`  ${created.id}`) : ""}`);
  renderNextSteps(steps);
}
