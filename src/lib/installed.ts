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

/**
 * The set of `packageSlug`s installed on the active pod. Empty on ANY failure
 * (no pod configured, unreachable, older build without the field) — the caller
 * simply shows no "installed" markers.
 */
export async function fetchInstalledSlugs(): Promise<Set<string>> {
  const slugs = new Set<string>();
  try {
    const cfg = await resolveHubConfig();
    const res = (await hubGet("/workspaces", {}, cfg)) as {
      workspaces?: Array<{ packageSlug?: string | null }>;
    };
    for (const ws of res.workspaces ?? []) {
      if (ws.packageSlug) slugs.add(ws.packageSlug);
    }
  } catch {
    // Non-fatal: degrade to no-marker. Discovery never depends on the pod.
  }
  return slugs;
}
