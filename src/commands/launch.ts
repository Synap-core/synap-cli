/**
 * `synap launch agent-os` — orchestrate a complete Company OS.
 *
 * Interactive flow:
 *   1. Ask the company/project name → create a PROJECT (cross-cutting lens)
 *   2. Pick domains (workspaces) → confirm the set
 *   3. For each domain → POST /packages/apply with that template
 *   4. Link each workspace to the project
 *
 * Templates come from the canonical @synap-core/workspace-templates package
 * (single source of truth, via toPackageDefinition) and are applied via
 * POST /api/hub/packages/apply (the unified provisioning endpoint).
 */

import prompts from "prompts";
import ora from "ora";
import chalk from "chalk";
import {
  listWorkspaceTemplates,
  toPackageDefinition,
} from "@synap-core/workspace-templates";
import { log, banner } from "../utils/logger.js";
import { resolveHubConfig, hubGet, hubPost } from "../lib/hub-client.js";

/** Domain catalog — what each template provides, for the picker + AI inference. */
const DOMAIN_CATALOG: Array<{
  slug: string;
  title: string;
  description: string;
  keywords: string[];
}> = [
  {
    slug: "crm",
    title: "CRM",
    description: "Contacts, companies, deals, pipeline",
    keywords: ["sales", "client", "customer", "deal", "lead", "agency"],
  },
  {
    slug: "content-os",
    title: "Content OS",
    description: "Posts, campaigns, content calendar, brand",
    keywords: ["content", "marketing", "social", "creator", "brand", "post"],
  },
  {
    slug: "project-management",
    title: "Project Management",
    description: "OKRs, projects, sprints, tasks",
    keywords: ["project", "sprint", "okr", "task", "team", "agile"],
  },
  {
    slug: "agent-fleet",
    title: "Agent Fleet",
    description: "AI agents, skills, providers — the agent fleet",
    keywords: ["agent", "ai", "automation", "bot", "fleet"],
  },
  {
    slug: "dev-dashboard",
    title: "Dev Dashboard",
    description: "Services, repos, environments, infrastructure",
    keywords: ["dev", "code", "deploy", "infra", "engineering", "build", "repo"],
  },
  {
    slug: "life-os",
    title: "Life OS",
    description: "Notes, books, goals, knowledge management",
    keywords: ["personal", "knowledge", "notes", "pkm", "life", "second brain"],
  },
  {
    slug: "foundation",
    title: "Foundation",
    description: "Strategic DNA — mission, audience, positioning, principles",
    keywords: ["strategy", "mission", "vision", "positioning", "brand strategy", "foundation"],
  },
  {
    slug: "radar",
    title: "Radar",
    description: "Competitors, market segments, trends, inspirations",
    keywords: ["market", "competitor", "research", "trend", "landscape", "radar"],
  },
  {
    slug: "brand-library",
    title: "Brand Library",
    description: "Brand voice, assets, tokens, components, rules",
    keywords: ["brand", "voice", "assets", "design", "identity", "tokens"],
  },
  {
    slug: "marketing-campaign",
    title: "Marketing Campaigns",
    description: "Campaigns, leads, channels",
    keywords: ["marketing", "campaign", "lead", "growth", "ads"],
  },
];

/** Load a template as a PackageDefinition from the canonical package. */
function loadTemplate(slug: string): Record<string, unknown> | null {
  try {
    return toPackageDefinition(slug) as unknown as Record<string, unknown>;
  } catch {
    return null;
  }
}

/** Suggest domains from a free-text company description (keyword overlap). */
function inferDomains(description: string): string[] {
  const text = description.toLowerCase();
  const matched = DOMAIN_CATALOG.filter((d) =>
    d.keywords.some((k) => text.includes(k))
  ).map((d) => d.slug);
  // Always suggest at least project-management as a sensible default.
  return matched.length > 0 ? matched : ["project-management"];
}

