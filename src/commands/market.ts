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
 *   synap market update [slug] [--yes] [--json]              — check/apply drift
 *
 * INSTALL SCOPE: the pod's one install door (`/packages/apply`) provisions a
 * WORKSPACE from a package definition — it is workspace-centric. So `market
 * install` fully installs WORKSPACE-type packages (same door `launch` uses) and,
 * for the operational types (capability/skill/…), routes the user to the surface
 * that installs them (the browser marketplace, or `synap cap add` for a
 * capability already in the pod catalog) rather than silently doing nothing. A
 * generic CLI→pod install for standalone non-workspace packages is not wired yet.
 */

import ora from "ora";
import chalk from "chalk";
import {
  assembleCatalog,
  computeTemplateUpdates,
  getWorkspaceTemplate,
  isHashVersion,
  listPublicTemplates,
  listWorkspaceTemplates,
  toPackageDefinition,
  type CatalogEntry,
  type TemplateDependency,
  type TemplateUpdateCheck,
} from "@synap-core/workspace-templates";
import { log, banner } from "../utils/logger.js";
import { resolveHubConfig, hubPost, renderHubError, type HubConfig } from "../lib/hub-client.js";
import { fetchProjects } from "../lib/project.js";
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
import { fetchInstalledSlugs, fetchInstalledTemplates, type InstalledTemplateInfo } from "../lib/installed.js";
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
  /**
   * Slug → CP row's OWN `version`, read straight off `CpBrowseRow`/`CpMineRow`
   * (NOT off the merged `entries[]`). Needed because `mergeCatalog`'s
   * squatting-defense makes the BUNDLE win the merged entry for every OFFICIAL
   * public template that also exists on the CP (list-route rows never carry
   * `definition`, so `computeTemplateUpdates` sees no remote version for them
   * via `entries[]` and would silently hide a real CP-side update). `market
   * update` compares against THIS map directly instead.
   */
  remoteVersionBySlug: Map<string, string>;
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
    // Logged in → include PRIVATE bundled templates (e.g. the `the-arch` suite),
    // matching the "private templates unlocked" promise. Logged out → public
    // bundle only. (mergeCatalog derives `isPrivate` from each template's
    // `meta.isPublic === false`, so private bundled entries stay badged.)
    bundled: loggedIn ? listWorkspaceTemplates() : listPublicTemplates(),
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

  // Raw CP-row versions, bypassing the merge winner (see `remoteVersionBySlug`
  // doc above). `/mine` rows are the caller's own — they win a slug collision
  // with a public browse row (matches `assembleCatalog`'s own precedence).
  const remoteVersionBySlug = new Map<string, string>();
  for (const r of publicRows) if (r.version) remoteVersionBySlug.set(r.slug, r.version);
  for (const r of mineRows) if (r.version) remoteVersionBySlug.set(r.slug, r.version);

  return {
    entries: merged.entries,
    tierBySlug,
    lockedSlugs,
    installed,
    bundledSlugs,
    loggedIn,
    reachedCp,
    remoteVersionBySlug,
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

// ── Seed-outcome honesty ────────────────────────────────────────────────────
// Mirrors the backend shape `ResolvedPackageDependency.seedOutcome`
// (`package-dependency-resolver.ts`) — kept local since api-types doesn't
// carry it yet; a structural match is all `/packages/apply`'s JSON needs.

interface DependencySeedOutcome {
  slug: string;
  status: "no-layers" | "seeded" | "failed";
  layers?: string[];
  error?: string;
}

interface ResolvedDependencyLike {
  slug: string;
  seedOutcome?: DependencySeedOutcome;
}

/**
 * Top-level rollup the backend now sends alongside `dependencies[]` — same
 * info, pre-aggregated. Kept local for the same reason as the types above:
 * a structural match is all `/packages/apply`'s JSON needs, and this CLI
 * doesn't carry api-types. Optional — older pod builds won't send it.
 */
interface SeedSummary {
  attempted: number;
  seeded: number;
  failed: Array<{ slug: string; error: string }>;
}

/** The two new honest-outcome fields `/packages/apply` may return. Both optional — a legacy pod build may omit them. */
interface WorkspaceApplyResult {
  status?: string;
  workspaceId?: string;
  onto?: string;
  outcome?: "created" | "reconciled" | "unchanged";
}

/**
 * Print an honest per-dependency seed summary — no more silent "✓ ready" when
 * a dependency's capabilities/playbooks failed to seed. Prefers the top-level
 * `seedSummary` rollup when present (pre-aggregated by the backend); falls
 * back to re-deriving from the per-dependency `dependencies[]` array on older
 * pod builds. No-op when there's nothing to report.
 */
function printSeedOutcomes(
  dependencies: ResolvedDependencyLike[] | undefined,
  seedSummary?: SeedSummary
): void {
  if (seedSummary) {
    if (seedSummary.attempted === 0) return;
    if (seedSummary.failed.length === 0) {
      log.success(`${seedSummary.seeded}/${seedSummary.attempted} capabilities seeded`);
      return;
    }
    log.warn(`${seedSummary.seeded}/${seedSummary.attempted} capabilities seeded`);
    for (const f of seedSummary.failed) {
      log.hint(`${f.slug}: failed${f.error ? ` (${f.error})` : ""}`);
    }
    return;
  }
  if (!dependencies?.length) return;
  const withLayers = dependencies.filter(
    (d) => d.seedOutcome && d.seedOutcome.status !== "no-layers"
  );
  if (withLayers.length === 0) return;
  const seeded = withLayers.filter((d) => d.seedOutcome!.status === "seeded");
  const failed = withLayers.filter((d) => d.seedOutcome!.status === "failed");
  if (failed.length === 0) {
    log.success(`${seeded.length}/${withLayers.length} capabilities seeded`);
    return;
  }
  log.warn(`${seeded.length}/${withLayers.length} capabilities seeded`);
  for (const d of failed) {
    log.hint(`${d.slug}: failed${d.seedOutcome!.error ? ` (${d.seedOutcome!.error})` : ""}`);
  }
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

// ── Optional --project link ──────────────────────────────────────────────────

/**
 * Installs are POD-WIDE. A template provisions WORKSPACES (pod-level) and their
 * contents are workspace-level — so linking the install to a project would be
 * superfluous. `--project` is a pure OPT-IN to ALSO tag the seeded entities to a
 * project; it is never prompted, defaulted, or taken from a pin. Returns the
 * resolved project (validated) or undefined for the pod-wide default; exits on
 * an unknown explicit id.
 */
async function resolveOptionalProject(
  cfg: HubConfig,
  explicitId: string | undefined,
): Promise<{ projectId: string; name: string } | undefined> {
  if (!explicitId) return undefined;
  const match = (await fetchProjects(cfg)).find((p) => p.id === explicitId);
  if (!match) {
    log.error(`No project "${explicitId}" found on this pod.`);
    log.hint("List projects: synap orient");
    process.exit(1);
  }
  return { projectId: match.id, name: match.name };
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

  // ── Install target: POD-WIDE. ────────────────────────────────────────────
  // A template just provisions its workspace(s) pod-wide — no project needed.
  // `--project` is an optional add-on to also tag the seeded entities to a
  // project (never prompted, never from a pin). Default = pod-wide.
  const project = await resolveOptionalProject(cfg, opts.project);
  const projectId = project?.projectId;
  const projectName = project?.name;
  if (!opts.json && project) {
    log.info(`Also linking seeded entities to project ${chalk.bold(project.name)}.`);
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

    const ws = res.workspace as WorkspaceApplyResult | undefined;
    const dependencies = res.dependencies as ResolvedDependencyLike[] | undefined;
    const seedSummary = res.seedSummary as SeedSummary | undefined;
    const steps = FLOW.afterMarketInstall({ slug, proposed: false, projectName });
    s?.stop();
    if (opts.json) {
      console.log(
        JSON.stringify(
          {
            slug,
            outcome: ws?.outcome ?? ws?.status ?? "unknown",
            workspace: ws,
            dependencies,
            seedSummary,
            projectId,
            nextSteps: steps,
          },
          null,
          2
        )
      );
      return;
    }
    // `outcome` is the honest signal when the pod build sends it — falls back
    // to the older ambiguous `status`-based message otherwise.
    if (ws?.outcome === "created") {
      log.success(`✓ Installed ${entry.name}.`);
    } else if (ws?.outcome === "reconciled") {
      log.success(`✓ Updated ${entry.name}.`);
    } else if (ws?.outcome === "unchanged") {
      log.info(`• ${entry.name} is already up to date.`);
    } else if (ws?.status === "composed") {
      log.success(`${entry.name} — layered onto its base workspace.`);
    } else if (ws?.status === "created") {
      log.success(`${entry.name} ready.`);
    } else {
      log.warn(`${entry.name} — pod returned no workspace.`);
    }
    printSeedOutcomes(dependencies, seedSummary);
    if (ws?.outcome || ws?.status === "composed" || ws?.status === "created") renderNextSteps(steps);
  } catch (e) {
    s?.stop();
    log.error(`${entry.name} failed`);
    renderHubError(e);
    process.exit(1);
  }
}

// ── `synap market update [slug]` — drift detection + version-aware re-apply ──

interface UpdateCheck extends TemplateUpdateCheck {
  /**
   * True when the installed workspace carries no version stamp at all — the
   * pod can't say whether it's stale. Distinct from `updateAvailable: false`
   * (checked, and it IS current). Every CLI/Hub-door install is `true` today —
   * see `InstalledTemplateInfo.version`'s doc in `lib/installed.ts`.
   */
  noVersionInfo: boolean;
}

/**
 * Per-installed-slug drift check. Starts from the shared `computeTemplateUpdates`
 * (handles bundled-only / private-only slugs via `bundleVersion`), then
 * overrides `latestVersion`/`updateAvailable` with the CP row's OWN version for
 * any slug in `remoteVersionBySlug` — the merge-winner bypass this command
 * needs (see `MarketCatalog.remoteVersionBySlug`'s doc). A slug the pod never
 * version-stamped is reported `noVersionInfo: true`, never silently "outdated".
 */
function computeUpdates(installedTemplates: InstalledTemplateInfo[], cat: MarketCatalog): UpdateCheck[] {
  const withVersion = installedTemplates.filter(
    (t): t is InstalledTemplateInfo & { version: string } => !!t.version
  );
  const base = computeTemplateUpdates(
    withVersion.map((t) => ({ slug: t.slug, version: t.version })),
    cat.entries,
    bundledTemplatesVersion()
  );
  const baseBySlug = new Map(base.map((b) => [b.slug, b]));

  return installedTemplates.map((t): UpdateCheck => {
    if (!t.version) {
      return {
        slug: t.slug,
        installedVersion: "",
        latestVersion: cat.remoteVersionBySlug.get(t.slug),
        updateAvailable: false,
        noVersionInfo: true,
      };
    }
    const b = baseBySlug.get(t.slug)!;
    const remoteVersion = cat.remoteVersionBySlug.get(t.slug);
    if (remoteVersion) {
      return {
        ...b,
        latestVersion: remoteVersion,
        updateAvailable: remoteVersion !== t.version,
        noVersionInfo: false,
      };
    }
    return { ...b, noVersionInfo: false };
  });
}

/**
 * Apply one package via the SAME door `marketInstall` uses
 * (`POST /packages/apply`) — for an already-installed slug this re-runs the
 * pod's idempotent-create path, which reconciles when the pod build supports
 * it (see the `applyOnePackage` caveat below for what "created" means here).
 */
async function applyOnePackage(
  entry: CatalogEntry,
  cat: MarketCatalog,
  cfg: HubConfig,
  opts: { json?: boolean }
): Promise<{
  slug: string;
  outcome: string;
  error?: string;
  dependencies?: ResolvedDependencyLike[];
  seedSummary?: SeedSummary;
}> {
  if (cat.lockedSlugs.has(entry.slug)) {
    const tier = cat.tierBySlug.get(entry.slug)?.requiredTier;
    if (!opts.json)
      log.warn(`"${entry.name}" requires the ${tier ?? "a higher"} tier — skipping.`);
    return { slug: entry.slug, outcome: "locked" };
  }

  const cpToken = getStoredToken()?.token;
  let pkg: Record<string, unknown>;
  if (cat.bundledSlugs.has(entry.slug)) {
    pkg = toPackageDefinition(entry.slug) as unknown as Record<string, unknown>;
  } else {
    const def = await fetchPackageDefinition(entry.slug, cpToken);
    if (!def) {
      if (!opts.json) {
        log.error(`Couldn't fetch "${entry.name}"'s definition from the control plane.`);
        if (!cat.loggedIn) log.hint("It may be private — try: synap login");
      }
      return { slug: entry.slug, outcome: "fetch-failed" };
    }
    pkg = def;
  }

  const s = opts.json ? null : ora(`Updating ${entry.name}…`).start();
  try {
    const res = (await hubPost("/packages/apply", pkg, cfg, APPLY_TIMEOUT_MS)) as Record<string, unknown>;
    s?.stop();

    if (writeGovernance(res) === "proposed") {
      const proposalId = res.proposalId ? String(res.proposalId) : undefined;
      if (!opts.json) {
        log.info(`${entry.name} — update proposed (under review, not live yet).`);
        if (proposalId) log.hint(`Approve: synap proposals approve ${proposalId.slice(0, 8)}`);
      }
      return { slug: entry.slug, outcome: "proposed" };
    }

    const ws = res.workspace as WorkspaceApplyResult | undefined;
    const dependencies = res.dependencies as ResolvedDependencyLike[] | undefined;
    const seedSummary = res.seedSummary as SeedSummary | undefined;
    if (!opts.json) {
      // `outcome` is the honest signal when the pod build sends it — the
      // "created" status used to be ambiguous (also what a no-op idempotent
      // return reports); `outcome` disambiguates, so prefer it.
      if (ws?.outcome === "created") {
        log.success(`✓ Installed ${entry.name}.`);
      } else if (ws?.outcome === "reconciled") {
        log.success(`✓ Updated ${entry.name}.`);
      } else if (ws?.outcome === "unchanged") {
        log.info(`• ${entry.name} is already up to date.`);
      } else if (ws?.status === "composed") {
        log.success(`${entry.name} — reconciled onto its base workspace.`);
      } else if (ws?.status === "created") {
        log.success(`${entry.name} — apply call completed.`);
        log.hint(
          "This pod's /packages/apply doesn't distinguish reconciled-vs-unchanged yet — check synap orient if you expected new content."
        );
      } else {
        log.warn(`${entry.name} — pod returned no workspace.`);
      }
      printSeedOutcomes(dependencies, seedSummary);
    }
    return { slug: entry.slug, outcome: ws?.outcome ?? ws?.status ?? "unknown", dependencies, seedSummary };
  } catch (e) {
    s?.stop();
    if (!opts.json) {
      log.error(`${entry.name} update failed`);
      renderHubError(e);
    }
    return { slug: entry.slug, outcome: "failed", error: e instanceof Error ? e.message : String(e) };
  }
}

export async function marketUpdate(
  slugsArg: string[] | undefined,
  opts: { yes?: boolean; dryRun?: boolean; json?: boolean; podUrl?: string; apiKey?: string }
): Promise<void> {
  const [installedTemplates, cat] = await Promise.all([fetchInstalledTemplates(), buildMarketCatalog()]);

  if (installedTemplates.length === 0) {
    if (opts.json) {
      console.log(JSON.stringify({ checks: [], loggedIn: cat.loggedIn }, null, 2));
      return;
    }
    log.warn("No installed packages found on this pod.");
    log.hint("Install one: synap market install <slug>");
    return;
  }

  let checks = computeUpdates(installedTemplates, cat);
  const explicitSlugs = !!slugsArg && slugsArg.length > 0;
  let unknownSlugs: string[] = [];

  if (explicitSlugs) {
    const known = new Set(checks.map((c) => c.slug));
    unknownSlugs = slugsArg!.filter((s) => !known.has(s));
    const validSlugs = slugsArg!.filter((s) => known.has(s));
    for (const s of unknownSlugs) {
      if (!opts.json) log.error(`"${s}" is not installed on this pod — skipping.`);
    }
    if (validSlugs.length === 0) {
      if (opts.json) {
        console.log(
          JSON.stringify({ checks: [], loggedIn: cat.loggedIn, unknownSlugs, applied: [] }, null, 2)
        );
        return;
      }
      log.hint("List what's installed: synap market installed");
      process.exit(1);
    }
    checks = checks.filter((c) => validSlugs.includes(c.slug));
  }

  const withUpdates = checks.filter((c) => c.updateAvailable);
  const noVersionInfo = checks.filter((c) => c.noVersionInfo);

  // Private templates resolve only via the authed CP path — an update check
  // that found NOTHING while logged out is ambiguous (could be genuinely
  // current, could be blind to private drift). Say so rather than staying
  // silently quiet.
  if (!cat.loggedIn && !opts.json) {
    log.dim("Not logged in — private template updates aren't visible. Run: synap login");
  }

  // --dry-run is a NAMED alias for the "no --yes" preview path — forces the
  // preview even when --yes or explicit slugs would otherwise trigger apply.
  const shouldApply = !opts.dryRun && (explicitSlugs || opts.yes);

  if (!opts.json) {
    log.heading("  Installed packages");
    log.blank();
    for (const c of checks) {
      const label = c.noVersionInfo
        ? chalk.dim("version unknown — reinstall to enable update checks")
        : c.updateAvailable
          ? chalk.yellow(`update available  `) + chalk.dim(c.installedVersion) + " → " + c.latestVersion
          : chalk.green("up to date");
      console.log("    " + chalk.cyan(c.slug.padEnd(28)) + label);
    }
    log.blank();
    if (noVersionInfo.length > 0) {
      log.dim(
        `${noVersionInfo.length} installed without a version stamp — can't check ${noVersionInfo.length === 1 ? "it" : "them"} for updates.`
      );
    }
  }

  if (withUpdates.length === 0) {
    if (opts.json) {
      console.log(JSON.stringify({ checks, loggedIn: cat.loggedIn, unknownSlugs, applied: [] }, null, 2));
    } else {
      log.success("Nothing to update.");
    }
    return;
  }

  if (!shouldApply) {
    const steps = FLOW.afterMarketUpdateCheck(withUpdates.map((c) => c.slug));
    if (opts.json) {
      console.log(
        JSON.stringify({ checks, loggedIn: cat.loggedIn, unknownSlugs, applied: [], nextSteps: steps }, null, 2)
      );
      return;
    }
    log.info(`${withUpdates.length} package${withUpdates.length === 1 ? "" : "s"} have updates.`);
    renderNextSteps(steps);
    return;
  }

  let cfg: HubConfig;
  try {
    cfg = await resolveHubConfig(opts);
  } catch (e) {
    renderHubError(e);
    process.exit(1);
  }

  const results: Array<{
    slug: string;
    outcome: string;
    error?: string;
    dependencies?: ResolvedDependencyLike[];
    seedSummary?: SeedSummary;
  }> = [];
  for (const c of withUpdates) {
    const entry = cat.entries.find((e) => e.slug === c.slug);
    if (!entry) {
      if (!opts.json) log.warn(`"${c.slug}" is no longer in the catalog — skipping.`);
      results.push({ slug: c.slug, outcome: "not-in-catalog" });
      continue;
    }
    results.push(await applyOnePackage(entry, cat, cfg, { json: opts.json }));
  }

  const steps = FLOW.afterMarketUpdateApply();
  if (opts.json) {
    console.log(
      JSON.stringify({ checks, loggedIn: cat.loggedIn, unknownSlugs, applied: results, nextSteps: steps }, null, 2)
    );
    return;
  }
  renderNextSteps(steps);
}

// ── `synap market installed [--json] [--outdated]` — pure-read inventory ────

/** `"h-<hash>"` → `"h-<first 6 hash chars>"`. Semver strings pass through. */
function truncateVersion(v: string): string {
  return isHashVersion(v) ? `h-${v.slice(2, 8)}` : v;
}

/**
 * Human status cell for one installed row — distinguishes hash drift (no
 * ordering, just "changed") from semver drift ("update available").
 */
function installedStatusLabel(c: UpdateCheck): string {
  if (c.noVersionInfo) return chalk.dim("can't check — reinstall");
  if (!c.updateAvailable) return chalk.green("up to date");
  const installed = truncateVersion(c.installedVersion);
  const latest = c.latestVersion ? truncateVersion(c.latestVersion) : "?";
  const hashPair = isHashVersion(c.installedVersion) || isHashVersion(c.latestVersion ?? "");
  const label = hashPair ? "content changed" : "update available";
  return chalk.yellow(`${label}  `) + chalk.dim(installed) + " → " + latest;
}

// ── `synap market installed --tree` — composition graph ────────────────────
//
// The flat list above shows one row per installed slug — so a SUITE (e.g.
// `enterprise-os`) reads as "1 workspace" even though it composed several
// (foundation/ecosystem/operations/crm/…). The tree surfaces that graph by
// walking each package's `dependencies[]` (the template-composition edges,
// declared once in the template YAML — no new storage). Purely derived: no
// new drift/version logic, reuses `computeUpdates`'s per-slug checks.

interface TreeNode {
  slug: string;
  name: string;
  relation: "compose" | "require";
  depKind?: string;
  installed: boolean;
  workspaceId?: string;
  workspaceName?: string;
  installedVersion?: string;
  latestVersion?: string | null;
  updateAvailable: boolean;
  noVersionInfo: boolean;
  /** Names of OTHER top-level packages whose tree also carries this slug. */
  shared: string[];
  children: TreeNode[];
}

interface TreePackage {
  slug: string;
  name: string;
  installedVersion: string;
  latestVersion: string | null;
  updateAvailable: boolean;
  noVersionInfo: boolean;
  workspaceCount: number;
  isSuite: boolean;
  children: TreeNode[];
}

/**
 * All slugs reachable from `slug`'s `dependencies[]`, recursively. `ancestors`
 * guards against a cycle (A requires B requires A) — a slug already on the
 * current path is not re-descended into.
 */
function collectDescendantSlugs(slug: string, ancestors: Set<string>): Set<string> {
  const out = new Set<string>();
  const deps = getWorkspaceTemplate(slug)?.dependencies ?? [];
  for (const dep of deps) {
    if (ancestors.has(dep.slug)) continue; // cycle guard
    out.add(dep.slug);
    const nextAncestors = new Set(ancestors);
    nextAncestors.add(dep.slug);
    for (const s of collectDescendantSlugs(dep.slug, nextAncestors)) out.add(s);
  }
  return out;
}

/**
 * Build one dependency node (and its subtree) for a top-level package's tree.
 * `ancestors` is the path from the top-level package down to this node — used
 * only for the cycle guard, so the SAME slug can still appear under multiple
 * sibling branches (that's sharing, not a cycle).
 */
function buildDependencyNode(
  dep: TemplateDependency,
  entryBySlug: Map<string, CatalogEntry>,
  installedBySlug: Map<string, InstalledTemplateInfo>,
  checksBySlug: Map<string, UpdateCheck>,
  slugToTopLevels: Map<string, Map<string, string>>,
  currentTopLevelSlug: string,
  ancestors: Set<string>
): TreeNode {
  const entry = entryBySlug.get(dep.slug);
  const installedInfo = installedBySlug.get(dep.slug);
  const check = checksBySlug.get(dep.slug);

  const owners = slugToTopLevels.get(dep.slug);
  const shared = owners
    ? [...owners.entries()].filter(([slug]) => slug !== currentTopLevelSlug).map(([, name]) => name)
    : [];

  const children: TreeNode[] = [];
  if (!ancestors.has(dep.slug)) {
    const nextAncestors = new Set(ancestors);
    nextAncestors.add(dep.slug);
    const childDeps = getWorkspaceTemplate(dep.slug)?.dependencies ?? [];
    for (const childDep of childDeps) {
      children.push(
        buildDependencyNode(
          childDep,
          entryBySlug,
          installedBySlug,
          checksBySlug,
          slugToTopLevels,
          currentTopLevelSlug,
          nextAncestors
        )
      );
    }
  }

  return {
    slug: dep.slug,
    name: entry?.name ?? dep.slug,
    relation: dep.relation ?? "require",
    depKind: dep.kind,
    installed: !!installedInfo,
    workspaceId: installedInfo?.workspaceId,
    workspaceName: installedInfo?.workspaceName,
    installedVersion: check?.installedVersion,
    latestVersion: check?.latestVersion ?? null,
    updateAvailable: check?.updateAvailable ?? false,
    noVersionInfo: check ? check.noVersionInfo : !installedInfo,
    shared,
    children,
  };
}

/**
 * The composition-graph view: one tree per installed TOP-LEVEL package (a
 * suite, or any installed package whose template declares `dependencies[]`).
 * Everything else stays a flat leaf (`leafSlugs`, rendered like today's row).
 */
function buildCompositionTrees(
  rows: UpdateCheck[],
  cat: MarketCatalog,
  installedTemplates: InstalledTemplateInfo[],
  workspaceCountBySlug: Map<string, number>
): { packages: TreePackage[]; leafRows: UpdateCheck[] } {
  const entryBySlug = new Map(cat.entries.map((e) => [e.slug, e]));
  const installedBySlug = new Map(installedTemplates.map((t) => [t.slug, t]));
  const checksBySlug = new Map(rows.map((c) => [c.slug, c]));

  const topLevel = rows.filter((c) => {
    const entry = entryBySlug.get(c.slug);
    const hasDeps = (getWorkspaceTemplate(c.slug)?.dependencies?.length ?? 0) > 0;
    return (entry && isSuite(entry)) || hasDeps;
  });
  const topLevelSlugs = new Set(topLevel.map((c) => c.slug));
  const leafRows = rows.filter((c) => !topLevelSlugs.has(c.slug));

  // Reverse index: dep slug → { top-level slug → top-level name } for every
  // top-level package that reaches it. Needed BEFORE building nodes so each
  // node can list its OTHER owners.
  const slugToTopLevels = new Map<string, Map<string, string>>();
  for (const c of topLevel) {
    const name = entryBySlug.get(c.slug)?.name ?? c.slug;
    const descendants = collectDescendantSlugs(c.slug, new Set([c.slug]));
    for (const d of descendants) {
      if (!slugToTopLevels.has(d)) slugToTopLevels.set(d, new Map());
      slugToTopLevels.get(d)!.set(c.slug, name);
    }
  }

  const packages: TreePackage[] = topLevel.map((c) => {
    const entry = entryBySlug.get(c.slug);
    const deps = getWorkspaceTemplate(c.slug)?.dependencies ?? [];
    const children = deps.map((dep) =>
      buildDependencyNode(
        dep,
        entryBySlug,
        installedBySlug,
        checksBySlug,
        slugToTopLevels,
        c.slug,
        new Set([c.slug])
      )
    );
    return {
      slug: c.slug,
      name: entry?.name ?? c.slug,
      installedVersion: c.installedVersion,
      latestVersion: c.latestVersion ?? null,
      updateAvailable: c.updateAvailable,
      noVersionInfo: c.noVersionInfo,
      workspaceCount: workspaceCountBySlug.get(c.slug) ?? 0,
      isSuite: !!(entry && isSuite(entry)),
      children,
    };
  });

  return { packages, leafRows };
}

function nodeStatusLabel(node: TreeNode): string {
  if (!node.installed) return chalk.dim("not installed");
  if (node.noVersionInfo) return chalk.dim("can't check");
  if (!node.updateAvailable) return chalk.green("up to date");
  const installed = node.installedVersion ? truncateVersion(node.installedVersion) : "?";
  const latest = node.latestVersion ? truncateVersion(node.latestVersion) : "?";
  return chalk.yellow("update available  ") + chalk.dim(installed) + " → " + latest;
}

function printDependencyNode(node: TreeNode, prefix: string, isLast: boolean): void {
  const branch = isLast ? "└─ " : "├─ ";
  const targetPlain = node.installed ? `→ ${node.workspaceName}` : "→ (not installed)";
  const target = node.installed ? `→ ${chalk.bold(node.workspaceName)}` : chalk.dim("→ (not installed)");
  const relationHint = node.relation === "compose" ? chalk.dim("  ↳ composes onto its base") : "";
  const sharedTag = node.shared.length ? chalk.magenta(`  [shared: ${node.shared.join(", ")}]`) : "";
  const pad = (s: string, n: number) => s + " ".repeat(Math.max(1, n - s.length));
  console.log(
    prefix +
      chalk.dim(branch) +
      chalk.cyan(pad(node.slug, 20)) +
      pad(target, target.length + Math.max(0, 26 - targetPlain.length)) +
      nodeStatusLabel(node) +
      relationHint +
      sharedTag
  );
  const childPrefix = prefix + (isLast ? "   " : chalk.dim("│  "));
  node.children.forEach((child, i) => printDependencyNode(child, childPrefix, i === node.children.length - 1));
}

function printCompositionTree(pkg: TreePackage): void {
  const suiteTag = pkg.isSuite ? "  " + chalk.magenta("suite") : "";
  console.log(
    chalk.bold(pkg.name) +
      "  " +
      chalk.cyan(`(${pkg.slug})`) +
      "  " +
      chalk.dim(truncateVersion(pkg.installedVersion)) +
      "  " +
      (pkg.noVersionInfo
        ? chalk.dim("can't check — reinstall")
        : pkg.updateAvailable
          ? chalk.yellow("update available")
          : chalk.green("up to date")) +
      suiteTag
  );
  pkg.children.forEach((child, i) => printDependencyNode(child, "", i === pkg.children.length - 1));
  log.blank();
}

/**
 * Pure-read inventory of what's installed on this pod — reuses
 * `buildMarketCatalog` + `fetchInstalledTemplates` + `computeUpdates`
 * (`market update`'s own drift check), never writes anything. Pairs with
 * `market update` to apply what this surfaces.
 */
export async function marketInstalled(opts: { json?: boolean; outdated?: boolean; tree?: boolean }): Promise<void> {
  const [installedTemplates, cat] = await Promise.all([fetchInstalledTemplates(), buildMarketCatalog()]);

  if (installedTemplates.length === 0) {
    if (opts.json) {
      console.log(JSON.stringify({ rows: [], loggedIn: cat.loggedIn }, null, 2));
      return;
    }
    log.warn("No installed packages found on this pod.");
    log.hint("Browse what's available: synap market --list");
    return;
  }

  const checks = computeUpdates(installedTemplates, cat);

  // Multiple workspaces can install the same slug (a template composed onto
  // several bases, or the same additive pack in >1 workspace) — one row per
  // DISTINCT slug, with `workspaceCount` carrying the fan-out.
  const workspaceCountBySlug = new Map<string, number>();
  for (const t of installedTemplates) {
    workspaceCountBySlug.set(t.slug, (workspaceCountBySlug.get(t.slug) ?? 0) + 1);
  }
  const seen = new Set<string>();
  let rows = checks.filter((c) => {
    if (seen.has(c.slug)) return false;
    seen.add(c.slug);
    return true;
  });
  if (opts.outdated) rows = rows.filter((c) => c.updateAvailable);

  const entryBySlug = new Map(cat.entries.map((e) => [e.slug, e]));

  if (opts.tree) {
    const { packages, leafRows } = buildCompositionTrees(rows, cat, installedTemplates, workspaceCountBySlug);
    const steps = FLOW.afterMarketInstalledCheck(rows.filter((c) => c.updateAvailable).map((c) => c.slug));

    if (opts.json) {
      console.log(
        JSON.stringify(
          {
            packages,
            leaves: leafRows.map((c) => {
              const entry = entryBySlug.get(c.slug);
              return {
                slug: c.slug,
                name: entry?.name ?? c.slug,
                installedVersion: c.installedVersion,
                latestVersion: c.latestVersion ?? null,
                updateAvailable: c.updateAvailable,
                noVersionInfo: c.noVersionInfo,
                isPrivate: entry?.isPrivate ?? false,
                workspaceCount: workspaceCountBySlug.get(c.slug) ?? 0,
              };
            }),
            loggedIn: cat.loggedIn,
            nextSteps: steps,
          },
          null,
          2
        )
      );
      return;
    }

    if (packages.length === 0 && leafRows.length === 0) {
      log.success("Nothing installed.");
      return;
    }

    if (packages.length > 0) {
      log.heading("  Installed packages — composition graph");
      log.blank();
      packages.forEach(printCompositionTree);
    }

    if (leafRows.length > 0) {
      log.heading("  Other installed packages");
      log.blank();
      const nameW = Math.max(4, ...leafRows.map((c) => (entryBySlug.get(c.slug)?.name ?? c.slug).length)) + 2;
      const slugW = Math.max(4, ...leafRows.map((c) => c.slug.length)) + 2;
      for (const c of leafRows) {
        const entry = entryBySlug.get(c.slug);
        const name = entry?.name ?? c.slug;
        const priv = entry?.isPrivate ? chalk.yellow("private") : "";
        const wsCount = workspaceCountBySlug.get(c.slug) ?? 0;
        console.log(
          "    " +
            chalk.bold(name.padEnd(nameW)) +
            chalk.cyan(c.slug.padEnd(slugW)) +
            installedStatusLabel(c) +
            "  " +
            priv +
            (priv ? "  " : "") +
            chalk.dim(`${wsCount} workspace${wsCount === 1 ? "" : "s"}`)
        );
      }
      log.blank();
    }

    if (!cat.loggedIn) log.dim("Not logged in — private template updates aren't visible. Run: synap login");
    renderNextSteps(steps);
    return;
  }

  if (opts.json) {
    const steps = FLOW.afterMarketInstalledCheck(rows.filter((c) => c.updateAvailable).map((c) => c.slug));
    console.log(
      JSON.stringify(
        {
          rows: rows.map((c) => {
            const entry = entryBySlug.get(c.slug);
            return {
              slug: c.slug,
              name: entry?.name ?? c.slug,
              installedVersion: c.installedVersion,
              latestVersion: c.latestVersion ?? null,
              updateAvailable: c.updateAvailable,
              noVersionInfo: c.noVersionInfo,
              isPrivate: entry?.isPrivate ?? false,
              isHashVersion: isHashVersion(c.installedVersion) || isHashVersion(c.latestVersion ?? ""),
              workspaceCount: workspaceCountBySlug.get(c.slug) ?? 0,
            };
          }),
          loggedIn: cat.loggedIn,
          nextSteps: steps,
        },
        null,
        2
      )
    );
    return;
  }

  if (rows.length === 0) {
    log.success(opts.outdated ? "Nothing outdated." : "Nothing installed.");
    return;
  }

  log.heading("  Installed packages");
  log.blank();

  const nameW = Math.max(4, ...rows.map((c) => (entryBySlug.get(c.slug)?.name ?? c.slug).length)) + 2;
  const slugW = Math.max(4, ...rows.map((c) => c.slug.length)) + 2;

  for (const c of rows) {
    const entry = entryBySlug.get(c.slug);
    const name = entry?.name ?? c.slug;
    const priv = entry?.isPrivate ? chalk.yellow("private") : "";
    const wsCount = workspaceCountBySlug.get(c.slug) ?? 0;
    console.log(
      "    " +
        chalk.bold(name.padEnd(nameW)) +
        chalk.cyan(c.slug.padEnd(slugW)) +
        installedStatusLabel(c) +
        "  " +
        priv +
        (priv ? "  " : "") +
        chalk.dim(`${wsCount} workspace${wsCount === 1 ? "" : "s"}`)
    );
  }
  log.blank();

  if (!cat.loggedIn) log.dim("Not logged in — private template updates aren't visible. Run: synap login");
  renderNextSteps(FLOW.afterMarketInstalledCheck(rows.filter((c) => c.updateAvailable).map((c) => c.slug)));
}
