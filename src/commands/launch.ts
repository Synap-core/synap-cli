/**
 * `synap launch` — nothing → a working company.
 *
 * This is NOT a template browser. It is the opinionated, guided, run-once
 * command that turns an empty pod into a company: one PROJECT (the cross-cutting
 * lens) + N domain WORKSPACES, provisioned from templates and linked together.
 * Browsing "what else could I add?" lives in the marketplace UI; `synap orient`
 * shows what you already have.
 *
 * Interactive flow:
 *   1. Ask the company/project name → attach to an existing PROJECT or create one
 *   2. Describe the company → suggest domains → pick/adjust the set
 *   3. Disclose the FULL plan (incl. dependencies) → confirm
 *   4. For each template → POST /packages/apply → report the real outcome
 *
 * Discovery is LOCAL: the bundled @synap-core/workspace-templates package is the
 * single source of truth (the pod exposes no GET /packages). It carries the
 * private, CLI-only templates too — those can never appear in the CP marketplace,
 * which is why this command is the only installer for them.
 *
 * Dependencies are resolved SERVER-side: `toPackageDefinition` carries the
 * template's `dependencies` into the body, and the apply endpoint ensures each
 * one is present first (installing missing bases topologically) and LAYERS a
 * `compose` template onto its base instead of creating a second workspace. So
 * this command's job is to DISCLOSE the graph before the user commits — never to
 * install the extras itself.
 *
 * Installs are GOVERNED: /packages/apply answers 202 `{status:"proposed"}` when
 * the write needs review. That is normal, not a failure — but it means nothing is
 * live until the proposal is approved, so we never print "ready" for it.
 */

import prompts from "prompts";
import ora from "ora";
import chalk from "chalk";
import {
  listWorkspaceTemplates,
  toPackageDefinition,
  type WorkspaceYaml,
} from "@synap-core/workspace-templates";
import { log, banner } from "../utils/logger.js";
import {
  resolveHubConfig,
  hubGet,
  hubPost,
  renderHubError,
} from "../lib/hub-client.js";
import { writeGovernance } from "../lib/capture-lane.js";
import { unwrapList } from "../lib/unwrapList.js";

// Provisioning a template writes profiles, properties, views, bento layouts and
// seed entities in one call — `life-os` alone carries 21 profiles and 25 views.
// The 15s CRUD default turns a legitimately-slow apply into a phantom failure,
// so this door opts into the longer budget (same precedent as `cap run`).
const APPLY_TIMEOUT_MS = 120_000;

// ── Template catalog (local, instant, offline) ───────────────────────────────

/** Every bundled template, keyed by slug. */
function catalog(): Map<string, WorkspaceYaml> {
  return new Map(listWorkspaceTemplates().map((t) => [t.meta.slug, t]));
}

/** The `compose` dependency, if any — the base this template LAYERS onto. */
function composeBase(t: WorkspaceYaml): string | undefined {
  return t.dependencies?.find((d) => d.relation === "compose")?.slug;
}

/** An overlay adds no workspace of its own — it layers onto its base. */
function isOverlay(t: WorkspaceYaml): boolean {
  return composeBase(t) !== undefined;
}

/** Private templates can never reach the CP marketplace — the CLI is their only installer. */
function isPrivate(t: WorkspaceYaml): boolean {
  return t.meta.isPublic === false;
}

function displayName(slug: string, all: Map<string, WorkspaceYaml>): string {
  return all.get(slug)?.meta.name ?? slug;
}

/**
 * Transitive closure of every template a selection drags in, excluding the
 * selection itself. Walks BOTH `compose` and `require` edges, because the apply
 * resolver installs the whole graph — e.g. `blockchain-ecosystem` composes onto
 * `ecosystem`, which in turn requires `foundation`.
 */
function resolveExtras(
  selected: string[],
  all: Map<string, WorkspaceYaml>
): string[] {
  const seen = new Set<string>();
  const walk = (slug: string) => {
    for (const dep of all.get(slug)?.dependencies ?? []) {
      if (seen.has(dep.slug)) continue;
      seen.add(dep.slug);
      walk(dep.slug);
    }
  };
  for (const s of selected) walk(s);
  for (const s of selected) seen.delete(s);
  return [...seen];
}

/** What picking this template actually does, in the user's words. */
function consequence(slug: string, all: Map<string, WorkspaceYaml>): string {
  const t = all.get(slug);
  if (!t) return "";
  const parts: string[] = [];
  const base = composeBase(t);
  if (base) parts.push(`layers onto ${displayName(base, all)}`);
  const extras = resolveExtras([slug], all).filter((s) => s !== base);
  if (extras.length > 0)
    parts.push(`also sets up: ${extras.map((s) => displayName(s, all)).join(", ")}`);
  return parts.join(" · ");
}

