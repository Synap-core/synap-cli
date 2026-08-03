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

import { resolveHubConfig, hubGet, type HubConfig } from "./hub-client.js";

/** An installed workspace's package identity — slug plus (when the pod stamped one) its content version. */
export interface InstalledTemplateInfo {
  slug: string;
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
  workspaceId: string;
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
 * Every installed workspace's `{slug, version, workspaceId, workspaceName}` —
 * the raw material for "what's installed" (`fetchInstalledSlugs`) and "what's
 * out of date" (`market update`'s `computeUpdates`). One Hub call, derived
 * views. Unions TWO install shapes, mirroring the browser's
 * `useInstalledPackageSlugs` (see that hook's doc for the full rationale):
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

/** Pure projection of the Hub `/workspaces` payload → installed-template rows. */
function mapInstalledTemplates(rows: HubWorkspaceRow[]): InstalledTemplateInfo[] {
  const out: InstalledTemplateInfo[] = [];
  for (const ws of rows) {
    if (ws.packageSlug) {
      out.push({
        slug: ws.packageSlug,
        version: ws.packageVersion ?? undefined,
        workspaceId: ws.id,
        workspaceName: ws.name,
        latestVersion: ws.latestVersion ?? undefined,
        drifted: ws.drifted,
      });
    }
    for (const pack of ws.installedPacks ?? []) {
      if (pack?.slug) {
        out.push({
          slug: pack.slug,
          version: pack.version,
          workspaceId: ws.id,
          workspaceName: ws.name,
        });
      }
    }
  }
  return out;
}

/**
 * STRICT variant — THROWS on any pod failure instead of degrading to empty.
 * Use when the caller must tell "pod unreachable" apart from "genuinely
 * nothing installed": `market update` otherwise reports a transient Hub error
 * as "No installed packages found," which reads as data loss and is why the
 * command felt random (empty on one call, full on the next).
 */
export async function fetchInstalledTemplatesStrict(): Promise<InstalledTemplateInfo[]> {
  const cfg = await resolveHubConfig();
  const res = (await hubGet("/workspaces", {}, cfg)) as { workspaces?: HubWorkspaceRow[] };
  return mapInstalledTemplates(res.workspaces ?? []);
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
