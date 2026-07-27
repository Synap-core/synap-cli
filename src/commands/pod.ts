/**
 * `synap pod` — the unified pod-configuration view.
 * ===================================================
 *
 * `market installed` shows what packages are installed; `synap pod` answers
 * the bigger question — "what does my WHOLE pod look like right now?" — one
 * scannable graph over workspaces (with provenance), pod-wide vs per-workspace
 * capabilities/automations/playbooks, and the give/need feed links between
 * workspaces. It is the read surface for `GET /api/hub/pod/config`
 * (`hub-protocol/rest/pod.ts` on the backend side).
 *
 * `synap pod adopt <workspaceId> --template <slug>` links an orphan/ad-hoc
 * workspace to a matching template so it becomes version-tracked, via
 * `POST /api/hub/pod/adopt`.
 *
 * READ-first, ONE write door (`adopt`). Reuses rather than re-derives:
 *   - the composition-tree engine (`buildCompositionTrees`/`printCompositionTree`
 *     + `buildMarketCatalog`/`computeUpdates`) from `market.ts`, for the
 *     marketplace-provenance workspaces' package → template deps → workspaces
 *     overlay.
 *   - the honest-outcome verdict helpers (`classifyApplyResult`/
 *     `printApplyVerdict`) from `market.ts`, for `pod adopt`'s outcome.
 */

import chalk from "chalk";
import { log } from "../utils/logger.js";
import {
  resolveHubConfig,
  hubGet,
  hubPost,
  renderHubError,
  HubError,
  type HubConfig,
} from "../lib/hub-client.js";
import { writeGovernance } from "../lib/capture-lane.js";
import { fetchInstalledTemplates } from "../lib/installed.js";
import {
  buildMarketCatalog,
  computeUpdates,
  buildCompositionTrees,
  printCompositionTree,
} from "./market.js";

// ── The `/pod/config` DTO ────────────────────────────────────────────────────
// `provenance` is a discriminated union, not a flat string — there is no
// separate "orphan" kind on the wire. An orphan is an `ad-hoc` workspace whose
// provenance happens to carry a `templateMatch` (the backend's best guess at
// which template it resembles); plain `ad-hoc` has no `templateMatch`.

export type WorkspaceProvenance =
  | { kind: "marketplace"; packageSlug: string; packageVersion: string | null }
  | { kind: "composed"; composedFrom: unknown[] }
  | { kind: "ad-hoc"; createdBy: string | null; templateMatch?: { slug: string; name: string } };

export interface PodConfigWorkspace {
  id: string;
  name: string;
  subtype: string | null;
  entityCount: number;
  provenance: WorkspaceProvenance;
}

export type CapabilityProvenance = { kind: "marketplace"; templateKey: string } | { kind: "manual" };

export interface PodConfigCapability {
  id: string;
  name: string;
  workspaceId: string | null;
  provenance: CapabilityProvenance;
}

export type AutomationProvenance = { kind: "ai" | "manual" | "template" };

export interface PodConfigAutomation {
  id: string;
  name: string;
  workspaceId: string | null;
  provenance: AutomationProvenance;
}

export type PlaybookProvenance = { kind: "manual" };

export interface PodConfigPlaybook {
  id: string;
  name: string;
  workspaceId: string | null;
  provenance: PlaybookProvenance;
}

export interface PodConfigFeedsLink {
  from: string;
  to: string;
  domain: string | null;
  profileSlug: string | null;
}

export interface PodConfig {
  workspaces: PodConfigWorkspace[];
  capabilities: PodConfigCapability[];
  automations: PodConfigAutomation[];
  playbooks: PodConfigPlaybook[];
  feedsLinks: PodConfigFeedsLink[];
}

/** Coerce whatever shape a field arrives in into an array — tolerates minor DTO drift. */
function arr<T>(v: unknown): T[] {
  return Array.isArray(v) ? (v as T[]) : [];
}

/** Defensive parse of the raw `/pod/config` JSON into `PodConfig` — never throws on a shifted field name, just degrades that section to empty. */
function parsePodConfig(raw: unknown): PodConfig {
  const r = (raw ?? {}) as Record<string, unknown>;
  return {
    workspaces: arr<PodConfigWorkspace>(r.workspaces),
    capabilities: arr<PodConfigCapability>(r.capabilities),
    automations: arr<PodConfigAutomation>(r.automations),
    playbooks: arr<PodConfigPlaybook>(r.playbooks),
    feedsLinks: arr<PodConfigFeedsLink>(r.feedsLinks),
  };
}

/**
 * `GET /pod/config`. Returns `null` (never throws) on a 404 — the endpoint
 * not being deployed yet on this pod build is an expected, non-fatal state
 * during parallel backend/CLI development; callers render an honest "not
 * live on this pod yet" message instead of a stack trace.
 */
