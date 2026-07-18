/**
 * `synap market` — discover + install ANY package type.
 * =====================================================
 *
 * `synap launch` is workspace-first: it turns an empty pod into a company from
 * BUNDLED workspace templates (offline). `market` is the superset browser — it
 * reaches EVERY package type the control-plane registry carries
 * (capability / skill / workflow / view / cell / workspace), public or private,
 * over the shared catalog door (`assembleCatalog` + the CP `/api/packages`
 * transport). Suites (`enterprise-os`, `the-arch`) headline via the `suite` tag,
 * not a hardcoded slug.
 *
 *   synap market [--search q] [--type t] [--list] [--json]   — browse
 *   synap market install <slug>                              — install
 *
 * INSTALL SCOPE: the pod's one install door (`/packages/apply`) provisions a
 * WORKSPACE from a package definition — it is workspace-centric. So `market
 * install` fully installs WORKSPACE-type packages (same door `launch` uses) and,
 * for the operational types (capability/skill/…), routes the user to the surface
 * that installs them (the browser marketplace, or `synap cap add` for a
 * capability already in the pod catalog) rather than silently doing nothing. A
 * generic CLI→pod install for standalone non-workspace packages is not wired yet.
 */

import prompts from "prompts";
import ora from "ora";
import chalk from "chalk";
import {
  assembleCatalog,
  listPublicTemplates,
  listWorkspaceTemplates,
  toPackageDefinition,
  type CatalogEntry,
} from "@synap-core/workspace-templates";
import { log, banner } from "../utils/logger.js";
import { resolveHubConfig, hubPost, renderHubError, type HubConfig } from "../lib/hub-client.js";
import { fetchProjects, createProject, type ProjectRef } from "../lib/project.js";
import { getActiveProjectId } from "../lib/pod.js";
import { resolveActiveLens } from "../lib/session-lens.js";
import { writeGovernance } from "../lib/capture-lane.js";
import { renderNextSteps, FLOW } from "../lib/next-steps.js";
import { getStoredToken, isTokenLocallyExpired } from "../lib/auth.js";
import {
  fetchPublicBrowseRows,
  fetchMyRows,
  fetchAvailableSlugs,
  fetchPackageDefinition,
  type PackageFilters,
  type CpBrowseRow,
  type CpMineRow,
  type TierInfo,
} from "../lib/cp-packages.js";
import { fetchInstalledSlugs } from "../lib/installed.js";
import { isSuite } from "../lib/suite.js";
import { bundledTemplatesVersion } from "../lib/bundle-version.js";

// Same longer budget launch uses — an apply writes profiles/views/entities.
const APPLY_TIMEOUT_MS = 120_000;

interface MarketCatalog {
  entries: CatalogEntry[];
  tierBySlug: Map<string, TierInfo>;
  lockedSlugs: Set<string>;
  installed: Set<string>;
  /** Bundled slugs (public + private) — the offline-installable workspace set. */
  bundledSlugs: Set<string>;
  loggedIn: boolean;
  reachedCp: boolean;
}

/**
 * Assemble the market catalog: bundled workspace templates ∪ public CP browse
 * (all types) ∪ the caller's own packages (when logged in), through the shared
 * `assembleCatalog` door. Unlike `launch`, PUBLIC CP rows are fetched even when
 * logged out — the bundle only carries workspaces, so all-types discovery needs
 * the CP browse route (which needs no auth).
 */
