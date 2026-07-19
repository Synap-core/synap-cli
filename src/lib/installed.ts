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

import { resolveHubConfig, hubGet } from "./hub-client.js";

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
export async function fetchInstalledTemplates(): Promise<InstalledTemplateInfo[]> {
  const out: InstalledTemplateInfo[] = [];
  try {
    const cfg = await resolveHubConfig();
    const res = (await hubGet("/workspaces", {}, cfg)) as {
      workspaces?: Array<{
        id: string;
        name: string;
        packageSlug?: string | null;
        packageVersion?: string | null;
        installedPacks?: Array<{ slug?: string; version?: string }> | null;
      }>;
    };
    for (const ws of res.workspaces ?? []) {
      if (ws.packageSlug) {
        out.push({
          slug: ws.packageSlug,
          version: ws.packageVersion ?? undefined,
          workspaceId: ws.id,
          workspaceName: ws.name,
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
  } catch {
    // Non-fatal: degrade to empty. Discovery never depends on the pod.
  }
  return out;
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
