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
 * INSTALL SCOPE: WORKSPACE-type packages install via `/packages/apply` (the
 * same door `launch` uses), which provisions a workspace from the definition.
 * Non-workspace kinds (capability / automation / cell / template) install via
 * the pod's kind-agnostic `market.install` verb on `/capabilities/execute`,
 * which resolves the definition from `cp_catalog_cache`. Types the verb doesn't
 * handle fall back to a route-to-browser message.
 */

import ora from "ora";
import chalk from "chalk";
import {
  assembleCatalog,
  computeTemplateUpdates,
  isHashVersion,
  listPublicTemplates,
  listWorkspaceTemplates,
  toPackageDefinition,
  layerTemplateGraph,
  bundledEdgesOf,
  groupByDomain,
  type CatalogEntry,
  type TemplateDependency,
  type TemplateUpdateCheck,
  type CompositionEdge,
  type CompositionGraph,
  type CompositionNode,
  type CompositionInstalledEntry,
} from "@synap-core/workspace-templates";
import { log, banner } from "../utils/logger.js";
import { resolveHubConfig, hubPost, renderHubError, HubError, type HubConfig } from "../lib/hub-client.js";
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
import { capabilityAdd } from "./capability.js";
import { bundledTemplatesVersion } from "../lib/bundle-version.js";
import { HubNetworkError } from "../lib/hub-client.js";

// Same longer budget launch uses — an apply writes profiles/views/entities.
const APPLY_TIMEOUT_MS = 120_000;

/** `--timeout <seconds>` → ms, falling back to `APPLY_TIMEOUT_MS` when unset/invalid. */
function parseApplyTimeoutMs(raw: string | undefined): number {
  const secs = raw ? parseInt(raw, 10) : NaN;
  return Number.isFinite(secs) && secs > 0 ? secs * 1000 : APPLY_TIMEOUT_MS;
}