async function buildMarketCatalog(filters?: PackageFilters): Promise<MarketCatalog> {
  const creds = getStoredToken();
  const loggedIn = !!creds && !isTokenLocallyExpired(creds);

  let reachedCp = true;
  const [publicRows, mineRows, availableSlugs, installed] = await Promise.all([
    fetchPublicBrowseRows(filters).catch(() => {
      reachedCp = false;
      return [] as CpBrowseRow[];
    }),
    loggedIn && creds
      ? fetchMyRows(creds.token, filters).catch(() => [] as CpMineRow[])
      : Promise.resolve([] as CpMineRow[]),
    loggedIn && creds
      ? fetchAvailableSlugs(creds.token, filters).catch(() => null)
      : Promise.resolve(null),
    fetchInstalledSlugs(),
  ]);

  const merged = assembleCatalog({
    bundled: listPublicTemplates(),
    remoteRows: [...publicRows, ...mineRows],
    bundleVersion: bundledTemplatesVersion(),
    remoteStatus: reachedCp ? "ok" : "unreachable",
  });

  const tierBySlug = new Map<string, TierInfo>();
  const lockedSlugs = new Set<string>();
  for (const r of publicRows) {
    if (r.requiredTier != null || r.pricingModel != null) {
      tierBySlug.set(r.slug, {
        requiredTier: r.requiredTier ?? null,
        pricingModel: r.pricingModel ?? null,
      });
    }
    if (availableSlugs && r.requiredTier && !availableSlugs.has(r.slug)) {
      lockedSlugs.add(r.slug);
    }
  }

  const bundledSlugs = new Set(listWorkspaceTemplates().map((t) => t.meta.slug));

  return {
    entries: merged.entries,
    tierBySlug,
    lockedSlugs,
    installed,
    bundledSlugs,
    loggedIn,
    reachedCp,
  };
}

/** The package type of an entry — bundled templates are always `workspace`. */
function typeOf(entry: CatalogEntry): string {
  return entry.category ?? "workspace";
}

/**
 * Client-side filter. The CP browse route filters REMOTE rows server-side, but
 * `assembleCatalog` always adds the BUNDLED (all-`workspace`) templates — so a
 * `--type capability` would otherwise leak bundled workspaces. Applied to the
 * merged list so both sources obey the same filter.
 */
function matchesFilters(entry: CatalogEntry, filters?: PackageFilters): boolean {
  if (!filters) return true;
  if (filters.category && typeOf(entry) !== filters.category) return false;
  if (filters.search) {
    const q = filters.search.toLowerCase();
    const hay = `${entry.slug} ${entry.name} ${entry.description ?? ""}`.toLowerCase();
    if (!hay.includes(q)) return false;
  }
  return true;
}

/** Status badges — suite (tag) / private / installed / tier / locked. */
function badges(entry: CatalogEntry, cat: MarketCatalog): string[] {
  const out: string[] = [];
  if (isSuite(entry)) out.push(chalk.magenta("suite"));
  if (entry.isPrivate) out.push(chalk.yellow("private"));
  if (cat.installed.has(entry.slug)) out.push(chalk.green("installed"));
  const tier = cat.tierBySlug.get(entry.slug);
  if (tier?.requiredTier) out.push(chalk.cyan(tier.requiredTier));
  else if (tier?.pricingModel && tier.pricingModel !== "free")
    out.push(chalk.cyan(tier.pricingModel));
  if (cat.lockedSlugs.has(entry.slug)) out.push(chalk.red("locked"));
  return out;
}

function clip(s: string, n: number): string {
  return s.length <= n ? s : s.slice(0, n - 1).trimEnd() + "…";
}

// ── `synap market` / `synap market --list` — discovery ───────────────────────

