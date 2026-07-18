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
 * Discovery is TWO-SOURCE, merged through the ONE `mergeCatalog` door:
 *   • PUBLIC templates ship BUNDLED in @synap-core/workspace-templates — always
 *     present, zero network, offline.
 *   • PRIVATE templates live in the control plane behind the user's login and are
 *     fetched from `GET /api/packages/mine` (Bearer). Logged out or CP-unreachable
 *     degrades HONESTLY to bundled-only + a "private needs login" note — it never
 *     fails open empty.
 * The bundle still carries the private YAMLs today, so a private template that
 * arrives as a remote entry is installed from the identical, offline bundled
 * definition; once a later wave drops those YAMLs it is installed from the CP.
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
  listPublicTemplates,
  listWorkspaceTemplates,
  mergeCatalog,
  toPackageDefinition,
  type WorkspaceYaml,
  type CatalogEntry,
  type MergeCatalogResult,
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
import { getStoredToken } from "../lib/auth.js";
import {
  fetchRemoteCatalog,
  fetchPackageDefinition,
  type RemoteCatalog,
  type PackageFilters,
} from "../lib/cp-packages.js";
import { fetchInstalledSlugs } from "../lib/installed.js";
import { isSuite } from "../lib/suite.js";
import { bundledTemplatesVersion } from "../lib/bundle-version.js";

// Provisioning a template writes profiles, properties, views, bento layouts and
// seed entities in one call — `life-os` alone carries 21 profiles and 25 views.
// The 15s CRUD default turns a legitimately-slow apply into a phantom failure,
// so this door opts into the longer budget (same precedent as `cap run`).
const APPLY_TIMEOUT_MS = 120_000;

// ── Template catalog (bundled public + CP private, merged) ───────────────────

/**
 * The merged, deduped catalog + the pieces the flow needs afterward:
 *  - `entries`  — merged picker list (bundled public ∪ CP private-if-logged-in).
 *  - `entryMap` — the same, by slug, for O(1) name/lookup.
 *  - `remote`   — the CP source's health (drives honest messaging).
 *  - `yaml`     — EVERY bundled template incl. private (21), by slug. This is the
 *    dependency graph the apply resolver mirrors AND the offline install payload;
 *    a merged entry whose slug is here installs from the bundle, offline.
 */
interface Catalog {
  entries: CatalogEntry[];
  entryMap: Map<string, CatalogEntry>;
  sources: MergeCatalogResult["sources"];
  remote: RemoteCatalog;
  yaml: Map<string, WorkspaceYaml>;
  /** Package slugs already provisioned on the active pod (B3). Empty if unreachable. */
  installed: Set<string>;
}

async function buildCatalog(filters?: PackageFilters): Promise<Catalog> {
  // Installed-awareness is best-effort and runs alongside the CP fetch: a pod
  // that is unconfigured/unreachable degrades to an empty set (no markers),
  // never a failure — discovery works offline.
  const [remote, installed] = await Promise.all([
    fetchRemoteCatalog(filters),
    fetchInstalledSlugs(),
  ]);
  const merged = mergeCatalog({
    // PUBLIC = bundle; PRIVATE = CP. Passing the public-only list (18) is what
    // makes this survive a later wave that drops the private YAMLs: they simply
    // arrive as remote entries instead of vanishing.
    bundled: listPublicTemplates(),
    remote: remote.rows,
    remoteStatus: remote.status,
    bundleVersion: bundledTemplatesVersion(),
  });
  return {
    entries: merged.entries,
    entryMap: new Map(merged.entries.map((e) => [e.slug, e])),
    sources: merged.sources,
    remote,
    yaml: new Map(listWorkspaceTemplates().map((t) => [t.meta.slug, t])),
    installed,
  };
}

/** Is this entry already installed on the active pod? (B3) */
function isInstalled(slug: string, cat: Catalog): boolean {
  return cat.installed.has(slug);
}

/**
 * Client-side filter for the merged catalog. The CP browse route already applies
 * `search`/`category` to REMOTE rows; bundled entries (all `workspace` category)
 * need the same filter applied here so `--list --type`/`--search` behaves
 * uniformly across both sources.
 */
