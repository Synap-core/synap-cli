/**
 * Installed-awareness — which packages are already on the active pod.
 * ===================================================================
 *
 * The pod stamps `workspace.settings.packageSlug` on every workspace it
 * provisions from a package (Hub `GET /workspaces` surfaces it — see
 * `workspaces.ts:508`). Cross-referencing the discovery catalog against that set
 * lets `launch --list` / the picker / `market` mark what is already installed
 * instead of re-offering it.
 *
 * NON-FATAL by design: if the pod is unreachable, unconfigured, or on an older
 * build, this degrades to an empty set (no markers) rather than failing the
 * discovery command — you can always browse the catalog offline.
 */

import { resolveHubConfig, hubGet, HubError, type HubConfig } from "./hub-client.js";

/** An installed workspace's package identity — slug plus (when the pod stamped one) its content version. */
export interface InstalledTemplateInfo {
  slug: string;
  /**
   * Which install ledger this row came from — `"workspace"` for the historical
   * shape, and one of the other five kinds once the pod serves
   * `GET /api/hub/installed`. Optional so every existing constructor (and every
   * test that builds one by hand) stays valid; absent reads as `"workspace"`.
   */
  kind?: InstalledKind;
  /**
   * `settings.packageVersion`, when the pod stamped one — `GET /api/hub/workspaces`
   * (`hub-protocol/rest/workspaces.ts`) projects it off `workspace.settings`.
   * Undefined for workspaces the pod never version-stamped: installs that
   * predate versioning, OR any install whose template only resolved from the
   * frozen bundle (no CP cache hit — `resolveWorkspaceTemplate` returns no
   * `version` for a bundle fallback). `market update` treats undefined as
   * "can't check" rather than "outdated" — see `market.ts`'s `computeUpdates`.
   */
  version?: string;
  /**
   * The workspace this row lives in — `null` for a POD-GLOBAL install (a
   * capability, cell or skill installed with `workspace_id IS NULL`). Widened
   * from `string` when `GET /installed` brought the other five kinds in: a
   * pod-wide row has no workspace, and inventing one would be a fabrication.
   */
  workspaceId: string | null;
  workspaceName: string;
  /**
   * Server-computed latest catalog version for this slug (Hub `/workspaces`
   * TemplateHealth projection). Present when the pod runs the server-side drift
   * code; `undefined` on an older pod, where the CLI falls back to deriving
   * drift itself. Only set for the `packageSlug` entry, never `installedPacks`.
   */
  latestVersion?: string | null;
  /**
   * Server-computed drift (Hub `/workspaces` TemplateHealth) — the single
   * truthful "an update is available" signal, so the CLI stops re-deriving it.
   * `undefined` on an older pod → client fallback.
   */
  drifted?: boolean;
}

/**
 * The Hub `GET /workspaces` row shape. It carries TWO install shapes, mirroring
 * the browser's `useInstalledPackageSlugs` (see that hook's doc for the full
 * rationale):
 *
 *  1. `workspace.packageSlug` — a workspace-creating install (template).
 *  2. `workspace.settings.installedPacks[]` — additive packs (profile/view/
 *     bento) that create no workspace of their own, so never set `packageSlug`.
 *
 * A workspace carrying BOTH contributes one row per shape — they're different
 * package identities layered onto the same workspace.
 */
type HubWorkspaceRow = {
  id: string;
  name: string;
  packageSlug?: string | null;
  packageVersion?: string | null;
  // TemplateHealth fields (present on pods running the server-side drift code).
  latestVersion?: string | null;
  drifted?: boolean;
  installedPacks?: Array<{ slug?: string; version?: string }> | null;
};

// ── THE ONE READ DOOR — `GET /api/hub/installed` ────────────────────────────
//
// The pod projects all FOUR install ledgers it already maintains (workspaces,
// capability containers, marketSource-linked view/skill/automation rows, and
// package cells) through one kind-agnostic route. Before it existed this file
// asked `GET /workspaces` and nothing else, so `market installed` /
// `market update` / every drift marker structurally reported ONE of six kinds
// while their names claimed all of them.
//
// Two calls, deliberately, both cheap and local to the pod:
//   • `/installed` — the six kinds. Absent on an older pod (404).
//   • `/workspaces` — for TWO things `/installed` does not carry:
//       1. the workspace id→name join (`/installed` reports each ROW's own
//          name — a view's title, not its workspace's), and
//       2. `settings.installedPacks[]`, an additive-pack ledger `/installed`
//          reads only to decide whether a workspace counts as installed, and
//          never emits rows for. Dropping it would un-list (and make
//          un-updatable) every additive pack — a coverage regression in the
//          exact command this consolidation exists to widen.