async function fetchPodConfig(cfg: HubConfig): Promise<PodConfig | null> {
  try {
    const raw = await hubGet("/pod/config", {}, cfg);
    return parsePodConfig(raw);
  } catch (e) {
    if (e instanceof HubError && e.status === 404) return null;
    throw e;
  }
}

/** An orphan is an ad-hoc workspace the backend matched to a known template. */
function isOrphan(ws: PodConfigWorkspace): boolean {
  return ws.provenance.kind === "ad-hoc" && !!ws.provenance.templateMatch;
}

// ── Rendering helpers ────────────────────────────────────────────────────────

/** Tag for the small provenance shapes shared by capabilities/automations/playbooks. */
function provenanceTag(p: { kind: string; templateKey?: string }): string {
  if (p.kind === "marketplace" && p.templateKey) return chalk.green(`marketplace: ${p.templateKey}`);
  switch (p.kind) {
    case "marketplace":
      return chalk.green("marketplace");
    case "ai":
      return chalk.magenta("ai");
    case "template":
      return chalk.cyan("template");
    case "manual":
    default:
      return chalk.dim(p.kind);
  }
}

/** One workspace row — `nameW` right-pads the name so provenance tags line up in a column. */
function workspaceLine(ws: PodConfigWorkspace, nameW = 0): string {
  const name = chalk.bold(ws.name.padEnd(nameW));
  const count = chalk.dim(`(${ws.entityCount} entities)`.padEnd(16));
  const p = ws.provenance;
  switch (p.kind) {
    case "marketplace":
      return `${name}  ${count}  ${chalk.green(`marketplace: ${p.packageSlug}${p.packageVersion ? "@" + p.packageVersion : ""}`)}`;
    case "composed": {
      const from = p.composedFrom.length ? p.composedFrom.map(String).join(", ") : "?";
      return `${name}  ${count}  ${chalk.cyan(`composed from ${from}`)}`;
    }
    case "ad-hoc":
      if (p.templateMatch) {
        return (
          `${name}  ${count}  ` +
          chalk.yellow(`⚠ orphan — matches template ${p.templateMatch.slug}`) +
          "\n" +
          " ".repeat(nameW + count.length + 4) +
          chalk.dim(`run: synap pod adopt ${ws.id} --template ${p.templateMatch.slug}`)
        );
      }
      return `${name}  ${count}  ${chalk.dim("ad-hoc")}`;
  }
}

/** Group `{workspaceId|null}`-carrying rows into pod-wide vs per-workspace. */
function splitPodWide<T extends { workspaceId: string | null }>(
  rows: T[]
): { podWide: T[]; perWorkspace: Map<string, T[]> } {
  const podWide: T[] = [];
  const perWorkspace = new Map<string, T[]>();
  for (const r of rows) {
    if (r.workspaceId) {
      (perWorkspace.get(r.workspaceId) ?? perWorkspace.set(r.workspaceId, []).get(r.workspaceId)!).push(r);
    } else {
      podWide.push(r);
    }
  }
  return { podWide, perWorkspace };
}

function printGroupedSection<
  T extends { id: string; name: string; workspaceId: string | null; provenance: { kind: string; templateKey?: string } },
>(title: string, rows: T[], nameById: Map<string, string>): void {
  log.heading(`  ${title}`);
  log.blank();
  if (rows.length === 0) {
    console.log("    " + chalk.dim("(none)"));
    log.blank();
    return;
  }

  const nameW = Math.max(4, ...rows.map((r) => r.name.length)) + 2;
  const { podWide, perWorkspace } = splitPodWide(rows);

  if (podWide.length > 0) {
    console.log("    " + chalk.dim("Pod-wide"));
    for (const r of podWide) {
      console.log("      " + r.name.padEnd(nameW) + provenanceTag(r.provenance));
    }
    log.blank();
  }

  for (const [wsId, wsRows] of perWorkspace) {
    console.log("    " + chalk.bold(nameById.get(wsId) ?? wsId));
    for (const r of wsRows) {
      console.log("      " + r.name.padEnd(nameW) + provenanceTag(r.provenance));
    }
    log.blank();
  }
}

/** Render `feedsLinks` as `Foundation → provides → CRM` edges. */
function printFeedsLinks(links: PodConfigFeedsLink[], nameById: Map<string, string>): void {
  log.heading("  Give / need links");
  log.blank();
  if (links.length === 0) {
    console.log("    " + chalk.dim("(none)"));
    log.blank();
    return;
  }
  for (const l of links) {
    const from = nameById.get(l.from) ?? l.from;
    const to = nameById.get(l.to) ?? l.to;
    const detail = l.domain ? ` (${l.domain})` : l.profileSlug ? ` (${l.profileSlug})` : "";
    console.log("    " + chalk.bold(from) + chalk.dim(" → provides → ") + chalk.bold(to) + chalk.dim(detail));
  }
  log.blank();
}