function matchesFilters(entry: CatalogEntry, filters?: PackageFilters): boolean {
  if (!filters) return true;
  if (filters.category && (entry.category ?? "workspace") !== filters.category) return false;
  if (filters.search) {
    const q = filters.search.toLowerCase();
    const hay = `${entry.slug} ${entry.name} ${entry.description ?? ""}`.toLowerCase();
    if (!hay.includes(q)) return false;
  }
  return true;
}

/** The `compose` dependency, if any — the base this template LAYERS onto. */
function composeBase(y: WorkspaceYaml): string | undefined {
  return y.dependencies?.find((d) => d.relation === "compose")?.slug;
}

/**
 * An overlay adds no workspace of its own — it layers onto its base. Only the
 * bundled YAML declares this; a remote-only entry has no local graph, so it is
 * treated as a plain workspace (the apply resolver figures out the rest).
 */
function isOverlay(slug: string, cat: Catalog): boolean {
  const y = cat.yaml.get(slug);
  return y ? composeBase(y) !== undefined : false;
}

function isPrivate(entry: CatalogEntry): boolean {
  return entry.isPrivate;
}

function displayName(slug: string, cat: Catalog): string {
  return cat.entryMap.get(slug)?.name ?? cat.yaml.get(slug)?.meta.name ?? slug;
}

/**
 * Transitive closure of every template a selection drags in, excluding the
 * selection itself. Walks BOTH `compose` and `require` edges, because the apply
 * resolver installs the whole graph — e.g. `blockchain-ecosystem` composes onto
 * `ecosystem`, which in turn requires `foundation`. Only bundled YAML carries
 * dependency edges; remote-only entries contribute none (server resolves them).
 */