/** Every kind the door can report. Mirrors the pod's `INSTALLED_KINDS`. */
export const INSTALLED_KINDS = [
  "workspace",
  "capability",
  "view",
  "skill",
  "automation",
  "cell",
] as const;
export type InstalledKind = (typeof INSTALLED_KINDS)[number];

/**
 * One row of `GET /api/hub/installed`, plus the locally-joined `workspaceName`.
 *
 * Read the pod's `hub-protocol/rest/installed.ts` docblock for the field
 * contract. The three that bite:
 *
 *  - `drift: null` means **NOT COMPUTED**, never "no drift". Capabilities and
 *    cells have no local comparator, so `null` is the honest answer for them.
 *  - `packageSlug: null` means **not source-linked to a package** — every
 *    capability row (its link is a `templateKey`, not a catalog slug) and any
 *    cell minted with the `"unknown"` sentinel. Never print it as a name.
 *  - `installedVersion` is a semver for workspace/view/skill/automation and a
 *    CONTENT HASH for capability/cell. Never diff the two shapes.
 */
export interface InstalledRow {
  kind: InstalledKind;
  id: string;
  name: string;
  packageSlug: string | null;
  templateKey: string | null;
  installedVersion: string | null;
  latestVersion: string | null;
  drift: boolean | null;
  installedAt: string | null;
  workspaceId: string | null;
  /** Joined LOCALLY from `GET /workspaces`; the door itself carries only the id. */
  workspaceName: string | null;
  provisioningStatus: string | null;
  failedStep: string | null;
  note?: string;
}

export interface InstalledInventory {
  rows: InstalledRow[];
  /** Echoes whether the pod ran its expensive drift pass. The CLI never asks for it. */
  driftComputed: boolean;
  /**
   * TRUE when the pod does not serve `GET /installed` (404) and this inventory
   * was rebuilt from `GET /workspaces` alone — i.e. workspace packages only.
   * Callers must SAY so; an older pod is not an empty pod.
   */
  degraded: boolean;
}

type HubInstalledResponse = {
  installed?: Array<Omit<InstalledRow, "workspaceName">>;
  driftComputed?: boolean;
};

/** `GET /installed`, or `null` when this pod is too old to serve it. Any other failure throws. */
async function getInstalledOrNull(cfg: HubConfig): Promise<HubInstalledResponse | null> {
  try {
    return (await hubGet("/installed", {}, cfg)) as HubInstalledResponse;
  } catch (e) {
    if (e instanceof HubError && e.status === 404) return null;
    throw e;
  }
}

/**
 * STRICT inventory — THROWS on any pod failure except the older-pod 404, which
 * degrades to the historical `/workspaces` behaviour with `degraded: true`.
 * Absence of the route is not absence of installs.
 */
export async function fetchInstalledInventoryStrict(cfg?: HubConfig): Promise<InstalledInventory> {
  const resolved = cfg ?? (await resolveHubConfig());
  const [wsRes, installedRes] = await Promise.all([
    hubGet("/workspaces", {}, resolved) as Promise<{ workspaces?: HubWorkspaceRow[] }>,
    getInstalledOrNull(resolved),
  ]);
  const wsRows = wsRes.workspaces ?? [];
  const nameById = new Map(wsRows.map((w) => [w.id, w.name]));

  // Additive packs — the ledger `/installed` never emits rows for (see above).
  const packRows: InstalledRow[] = [];
  for (const ws of wsRows) {
    for (const pack of ws.installedPacks ?? []) {
      if (!pack?.slug) continue;
      packRows.push({
        kind: "workspace",
        id: `${ws.id}:${pack.slug}`,
        name: pack.slug,
        packageSlug: pack.slug,
        templateKey: null,
        installedVersion: pack.version ?? null,
        latestVersion: null,
        // The pod never version-stamped or health-checked an additive pack, so
        // it cannot be computed here either. `null`, not a defaulted `false`.
        drift: null,
        installedAt: null,
        workspaceId: ws.id,
        workspaceName: ws.name,
        provisioningStatus: null,
        failedStep: null,
      });
    }
  }

  if (!installedRes) {
    // Older pod: rebuild the workspace rows exactly as this file always did.
    const wsOnly: InstalledRow[] = wsRows
      .filter((ws) => !!ws.packageSlug)
      .map((ws) => ({
        kind: "workspace" as const,
        id: ws.id,
        name: ws.name,
        packageSlug: ws.packageSlug!,
        templateKey: null,
        installedVersion: ws.packageVersion ?? null,
        latestVersion: ws.latestVersion ?? null,
        drift: ws.drifted ?? null,
        installedAt: null,
        workspaceId: ws.id,
        workspaceName: ws.name,
        provisioningStatus: null,
        failedStep: null,
      }));
    return { rows: [...wsOnly, ...packRows], driftComputed: false, degraded: true };
  }

  const rows: InstalledRow[] = (installedRes.installed ?? []).map((r) => ({
    ...r,
    workspaceName: r.workspaceId ? (nameById.get(r.workspaceId) ?? null) : null,
  }));
  return {
    rows: [...rows, ...packRows],
    driftComputed: installedRes.driftComputed === true,
    degraded: false,
  };
}