export async function market(opts: {
  list?: boolean;
  json?: boolean;
  search?: string;
  type?: string;
}): Promise<void> {
  const filters: PackageFilters | undefined =
    opts.search || opts.type ? { search: opts.search, category: opts.type } : undefined;
  const cat = await buildMarketCatalog(filters);
  const entries = cat.entries.filter((e) => matchesFilters(e, filters));

  if (opts.json) {
    console.log(
      JSON.stringify(
        {
          entries: entries.map((e) => {
            const tier = cat.tierBySlug.get(e.slug);
            return {
              slug: e.slug,
              name: e.name,
              description: e.description,
              type: typeOf(e),
              tags: e.tags,
              suite: isSuite(e),
              isPrivate: e.isPrivate,
              installed: cat.installed.has(e.slug),
              requiredTier: tier?.requiredTier ?? null,
              pricingModel: tier?.pricingModel ?? null,
              locked: cat.lockedSlugs.has(e.slug),
              source: e.source,
            };
          }),
          loggedIn: cat.loggedIn,
          reachedCp: cat.reachedCp,
          nextSteps: FLOW.afterMarketList(),
        },
        null,
        2
      )
    );
    return;
  }

  // If a project is pinned, say where an install would land. Best-effort: a
  // logged-out / unconfigured pod just skips it — never fatal to browsing.
  const pinned = activeProjectId();
  if (pinned) {
    let label = pinned.slice(0, 8);
    try {
      const cfg = await resolveHubConfig({});
      const match = (await fetchProjects(cfg)).find((p) => p.id === pinned);
      if (match) label = match.name;
    } catch {
      /* offline / no pod — show the id fragment */
    }
    log.dim(`Adding to: ${label}`);
    log.blank();
  }

  if (entries.length === 0) {
    log.warn("No packages match.");
    if (!cat.reachedCp)
      log.dim("Couldn't reach the control plane — only bundled workspaces are shown.");
    log.dim("Try 'synap market' with no filter, or 'synap login' to see your private packages.");
    return;
  }

  // Suites headline; then group by type.
  const suites = entries.filter((e) => isSuite(e));
  const rest = entries.filter((e) => !isSuite(e));

  const render = (entry: CatalogEntry) => {
    const b = badges(entry, cat);
    console.log(
      "    " +
        chalk.cyan(entry.slug.padEnd(24)) +
        chalk.bold(entry.name) +
        (b.length ? "  " + b.join(" ") : "")
    );
    if (entry.description)
      console.log("    " + " ".repeat(24) + chalk.dim(clip(entry.description, 66)));
    log.blank();
  };

  if (suites.length > 0) {
    log.heading("  Suites — a whole operating core in one install");
    log.blank();
    suites.forEach(render);
  }

  // Group the rest by type, in a stable order.
  const order = ["workspace", "capability", "skill", "workflow", "view", "cell"];
  const byType = new Map<string, CatalogEntry[]>();
  for (const e of rest) {
    const t = typeOf(e);
    (byType.get(t) ?? byType.set(t, []).get(t)!).push(e);
  }
  const types = [...byType.keys()].sort(
    (a, b) => (order.indexOf(a) + 1 || 99) - (order.indexOf(b) + 1 || 99)
  );
  for (const t of types) {
    log.heading(`  ${t.charAt(0).toUpperCase() + t.slice(1)}`);
    log.blank();
    byType.get(t)!.forEach(render);
  }

  log.dim(`${entries.length} package${entries.length === 1 ? "" : "s"} available.`);
  if (!cat.loggedIn) log.dim("Log in to see your private packages: synap login");
  renderNextSteps(FLOW.afterMarketList());
}

// ── Target project resolution (the spine `market install` links installs to) ─

/** The durable/session active project — the same door hub-client threads. */
function activeProjectId(): string | undefined {
  return resolveActiveLens()?.projectId || getActiveProjectId();
}

/**
 * What project an install lands under. AI-first: with `--project` or an active
 * project, ZERO prompts; the interactive picker appears ONLY when neither is set
 * AND stdin is a TTY (and not `--json`). Non-interactive with nothing resolved =
 * pod-wide, said out loud so a script never silently mis-scopes.
 */
type TargetProject =
  | { kind: "project"; projectId: string; name: string; created?: boolean }
  | { kind: "pod-wide" }
  | { kind: "proposed"; proposalId?: string; name: string }
  | { kind: "unknown"; id: string }
  | { kind: "cancelled" };