// ── `synap pod` ──────────────────────────────────────────────────────────────

export async function pod(opts: {
  json?: boolean;
  orphans?: boolean;
  podUrl?: string;
  apiKey?: string;
}): Promise<void> {
  let cfg: HubConfig;
  try {
    cfg = await resolveHubConfig(opts);
  } catch (e) {
    renderHubError(e);
    process.exit(1);
  }

  const config = await fetchPodConfig(cfg);
  if (!config) {
    if (opts.json) {
      console.log(JSON.stringify({ error: "not-deployed", message: "GET /api/hub/pod/config returned 404" }, null, 2));
      return;
    }
    log.warn("The unified pod-config endpoint isn't live on this pod yet (404).");
    log.hint("The backend half of this feature hasn't been deployed — this command is wired and will work once it is.");
    return;
  }

  const nameById = new Map(config.workspaces.map((w) => [w.id, w.name]));
  const adHocWorkspaces = config.workspaces.filter((w) => w.provenance.kind === "ad-hoc");

  if (opts.orphans) {
    if (opts.json) {
      console.log(JSON.stringify({ workspaces: adHocWorkspaces }, null, 2));
      return;
    }
    if (adHocWorkspaces.length === 0) {
      log.success("No orphan or ad-hoc workspaces — everything is either marketplace-linked or composed.");
      return;
    }
    log.heading("  Orphan / ad-hoc workspaces");
    log.blank();
    const nameW = Math.max(4, ...adHocWorkspaces.map((w) => w.name.length)) + 2;
    for (const ws of adHocWorkspaces) {
      console.log("    " + workspaceLine(ws, nameW));
    }
    log.blank();
    return;
  }

  if (opts.json) {
    console.log(JSON.stringify(config, null, 2));
    return;
  }

  // ── Workspaces ─────────────────────────────────────────────────────────
  log.heading("  Workspaces");
  log.blank();

  if (config.workspaces.length === 0) {
    console.log("    " + chalk.dim("(none)"));
    log.blank();
  }

  const marketplaceWorkspaces = config.workspaces.filter((w) => w.provenance.kind === "marketplace");
  const otherWorkspaces = config.workspaces.filter((w) => w.provenance.kind !== "marketplace");

  // Composition-tree overlay for marketplace workspaces — reuses market.ts's
  // `--tree` engine (buildMarketCatalog + computeUpdates + buildCompositionTrees)
  // rather than re-deriving a second package→workspace walk.
  if (marketplaceWorkspaces.length > 0) {
    const nameW = Math.max(4, ...marketplaceWorkspaces.map((w) => w.name.length)) + 2;
    const printFlat = () => {
      marketplaceWorkspaces.forEach((ws) => console.log("    " + workspaceLine(ws, nameW)));
      log.blank();
    };
    try {
      const [installedTemplates, cat] = await Promise.all([fetchInstalledTemplates(), buildMarketCatalog()]);
      if (installedTemplates.length > 0) {
        const checks = computeUpdates(installedTemplates, cat);
        const workspaceCountBySlug = new Map<string, number>();
        for (const t of installedTemplates) {
          workspaceCountBySlug.set(t.slug, (workspaceCountBySlug.get(t.slug) ?? 0) + 1);
        }
        const seen = new Set<string>();
        const rows = checks.filter((c) => (seen.has(c.slug) ? false : (seen.add(c.slug), true)));
        const { packages } = await buildCompositionTrees(rows, cat, installedTemplates, workspaceCountBySlug);
        if (packages.length > 0) packages.forEach(printCompositionTree);
        else printFlat();
      } else {
        printFlat();
      }
    } catch {
      // Composition-tree overlay is best-effort — fall back to the flat list.
      printFlat();
    }
  }

  if (otherWorkspaces.length > 0) {
    console.log("    " + chalk.dim("Composed / ad-hoc"));
    const nameW = Math.max(4, ...otherWorkspaces.map((w) => w.name.length)) + 2;
    for (const ws of otherWorkspaces) {
      console.log("    " + workspaceLine(ws, nameW));
    }
    log.blank();
  }

  // ── Capabilities / Automations / Playbooks ────────────────────────────
  printGroupedSection("Capabilities", config.capabilities, nameById);
  printGroupedSection("Automations", config.automations, nameById);
  printGroupedSection("Playbooks", config.playbooks, nameById);

  // ── Give / need links ──────────────────────────────────────────────────
  printFeedsLinks(config.feedsLinks, nameById);

  const orphanCount = adHocWorkspaces.filter(isOrphan).length;
  const adHocCount = adHocWorkspaces.length - orphanCount;
  if (orphanCount > 0 || adHocCount > 0) {
    log.dim(
      `${orphanCount} orphan, ${adHocCount} ad-hoc workspace${orphanCount + adHocCount === 1 ? "" : "s"} — run 'synap pod --orphans' to focus on them.`
    );
  }
}