function resolveExtras(selected: string[], cat: Catalog): string[] {
  const seen = new Set<string>();
  const walk = (slug: string) => {
    for (const dep of cat.yaml.get(slug)?.dependencies ?? []) {
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
function consequence(slug: string, cat: Catalog): string {
  const y = cat.yaml.get(slug);
  if (!y) return "";
  const parts: string[] = [];
  const base = composeBase(y);
  if (base) parts.push(`layers onto ${displayName(base, cat)}`);
  const extras = resolveExtras([slug], cat).filter((s) => s !== base);
  if (extras.length > 0)
    parts.push(`also sets up: ${extras.map((s) => displayName(s, cat)).join(", ")}`);
  return parts.join(" · ");
}

/** Terse "what you get" line. Derived from the bundled YAML when we have it. */
function contents(entry: CatalogEntry, cat: Catalog): string {
  const y = cat.yaml.get(entry.slug);
  if (!y) return "workspace template"; // remote-only — counts unknown until install
  const p = y.profiles?.length ?? 0;
  const v = y.views?.length ?? 0;
  return `${p} profile${p === 1 ? "" : "s"} · ${v} view${v === 1 ? "" : "s"}`;
}

function clip(s: string, n: number): string {
  return s.length <= n ? s : s.slice(0, n - 1).trimEnd() + "…";
}

/**
 * Suggest domains from a free-text company description. Matches the user's words
 * against each merged entry's `tags` — no hardcoded keyword catalog, so new
 * templates (bundled OR private) become suggestable the moment they declare tags.
 */
function inferDomains(description: string, cat: Catalog): string[] {
  const text = description.toLowerCase();
  const matched: string[] = [];
  for (const entry of cat.entries) {
    const tags = (entry.tags ?? []).filter((k) => k.length >= 3);
    const hit = tags.some((k) =>
      new RegExp(`\\b${k.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`).test(text)
    );
    if (hit) matched.push(entry.slug);
  }
  // Always land on something sensible rather than an empty picker.
  return matched.length > 0 ? matched : ["project-management"];
}

/**
 * The ONE honest line about the remote (private) source's health — the reason
 * the merge door returns `sources`. `null` when everything resolved cleanly and
 * there is nothing to disclose. NEVER silence a degradation (the fails-open-empty
 * trap where an agent sees an empty catalog and thinks the pod is empty).
 */
function remoteNote(remote: RemoteCatalog): string | null {
  switch (remote.status) {
    case "ok":
      return remote.privateCount > 0
        ? `${remote.privateCount} private template${remote.privateCount === 1 ? "" : "s"} from your account${remote.email ? ` (${remote.email})` : ""}.`
        : null;
    case "unauthenticated":
      return remote.loggedIn
        ? "Your session expired — run 'synap login' to see your private templates."
        : "Private templates are available after 'synap login'.";
    case "unreachable":
      return "Couldn't reach the control plane — showing bundled templates only. Your private templates need it.";
  }
}

/**
 * Status badges for an entry — data-driven, no hardcoded slugs. `suite` from the
 * tag (`isSuite`); `installed` from the pod (B3); `requiredTier`/price and
 * `locked` from the CP browse row (B4).
 */
function entryBadges(entry: CatalogEntry, cat: Catalog): string[] {
  const badges: string[] = [];
  if (isSuite(entry)) badges.push(chalk.magenta("suite"));
  if (isPrivate(entry)) badges.push(chalk.yellow("private"));
  if (isInstalled(entry.slug, cat)) badges.push(chalk.green("installed"));
  const tier = cat.remote.tierBySlug.get(entry.slug);
  if (tier?.requiredTier) badges.push(chalk.cyan(tier.requiredTier));
  else if (tier?.pricingModel && tier.pricingModel !== "free")
    badges.push(chalk.cyan(tier.pricingModel));
  if (cat.remote.lockedSlugs.has(entry.slug)) badges.push(chalk.red("locked"));
  return badges;
}

// ── `synap launch --list` — what CAN be launched, without committing ─────────

export async function launchList(opts: {
  json?: boolean;
  search?: string;
  type?: string;
}): Promise<void> {
  const filters: PackageFilters | undefined =
    opts.search || opts.type ? { search: opts.search, category: opts.type } : undefined;
  const cat = await buildCatalog(filters);
  const { remote } = cat;
  const entries = cat.entries.filter((e) => matchesFilters(e, filters));

  if (opts.json) {
    console.log(
      JSON.stringify(
        {
          entries: entries.map((e) => {
            const y = cat.yaml.get(e.slug);
            const tier = remote.tierBySlug.get(e.slug);
            return {
              slug: e.slug,
              name: e.name,
              description: e.description,
              tags: e.tags,
              isPrivate: e.isPrivate,
              suite: isSuite(e),
              installed: isInstalled(e.slug, cat),
              requiredTier: tier?.requiredTier ?? null,
              pricingModel: tier?.pricingModel ?? null,
              locked: remote.lockedSlugs.has(e.slug),
              source: e.source,
              kind: isOverlay(e.slug, cat) ? "overlay" : "workspace",
              profiles: y?.profiles?.length ?? null,
              views: y?.views?.length ?? null,
              dependencies: y?.dependencies ?? [],
            };
          }),
          sources: cat.sources,
          remote: {
            status: remote.status,
            loggedIn: remote.loggedIn,
            privateCount: remote.privateCount,
          },
        },
        null,
        2
      )
    );
    return;
  }

  const render = (entry: CatalogEntry) => {
    const badges = entryBadges(entry, cat);
    console.log(
      "    " +
        chalk.cyan(entry.slug.padEnd(22)) +
        chalk.bold(entry.name) +
        (badges.length ? "  " + badges.join(" ") : "")
    );
    console.log("    " + " ".repeat(22) + chalk.dim(clip(entry.description ?? "", 68)));
    const why = consequence(entry.slug, cat);
    console.log(
      "    " +
        " ".repeat(22) +
        chalk.dim(contents(entry, cat)) +
        (why ? chalk.dim(" · " + why) : "")
    );
    log.blank();
  };

  if (entries.length === 0) {
    log.warn("No templates match that filter.");
    log.dim("Try 'synap launch --list' with no filter, or 'synap market --list' for all package types.");
    return;
  }

  const workspaces = entries.filter((e) => !isOverlay(e.slug, cat));
  const overlays = entries.filter((e) => isOverlay(e.slug, cat));

  if (workspaces.length > 0) {
    log.heading("  Domain workspaces — each creates its own workspace");
    log.blank();
    workspaces.forEach(render);
  }

  if (overlays.length > 0) {
    log.heading("  Overlays — layer onto an existing workspace (no new workspace)");
    log.blank();
    overlays.forEach(render);
  }

  log.dim(`${entries.length} template${entries.length === 1 ? "" : "s"} available.`);
  const note = remoteNote(remote);
  if (note) log.dim(note);
  log.dim("Run 'synap launch' to set one up · 'synap orient' to see what you already have.");
}

// ── Intent pickers — the flow shows the RIGHT thing per intent ───────────────
// Not a flat wall of 24 templates. A SUITE is the headline for a company; its
// constituent lenses are opt-OUT customization UNDER it, never flat peers; bases
// (foundation) and overlays (grants, internal-runbook) are implementation
// details a suite pulls in — they surface only in "Custom".

/**
 * The preferred public headline suite for a company — a TIEBREAKER, not an
 * allowlist. "Is this a suite?" is derived from the `suite` tag via `isSuite()`
 * (data-driven); this only decides WHICH public suite headlines when several are
 * tagged. enterprise-os stays the canonical company OS.
 */
const PREFERRED_COMPANY_SUITE = "enterprise-os";
/** Personal-knowledge default (falls back to life-os if personal isn't bundled). */
const PERSONAL_SLUGS = ["personal", "life-os"];

/**
 * The public headline suite for a company — a suite-tagged, public entry
 * (`isSuite && !isPrivate`), preferring `enterprise-os` when several are tagged.
 * Replaces the hardcoded `COMPANY_SUITE` slug.
 */
function publicCompanySuite(cat: Catalog): CatalogEntry | undefined {
  const suites = cat.entries.filter((e) => isSuite(e) && !isPrivate(e));
  return suites.find((e) => e.slug === PREFERRED_COMPANY_SUITE) ?? suites[0];
}

/**
 * The private flagship suite offered on top — any suite-tagged PRIVATE entry
 * (resolves only when the account owns it). Replaces the hardcoded
 * `PRIVATE_SUITE` slug.
 */
function privateSuite(cat: Catalog): CatalogEntry | undefined {
  return cat.entries.find((e) => isSuite(e) && isPrivate(e));
}

/**
 * Company intent → the suite is the headline. "Use the full suite" installs it
 * as ONE apply (the pod resolves its lenses); "pick lenses" installs the chosen
 * constituents directly. Required bases (foundation) are pulled back in by the
 * resolver and shown in the disclose step, so a de-selected base is never lost.
 * If the private flagship suite is actually available to this account, offer it.
 */
async function pickCompany(cat: Catalog): Promise<string[]> {
  const suite = publicCompanySuite(cat);
  if (!suite) return [];
  const suiteSlug = suite.slug;
  const suiteName = suite.name;
  const lenses = (cat.yaml.get(suiteSlug)?.dependencies ?? [])
    .filter((d) => (d.relation ?? "require") === "require")
    .map((d) => d.slug);

  const { scope } = await prompts({
    type: "select",
    name: "scope",
    message: `${suiteName} — ${lenses.map((s) => displayName(s, cat)).join(", ")}`,
    choices: [
      {
        title: `Use the full ${suiteName}`,
        description: "Everything, wired together — recommended",
        value: "full",
      },
      {
        title: "Pick which lenses",
        description: "Choose which parts to install",
        value: "pick",
      },
    ],
  });
  if (!scope) return [];

  let selected: string[];
  if (scope === "full") {
    selected = [suiteSlug];
  } else {
    const { picked } = await prompts({
      type: "multiselect",
      name: "picked",
      message: "Which lenses? (space to toggle)",
      choices: lenses.map((s) => ({
        title:
          displayName(s, cat) +
          chalk.dim(` — ${clip(cat.yaml.get(s)?.meta?.description ?? "", 56)}`),
        value: s,
        selected: true,
      })),
      hint: "- Space to toggle. Return to submit. Required bases are added automatically.",
    });
    selected = (picked as string[]) ?? [];
    if (selected.length === 0) return [];
  }

  // Private flagship layer — offered ONLY when a suite-tagged PRIVATE entry
  // actually resolved for this account (CP-logged-in as its owner). Absent
  // otherwise, honestly. Detected by tag, not a hardcoded slug.
  const arch = privateSuite(cat);
  if (arch) {
    const { addArch } = await prompts({
      type: "confirm",
      name: "addArch",
      message: `Add your private flagships — ${arch.name}?`,
      initial: false,
    });
    if (addArch) selected.push(arch.slug);
  }
  return selected;
}

/**
 * Custom intent → the full flat list (the power-user escape hatch). Keeps the
 * describe-inference suggestion and the overlay-last ordering the flow had.
 */
async function pickCustom(cat: Catalog, description: string): Promise<string[]> {
  const suggested = inferDomains(description, cat);
  log.blank();
  log.info(
    `Based on that, I suggest: ${chalk.cyan(
      suggested.map((s) => displayName(s, cat)).join(", ")
    )}`
  );
  // `prompts` only renders `description` for the FOCUSED choice — so what you
  // get, and what it drags in, goes in the always-visible title.
  const choice = (entry: CatalogEntry) => {
    const why = consequence(entry.slug, cat);
    return {
      title:
        `${entry.name}${isPrivate(entry) ? chalk.yellow(" (private)") : ""}` +
        `${isInstalled(entry.slug, cat) ? chalk.green(" [installed]") : ""}` +
        chalk.dim(` — ${contents(entry, cat)}`) +
        (why ? chalk.dim(` · ${why}`) : ""),
      description: clip(entry.description ?? "", 72),
      value: entry.slug,
      selected: suggested.includes(entry.slug),
    };
  };
  const { domains } = await prompts({
    type: "multiselect",
    name: "domains",
    message: "Which workspaces do you want? (space to toggle, enter to confirm)",
    choices: [
      ...cat.entries.filter((e) => !isOverlay(e.slug, cat)).map(choice),
      ...cat.entries.filter((e) => isOverlay(e.slug, cat)).map(choice),
    ],
    hint: "- Space to select. Return to submit",
  });
  return (domains as string[]) ?? [];
}

// ── `synap launch` — the guided flow ─────────────────────────────────────────

export async function launch(opts: {
  podUrl?: string;
  apiKey?: string;
  json?: boolean;
  list?: boolean;
  search?: string;
  type?: string;
}): Promise<void> {
  // Discovery answers "what can I launch?" — bundled public always, plus the
  // user's private CP templates when logged in. Never touches the pod.
  if (opts.list) {
    await launchList(opts);
    return;
  }

  if (!opts.json) banner();

  const cat = await buildCatalog();
  if (!opts.json) {
    const note = remoteNote(cat.remote);
    if (note) log.dim(note);
  }

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
  // ── 3. Intent — what are you setting up? ────────────────────────────────
  // Intent-first, not a flat wall of 24 templates. A company gets the suite as
  // the headline; personal gets a knowledge base; custom is the full list for
  // power users. This is where foundation/overlays/niche standalones stop being
  // confusing flat peers — they only appear under "Custom".
  const companyAvailable = publicCompanySuite(cat) !== undefined;
  const { intent } = await prompts({
    type: "select",
    name: "intent",
    message: "What are you setting up?",
    choices: [
      ...(companyAvailable
        ? [
            {
              title: "A company / full operation",
              description:
                "Enterprise OS — strategy, market, operations, CRM, and content in one",
              value: "company",
            },
          ]
        : []),
      {
        title: "Personal knowledge base",
        description: "A private space for your notes, ideas, and thinking",
        value: "personal",
      },
      {
        title: "Custom — browse every workspace",
        description: "Pick individual workspaces and overlays yourself",
        value: "custom",
      },
    ],
  });
  if (!intent) {
    log.warn("Cancelled.");
    return;
  }

  let selected: string[];
  if (intent === "personal") {
    const slug = PERSONAL_SLUGS.find((s) => cat.yaml.has(s) || cat.entryMap.has(s));
    if (!slug) {
      log.warn("No personal-knowledge template is available.");
      return;
    }
    selected = [slug];
  } else if (intent === "company") {
    selected = await pickCompany(cat);
    if (selected.length === 0) {
      log.warn("Cancelled.");
      return;
    }
  } else {
    selected = await pickCustom(cat, description ?? "");
    if (selected.length === 0) {
      log.warn("No workspaces selected. Cancelled.");
      return;
    }
  }

  // ── 3b. DISCLOSE the whole plan before the user commits ──────────────────
  // Picking "Grants" silently provisions Operations AND Foundation — the user
  // must see that BEFORE confirming, not discover it afterwards.
  const extras = resolveExtras(selected, cat);
  log.blank();
  log.heading("  This will set up:");
  log.blank();
  for (const slug of selected) {
    const entry = cat.entryMap.get(slug);
    if (!entry) continue;
    const why = consequence(slug, cat);
    console.log(
      "    " +
        chalk.bold(displayName(slug, cat).padEnd(22)) +
        chalk.dim(isOverlay(slug, cat) ? "overlay" : "new workspace")
    );
    if (why) console.log("    " + " ".repeat(22) + chalk.dim(why));
  }
  if (extras.length > 0) {
    log.blank();
    log.info(
      `Dependencies provisioned automatically: ${chalk.cyan(
        extras.map((s) => displayName(s, cat)).join(", ")
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
    /** Which source produced the install payload. */
    source?: "bundled" | "remote";
    workspaceId?: string;
    onto?: string;
    proposalId?: string;
    error?: string;
  }> = [];

  // Authed detail fetches (private CP-only templates) need the Bearer token.
  const cpToken = getStoredToken()?.token;

  for (const slug of selected) {
    const name = displayName(slug, cat);
    const s = ora(`Provisioning ${name}…`).start();

    // Install-source decision, per entry:
    //  • slug IS in the bundle → use the OFFLINE bundled definition. It is
    //    byte-for-byte the install payload the CP would serve, needs no network,
    //    and no extra authed round-trip — so we prefer it EVEN for a private
    //    template that arrived as a remote entry (its YAML still ships today).
    //  • slug is CP-only (third-party, or a future build that dropped the YAML)
    //    → the CP is the sole source; fetch the full definition (authed, so a
    //    private one resolves).
    let pkg: Record<string, unknown>;
    let source: "bundled" | "remote";
    if (cat.yaml.has(slug)) {
      try {
        pkg = toPackageDefinition(slug) as unknown as Record<string, unknown>;
        source = "bundled";
      } catch {
        s.fail(`${name} — template not found`);
        results.push({ slug, name, outcome: "failed", error: "template not found" });
        continue;
      }
    } else {
      const def = await fetchPackageDefinition(slug, cpToken);
      if (!def) {
        s.fail(`${name} — couldn't fetch its definition from the control plane`);
        results.push({
          slug,
          name,
          outcome: "failed",
          error: "remote definition unavailable",
        });
        continue;
      }
      pkg = def;
      source = "remote";
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
        results.push({ slug, name, outcome: "proposed", source, proposalId });
        continue;
      }

      const ws = res.workspace as
        | { status?: string; workspaceId?: string; onto?: string }
        | undefined;
      if (ws?.status === "composed") {
        const onto = ws.onto ? String(ws.onto) : undefined;
        s.succeed(`${name} — layered onto its base workspace`);
        results.push({ slug, name, outcome: "composed", source, workspaceId: ws.workspaceId, onto });
      } else if (ws?.status === "created") {
        s.succeed(`${name} ready`);
        results.push({ slug, name, outcome: "created", source, workspaceId: ws.workspaceId });
      } else {
        // No workspace in the response and not proposed — report it, don't
        // silently count it as a success.
        s.fail(`${name} — pod returned no workspace`);
        results.push({ slug, name, outcome: "failed", source, error: "no workspace in response" });
      }
    } catch (e) {
      s.stop();
      log.error(`${name} failed`);
      renderHubError(e);
      results.push({ slug, name, outcome: "failed", source, error: (e as Error).message });
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