/** Terse "what you get" line, derived from the template itself. */
function contents(t: WorkspaceYaml): string {
  const p = t.profiles?.length ?? 0;
  const v = t.views?.length ?? 0;
  return `${p} profile${p === 1 ? "" : "s"} · ${v} view${v === 1 ? "" : "s"}`;
}

function clip(s: string, n: number): string {
  return s.length <= n ? s : s.slice(0, n - 1).trimEnd() + "…";
}

/**
 * Suggest domains from a free-text company description. Matches the user's words
 * against each template's own `tags` — no hardcoded keyword catalog, so new
 * templates become suggestable the moment they declare tags.
 */
function inferDomains(description: string, all: Map<string, WorkspaceYaml>): string[] {
  const text = description.toLowerCase();
  const matched: string[] = [];
  for (const [slug, t] of all) {
    const tags = (t.meta.tags ?? []).filter((k) => k.length >= 3);
    const hit = tags.some((k) =>
      new RegExp(`\\b${k.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`).test(text)
    );
    if (hit) matched.push(slug);
  }
  // Always land on something sensible rather than an empty picker.
  return matched.length > 0 ? matched : ["project-management"];
}

// ── `synap launch --list` — what CAN be launched, without committing ─────────

export function launchList(opts: { json?: boolean }): void {
  const all = catalog();
  const templates = [...all.values()];

  if (opts.json) {
    console.log(
      JSON.stringify(
        templates.map((t) => ({
          slug: t.meta.slug,
          name: t.meta.name,
          description: t.meta.description,
          tags: t.meta.tags ?? [],
          isPublic: t.meta.isPublic !== false,
          kind: isOverlay(t) ? "overlay" : "workspace",
          profiles: t.profiles?.length ?? 0,
          views: t.views?.length ?? 0,
          dependencies: t.dependencies ?? [],
        })),
        null,
        2
      )
    );
    return;
  }

  const render = (t: WorkspaceYaml) => {
    const tags = [
      isPrivate(t) ? chalk.yellow("CLI-only") : null,
    ].filter(Boolean);
    console.log(
      "    " +
        chalk.cyan(t.meta.slug.padEnd(22)) +
        chalk.bold(t.meta.name) +
        (tags.length ? "  " + tags.join(" ") : "")
    );
    console.log("    " + " ".repeat(22) + chalk.dim(clip(t.meta.description, 68)));
    const why = consequence(t.meta.slug, all);
    console.log(
      "    " +
        " ".repeat(22) +
        chalk.dim(contents(t)) +
        (why ? chalk.dim(" · " + why) : "")
    );
    log.blank();
  };

  const workspaces = templates.filter((t) => !isOverlay(t));
  const overlays = templates.filter((t) => isOverlay(t));

  log.heading("  Domain workspaces — each creates its own workspace");
  log.blank();
  workspaces.forEach(render);

  if (overlays.length > 0) {
    log.heading("  Overlays — layer onto an existing workspace (no new workspace)");
    log.blank();
    overlays.forEach(render);
  }

  log.dim(`${templates.length} templates bundled with this CLI.`);
  log.dim(
    chalk.yellow("CLI-only") + " templates are private — they never appear in the marketplace."
  );
  log.dim("Run 'synap launch' to set one up · 'synap orient' to see what you already have.");
}

// ── `synap launch` — the guided flow ─────────────────────────────────────────