export interface MarketCatalog {
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
export async function buildMarketCatalog(filters?: PackageFilters): Promise<MarketCatalog> {
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

/** The `kind` values the pod's `market.install` verb provisions (see
 * cp-catalog-sync.ts `CatalogKind`). */
export type MarketInstallKind = "capability" | "automation" | "template" | "cell";

/**
 * Map a CP package `category` (what {@link typeOf} returns) → the pod
 * `market.install` verb's `kind` vocabulary, or `null` when the verb can't
 * install that type. The CP's live PACKAGE_TYPES and the pod's cache `kind`
 * diverge (see cp-catalog-sync.ts): the CP's `workflow` is the pod's
 * `automation`; the CP's `workspace` is the pod's `template` — but a workspace
 * installs through the dedicated `/packages/apply` create path, so it never
 * routes through here. `automation`/`template` are also accepted verbatim so a
 * row already speaking the pod's cache vocabulary still resolves.
 */
export function marketInstallKind(type: string): MarketInstallKind | null {
  switch (type) {
    case "capability":
      return "capability";
    case "cell":
      return "cell";
    case "workflow":
    case "automation":
      return "automation";
    case "template":
      return "template";
    default:
      return null;
  }
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

export interface ResolvedDependencyLike {
  slug: string;
  seedOutcome?: DependencySeedOutcome;
}

/**
 * Top-level rollup the backend now sends alongside `dependencies[]` — same
 * info, pre-aggregated. Kept local for the same reason as the types above:
 * a structural match is all `/packages/apply`'s JSON needs, and this CLI
 * doesn't carry api-types. Optional — older pod builds won't send it.
 */
export interface SeedSummary {
  attempted: number;
  seeded: number;
  failed: Array<{ slug: string; error: string }>;
}

/** The two new honest-outcome fields `/packages/apply` may return. Both optional — a legacy pod build may omit them. */
export interface WorkspaceApplyResult {
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

// ── Apply-outcome honesty — shared by `marketInstall` + `applyOnePackage` ───
// Both hit the same `/packages/apply` door and must render the SAME honest
// verdict from its response: a partial capability-seed failure, a version
// stamp that silently didn't take, or a compose-overlay result are never a
// plain "✓ success" — in the human text OR in `--json`.

/** True when at least one dependency's capability seed genuinely failed. */
function hasSeedFailure(
  dependencies: ResolvedDependencyLike[] | undefined,
  seedSummary: SeedSummary | undefined
): boolean {
  if (seedSummary) return seedSummary.failed.length > 0;
  return !!dependencies?.some((d) => d.seedOutcome?.status === "failed");
}

/**
 * A version was sent for a template the pod had never stamped before, yet the
 * response either says nothing changed or omits the honest-outcome fields
 * entirely — that combination means the stamp/reconcile didn't actually take,
 * not that the install was genuinely a no-op (the observed `market install
 * the-arch` → "already up to date" bug).
 */
function detectStampContradiction(
  ws: WorkspaceApplyResult | undefined,
  seedSummary: SeedSummary | undefined,
  remoteVersionSent: string | undefined,
  wasUnstamped: boolean
): boolean {
  if (!remoteVersionSent || !wasUnstamped) return false;
  return ws?.outcome === "unchanged" || (ws?.outcome === undefined && seedSummary === undefined);
}

export interface ApplyVerdict {
  /** Honest coarse status — JSON consumers should branch on this, never guess from `workspace.outcome` alone. */
  status:
    | "installed"
    | "installed-with-failures"
    | "updated"
    | "updated-with-failures"
    | "unchanged"
    | "composed"
    | "composed-with-failures"
    | "stamp-contradiction"
    | "legacy-unknown"
    | "no-workspace";
  /** Non-fatal warnings — a stamp contradiction or a compose-overlay note. Seed failures are reported separately via `printSeedOutcomes`. */
  warnings: string[];
}

/**
 * Classify one `/packages/apply` response into the honest verdict both
 * `marketInstall` and `applyOnePackage` print (and both put in `--json`).
 * `wasUnstamped` = the slug was already installed with no recorded version
 * BEFORE this call (only `marketInstall` can detect this today — see its
 * `fetchInstalledTemplates` call; `applyOnePackage` only ever re-applies
 * already-versioned slugs, so it always passes `false`).
 */
export function classifyApplyResult(
  entry: CatalogEntry,
  ws: WorkspaceApplyResult | undefined,
  dependencies: ResolvedDependencyLike[] | undefined,
  seedSummary: SeedSummary | undefined,
  ctx: { remoteVersionSent?: string; wasUnstamped: boolean }
): ApplyVerdict {
  const seedFailed = hasSeedFailure(dependencies, seedSummary);

  if (detectStampContradiction(ws, seedSummary, ctx.remoteVersionSent, ctx.wasUnstamped)) {
    return {
      status: "stamp-contradiction",
      warnings: [
        `${entry.name} didn't get stamped — your pod may be running an older version that doesn't support this yet (redeploy the pod backend).`,
      ],
    };
  }

  if (ws?.outcome === "created") return { status: seedFailed ? "installed-with-failures" : "installed", warnings: [] };
  if (ws?.outcome === "reconciled") return { status: seedFailed ? "updated-with-failures" : "updated", warnings: [] };
  if (ws?.outcome === "unchanged") return { status: "unchanged", warnings: [] };
  if (ws?.status === "composed") {
    const warnings = [
      `${entry.name} is a compose-overlay — it rides its base workspace and isn't independently updatable; update the base workspace to update this too.`,
    ];
    return { status: seedFailed ? "composed-with-failures" : "composed", warnings };
  }
  if (ws?.status === "created") return { status: "legacy-unknown", warnings: [] };
  return { status: "no-workspace", warnings: [] };
}

/** Render a `classifyApplyResult` verdict — the ONE honest-text door for both `marketInstall` and `applyOnePackage`. */
export function printApplyVerdict(entry: CatalogEntry, verdict: ApplyVerdict): void {
  switch (verdict.status) {
    case "installed":
      log.success(`Installed ${entry.name}.`);
      return;
    case "installed-with-failures":
      log.warn(`Installed ${entry.name} — completed with capability failures (see below).`);
      return;
    case "updated":
      log.success(`Updated ${entry.name}.`);
      return;
    case "updated-with-failures":
      log.warn(`Updated ${entry.name} — completed with capability failures (see below).`);
      return;
    case "unchanged":
      log.info(`• ${entry.name} is already up to date.`);
      return;
    case "composed":
      log.success(`${entry.name} — layered onto its base workspace.`);
      log.hint(verdict.warnings[0]);
      return;
    case "composed-with-failures":
      log.warn(`${entry.name} — layered onto its base workspace, with capability failures (see below).`);
      log.hint(verdict.warnings[0]);
      return;
    case "stamp-contradiction":
      log.warn(verdict.warnings[0]);
      return;
    case "legacy-unknown":
      log.success(`${entry.name} ready.`);
      log.hint(
        "This pod's /packages/apply doesn't distinguish reconciled-vs-unchanged yet — check synap orient if you expected new content."
      );
      return;
    case "no-workspace":
      log.warn(`${entry.name} — pod returned no workspace.`);
      return;
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
              domain: e.domain ?? null,
              tags: e.tags,
              suite: isSuite(e),
              overlay: isOverlay(e),
              ridesBase: composeBaseOf(e.slug),
              bundles: bundleCountOf(e.slug),
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

  renderCatalog(entries, cat);
}

/**
 * The kind of composition a workspace template participates in, derived from its
 * bundled dependency edges — NOT hardcoded. A `compose` edge = an OVERLAY that
 * rides a base workspace (installing it bare is meaningless); a `require` edge
 * on a suite = a workspace it BUNDLES. Non-bundled (private/CP-only) rows return
 * `null` base and 0 bundles, which the renderer degrades gracefully.
 */
function composeBaseOf(slug: string): string | null {
  for (const dep of bundledEdgesOf(slug)) {
    if (dep.relation === "compose") return dep.slug;
  }
  return null;
}
function bundleCountOf(slug: string): number {
  return bundledEdgesOf(slug).filter((d) => d.relation === "require").length;
}
function isOverlay(entry: CatalogEntry): boolean {
  return typeOf(entry) === "workspace" && !isSuite(entry) && composeBaseOf(entry.slug) !== null;
}

/**
 * Section-aware catalog renderer. Three axes carry distinct signal, so each gets
 * its OWN visual channel instead of one flat colored word (the old list):
 *   KIND    → the SECTION (Suites / Workspaces-by-domain / Overlays / other types)
 *   STATE   → a leading ✓ glyph (installed)
 *   ACCESS  → a dim right-hand tag (private / tier / locked)
 * Name reads first (you scan it); the slug is the dim type-token (you type it).
 */
function renderCatalog(entries: CatalogEntry[], cat: MarketCatalog): void {
  const width = process.stdout.columns ?? 100;
  const NAME_W = 26;
  const SLUG_W = 20;
  // Resolve a base slug to its display name so an overlay names the WORKSPACE it
  // extends, not its raw slug (e.g. "→ Brand Library", not "→ brand-library").
  const nameBySlug = new Map(entries.map((e) => [e.slug, e.name]));

  const accessTag = (entry: CatalogEntry): string => {
    const parts: string[] = [];
    if (entry.isPrivate) parts.push(chalk.yellow("private"));
    const tier = cat.tierBySlug.get(entry.slug);
    if (tier?.requiredTier) parts.push(chalk.cyan(tier.requiredTier));
    else if (tier?.pricingModel && tier.pricingModel !== "free")
      parts.push(chalk.cyan(tier.pricingModel));
    if (cat.lockedSlugs.has(entry.slug)) parts.push(chalk.red("locked"));
    return parts.length ? "  " + parts.join(" ") : "";
  };

  // One item = one line: glyph · bold name · default-weight slug (the token you
  // TYPE — never dimmed) · dim detail · dim access.
  const row = (entry: CatalogEntry, detail?: string): void => {
    const glyph = cat.installed.has(entry.slug) ? chalk.green("✓") : " ";
    const name = clip(entry.name, NAME_W).padEnd(NAME_W);
    const slug = clip(entry.slug, SLUG_W).padEnd(SLUG_W);
    const access = accessTag(entry);
    const head = `  ${glyph} ${chalk.bold(name)} ${slug}`;
    // Budget the detail to the remaining terminal width (never wrap/overflow).
    const detailText = detail ?? entry.description ?? "";
    const used = 2 + 1 + 1 + NAME_W + 1 + SLUG_W + 1;
    const room = Math.max(12, width - used - stripLen(access) - 1);
    console.log(head + " " + chalk.dim(clip(detailText, room)) + access);
  };

  // An overlay's identity IS "Name → Base Workspace" — the base it extends must
  // read as part of what it IS, not be buried in the description. So it gets its
  // own row shape: a combined, coloured identity column, then slug, then blurb.
  const IDENT_W = 40;
  const overlayRow = (entry: CatalogEntry): void => {
    const glyph = cat.installed.has(entry.slug) ? chalk.green("✓") : " ";
    const baseName = clip(
      nameBySlug.get(composeBaseOf(entry.slug) ?? "") ?? composeBaseOf(entry.slug) ?? "",
      IDENT_W - 22 - 3 // leave room for "name → " inside IDENT_W
    );
    const nameText = clip(entry.name, 22);
    const identityVisible = `${nameText} → ${baseName}`;
    const identity = chalk.bold(nameText) + chalk.dim(" → ") + chalk.cyan(baseName);
    const pad = " ".repeat(Math.max(1, IDENT_W - identityVisible.length));
    const slug = clip(entry.slug, SLUG_W).padEnd(SLUG_W);
    const access = accessTag(entry);
    const used = 2 + 1 + 1 + IDENT_W + 1 + SLUG_W + 1;
    const room = Math.max(10, width - used - stripLen(access) - 1);
    console.log(
      `  ${glyph} ${identity}${pad} ${slug} ` +
        chalk.dim(clip(entry.description ?? "", room)) +
        access
    );
  };

  // ── Suites — the headline: one install = a whole operating core ────────────
  const suites = entries.filter((e) => isSuite(e));
  if (suites.length > 0) {
    log.heading("  Suites  ·  a whole operating core in one install");
    log.blank();
    for (const e of suites) {
      const n = bundleCountOf(e.slug);
      row(e, n > 0 ? `bundles ${n} workspace${n === 1 ? "" : "s"}` : e.description ?? "");
    }
    log.blank();
  }

  // ── Workspaces — standalone installs, grouped by authored DOMAIN ───────────
  const workspaces = entries.filter(
    (e) => typeOf(e) === "workspace" && !isSuite(e) && !isOverlay(e)
  );
  if (workspaces.length > 0) {
    log.heading("  Workspaces");
    for (const group of groupByDomain(workspaces, (e) => e.domain)) {
      log.blank();
      console.log("  " + chalk.underline(group.label));
      for (const e of group.items) row(e);
    }
    log.blank();
  }

  // ── Add-ons — each rides a workspace you already have (named in-line) ───────
  const overlays = entries.filter((e) => isOverlay(e));
  if (overlays.length > 0) {
    log.heading("  Add-ons  ·  each extends the workspace named after the →");
    log.blank();
    for (const e of overlays) overlayRow(e);
    log.blank();
  }

  // ── Other package types (capability / skill / view / cell) by type ─────────
  const other = entries.filter(
    (e) => typeOf(e) !== "workspace"
  );
  if (other.length > 0) {
    const order = ["capability", "skill", "workflow", "view", "cell"];
    const byType = new Map<string, CatalogEntry[]>();
    for (const e of other) {
      const t = typeOf(e);
      (byType.get(t) ?? byType.set(t, []).get(t)!).push(e);
    }
    const types = [...byType.keys()].sort(
      (a, b) => (order.indexOf(a) + 1 || 99) - (order.indexOf(b) + 1 || 99)
    );
    for (const t of types) {
      log.heading(`  ${t.charAt(0).toUpperCase() + t.slice(1)}`);
      log.blank();
      for (const e of byType.get(t)!) row(e);
      log.blank();
    }
  }

  // Footer: a scannable count line + progressive-disclosure hints.
  const installedN = entries.filter((e) => cat.installed.has(e.slug)).length;
  log.dim(
    `${installedN} installed · ${entries.length - installedN} available` +
      (suites.length ? ` · ${suites.length} suite${suites.length === 1 ? "" : "s"}` : "")
  );
  if (!cat.loggedIn) log.dim("Log in to see your private packages: synap login");
  renderNextSteps(FLOW.afterMarketList());
}

/** Visible length of a string with chalk color codes stripped — for width math. */
function stripLen(s: string): number {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\[[0-9;]*m/g, "").length;
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

// ── `synap market install <slug> --dry-run` — write-free preflight ───────────

/** Mirror of the backend `WorkspacePreflightReport` (@synap/database). */
interface PreflightReport {
  dryRun: boolean;
  ok: boolean;
  validationErrors: string[];
  profiles: {
    create: string[];
    reused: string[];
    conflicts: Array<{ slug: string; existingKind: string; declaredKind: string }>;
    deferred: Array<{ slug: string; reason: string }>;
    scopeConflicts: Array<{
      slug: string;
      existingScope: string;
      declaredScope: string;
      existingEntityScope: string;
      declaredEntityScope: string | null;
    }>;
  };
  entityLinks: { unresolved: string[] };
  views: { wouldOrphan: string[] };
}

/** Human render of a preflight report — scannable summary + per-issue reasons. */
function renderPreflightReport(entry: CatalogEntry, r: PreflightReport): void {
  // Hard structural failure — the definition itself won't install.
  if (r.validationErrors.length > 0) {
    log.error(
      `${entry.name} — ${r.validationErrors.length} structural error${r.validationErrors.length === 1 ? "" : "s"} (won't install):`
    );
    for (const e of r.validationErrors) log.hint(e);
    return;
  }

  const p = r.profiles;
  // Every issue class, not just profile conflicts — the verdict and the printed
  // warnings must agree (`r.ok` excludes advisory deferred/scopeConflicts, so
  // "cleanly" alone could sit above a ⚠ line; count them all here).
  const issueCounts: string[] = [];
  if (p.conflicts.length) issueCounts.push(`${p.conflicts.length} profile conflict${p.conflicts.length === 1 ? "" : "s"}`);
  if (p.deferred.length) issueCounts.push(`${p.deferred.length} duplicate${p.deferred.length === 1 ? "" : "s"}`);
  if (p.scopeConflicts.length) issueCounts.push(`${p.scopeConflicts.length} scope note${p.scopeConflicts.length === 1 ? "" : "s"}`);
  if (r.entityLinks.unresolved.length) issueCounts.push(`${r.entityLinks.unresolved.length} dropped link${r.entityLinks.unresolved.length === 1 ? "" : "s"}`);
  if (r.views.wouldOrphan.length) issueCounts.push(`${r.views.wouldOrphan.length} orphaned view${r.views.wouldOrphan.length === 1 ? "" : "s"}`);
  const blocking = !r.ok; // conflicts / dropped links / orphaned views
  const hasAny = issueCounts.length > 0;

  // Verdict — never says "clean" if any warning will print below.
  if (!hasAny) log.success(`Preflight for ${entry.name}: no conflicts — safe to install.`);
  else if (blocking) log.warn(`Preflight for ${entry.name}: would install with issues — review before installing.`);
  else log.warn(`Preflight for ${entry.name}: installs, with ${issueCounts.length} advisory note${issueCounts.length === 1 ? "" : "s"} — review below.`);

  log.dim(`Profiles: ${p.create.length} to create · ${p.reused.length} reused`);
  if (hasAny) log.dim(`Issues: ${issueCounts.join(" · ")}`);

  // Warnings are the PAYLOAD of a dry-run — print them BEFORE the (potentially
  // long) create/reuse list so they never scroll off-screen.
  // The load-bearing signal for an AI author: a declared role/kind that clashes
  // with an existing pod profile is SKIPPED — never created, never mutated.
  for (const c of p.conflicts)
    log.warn(`${c.slug}: declared ${c.declaredKind}, pod has ${c.existingKind} → SKIP (not created)`);
  for (const d of p.deferred)
    log.warn(`${d.slug}: same slug exists but not promotable (${d.reason}) → a duplicate would be created`);
  for (const sc of p.scopeConflicts)
    log.warn(`${sc.slug}: declared scope ${sc.declaredScope}, pod has ${sc.existingScope} → reused as-is (declared scope not applied)`);
  for (const link of r.entityLinks.unresolved)
    log.warn(`link ${link}: an endpoint profile is a conflict → relation dropped`);
  for (const v of r.views.wouldOrphan)
    log.warn(`view "${v}": its scope profile is a conflict → view would have no scope`);

  // One actionable hint for the whole conflict/link/view class — the remedy the
  // per-line messages don't give.
  if (p.conflicts.length || r.entityLinks.unresolved.length || r.views.wouldOrphan.length)
    log.hint(
      "Conflicts are skipped, never merged — rename the template's profile to a new slug, or install as-is to reuse the pod's existing one."
    );

  for (const slug of p.create) log.dim(`+ ${slug} (new profile)`);
  for (const slug of p.reused) log.dim(`↺ ${slug} (reuses existing pod profile)`);

  if (!hasAny) log.hint("Run without --dry-run to install.");
}

// ── `synap market install <slug>` ───────────────────────────────────────────

export async function marketInstall(
  slug: string,
  opts: {
    podUrl?: string;
    apiKey?: string;
    json?: boolean;
    project?: string;
    timeout?: string;
    /** Reconcile this template ONTO an existing workspace (additive) instead of creating a new one — passed through to `/packages/apply` as `targetWorkspaceId`. */
    onto?: string;
    /** Preview the create path write-free (`/packages/preflight`) — reports would-create / reuse / conflicts and writes nothing. */
    dryRun?: boolean;
  }
): Promise<void> {
  const applyTimeoutMs = parseApplyTimeoutMs(opts.timeout);
  // `installedTemplates` (not just `cat.installed`'s slug set) is fetched here
  // too — it carries per-slug VERSION, which is what lets the stamp-
  // contradiction check below tell "genuinely unchanged" apart from "the pod
  // silently failed to stamp/reconcile a previously-unstamped install".
  const [cat, installedTemplates] = await Promise.all([buildMarketCatalog(), fetchInstalledTemplates()]);
  const entry = cat.entries.find((e) => e.slug === slug);
  if (!entry) {
    log.error(`No package "${slug}" found.`);
    log.hint("Browse what's available: synap market --list");
    process.exit(1);
  }

  const type = typeOf(entry);

  // A CAPABILITY installs through the SAME door as `cap add` — one code path, so
  // the two commands can never diverge. That door resolves the template by key
  // (so opt-in / syncByDefault:false caps like unipile-linkedin work — the
  // params-less market.install verb below cannot) AND prompts for any required
  // credential inline (a key), which a server-side verb can never do. `cap add`
  // is now a thin alias of this. `--pod` is honoured (capabilityAdd resolves the
  // active pod itself); `--json` prompts can't render, so a credentialed cap
  // still prompts — run it interactively.
  if (type === "capability") {
    await capabilityAdd(slug, {});
    return;
  }

  // Other non-workspace packages install through the pod's ONE kind-agnostic
  // door — the `market.install` verb on `/capabilities/execute`. (The WORKSPACE
  // path below uses `/packages/apply`, which provisions a workspace, and is
  // left untouched.) The verb resolves the definition from `cp_catalog_cache`
  // by (kind, slug), tier-gates, and — for the CLI's OPERATOR hub key (no
  // agentUserId) — installs directly; an agent call would file a proposal.
  if (type !== "workspace") {
    const kind = marketInstallKind(type);
    if (!kind) {
      log.warn(`"${entry.name}" is a ${type} package — the CLI can't install this type yet.`);
      log.hint("Install it from the browser marketplace (Marketplace → find it → Install).");
      return;
    }

    let cfg;
    try {
      cfg = await resolveHubConfig(opts);
    } catch (e) {
      renderHubError(e);
      process.exit(1);
    }

    const s = opts.json ? null : ora(`Installing ${entry.name}…`).start();
    let res: Record<string, unknown>;
    try {
      // Pod-wide install: no workspaceId (a capability/cell/template lands on
      // the pod). `market.install` is a WRITE builtin — an operator run
      // owner-bypasses the gate and runs it in-process.
      res = (await hubPost(
        "/capabilities/execute",
        { verbId: "market.install", parameters: { slug, kind } },
        cfg,
        applyTimeoutMs
      )) as Record<string, unknown>;
    } catch (e) {
      s?.stop();
      // 404 = this pod predates the seeded `market.install` verb (older deploy).
      if (e instanceof HubError && e.status === 404) {
        log.error(`This pod doesn't expose the market.install verb yet.`);
        log.hint("It needs a newer pod deploy — meanwhile install from the browser marketplace.");
        process.exit(1);
      }
      // The verb throws NOT_FOUND (surfaced as a 500) when the CP kind hasn't
      // synced into `cp_catalog_cache` yet — say so actionably, not opaquely.
      if (e instanceof HubError && /catalog cache/i.test(e.message)) {
        log.error(`"${entry.name}" isn't in the pod's marketplace cache yet.`);
        log.hint("The pod syncs the catalog every ~10 min — retry shortly, or install from the browser marketplace.");
        process.exit(1);
      }
      log.error(`${entry.name} failed`);
      renderHubError(e);
      process.exit(1);
    }
    s?.stop();

    // The execute door wraps the verb's return as { status:"run", result: <MarketInstallOutcome> }.
    // The outcome is { status:"installed", result } (operator) or { status:"proposed", proposalId, reviewUrl }.
    const outcome = (res.result ?? res) as Record<string, unknown>;
    const status = String(outcome.status ?? "installed");

    if (opts.json) {
      console.log(JSON.stringify({ slug, kind, outcome: status, result: outcome }, null, 2));
      return;
    }

    if (status === "proposed") {
      const proposalId = outcome.proposalId ? String(outcome.proposalId) : undefined;
      log.info(`${entry.name} — proposed (under review, not live yet).`);
      if (proposalId) log.hint(`Approve: synap proposals approve ${proposalId}`);
      return;
    }
    log.success(`Installed ${entry.name}.`);
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

  // Stamp the version the catalog resolved for this slug — including the
  // authed `/mine` version for private templates — so the pod records the
  // installed baseline and later `market update` drift checks work.
  const remoteVersion = cat.remoteVersionBySlug.get(slug);
  if (remoteVersion) pkg._meta = { ...(pkg._meta as Record<string, unknown> | undefined ?? {}), version: remoteVersion };

  // ── --dry-run: write-free preflight of the CREATE path. ───────────────────
  // Runs the pod's REAL resolver (write-free) so a template author sees
  // profileKind conflicts and other resolution failures BEFORE installing.
  // (Previews the create path only; `--onto` reconcile-preview is not modeled.)
  if (opts.dryRun) {
    const s = opts.json ? null : ora(`Checking ${entry.name}…`).start();
    try {
      const report = (await hubPost(
        "/packages/preflight",
        pkg,
        cfg,
        applyTimeoutMs
      )) as PreflightReport;
      s?.stop();
      if (opts.json) {
        console.log(JSON.stringify({ slug, ...report }, null, 2));
        return;
      }
      renderPreflightReport(entry, report);
      return;
    } catch (e) {
      s?.stop();
      log.error(`${entry.name} preflight failed`);
      renderHubError(e);
      process.exit(1);
    }
  }

  // Pre-apply state — was this slug already installed with NO version stamp?
  // Feeds `classifyApplyResult`'s stamp-contradiction check below.
  const preInstalled = installedTemplates.find((t) => t.slug === slug);
  const wasUnstamped = !!preInstalled && !preInstalled.version;

  const s = opts.json ? null : ora(`Installing ${entry.name}…`).start();
  try {
    // projectId links the workspace's seed entities to the project
    // (belongs_to_project) — exactly what `launch` does. Undefined = pod-wide.
    // targetWorkspaceId (--onto) reconciles the template ADDITIVELY onto an
    // existing workspace instead of creating a new one.
    const res = (await hubPost(
      "/packages/apply",
      { ...pkg, projectId, targetWorkspaceId: opts.onto },
      cfg,
      applyTimeoutMs
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
      if (proposalId) log.hint(`Approve: synap proposals approve ${proposalId}`);
      renderNextSteps(steps);
      return;
    }

    const ws = res.workspace as WorkspaceApplyResult | undefined;
    const dependencies = res.dependencies as ResolvedDependencyLike[] | undefined;
    const seedSummary = res.seedSummary as SeedSummary | undefined;
    const steps = FLOW.afterMarketInstall({ slug, proposed: false, projectName });
    s?.stop();
    const verdict = classifyApplyResult(entry, ws, dependencies, seedSummary, {
      remoteVersionSent: remoteVersion,
      wasUnstamped,
    });
    if (opts.json) {
      console.log(
        JSON.stringify(
          {
            slug,
            outcome: ws?.outcome ?? ws?.status ?? "unknown",
            status: verdict.status,
            warnings: verdict.warnings,
            workspace: ws,
            dependencies,
            seedSummary,
            projectId,
            onto: opts.onto,
            nextSteps: steps,
          },
          null,
          2
        )
      );
      return;
    }
    // `--onto` reconciles onto an EXISTING workspace — the honest verdict
    // reads "reconciled onto <workspace>", not the create-flavored default
    // text `printApplyVerdict` would otherwise print for the same outcomes.
    if (opts.onto) {
      const wsLabel = ws?.workspaceId ? chalk.bold(ws.workspaceId) : chalk.bold(opts.onto);
      switch (verdict.status) {
        case "installed":
        case "updated":
          log.success(`Reconciled ${entry.name} onto ${wsLabel}.`);
          break;
        case "installed-with-failures":
        case "updated-with-failures":
          log.warn(`Reconciled ${entry.name} onto ${wsLabel} — completed with capability failures (see below).`);
          break;
        case "unchanged":
          log.info(`• ${entry.name} is already up to date on ${wsLabel}.`);
          break;
        default:
          printApplyVerdict(entry, verdict);
      }
    } else {
      printApplyVerdict(entry, verdict);
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

export interface UpdateCheck extends TemplateUpdateCheck {
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
export function computeUpdates(installedTemplates: InstalledTemplateInfo[], cat: MarketCatalog): UpdateCheck[] {
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
  opts: { json?: boolean },
  applyTimeoutMs: number = APPLY_TIMEOUT_MS
): Promise<{
  slug: string;
  outcome: string;
  /** Honest coarse status from `classifyApplyResult` — see its doc. Early-return branches (locked/fetch-failed/proposed/failed/timed-out) reuse `outcome` as `status` verbatim. */
  status: string;
  warnings: string[];
  error?: string;
  dependencies?: ResolvedDependencyLike[];
  seedSummary?: SeedSummary;
}> {
  if (cat.lockedSlugs.has(entry.slug)) {
    const tier = cat.tierBySlug.get(entry.slug)?.requiredTier;
    if (!opts.json)
      log.warn(`"${entry.name}" requires the ${tier ?? "a higher"} tier — skipping.`);
    return { slug: entry.slug, outcome: "locked", status: "locked", warnings: [] };
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
      return { slug: entry.slug, outcome: "fetch-failed", status: "fetch-failed", warnings: [] };
    }
    pkg = def;
  }

  // Same version stamp as `marketInstall` — needed for private templates too,
  // since `applyOnePackage` re-runs the apply door on every update.
  const remoteVersion = cat.remoteVersionBySlug.get(entry.slug);
  if (remoteVersion) pkg._meta = { ...(pkg._meta as Record<string, unknown> | undefined ?? {}), version: remoteVersion };

  const s = opts.json ? null : ora(`Updating ${entry.name}…`).start();
  try {
    const res = (await hubPost("/packages/apply", pkg, cfg, applyTimeoutMs)) as Record<string, unknown>;
    s?.stop();

    if (writeGovernance(res) === "proposed") {
      const proposalId = res.proposalId ? String(res.proposalId) : undefined;
      if (!opts.json) {
        log.info(`${entry.name} — update proposed (under review, not live yet).`);
        if (proposalId) log.hint(`Approve: synap proposals approve ${proposalId}`);
      }
      return { slug: entry.slug, outcome: "proposed", status: "proposed", warnings: [] };
    }

    const ws = res.workspace as WorkspaceApplyResult | undefined;
    const dependencies = res.dependencies as ResolvedDependencyLike[] | undefined;
    const seedSummary = res.seedSummary as SeedSummary | undefined;
    // `wasUnstamped: false` — `applyOnePackage` is only ever reached (from
    // `marketUpdate`) for a slug that already had `updateAvailable: true`,
    // which by construction means it already carried a recorded version. The
    // stamp-contradiction check is therefore a no-op here by design; it's
    // `marketInstall`'s job to catch it on a first-time/unstamped install.
    const verdict = classifyApplyResult(entry, ws, dependencies, seedSummary, {
      remoteVersionSent: remoteVersion,
      wasUnstamped: false,
    });
    if (!opts.json) {
      printApplyVerdict(entry, verdict);
      printSeedOutcomes(dependencies, seedSummary);
    }
    return {
      slug: entry.slug,
      outcome: ws?.outcome ?? ws?.status ?? "unknown",
      status: verdict.status,
      warnings: verdict.warnings,
      dependencies,
      seedSummary,
    };
  } catch (e) {
    s?.stop();
    const timedOut = e instanceof HubNetworkError && e.code === "TIMEOUT";
    if (!opts.json) {
      log.error(`${entry.name} update failed`);
      renderHubError(e);
    }
    return {
      slug: entry.slug,
      outcome: timedOut ? "timed-out" : "failed",
      status: timedOut ? "timed-out" : "failed",
      warnings: [],
      error: e instanceof Error ? e.message : String(e),
    };
  }
}

export async function marketUpdate(
  slugsArg: string[] | undefined,
  opts: {
    yes?: boolean;
    dryRun?: boolean;
    json?: boolean;
    podUrl?: string;
    apiKey?: string;
    timeout?: string;
  }
): Promise<void> {
  const applyTimeoutMs = parseApplyTimeoutMs(opts.timeout);
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
  const entryBySlug = new Map(cat.entries.map((e) => [e.slug, e]));
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
        ? noVersionLabel(entryBySlug.get(c.slug)?.isPrivate ?? false, cat.loggedIn)
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
    // "Nothing to update" is only honest when every installed row was
    // actually CHECKED. Rows the pod can't version-check are "couldn't be
    // checked", not silently folded into a clean ✓ — see rule #2 in this
    // file's header.
    if (opts.json) {
      console.log(
        JSON.stringify(
          {
            checks,
            loggedIn: cat.loggedIn,
            unknownSlugs,
            applied: [],
            status: noVersionInfo.length > 0 ? "partial" : "clean",
            uncheckable: noVersionInfo.map((c) => c.slug),
          },
          null,
          2
        )
      );
    } else if (noVersionInfo.length > 0) {
      const upToDate = checks.length - noVersionInfo.length;
      console.log(
        "  " +
          chalk.yellow(
            `⚠ ${upToDate} up to date · ${noVersionInfo.length} couldn't be checked`
          )
      );
      log.hint(
        "Run 'synap market installed' for why — unstamped install (reinstall to fix) or a private template while logged out (synap login)."
      );
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
    status: string;
    warnings: string[];
    error?: string;
    dependencies?: ResolvedDependencyLike[];
    seedSummary?: SeedSummary;
  }> = [];
  for (const c of withUpdates) {
    const entry = cat.entries.find((e) => e.slug === c.slug);
    if (!entry) {
      if (!opts.json) log.warn(`"${c.slug}" is no longer in the catalog — skipping.`);
      results.push({ slug: c.slug, outcome: "not-in-catalog", status: "not-in-catalog", warnings: [] });
      continue;
    }
    results.push(await applyOnePackage(entry, cat, cfg, { json: opts.json }, applyTimeoutMs));
  }

  const summary = summarizeApplyResults(results);
  const steps = FLOW.afterMarketUpdateApply();
  if (opts.json) {
    console.log(
      JSON.stringify(
        { checks, loggedIn: cat.loggedIn, unknownSlugs, applied: results, summary, nextSteps: steps },
        null,
        2
      )
    );
    return;
  }
  log.blank();
  console.log("  " + summary.line);
  renderNextSteps(steps);
}

/**
 * One-line rollup over a batch of `applyOnePackage` outcomes — computed from
 * the SAME per-item `status` (`classifyApplyResult`'s honest verdict) the
 * loop already collects, not a separate tally. `"installed"`/`"updated"`/
 * `"composed"`/`"legacy-unknown"` count as a clean update, `"unchanged"` as
 * already-current, the `*-with-failures` and `"stamp-contradiction"` statuses
 * get their OWN bucket — a partial capability-seed failure or a stamp that
 * silently didn't take is never folded into a clean "updated" count.
 * `"timed-out"` is broken out from the generic `"failed"` bucket; everything
 * else (locked/proposed/fetch-failed/not-in-catalog/no-workspace/unknown)
 * rolls into "failed".
 */
function summarizeApplyResults(
  results: Array<{ slug: string; status: string }>
): { updated: number; unchanged: number; withFailures: number; failed: number; timedOut: number; line: string } {
  let updated = 0;
  let unchanged = 0;
  let withFailures = 0;
  let timedOut = 0;
  let failed = 0;
  for (const r of results) {
    switch (r.status) {
      case "installed":
      case "updated":
      case "composed":
      case "legacy-unknown":
        updated++;
        break;
      case "unchanged":
        unchanged++;
        break;
      case "installed-with-failures":
      case "updated-with-failures":
      case "composed-with-failures":
      case "stamp-contradiction":
        withFailures++;
        break;
      case "timed-out":
        timedOut++;
        break;
      default:
        failed++;
    }
  }
  const parts = [`${updated} updated`, `${unchanged} already current`];
  if (withFailures > 0) parts.push(`${withFailures} completed with failures`);
  if (failed > 0) parts.push(`${failed} failed`);
  if (timedOut > 0) parts.push(`${timedOut} timed out`);
  const clean = withFailures === 0 && failed === 0 && timedOut === 0;
  const color = clean ? chalk.green : chalk.yellow;
  return {
    updated,
    unchanged,
    withFailures,
    failed,
    timedOut,
    line: color(`${clean ? "✓" : "⚠"} ${parts.join(" · ")}`),
  };
}

// ── `synap market installed [--json] [--outdated]` — pure-read inventory ────

/** `"h-<hash>"` → `"h-<first 6 hash chars>"`. Semver strings pass through. */
function truncateVersion(v: string): string {
  return isHashVersion(v) ? `h-${v.slice(2, 8)}` : v;
}

/**
 * Honest `noVersionInfo` label — a PRIVATE template that's blind to updates
 * because the caller is logged out is a different (recoverable) situation
 * than a genuinely unstampable install: "reinstall" is the wrong fix when
 * the real fix is `synap login`.
 */
function noVersionLabel(isPrivate: boolean, loggedIn: boolean): string {
  return isPrivate && !loggedIn
    ? chalk.dim("connect to the Control Plane to check/update — run: synap login")
    : chalk.dim("version unknown — reinstall to enable update checks");
}

/**
 * Human status cell for one installed row — distinguishes hash drift (no
 * ordering, just "changed") from semver drift ("update available").
 */
function installedStatusLabel(c: UpdateCheck, isPrivate: boolean, loggedIn: boolean): string {
  if (c.noVersionInfo) return noVersionLabel(isPrivate, loggedIn);
  if (!c.updateAvailable) return chalk.green("up to date");
  const installed = truncateVersion(c.installedVersion);
  const latest = c.latestVersion ? truncateVersion(c.latestVersion) : "?";
  const hashPair = isHashVersion(c.installedVersion) || isHashVersion(c.latestVersion ?? "");
  const label = hashPair ? "content changed" : "update available";
  return chalk.yellow(`${label}  `) + chalk.dim(installed) + " → " + latest;
}

// ── Composition engine — the ONE traversal door ─────────────────────────────
//
// Both `--tree` (nested view) and `--layers` (flat DAG view) are RENDERERS
// over the shared `layerTemplateGraph` engine (`@synap-core/workspace-
// templates`) — neither hand-walks `dependencies[]` itself anymore. The old
// bespoke walker (`collectDescendantSlugs`/`buildDependencyNode`) rebuilt a
// fresh node for every OCCURRENCE of a shared slug (`foundation` printed once
// per branch that reached it) and was blind to a remote/private CP-only
// package's `dependencies[]` (only bundled templates were ever consulted, so
// such a package's subtree silently rendered empty — a live bug). The engine
// fixes both: one node per slug at its longest-path layer, edges converging
// on it, via an INJECTED `edgesOf` (see `buildEdgesOf` below) that falls back
// to a remote catalog entry's fetched `definition.dependencies` when the slug
// isn't in the bundle.

/**
 * Synchronous `edgesOf` for `layerTemplateGraph`, backed by an async prefetch
 * BFS: bundled slugs resolve instantly via `bundledEdgesOf`; any slug NOT
 * bundled (a remote/private CP-only package) has its full definition fetched
 * via `fetchPackageDefinition` and its `.dependencies` cached. `seeds` is the
 * set of slugs to start the BFS from — pass every installed slug so the
 * resulting closure covers everything either renderer might touch.
 */
async function buildEdgesOf(
  seeds: string[],
  cat: MarketCatalog,
  cpToken: string | undefined
): Promise<(slug: string) => readonly TemplateDependency[]> {
  const cache = new Map<string, readonly TemplateDependency[]>();
  const visited = new Set<string>();
  let frontier = [...new Set(seeds)];
  while (frontier.length > 0) {
    const nextFrontier = new Set<string>();
    await Promise.all(
      frontier.map(async (slug) => {
        if (visited.has(slug)) return;
        visited.add(slug);
        let deps: readonly TemplateDependency[];
        if (cat.bundledSlugs.has(slug)) {
          deps = bundledEdgesOf(slug);
        } else {
          try {
            const def = await fetchPackageDefinition(slug, cpToken);
            deps = (def?.dependencies as TemplateDependency[] | undefined) ?? [];
          } catch {
            deps = [];
          }
        }
        cache.set(slug, deps);
        for (const d of deps) nextFrontier.add(d.slug);
      })
    );
    frontier = [...nextFrontier].filter((s) => !visited.has(s));
  }
  // Fallback covers a slug the BFS never seeded (shouldn't happen — every
  // `edgesOf` call the engine makes is reachable from `seeds`) — cheap and
  // safe either way since it's the same bundled-only lookup as the default.
  return (slug: string) => cache.get(slug) ?? bundledEdgesOf(slug);
}

/** `CompositionInstalledEntry[]` from the Hub's installed-templates rows — the shape both `--tree` and `--layers` feed the engine. */
function toInstalledEntries(installedTemplates: InstalledTemplateInfo[]): CompositionInstalledEntry[] {
  return installedTemplates.map((t) => ({
    slug: t.slug,
    workspaceId: t.workspaceId,
    workspaceName: t.workspaceName,
    version: t.version,
  }));
}

// ── `synap market installed --tree` — nested composition view ──────────────

export interface TreeNode {
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

export interface TreePackage {
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
 * The nested composition-tree view: one tree per installed TOP-LEVEL package
 * (a suite, or any installed package whose `edgesOf` resolves at least one
 * dependency — bundled OR remote). Everything else stays a flat leaf
 * (`leafRows`, rendered like a plain `market installed` row). This is the
 * SAME "top-level" rule the old walker used (kept verbatim for `--tree`'s
 * JSON/text backward compatibility — see `marketInstalled`'s before/after
 * diff check), just evaluated against the fixed `edgesOf` instead of the
 * bundled-only map.
 *
 * Nested `TreeNode`s are built by walking `graph.edges` (both `require` and
 * `compose` relations — the engine excludes compose SOURCES from `nodes`,
 * rule 2, but never from `edges`, so the nested view still shows them exactly
 * where the old walker did) and `shared` reads straight off each node's
 * `roots` (the engine's true reachability set), replacing the old walker's
 * bespoke reverse index.
 */
export async function buildCompositionTrees(
  rows: UpdateCheck[],
  cat: MarketCatalog,
  installedTemplates: InstalledTemplateInfo[],
  workspaceCountBySlug: Map<string, number>
): Promise<{ packages: TreePackage[]; leafRows: UpdateCheck[] }> {
  const entryBySlug = new Map(cat.entries.map((e) => [e.slug, e]));
  const installedBySlug = new Map(installedTemplates.map((t) => [t.slug, t]));
  const checksBySlug = new Map(rows.map((c) => [c.slug, c]));
  const cpToken = getStoredToken()?.token;

  const installedSlugs = [...new Set(installedTemplates.map((t) => t.slug))];
  const edgesOf = await buildEdgesOf(installedSlugs, cat, cpToken);

  const topLevel = rows.filter((c) => {
    const entry = entryBySlug.get(c.slug);
    return (entry && isSuite(entry)) || edgesOf(c.slug).length > 0;
  });
  const topLevelSlugs = new Set(topLevel.map((c) => c.slug));
  const leafRows = rows.filter((c) => !topLevelSlugs.has(c.slug));

  const graph = layerTemplateGraph({
    roots: [...topLevelSlugs],
    edgesOf,
    nameOf: (slug) => entryBySlug.get(slug)?.name,
    installed: toInstalledEntries(installedTemplates),
    updates: rows,
  });

  function buildTreeNode(edge: CompositionEdge, currentTopLevelSlug: string, ancestors: Set<string>): TreeNode {
    const slug = edge.to;
    const entry = entryBySlug.get(slug);
    const installedInfo = installedBySlug.get(slug);
    const node = graph.nodes.get(slug);
    // Exclude BOTH the walking root (matches the old walker's exclusion) AND
    // the node's own slug (a top-level package that's ALSO separately
    // installed reaches itself trivially in `node.roots` — rule 4 of Phase 4
    // — which the old bespoke `collectDescendantSlugs` never surfaced since
    // it only ever recorded genuine descendants, never a self-loop).
    const shared = (node?.roots ?? [])
      .filter((r) => r !== currentTopLevelSlug && r !== slug)
      .map((r) => entryBySlug.get(r)?.name ?? r);

    const children: TreeNode[] = [];
    if (!ancestors.has(slug)) {
      const nextAncestors = new Set(ancestors);
      nextAncestors.add(slug);
      for (const childEdge of graph.edges.filter((e) => e.from === slug)) {
        children.push(buildTreeNode(childEdge, currentTopLevelSlug, nextAncestors));
      }
    }

    const check = checksBySlug.get(slug);
    return {
      slug,
      name: entry?.name ?? slug,
      relation: edge.relation,
      depKind: edge.depKind,
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

  const packages: TreePackage[] = topLevel.map((c) => {
    const entry = entryBySlug.get(c.slug);
    const children = graph.edges
      .filter((e) => e.from === c.slug)
      .map((edge) => buildTreeNode(edge, c.slug, new Set([c.slug])));
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

export function printCompositionTree(pkg: TreePackage): void {
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

// ── `synap market installed --layers` — flat DAG view ──────────────────────
//
// `--tree` nests (and, by design, reprints a shared base once per branch that
// reaches it — see `TreeNode.shared`). `--layers` is the OTHER read of the
// SAME engine: each installed/dependency slug appears EXACTLY ONCE, sunk to
// its longest-path layer (roots at the top, bedrock at the bottom), with true
// fan-in (`← N packages`) instead of a per-branch "shared" tag.

/**
 * Full graph over every currently-installed package — the ROOTS are every
 * "top-level" installed slug (a suite, or one with its own resolved
 * dependencies — same rule `buildCompositionTrees` uses) PLUS any installed
 * slug left unreached by that walk (a standalone leaf with no dependents/
 * dependencies of its own). The second half matters here specifically:
 * `layerTemplateGraph` only ever surfaces nodes reachable from `roots` (its
 * contract — "roots always land at layer 0"), so a genuinely standalone
 * package would otherwise silently vanish from `--layers` instead of showing
 * up as its own one-node layer-0 entry.
 */
async function buildInstallationGraph(
  installedTemplates: InstalledTemplateInfo[],
  cat: MarketCatalog,
  checks: UpdateCheck[]
): Promise<CompositionGraph> {
  const cpToken = getStoredToken()?.token;
  const entryBySlug = new Map(cat.entries.map((e) => [e.slug, e]));
  const installedSlugs = [...new Set(installedTemplates.map((t) => t.slug))];
  const edgesOf = await buildEdgesOf(installedSlugs, cat, cpToken);

  const primary = installedSlugs.filter((slug) => {
    const entry = entryBySlug.get(slug);
    return (entry && isSuite(entry)) || edgesOf(slug).length > 0;
  });

  const reached = new Set<string>(primary);
  let frontier = [...primary];
  while (frontier.length > 0) {
    const next: string[] = [];
    for (const s of frontier) {
      for (const dep of edgesOf(s)) {
        if (!reached.has(dep.slug)) {
          reached.add(dep.slug);
          next.push(dep.slug);
        }
      }
    }
    frontier = next;
  }
  const leftover = installedSlugs.filter((s) => !reached.has(s));
  const roots = [...new Set([...primary, ...leftover])];

  return layerTemplateGraph({
    roots,
    edgesOf,
    nameOf: (slug) => entryBySlug.get(slug)?.name,
    installed: toInstalledEntries(installedTemplates),
    updates: checks,
  });
}

/** Status cell for one `--layers` row — same vocabulary as `installedStatusLabel`, adapted to a `CompositionNode` (which, unlike `UpdateCheck`, can be a ghost — not installed at all). */
function layerNodeStatus(node: CompositionNode, isPrivate: boolean, loggedIn: boolean): string {
  if (!node.installed) return chalk.dim("not installed");
  if (node.noVersionInfo) return noVersionLabel(isPrivate, loggedIn);
  if (!node.updateAvailable) return chalk.green("up to date");
  const installed = node.installedVersion ? truncateVersion(node.installedVersion) : "?";
  const latest = node.latestVersion ? truncateVersion(node.latestVersion) : "?";
  return chalk.yellow("update available  ") + chalk.dim(installed) + " → " + latest;
}

/**
 * Render the layered DAG bottom-up: bedrock (the highest layer index, most
 * depended-on) FIRST, roots (layer 0) LAST — the base of the pyramid printed
 * first felt like the clearer reading order for "what everything rests on".
 */
function printLayersGraph(graph: CompositionGraph, cat: MarketCatalog): void {
  const entryBySlug = new Map(cat.entries.map((e) => [e.slug, e]));
  log.heading("  Installed packages — composition layers (bedrock first, bottom-up)");
  log.blank();

  // Column widths computed ONCE over every node in the graph (not per layer
  // bucket) — otherwise name/slug columns re-align at each layer boundary
  // and read as ragged.
  const allNodes = [...graph.nodes.values()];
  const nameW = Math.max(4, ...allNodes.map((n) => n.name.length)) + 2;
  const slugW = Math.max(4, ...allNodes.map((n) => n.slug.length)) + 2;

  for (let i = graph.layers.length - 1; i >= 0; i--) {
    const bucket = graph.layers[i];
    if (!bucket || bucket.length === 0) continue;
    // Bedrock/Roots already say what they need to; a bare "Layer N" in
    // between doesn't need "— layer N" repeated after it.
    const label =
      i === graph.layers.length - 1 ? "Bedrock" : i === 0 ? "Roots" : `Layer ${i}`;
    console.log("    " + chalk.dim(label));
    for (const node of bucket) {
      const entry = entryBySlug.get(node.slug);
      const dim = !node.installed;
      const fanIn =
        node.dependents.length > 0
          ? "  " + chalk.magenta(`used by ${node.dependents.length} package${node.dependents.length === 1 ? "" : "s"}`)
          : "";
      const overlays =
        node.overlays.length > 0
          ? "  " + node.overlays.map((o) => chalk.cyan(`+ ${o.name} (overlay)`)).join(" ")
          : "";
      const priv = entry?.isPrivate ? "  " + chalk.yellow("private") : "";
      const name = dim ? chalk.dim(node.name.padEnd(nameW)) : chalk.bold(node.name.padEnd(nameW));
      const slug = dim ? chalk.dim(node.slug.padEnd(slugW)) : chalk.cyan(node.slug.padEnd(slugW));
      console.log(
        "      " +
          name +
          slug +
          layerNodeStatus(node, entry?.isPrivate ?? false, cat.loggedIn) +
          fanIn +
          overlays +
          priv
      );
    }
    log.blank();
  }

  if (graph.cycles.length > 0) {
    log.warn(
      `${graph.cycles.length} dependency cycle${graph.cycles.length === 1 ? "" : "s"} detected — surfaced, not hidden:`
    );
    for (const [from, to] of graph.cycles) log.hint(`${from} → ${to}  (broken here to avoid an infinite loop)`);
    log.blank();
  }
}

/**
 * Pure-read inventory of what's installed on this pod — reuses
 * `buildMarketCatalog` + `fetchInstalledTemplates` + `computeUpdates`
 * (`market update`'s own drift check), never writes anything. Pairs with
 * `market update` to apply what this surfaces.
 */
export async function marketInstalled(opts: {
  json?: boolean;
  outdated?: boolean;
  tree?: boolean;
  layers?: boolean;
}): Promise<void> {
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

  if (opts.layers) {
    const graph = await buildInstallationGraph(installedTemplates, cat, checks);
    const steps = FLOW.afterMarketInstalledCheck(rows.filter((c) => c.updateAvailable).map((c) => c.slug));

    if (opts.json) {
      console.log(
        JSON.stringify(
          {
            nodes: [...graph.nodes.values()],
            edges: graph.edges,
            layers: graph.layers.map((bucket) => bucket.map((n) => n.slug)),
            cycles: graph.cycles,
            loggedIn: cat.loggedIn,
            nextSteps: steps,
          },
          null,
          2
        )
      );
      return;
    }

    if (graph.nodes.size === 0) {
      log.success("Nothing installed.");
      return;
    }

    printLayersGraph(graph, cat);
    if (!cat.loggedIn) log.dim("Not logged in — private template updates aren't visible. Run: synap login");
    renderNextSteps(steps);
    return;
  }

  if (opts.tree) {
    const { packages, leafRows } = await buildCompositionTrees(rows, cat, installedTemplates, workspaceCountBySlug);
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
            installedStatusLabel(c, entry?.isPrivate ?? false, cat.loggedIn) +
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
        installedStatusLabel(c, entry?.isPrivate ?? false, cat.loggedIn) +
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