/** Non-fatal inventory — empty (and NOT degraded) on any failure, for markers that must never block discovery. */
export async function fetchInstalledInventory(cfg?: HubConfig): Promise<InstalledInventory> {
  try {
    return await fetchInstalledInventoryStrict(cfg);
  } catch {
    return { rows: [], driftComputed: false, degraded: false };
  }
}

/**
 * The UPDATABLE subset of an inventory, in the shape `computeUpdates` /
 * `market update` / the composition renderers already speak.
 *
 * Rows with `packageSlug: null` are dropped ON PURPOSE — they are inventory,
 * not update targets: `market update` takes a catalog SLUG, and a capability's
 * `templateKey` is not one. Feeding them through would hand the user a slug
 * that misses the catalog. `market installed` renders them separately.
 *
 * `drift: null` maps to `drifted: undefined`, which is `computeUpdates`'
 * long-standing "the server didn't answer — derive it client-side, and report
 * an unstampable install as noVersionInfo rather than outdated" path. It is
 * NEVER mapped to `drifted: false`.
 */
export function installedRowsToTemplates(rows: InstalledRow[]): InstalledTemplateInfo[] {
  const out: InstalledTemplateInfo[] = [];
  for (const r of rows) {
    if (!r.packageSlug) continue;
    out.push({
      kind: r.kind,
      slug: r.packageSlug,
      version: r.installedVersion ?? undefined,
      workspaceId: r.workspaceId,
      workspaceName: r.workspaceName ?? (r.workspaceId ? r.workspaceId : "pod-wide"),
      latestVersion: r.latestVersion ?? undefined,
      drifted: r.drift ?? undefined,
    });
  }
  return out;
}

/**
 * STRICT variant — THROWS on any pod failure instead of degrading to empty.
 * Use when the caller must tell "pod unreachable" apart from "genuinely
 * nothing installed": `market update` otherwise reports a transient Hub error
 * as "No installed packages found," which reads as data loss and is why the
 * command felt random (empty on one call, full on the next).
 *
 * Sources from `fetchInstalledInventoryStrict` — so every consumer of this
 * function (`market update`, `launch --list`, the picker, `fetchInstalledSlugs`)
 * now sees ALL SIX kinds on a current pod, and exactly the old workspace-only
 * set on an older one.
 */
export async function fetchInstalledTemplatesStrict(): Promise<InstalledTemplateInfo[]> {
  const inv = await fetchInstalledInventoryStrict();
  return installedRowsToTemplates(inv.rows);
}

export async function fetchInstalledTemplates(): Promise<InstalledTemplateInfo[]> {
  try {
    return await fetchInstalledTemplatesStrict();
  } catch {
    // Non-fatal: degrade to empty. Discovery/markers never depend on the pod.
    return [];
  }
}

/**
 * Ground-truth stamp verification — re-reads ONE workspace's stored
 * `packageVersion` after an apply to confirm a version stamp actually landed,
 * instead of INFERRING it from the apply response's `outcome` (a proxy that
 * false-positives whenever content was already identical, so `outcome` comes
 * back `"unchanged"` even though the stamp was written). Returns:
 *   - `true`  — the workspace now carries the expected version (stamp landed).
 *   - `false` — reached the pod, but the stamp is missing/different (old pod
 *               that doesn't stamp on reconcile, or a real failure).
 *   - `null`  — couldn't reach/find the workspace; don't cry wolf on a verify
 *               failure — the apply itself already succeeded.
 */