async function resolveTargetProject(
  cfg: HubConfig,
  opts: { explicitId?: string; json?: boolean }
): Promise<TargetProject> {
  const interactive = !opts.json && Boolean(process.stdin.isTTY);

  // 1. Explicit --project wins — but must exist, or we refuse clearly.
  if (opts.explicitId) {
    const projects = await fetchProjects(cfg);
    const match = projects.find((p) => p.id === opts.explicitId);
    return match
      ? { kind: "project", projectId: match.id, name: match.name }
      : { kind: "unknown", id: opts.explicitId };
  }

  // 2. Active project (durable `synap project use`, or this session's lens).
  const active = activeProjectId();
  if (active) {
    const projects = await fetchProjects(cfg);
    const name = projects.find((p) => p.id === active)?.name ?? active;
    return { kind: "project", projectId: active, name };
  }

  // 3. Interactive: pick an existing project, create one, or go pod-wide.
  if (interactive) {
    const projects = await fetchProjects(cfg);
    const NEW = "__new__";
    const NONE = "__none__";
    const { choice } = await prompts({
      type: "select",
      name: "choice",
      message: "Add to which project?",
      choices: [
        ...projects.map((p: ProjectRef) => ({
          title: `${p.name} ${chalk.dim(p.id.slice(0, 8))}`,
          value: p.id,
        })),
        { title: chalk.cyan("＋ Create a new project"), value: NEW },
        { title: chalk.dim("None (pod-wide)"), value: NONE },
      ],
    });
    if (choice === undefined) return { kind: "cancelled" };
    if (choice === NONE) return { kind: "pod-wide" };
    if (choice !== NEW) {
      const chosen = projects.find((p) => p.id === choice);
      return { kind: "project", projectId: choice as string, name: chosen?.name ?? String(choice) };
    }
    // Create a new project.
    const { name } = await prompts({
      type: "text",
      name: "name",
      message: "New project name:",
    });
    if (!name) return { kind: "cancelled" };
    const created = await createProject(cfg, { name });
    if (!created.id) {
      return { kind: "proposed", proposalId: created.proposalId, name };
    }
    return { kind: "project", projectId: created.id, name, created: true };
  }

  // 4. Non-interactive, nothing resolved → pod-wide (announced by the caller).
  return { kind: "pod-wide" };
}

// ── `synap market install <slug>` ───────────────────────────────────────────