// ── `synap pod adopt <nameOrId> --template <slug>` ───────────────────────────

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Resolve a user-supplied `<workspace>` arg to a workspace id.
 *
 * `adopt` is FOR orphans, so the source must include unstamped/ad-hoc
 * workspaces — `fetchInstalledTemplates` (template-installed only) is the
 * wrong list here. `GET /orient` already returns every workspace on the pod
 * (incl. orphans) and is deployed today, so it's the resolution source; the
 * newer `/pod/config` read (this file's `fetchPodConfig`) would also work
 * once live but isn't guaranteed deployed yet.
 *
 * A UUID is passed straight through unchanged (fast path — no network call).
 * Anything else is matched case-insensitively by exact name against `/orient`.
 */
async function resolveWorkspaceRef(nameOrId: string, cfg: HubConfig): Promise<string> {
  if (UUID_RE.test(nameOrId)) return nameOrId;

  const res = (await hubGet("/orient", { detail: "full" }, cfg)) as {
    workspaces?: Array<{ id: string; name: string }>;
  };
  const workspaces = res.workspaces ?? [];
  const needle = nameOrId.trim().toLowerCase();
  const matches = workspaces.filter((w) => (w.name ?? "").trim().toLowerCase() === needle);

  if (matches.length === 0) {
    log.error(`No workspace named "${nameOrId}" on this pod. Run 'synap pod' to see them.`);
    process.exit(1);
  }
  if (matches.length > 1) {
    const candidates = matches.map((w) => `${w.id} (${w.name})`).join(", ");
    log.error(`Multiple workspaces named "${nameOrId}" — use the id: ${candidates}`);
    process.exit(1);
  }

  const match = matches[0]!;
  log.dim(`Resolved "${nameOrId}" → ${match.id}`);
  return match.id;
}

interface AdoptResult {
  outcome?: "linked" | "already-linked" | string;
  workspace?: { id: string; name: string; packageSlug?: string; packageVersion?: string };
}

export async function podAdopt(
  workspaceNameOrId: string,
  opts: { template?: string; json?: boolean; podUrl?: string; apiKey?: string }
): Promise<void> {
  if (!opts.template) {
    log.error("Missing --template <slug>.");
    log.hint("List template matches: synap pod --orphans");
    process.exit(1);
  }

  let cfg: HubConfig;
  try {
    cfg = await resolveHubConfig(opts);
  } catch (e) {
    renderHubError(e);
    process.exit(1);
  }

  const workspaceId = await resolveWorkspaceRef(workspaceNameOrId, cfg);

  try {
    const res = (await hubPost(
      "/pod/adopt",
      { workspaceId, templateSlug: opts.template },
      cfg
    )) as Record<string, unknown>;

    if (writeGovernance(res) === "proposed") {
      const proposalId = res.proposalId ? String(res.proposalId) : undefined;
      if (opts.json) {
        console.log(JSON.stringify({ outcome: "proposed", proposalId }, null, 2));
        return;
      }
      log.info(`Adopting into ${opts.template} — proposed (under review, not live yet).`);
      if (proposalId) log.hint(`Approve: synap proposals approve ${proposalId}`);
      return;
    }

    const result = res as AdoptResult;
    if (opts.json) {
      console.log(JSON.stringify(result, null, 2));
      return;
    }

    const wsName = result.workspace?.name ?? workspaceId;
    if (result.outcome === "already-linked") {
      log.info(`${wsName} is already linked to ${opts.template}.`);
      return;
    }
    log.success(`Linked ${wsName} to ${opts.template} — now version-tracked.`);
    if (result.workspace?.packageVersion) {
      log.dim(`Stamped version ${result.workspace.packageVersion}.`);
    }
    log.hint(`Check for drift going forward: synap market update ${opts.template}`);
  } catch (e) {
    if (e instanceof HubError && e.status === 404) {
      log.warn("The pod-adopt endpoint isn't live on this pod yet (404).");
      log.hint("The backend half of this feature hasn't been deployed — this command is wired and will work once it is.");
      return;
    }
    log.error(`Adopting ${workspaceId} into ${opts.template} failed`);
    renderHubError(e);
    process.exit(1);
  }
}
