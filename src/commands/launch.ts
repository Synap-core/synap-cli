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

import { createRequire } from "node:module";
import path from "node:path";
import fs from "node:fs";
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
  type HubConfig,
} from "../lib/hub-client.js";
import { writeGovernance } from "../lib/capture-lane.js";
import { unwrapList } from "../lib/unwrapList.js";
import { getStoredToken } from "../lib/auth.js";
import {
  fetchRemoteCatalog,
  fetchPackageDefinition,
  type RemoteCatalog,
} from "../lib/cp-packages.js";

// Provisioning a template writes profiles, properties, views, bento layouts and
// seed entities in one call — `life-os` alone carries 21 profiles and 25 views.
// The 15s CRUD default turns a legitimately-slow apply into a phantom failure,
// so this door opts into the longer budget (same precedent as `cap run`).
const APPLY_TIMEOUT_MS = 120_000;

// ── Template catalog (bundled public + CP private, merged) ───────────────────

/**
 * THIS client's bundled `@synap-core/workspace-templates` version. The merge
 * door compares it against each CP row's `sourcePackage.version` to decide
 * whether the bundle is stale. Resolved from the installed package.json (the
 * subpath is blocked by `exports`, so we walk up from the resolved entry). On
 * failure we return "" — unparseable ⇒ the door keeps the bundle (safe default).
 */
function bundledTemplatesVersion(): string {
  try {
    const require = createRequire(import.meta.url);
    let dir = path.dirname(require.resolve("@synap-core/workspace-templates"));
    for (let i = 0; i < 6; i++) {
      const pj = path.join(dir, "package.json");
      if (fs.existsSync(pj)) {
        const parsed = JSON.parse(fs.readFileSync(pj, "utf8")) as {
          name?: string;
          version?: string;
        };
        if (parsed.name === "@synap-core/workspace-templates") return parsed.version ?? "";
      }
      dir = path.dirname(dir);
    }
  } catch {
    /* fall through to the safe default */
  }
  return "";
}

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
}

async function buildCatalog(): Promise<Catalog> {
  const remote = await fetchRemoteCatalog();
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
  };
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
 * CLI-side display-name overrides for the INTERACTIVE picker only — `--list`
 * and JSON output stay the raw catalog name, unchanged, so scripts and the
 * template-package identity are never affected by this cosmetic relabeling.
 */
const PICKER_LABELS: Record<string, string> = {
  foundation: "Strategy & Identity",
  "internal-runbook": "Operations Manual",
  social: "Social Media",
};

/** Like `displayName`, but for the guided `launch` flow's prompts/summaries —
 * applies `PICKER_LABELS`. Never use this for `--list` or JSON output. */