export async function launch(opts: {
  podUrl?: string;
  apiKey?: string;
  json?: boolean;
  list?: boolean;
}): Promise<void> {
  // Discovery is local — never touch a pod to answer "what can I launch?".
  if (opts.list) {
    launchList(opts);
    return;
  }

  if (!opts.json) banner();

  const all = catalog();

  let cfg;
  try {
    cfg = await resolveHubConfig(opts);
  } catch (e) {
    renderHubError(e);
    process.exit(1);
  }

  // ── 1. Project name ─────────────────────────────────────────────────────
  const { projectName } = await prompts({
    type: "text",
    name: "projectName",
    message: "What's your company or project called?",
  });
  if (!projectName) {
    log.warn("Cancelled.");
    return;
  }

  // ── 1b. Attach to an existing project, or create a new one? ──────────────
  let existingProjects: Array<{ id: string; name: string }> = [];
  try {
    const res = (await hubGet("/projects", {}, cfg)) as unknown;
    const list = unwrapList<Record<string, unknown>>(res, ["projects"]);
    existingProjects = list
      .filter((p) => p.id)
      .map((p) => ({ id: String(p.id), name: String(p.name ?? p.id) }));
  } catch {
    // Non-fatal: if we can't list, fall back to create-new only.
  }

  const NEW_PROJECT = "__new__";
  let attachProjectId: string | undefined;
  if (existingProjects.length > 0) {
    const { choice } = await prompts({
      type: "select",
      name: "choice",
      message: "Attach to an existing project, or create a new one?",
      choices: [
        ...existingProjects.map((p) => ({
          title: `${p.name} ${chalk.dim(p.id.slice(0, 8))}`,
          value: p.id,
        })),
        { title: chalk.cyan("＋ Create a new project"), value: NEW_PROJECT },
      ],
    });
    if (!choice) {
      log.warn("Cancelled.");
      return;
    }
    if (choice !== NEW_PROJECT) {
      attachProjectId = choice as string;
      const chosen = existingProjects.find((p) => p.id === attachProjectId);
      log.blank();
      log.info(`Attaching new workspaces to ${chalk.bold(chosen?.name ?? attachProjectId)}.`);
      log.dim(
        `Tip: review what's already there first — 'synap digest --project ${attachProjectId.slice(0, 8)}'`
      );
    }
  }

  // ── 2. Describe → infer domains ─────────────────────────────────────────
  const { description } = await prompts({
    type: "text",
    name: "description",
    message: "Describe what you do (one sentence):",
  });
  const suggested = inferDomains(description ?? "", all);

  log.blank();
  log.info(
    `Based on that, I suggest: ${chalk.cyan(
      suggested.map((s) => displayName(s, all)).join(", ")
    )}`
  );

  // ── 3. Pick the domain set — the picker says what each one GIVES you ─────
  // `prompts` only renders `description` for the FOCUSED choice — so what you
  // get, and what it drags in, goes in the always-visible title. The prose sits
  // in the description where it costs nothing to skip.
  const choice = (t: WorkspaceYaml) => {
    const why = consequence(t.meta.slug, all);
    return {
      title:
        `${t.meta.name}${isPrivate(t) ? chalk.yellow(" (CLI-only)") : ""}` +
        chalk.dim(` — ${contents(t)}`) +
        (why ? chalk.dim(` · ${why}`) : ""),
      description: clip(t.meta.description, 72),
      value: t.meta.slug,
      selected: suggested.includes(t.meta.slug),
    };
  };
  const templates = [...all.values()];
  const { domains } = await prompts({
    type: "multiselect",
    name: "domains",
    message: "Which workspaces do you want? (space to toggle, enter to confirm)",
    choices: [
      ...templates.filter((t) => !isOverlay(t)).map(choice),
      ...templates.filter((t) => isOverlay(t)).map(choice),
    ],
    hint: "- Space to select. Return to submit",
  });

  if (!domains || (domains as string[]).length === 0) {
    log.warn("No workspaces selected. Cancelled.");
    return;
  }

  const selected = domains as string[];

  // ── 3b. DISCLOSE the whole plan before the user commits ──────────────────
  // Picking "Grants" silently provisions Operations AND Foundation — the user
  // must see that BEFORE confirming, not discover it afterwards.
  const extras = resolveExtras(selected, all);
  log.blank();
  log.heading("  This will set up:");
  log.blank();
  for (const slug of selected) {
    const t = all.get(slug);
    if (!t) continue;
    const why = consequence(slug, all);
    console.log(
      "    " +
        chalk.bold(t.meta.name.padEnd(22)) +
        chalk.dim(isOverlay(t) ? "overlay" : "new workspace")
    );
    if (why) console.log("    " + " ".repeat(22) + chalk.dim(why));
  }
  if (extras.length > 0) {
    log.blank();
    log.info(
      `Dependencies provisioned automatically: ${chalk.cyan(
        extras.map((s) => displayName(s, all)).join(", ")
      )}`
    );
  }
  log.blank();
  log.dim("Installs are governed — some may need your approval before they go live.");
  log.blank();

  const { proceed } = await prompts({
    type: "confirm",
    name: "proceed",
    message: "Proceed?",
    initial: true,
  });
  if (!proceed) {
    log.warn("Cancelled.");
    return;
  }

  // ── 4. Resolve the project — attach to the chosen one, or create new ─────
  let projectId: string;
  if (attachProjectId) {
    projectId = attachProjectId;
  } else {
    const spinner = ora("Creating project…").start();
    try {
      const project = (await hubPost(
        "/projects",
        { name: projectName, description: description || undefined, status: "active" },
        cfg
      )) as { id?: string; status?: string; proposalId?: string };
      // Governance may return a proposal instead of creating directly.
      if (!project.id) {
        spinner.stop();
        const pid = project.proposalId;
        log.warn("Project not created yet — it needs your approval first.");
        if (pid) log.hint(`Proposal ${pid.slice(0, 8)} — approve it, then re-run 'synap launch'.`);
        log.hint("Review it with: synap proposals list");
        return;
      }
      projectId = project.id;
      spinner.succeed(`Project created: ${chalk.bold(projectName)}`);
    } catch (e) {
      spinner.stop();
      renderHubError(e);
      return;
    }
  }

  // ── 5. Provision each selected template + link to the project ────────────
  type Outcome = "created" | "composed" | "proposed" | "failed";
  const results: Array<{
    slug: string;
    name: string;
    outcome: Outcome;
    workspaceId?: string;
    onto?: string;
    proposalId?: string;
    error?: string;
  }> = [];

  for (const slug of selected) {
    const t = all.get(slug);
    const name = t?.meta.name ?? slug;
    const s = ora(`Provisioning ${name}…`).start();

    let pkg: Record<string, unknown>;
    try {
      pkg = toPackageDefinition(slug) as unknown as Record<string, unknown>;
    } catch {
      s.fail(`${name} — template not found`);
      results.push({ slug, name, outcome: "failed", error: "template not found" });
      continue;
    }

    try {
      // projectId links the workspace's seed entities to the project
      // (belongs_to_project) — this is what unifies the OS. The body carries the
      // template's `dependencies`; the endpoint resolves them.
      const res = (await hubPost(
        "/packages/apply",
        { ...pkg, projectId },
        cfg,
        APPLY_TIMEOUT_MS
      )) as Record<string, unknown>;

      // `writeGovernance` is the one door for "did this apply, or was it queued?"
      if (writeGovernance(res) === "proposed") {
        const proposalId = res.proposalId ? String(res.proposalId) : undefined;
        s.stop();
        log.info(`${name} — proposed (under review)`);
        results.push({ slug, name, outcome: "proposed", proposalId });
        continue;
      }

      const ws = res.workspace as
        | { status?: string; workspaceId?: string; onto?: string }
        | undefined;
      if (ws?.status === "composed") {
        const onto = ws.onto ? String(ws.onto) : undefined;
        s.succeed(`${name} — layered onto its base workspace`);
        results.push({ slug, name, outcome: "composed", workspaceId: ws.workspaceId, onto });
      } else if (ws?.status === "created") {
        s.succeed(`${name} ready`);
        results.push({ slug, name, outcome: "created", workspaceId: ws.workspaceId });
      } else {
        // No workspace in the response and not proposed — report it, don't
        // silently count it as a success.
        s.fail(`${name} — pod returned no workspace`);
        results.push({ slug, name, outcome: "failed", error: "no workspace in response" });
      }
    } catch (e) {
      s.stop();
      log.error(`${name} failed`);
      renderHubError(e);
      results.push({ slug, name, outcome: "failed", error: (e as Error).message });
    }
  }

  // ── 6. Honest summary ───────────────────────────────────────────────────
  const projectLabel = attachProjectId
    ? existingProjects.find((p) => p.id === attachProjectId)?.name ?? projectName
    : projectName;

  if (opts.json) {
    console.log(
      JSON.stringify(
        {
          projectId,
          projectName: projectLabel,
          attached: Boolean(attachProjectId),
          dependencies: extras,
          results,
        },
        null,
        2
      )
    );
    return;
  }

  const live = results.filter((r) => r.outcome === "created" || r.outcome === "composed");
  const proposed = results.filter((r) => r.outcome === "proposed");
  const failed = results.filter((r) => r.outcome === "failed");

  log.blank();
  if (live.length > 0) {
    log.success(
      `${live.length}/${results.length} live under project ${chalk.bold(projectLabel)}.`
    );
  }

  if (proposed.length > 0) {
    // A proposal is a PR under review, not a failure — but it is NOT live, and
    // saying "ready" here is the lie this command used to tell.
    log.blank();
    log.warn(
      `${proposed.length} ${proposed.length === 1 ? "workspace is" : "workspaces are"} NOT live yet — governance queued ${proposed.length === 1 ? "it" : "them"} for your approval:`
    );
    for (const r of proposed) {
      log.hint(`${r.name}${r.proposalId ? ` — proposal ${r.proposalId.slice(0, 8)}` : ""}`);
    }
    log.hint("Approve with: synap proposals list  →  synap proposals approve <id>");
    log.hint("(or review them in the browser under Proposals)");
  }

  if (failed.length > 0) {
    log.blank();
    log.warn(`${failed.length} failed: ${failed.map((r) => r.name).join(", ")}`);
  }

  if (live.length > 0 && proposed.length === 0 && failed.length === 0) {
    log.blank();
    log.dim("Run 'synap orient' to see your new workspaces and project.");
    log.dim(`Scope your AI to this project: 'synap project use ${projectId.slice(0, 8)}'`);
  }
}
