/**
 * Test seam for `market update`: the pod's verdicts (`GET /package-updates`
 * → `installed[]`) built from a test's mocked inventory rows, so a test that
 * describes what is installed keeps doing so in one place. `drift` stands
 * for the pod's `hasUpdate`.
 */
import type { PackageStanding } from "../../src/lib/package-updates.js";

export async function standingsFromMockedInventory(): Promise<PackageStanding[]> {
  const { fetchInstalledInventoryStrict } = await import("../../src/lib/installed.js");
  const { rows } = await fetchInstalledInventoryStrict();
  return rows
    .filter((r) => !!r.packageSlug)
    .map((r) => ({
      slug: r.packageSlug!,
      kind: r.kind,
      name: r.name,
      installedVersion: r.installedVersion,
      latestVersion: r.latestVersion,
      hasUpdate: r.drift,
    }));
}