function pickerName(slug: string, cat: Catalog): string {
  return PICKER_LABELS[slug] ?? displayName(slug, cat);
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
function consequence(
  slug: string,
  cat: Catalog,
  nameFn: (slug: string, cat: Catalog) => string = displayName
): string {
  const y = cat.yaml.get(slug);
  if (!y) return "";
  const parts: string[] = [];
  const base = composeBase(y);
  if (base) parts.push(`layers onto ${nameFn(base, cat)}`);
  const extras = resolveExtras([slug], cat).filter((s) => s !== base);
  if (extras.length > 0)
    parts.push(`also sets up: ${extras.map((s) => nameFn(s, cat)).join(", ")}`);
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

// ── `synap launch --list` — what CAN be launched, without committing ─────────

export async function launchList(opts: { json?: boolean }): Promise<void> {
  const cat = await buildCatalog();
  const { entries, remote } = cat;

  if (opts.json) {
    console.log(
      JSON.stringify(
        {
          entries: entries.map((e) => {
            const y = cat.yaml.get(e.slug);
            return {
              slug: e.slug,
              name: e.name,
              description: e.description,
              tags: e.tags,
              isPrivate: e.isPrivate,
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
    const tags = [isPrivate(entry) ? chalk.yellow("private") : null].filter(Boolean);
    console.log(
      "    " +
        chalk.cyan(entry.slug.padEnd(22)) +
        chalk.bold(entry.name) +
        (tags.length ? "  " + tags.join(" ") : "")
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

  const workspaces = entries.filter((e) => !isOverlay(e.slug, cat));
  const overlays = entries.filter((e) => isOverlay(e.slug, cat));

  log.heading("  Domain workspaces — each creates its own workspace");
  log.blank();
  workspaces.forEach(render);

  if (overlays.length > 0) {
    log.heading("  Overlays — layer onto an existing workspace (no new workspace)");
    log.blank();
    overlays.forEach(render);
  }

  log.dim(`${entries.length} templates available.`);
  const note = remoteNote(remote);
  if (note) log.dim(note);
  log.dim("Run 'synap launch' to set one up · 'synap orient' to see what you already have.");
}

// ── Intent pickers — the flow shows the RIGHT thing per intent ───────────────
// Not a flat wall of 24 templates. The `enterprise-os` bundle is the headline
// for a company — its components are opt-OUT under it, never flat peers with
// niche add-ons; bases (foundation) never surface as a choice anywhere; and the
// full catalog stays one "Browse all templates…" away for power users.

/** The suite headline for a company. Bundled + public. */
const COMPANY_SUITE = "enterprise-os";
/** Personal-knowledge options — both shown, single-select. */
const PERSONAL_SLUGS = ["personal", "life-os"];

/**
 * Niche add-ons offered (unchecked) under the Company intent — domains most
 * companies don't need on day one. Any PRIVATE/CP template not already part of
 * the bundle rides along here too — this is where a logged-in account's own
 * overlays (e.g. a private flagship suite) surface, honestly and only when
 * they actually resolved for that account.
 */
const COMPANY_ADDON_SLUGS = [
  "internal-runbook",
  "social",
  "content-studio",
  "hr",
  "legal",
  "finance",
  "project-management",
];

/**
 * Curated standalone picks for "Just one workspace" — the common single-domain
 * asks. Deliberately excludes: `foundation` (never a choice, see module doc),
 * `personal`/`life-os` (their own intent), `enterprise-os`/private suites (the
 * Company intent's job), and `project-management` (add-on/browse-all only, per
 * the label-map note below `PICKER_LABELS`). Anything else stays reachable via
 * "Browse all templates…".
 */
const JUST_ONE_SLUGS = [
  "crm",
  "operations",
  "ecosystem",
  "content-os",
  "marketing-campaign",
  "communication",
  "brand-library",
  "builder-workspace",
  "agent-fleet",
  "internal-runbook",
  "social",
  "content-studio",
  "hr",
  "legal",
  "finance",
];

/**
 * Existing workspace NAMES on the pod (lowercased), best-effort. Used only to
 * flag a bundle component as "already installed" in the Company picker — a
 * failure here degrades honestly to an empty set (nothing shows as installed),
 * it never blocks the flow.
 */
async function fetchExistingWorkspaceNames(cfg: HubConfig): Promise<Set<string>> {
  try {
    const res = (await hubGet("/workspaces", {}, cfg)) as Record<string, unknown>;
    const list = unwrapList<Record<string, unknown>>(res, ["workspaces"]);
    return new Set(
      list.map((w) => String(w.name ?? "").toLowerCase().trim()).filter(Boolean)
    );
  } catch {
    return new Set();
  }
}

/**
 * Pure catalog partitioning for the guided flow — bundle components vs
 * add-ons vs personal vs "just one" curated list. No I/O, no prompts: this is
 * the piece worth unit-testing. (This package has no test runner installed
 * today — see the wave report; the test file uses node's built-in
 * `node:test`, which needs no new dependency.)
 */
export function partitionCatalog(cat: Catalog): {
  /** `enterprise-os`'s required lenses, minus `foundation` (never a choice). */
  companyComponents: string[];
  /** Public niche add-ons + any private/CP entry not already a component. */
  companyAddons: CatalogEntry[];
  /** Personal-knowledge options available in this catalog. */
  personal: string[];
  /** Curated standalone picks for "Just one workspace". */
  justOne: string[];
} {
  const requireDeps = (cat.yaml.get(COMPANY_SUITE)?.dependencies ?? [])
    .filter((d) => (d.relation ?? "require") === "require")
    .map((d) => d.slug);
  const companyComponents = requireDeps.filter((s) => s !== "foundation");
  const companyAddons = cat.entries.filter(
    (e) =>
      COMPANY_ADDON_SLUGS.includes(e.slug) ||
      (isPrivate(e) && e.slug !== COMPANY_SUITE && !companyComponents.includes(e.slug))
  );
  const personal = PERSONAL_SLUGS.filter((s) => cat.yaml.has(s) || cat.entryMap.has(s));
  const justOne = JUST_ONE_SLUGS.filter((s) => cat.yaml.has(s) || cat.entryMap.has(s));
  return { companyComponents, companyAddons, personal, justOne };
}

/**
 * Company intent → the `enterprise-os` bundle IS the default: its components
 * are shown pre-checked (uncheck to skip); a component that already exists as
 * a workspace on the pod is shown non-toggleable and forced in ("will be
 * reused" — never silently dropped). Then an Add-ons section, unchecked.
 */
async function pickCompany(cat: Catalog, cfg: HubConfig): Promise<string[]> {
  const suiteName = pickerName(COMPANY_SUITE, cat);
  const { companyComponents: components, companyAddons: addonEntries } = partitionCatalog(cat);

  const existing = await fetchExistingWorkspaceNames(cfg);
  const alreadyInstalled = (s: string) => existing.has(pickerName(s, cat).toLowerCase());

  log.blank();
  log.heading(`  ${suiteName} — uncheck anything you don't need`);
  const { picked } = await prompts({
    type: "multiselect",
    name: "picked",
    message: "Components",
    choices: components.map((s) => {
      const already = alreadyInstalled(s);
      return {
        title:
          pickerName(s, cat) +
          (already
            ? chalk.dim(" (already installed — will be reused)")
            : chalk.dim(` — ${clip(cat.yaml.get(s)?.meta?.description ?? "", 50)}`)),
        value: s,
        selected: true,
        disabled: already,
      };
    }),
    hint: "- Space to toggle. Return to submit.",
  });
  if (picked === undefined) return []; // cancelled (Ctrl+C / Esc)
  let selected: string[] = (picked as string[]) ?? [];

  // Add-ons — public niche domains plus any private/CP template not already
  // part of the bundle (an account's own overlays surface here, honestly).
  if (addonEntries.length > 0) {
    const { addons } = await prompts({
      type: "multiselect",
      name: "addons",
      message: "Add-ons (space to toggle — none selected by default)",
      choices: addonEntries.map((e) => ({
        title:
          pickerName(e.slug, cat) +
          (isPrivate(e) ? chalk.yellow(" (private)") : "") +
          chalk.dim(` — ${clip(e.description ?? "", 50)}`),
        value: e.slug,
        selected: false,
      })),
      hint: "- Space to toggle. Return to submit.",
    });
    selected = selected.concat((addons as string[]) ?? []);
  }
  return selected;
}

/** Personal intent → life-os and personal-knowledge, both shown, single-select. */
async function pickPersonal(cat: Catalog): Promise<string[]> {
  const { personal: available } = partitionCatalog(cat);
  if (available.length === 0) return [];
  if (available.length === 1) return available;

  const { slug } = await prompts({
    type: "select",
    name: "slug",
    message: "Which personal knowledge base?",
    choices: available.map((s) => ({
      title: pickerName(s, cat),
      description: clip(cat.entryMap.get(s)?.description ?? cat.yaml.get(s)?.meta.description ?? "", 72),
      value: s,
    })),
  });
  return slug ? [slug] : [];
}

const BROWSE_ALL = "__browse_all__";

/**
 * "Just one workspace" intent → a curated single-select of common domains,
 * with a final "Browse all templates…" entry that falls back to today's full
 * flat list (`pickCustom`) — every template stays reachable, per the guardrail.
 */
async function pickJustOne(cat: Catalog): Promise<string[]> {
  const { justOne: curated } = partitionCatalog(cat);
  const { slug } = await prompts({
    type: "select",
    name: "slug",
    message: "Which workspace?",
    choices: [
      ...curated.map((s) => ({
        title: pickerName(s, cat),
        description: clip(cat.entryMap.get(s)?.description ?? cat.yaml.get(s)?.meta.description ?? "", 72),
        value: s,
      })),
      { title: chalk.cyan("Browse all templates…"), description: "See every workspace and overlay", value: BROWSE_ALL },
    ],
  });
  if (!slug) return [];
  if (slug === BROWSE_ALL) {
    const { description } = await prompts({
      type: "text",
      name: "description",
      message: "Describe what you do (one sentence) — helps suggest a starting point:",
    });
    return pickCustom(cat, description ?? "");
  }
  return [slug];
}

/**
 * The full flat list (the power-user escape hatch, reached via "Browse all
 * templates…"). Keeps the describe-inference suggestion and the overlay-last
 * ordering the flow had.
 */
async function pickCustom(cat: Catalog, description: string): Promise<string[]> {
  const suggested = inferDomains(description, cat);
  log.blank();
  log.info(
    `Based on that, I suggest: ${chalk.cyan(
      suggested.map((s) => pickerName(s, cat)).join(", ")
    )}`
  );
  // `prompts` only renders `description` for the FOCUSED choice — so what you
  // get, and what it drags in, goes in the always-visible title.
  const choice = (entry: CatalogEntry) => {
    const why = consequence(entry.slug, cat, pickerName);
    return {
      title:
        `${pickerName(entry.slug, cat)}${isPrivate(entry) ? chalk.yellow(" (private)") : ""}` +
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

  // ── 2. Intent — what are you setting up? ────────────────────────────────
  // Intent-first, not a flat wall of ~20 templates. A company gets the
  // `enterprise-os` bundle as the headline (opt-out components + add-ons);
  // personal gets a knowledge-base pick; "just one" is a curated single pick
  // with a full-catalog escape hatch. This is where foundation, overlays, and
  // niche standalones stop being confusing flat peers.
  const companyAvailable = cat.yaml.has(COMPANY_SUITE) || cat.entryMap.has(COMPANY_SUITE);
  const { intent } = await prompts({
    type: "select",
    name: "intent",
    message: "What are you setting up?",
    choices: [
      {
        title: "Personal second brain",
        description: "A private space for your notes, ideas, and thinking",
        value: "personal",
      },
      ...(companyAvailable
        ? [
            {
              title: "A company or venture",
              description:
                "Enterprise OS — strategy, market, operations, CRM, and content in one",
              value: "company",
            },
          ]
        : []),
      {
        title: "Just one workspace",
        description: "Pick a single domain — or browse every template yourself",
        value: "just-one",
      },
    ],
  });
  if (!intent) {
    log.warn("Cancelled.");
    return;
  }

  // ── 3. Attach to an existing project, or create a new one? ───────────────
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

  // ── 4. Per-intent selection ───────────────────────────────────────────────
  let selected: string[];
  if (intent === "personal") {
    selected = await pickPersonal(cat);
    if (selected.length === 0) {
      log.warn("No personal-knowledge template is available.");
      return;
    }
  } else if (intent === "company") {
    selected = await pickCompany(cat, cfg);
    if (selected.length === 0) {
      log.warn("Cancelled.");
      return;
    }
  } else {
    selected = await pickJustOne(cat);
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
    const why = consequence(slug, cat, pickerName);
    console.log(
      "    " +
        chalk.bold(pickerName(slug, cat).padEnd(22)) +
        chalk.dim(isOverlay(slug, cat) ? "overlay" : "new workspace")
    );
    if (why) console.log("    " + " ".repeat(22) + chalk.dim(why));
  }
  if (extras.length > 0) {
    log.blank();
    log.info(
      `Dependencies provisioned automatically: ${chalk.cyan(
        extras.map((s) => pickerName(s, cat)).join(", ")
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
      // No free-text description question in the new intent-first flow — the
      // project is created from its name alone; `description` stays optional
      // server-side.
      const project = (await hubPost(
        "/projects",
        { name: projectName, status: "active" },
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
    // Picker label, not the raw catalog name — this whole command (spinners,
    // disclosure, summary) is the interactive picker; only `--list` stays raw.
    const name = pickerName(slug, cat);
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