export async function launchAgentOs(opts: {
  podUrl?: string;
  apiKey?: string;
  json?: boolean;
}): Promise<void> {
  if (!opts.json) banner();

  const cfg = await resolveHubConfig(opts);

  // Templates come from the canonical @synap-core/workspace-templates package.
  const available = listWorkspaceTemplates().map((t) => t.meta.slug);

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
  // GET /projects returns a raw array of project rows (no envelope).
  let existingProjects: Array<{ id: string; name: string }> = [];
  try {
    const res = (await hubGet("/projects", {}, cfg)) as unknown;
    const list = (Array.isArray(res)
      ? res
      : ((res as Record<string, unknown>)?.projects as unknown[]) ?? []) as Record<string, unknown>[];
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
  const suggested = inferDomains(description ?? "").filter((s) =>
    available.includes(s)
  );

  log.blank();
  log.info(
    `Based on that, I suggest: ${chalk.cyan(
      suggested.map((s) => DOMAIN_CATALOG.find((d) => d.slug === s)?.title ?? s).join(", ")
    )}`
  );

  // ── 3. Confirm/adjust the domain set ────────────────────────────────────
  const { domains } = await prompts({
    type: "multiselect",
    name: "domains",
    message: "Which workspaces do you want? (space to toggle, enter to confirm)",
    choices: DOMAIN_CATALOG.filter((d) => available.includes(d.slug)).map((d) => ({
      title: `${d.title} — ${chalk.dim(d.description)}`,
      value: d.slug,
      selected: suggested.includes(d.slug),
    })),
    hint: "- Space to select. Return to submit",
  });

  if (!domains || domains.length === 0) {
    log.warn("No workspaces selected. Cancelled.");
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
      {
        name: projectName,
        description: description || undefined,
        status: "active",
      },
      cfg
    )) as { id?: string; status?: string; proposalId?: string };
    // Governance may return a proposal (HTTP 202) instead of creating directly.
    if (!project.id) {
      spinner.warn(
        project.proposalId
          ? `Project needs approval (proposal ${project.proposalId.slice(0, 8)}…). Approve it in Synap, then re-run.`
          : "Project was not created (governance proposal). Approve it in Synap, then re-run."
      );
      return;
    }
    projectId = project.id;
    spinner.succeed(`Project created: ${chalk.bold(projectName)}`);
  } catch (e) {
    spinner.fail(`Project creation failed: ${(e as Error).message}`);
    return;
  }
  }

  // ── 5. Provision each workspace + link to project ───────────────────────
  const results: Array<{ slug: string; workspaceId?: string; error?: string }> = [];
  for (const slug of domains as string[]) {
    const tmplName = DOMAIN_CATALOG.find((d) => d.slug === slug)?.title ?? slug;
    const s = ora(`Provisioning ${tmplName}…`).start();
    const template = loadTemplate(slug);
    if (!template) {
      s.fail(`Template ${slug} not found`);
      results.push({ slug, error: "template not found" });
      continue;
    }
    try {
      // Pass projectId so the endpoint links the workspace's seed entities to
      // the project (belongs_to_project) — this is what unifies the OS.
      const r = (await hubPost(
        "/packages/apply",
        { ...template, projectId },
        cfg
      )) as {
        workspace?: { workspaceId?: string };
      };
      const workspaceId = r.workspace?.workspaceId;
      s.succeed(`${tmplName} ready`);
      results.push({ slug, workspaceId });
    } catch (e) {
      s.fail(`${tmplName} failed: ${(e as Error).message}`);
      results.push({ slug, error: (e as Error).message });
    }
  }

  // ── 6. Summary ──────────────────────────────────────────────────────────
  log.blank();
  const ok = results.filter((r) => r.workspaceId);
  const projectLabel = attachProjectId
    ? existingProjects.find((p) => p.id === attachProjectId)?.name ?? projectName
    : projectName;
  log.success(
    `Company OS ready — ${ok.length}/${results.length} workspaces under project ${chalk.bold(
      projectLabel
    )}.`
  );

  if (opts.json) {
    console.log(
      JSON.stringify(
        { projectId, projectName: projectLabel, attached: Boolean(attachProjectId), results },
        null,
        2
      )
    );
  } else {
    log.dim("Run 'synap orient' to see your new workspaces and project.");
    log.dim(
      `Scope your AI to this project: 'synap project use ${projectId.slice(0, 8)}…'`
    );
  }
}