export async function marketInstall(
  slug: string,
  opts: { podUrl?: string; apiKey?: string; json?: boolean; project?: string }
): Promise<void> {
  const cat = await buildMarketCatalog();
  const entry = cat.entries.find((e) => e.slug === slug);
  if (!entry) {
    log.error(`No package "${slug}" found.`);
    log.hint("Browse what's available: synap market --list");
    process.exit(1);
  }

  const type = typeOf(entry);

  // Non-workspace types have no CLI→pod install door yet (the pod's
  // /packages/apply provisions a WORKSPACE). Be honest and route the user.
  if (type !== "workspace") {
    log.warn(`"${entry.name}" is a ${type} package — not installable from the CLI yet.`);
    if (type === "capability") {
      log.hint(`Add a capability from the pod catalog: synap cap add "${entry.name}"`);
    }
    log.hint("Install it from the browser marketplace (Marketplace → find it → Install).");
    return;
  }

  // Tier gate: don't silently attempt an ungrantable install.
  if (cat.lockedSlugs.has(slug)) {
    const tier = cat.tierBySlug.get(slug)?.requiredTier;
    log.warn(
      `"${entry.name}" requires the ${tier ?? "a higher"} tier — your account can't install it yet.`
    );
    log.hint("Upgrade your plan, then retry. Manage it from the browser billing settings.");
    return;
  }

  let cfg;
  try {
    cfg = await resolveHubConfig(opts);
  } catch (e) {
    renderHubError(e);
    process.exit(1);
  }

  // ── Resolve the target PROJECT this install lands under (the spine). ──────
  // Same door `launch` uses to link seed entities via `belongs_to_project`.
  const target = await resolveTargetProject(cfg, { explicitId: opts.project, json: opts.json });
  switch (target.kind) {
    case "cancelled":
      log.warn("Cancelled.");
      return;
    case "unknown":
      log.error(`No project "${target.id}" found on this pod.`);
      log.hint("List projects: synap orient · pin one: synap project use <id>");
      process.exit(1);
    // fallthrough not reached — process.exit above
    case "proposed":
      log.warn(`Project "${target.name}" isn't live yet — it needs your approval first.`);
      if (target.proposalId) log.hint(`Approve proposal ${target.proposalId.slice(0, 8)}, then retry.`);
      log.hint("Review it with: synap proposals list");
      return;
  }
  // Undefined = pod-wide (no project link).
  const projectId = target.kind === "project" ? target.projectId : undefined;
  if (!opts.json) {
    if (target.kind === "project") {
      log.info(
        `Adding to project ${chalk.bold(target.name)}${target.created ? chalk.dim(" (new)") : ""}.`
      );
    } else {
      // pod-wide — say so, and how to scope next time (AI/script path).
      log.dim("No project linked — installing pod-wide.");
      log.dim("Scope it with: --project <id>  or  synap project use <id>");
    }
  }

  // Build the install payload — bundled (offline, byte-identical to the CP
  // definition) when available, else the authed CP definition.
  const cpToken = getStoredToken()?.token;
  let pkg: Record<string, unknown>;
  if (cat.bundledSlugs.has(slug)) {
    pkg = toPackageDefinition(slug) as unknown as Record<string, unknown>;
  } else {
    const def = await fetchPackageDefinition(slug, cpToken);
    if (!def) {
      log.error(`Couldn't fetch "${entry.name}"'s definition from the control plane.`);
      log.hint(cat.loggedIn ? "" : "It may be private — try: synap login");
      process.exit(1);
    }
    pkg = def;
  }

  const s = opts.json ? null : ora(`Installing ${entry.name}…`).start();
  try {
    // projectId links the workspace's seed entities to the project
    // (belongs_to_project) — exactly what `launch` does. Undefined = pod-wide.
    const res = (await hubPost(
      "/packages/apply",
      { ...pkg, projectId },
      cfg,
      APPLY_TIMEOUT_MS
    )) as Record<string, unknown>;

    const projectName = target.kind === "project" ? target.name : undefined;

    if (writeGovernance(res) === "proposed") {
      const proposalId = res.proposalId ? String(res.proposalId) : undefined;
      const steps = FLOW.afterMarketInstall({ slug, proposed: true, projectName });
      s?.stop();
      if (opts.json) {
        console.log(JSON.stringify({ slug, outcome: "proposed", proposalId, projectId, nextSteps: steps }, null, 2));
        return;
      }
      log.info(`${entry.name} — proposed (under review, not live yet).`);
      if (proposalId) log.hint(`Approve: synap proposals approve ${proposalId.slice(0, 8)}`);
      renderNextSteps(steps);
      return;
    }

    const ws = res.workspace as
      | { status?: string; workspaceId?: string; onto?: string }
      | undefined;
    const steps = FLOW.afterMarketInstall({ slug, proposed: false, projectName });
    s?.stop();
    if (opts.json) {
      console.log(JSON.stringify({ slug, outcome: ws?.status ?? "unknown", workspace: ws, projectId, nextSteps: steps }, null, 2));
      return;
    }
    if (ws?.status === "composed") {
      log.success(`${entry.name} — layered onto its base workspace.`);
    } else if (ws?.status === "created") {
      log.success(`${entry.name} ready.`);
    } else {
      log.warn(`${entry.name} — pod returned no workspace.`);
    }
    if (ws?.status === "composed" || ws?.status === "created") renderNextSteps(steps);
  } catch (e) {
    s?.stop();
    log.error(`${entry.name} failed`);
    renderHubError(e);
    process.exit(1);
  }
}