export async function verifyStampLanded(
  workspaceId: string,
  expectedVersion: string,
  cfg?: HubConfig
): Promise<boolean | null> {
  try {
    const resolved = cfg ?? (await resolveHubConfig());
    const res = (await hubGet("/workspaces", {}, resolved)) as { workspaces?: HubWorkspaceRow[] };
    const ws = (res.workspaces ?? []).find((w) => w.id === workspaceId);
    if (!ws) return null;
    return (ws.packageVersion ?? null) === expectedVersion;
  } catch {
    return null;
  }
}

/**
 * A workspace's template-attachment status — every workspace on the pod, NOT
 * just the ones with a package identity (which is `fetchInstalledTemplates`'s
 * job). This is the raw material for the workspace-centric discovery surface
 * (`market workspaces`): it deliberately KEEPS workspaces with no `packageSlug`
 * so the user can find the pre-market / hand-built one that still needs
 * attaching.
 */
export interface WorkspaceAttachment {
  workspaceId: string;
  workspaceName: string;
  /** Operational-domain label — `settings.workspaceSubtype ?? workspaceType`, mirroring the `discover()` service's `domain` field. */
  domain: string | null;
  /** `settings.packageSlug` — null means this workspace was never provisioned from a template (pre-market or hand-built): a candidate to attach. */
  packageSlug: string | null;
  /** `settings.packageVersion` — set only when the pod version-stamped the install. `packageSlug` set + this null = "attached, no version stamp — reattach to enable updates". */
  packageVersion: string | null;
  /** Server-computed latest catalog version (Hub TemplateHealth); `undefined` on an older pod. */
  latestVersion?: string | null;
  /** Server-computed drift (Hub TemplateHealth) — the truthful "update available"; `undefined` on an older pod → client fallback. */
  drifted?: boolean;
}

/**
 * Every workspace on the pod with its template-attachment status, sourced from
 * the SAME Hub `GET /workspaces` call `fetchInstalledTemplates` uses (which
 * already projects `packageSlug`/`packageVersion`/`workspaceType`/
 * `workspaceSubtype`). Unlike `fetchInstalledTemplates`, it does NOT drop rows
 * without a `packageSlug` — those unattached workspaces are exactly what the
 * discovery surface exists to surface. Non-fatal: empty on ANY failure.
 *
 * Only the workspace's OWN `packageSlug` is considered here — additive
 * `installedPacks` (profile/view/bento packs) don't constitute a workspace's
 * template attachment, so they're intentionally ignored for this view.
 */
type HubWorkspaceAttachmentRow = {
  id: string;
  name: string;
  workspaceType?: string | null;
  workspaceSubtype?: string | null;
  packageSlug?: string | null;
  packageVersion?: string | null;
  latestVersion?: string | null;
  drifted?: boolean;
};

function mapWorkspaceAttachments(rows: HubWorkspaceAttachmentRow[]): WorkspaceAttachment[] {
  return rows.map((ws) => ({
    workspaceId: ws.id,
    workspaceName: ws.name,
    domain: ws.workspaceSubtype ?? ws.workspaceType ?? null,
    packageSlug: ws.packageSlug ?? null,
    packageVersion: ws.packageVersion ?? null,
    latestVersion: ws.latestVersion ?? undefined,
    drifted: ws.drifted,
  }));
}

/**
 * STRICT variant — THROWS on any pod failure instead of degrading to empty.
 * Use where an empty result would be a LIE about the user's pod (e.g. `synap
 * templates`, the consolidated home): "pod unreachable" must not read as "no
 * workspaces / stand one up" — the same false-empty trap `fetchInstalledTemplatesStrict`
 * exists to prevent.
 */
export async function fetchWorkspaceAttachmentsStrict(cfg?: HubConfig): Promise<WorkspaceAttachment[]> {
  const resolved = cfg ?? (await resolveHubConfig());
  const res = (await hubGet("/workspaces", {}, resolved)) as { workspaces?: HubWorkspaceAttachmentRow[] };
  return mapWorkspaceAttachments(res.workspaces ?? []);
}

export async function fetchWorkspaceAttachments(cfg?: HubConfig): Promise<WorkspaceAttachment[]> {
  try {
    return await fetchWorkspaceAttachmentsStrict(cfg);
  } catch {
    // Non-fatal: degrade to empty. Discovery/markers never hard-depend on the pod.
    return [];
  }
}

/**
 * The set of `packageSlug`s installed on the active pod. Empty on ANY failure
 * (no pod configured, unreachable, older build without the field) — the caller
 * simply shows no "installed" markers.
 */
export async function fetchInstalledSlugs(): Promise<Set<string>> {
  const templates = await fetchInstalledTemplates();
  return new Set(templates.map((t) => t.slug));
}
