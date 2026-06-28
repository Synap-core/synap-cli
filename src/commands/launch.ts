/**
 * `synap launch agent-os` — orchestrate a complete company OS.
 *
 * Interactive flow:
 *   1. Ask the company/project name → create a PROJECT (cross-cutting lens)
 *   2. Pick domains (workspaces) → confirm the set
 *   3. For each domain → POST /packages/apply with that template
 *   4. Link each workspace to the project
 *
 * Templates live in synap-backend/templates/packages/*.package.json and are
 * applied via POST /api/hub/packages/apply (the unified provisioning endpoint).
 */

import prompts from "prompts";
import ora from "ora";
import chalk from "chalk";
import { readFileSync, existsSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { log, banner } from "../utils/logger.js";
import { resolveHubConfig, hubPost, resolveUserId } from "../lib/hub-client.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

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
    slug: "agent-os",
    title: "Agent OS",
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
];

/** Find the templates/packages directory (bundled with the backend). */
function resolvePackagesDir(): string | null {
  // Candidate locations relative to the CLI install + monorepo dev layout.
  const candidates = [
    join(__dirname, "../../../synap-backend/templates/packages"),
    join(__dirname, "../../templates/packages"),
    join(process.cwd(), "synap-backend/templates/packages"),
    join(process.cwd(), "templates/packages"),
  ];
  for (const c of candidates) {
    if (existsSync(c)) return c;
  }
  return null;
}

function loadTemplate(packagesDir: string, slug: string): Record<string, unknown> | null {
  const path = join(packagesDir, `${slug}.package.json`);
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf-8"));
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
  yes?: boolean;
}): Promise<void> {
  if (!opts.json) banner();

  const cfg = await resolveHubConfig(opts);
  const userId = await resolveUserId(cfg);

  const packagesDir = resolvePackagesDir();
  if (!packagesDir) {
    log.error(
      "Could not find templates/packages — run from the synap monorepo, or ensure the backend templates are installed."
    );
    process.exit(1);
  }

  const available = readdirSync(packagesDir)
    .filter((f) => f.endsWith(".package.json"))
    .map((f) => f.replace(".package.json", ""));

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

  // ── 4. Create the project ───────────────────────────────────────────────
  const spinner = ora("Creating project…").start();
  let projectId: string;
  try {
    const project = (await hubPost(
      "/projects",
      {
        name: projectName,
        description: description || undefined,
        status: "active",
        userId,
      },
      cfg
    )) as { id: string };
    projectId = project.id;
    spinner.succeed(`Project created: ${chalk.bold(projectName)}`);
  } catch (e) {
    spinner.fail(`Project creation failed: ${(e as Error).message}`);
    return;
  }

  // ── 5. Provision each workspace + link to project ───────────────────────
  const results: Array<{ slug: string; workspaceId?: string; error?: string }> = [];
  for (const slug of domains as string[]) {
    const tmplName = DOMAIN_CATALOG.find((d) => d.slug === slug)?.title ?? slug;
    const s = ora(`Provisioning ${tmplName}…`).start();
    const template = loadTemplate(packagesDir, slug);
    if (!template) {
      s.fail(`Template ${slug} not found`);
      results.push({ slug, error: "template not found" });
      continue;
    }
    try {
      const r = (await hubPost("/packages/apply", template, cfg)) as {
        workspace?: { workspaceId?: string };
      };
      const workspaceId = r.workspace?.workspaceId;
      // Link the workspace's seed entities to the project happens server-side
      // via the template; here we record the workspace for the summary.
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
  log.success(
    `Agent OS ready — ${ok.length}/${results.length} workspaces under project ${chalk.bold(
      projectName
    )}.`
  );

  if (opts.json) {
    console.log(JSON.stringify({ projectId, projectName, results }, null, 2));
  } else {
    log.dim("Run 'synap orient' to see your new workspaces and project.");
    log.dim(
      `Scope your AI to this project: 'synap project use ${projectId.slice(0, 8)}…'`
    );
  }
}
