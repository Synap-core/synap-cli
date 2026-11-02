/**
 * "Does this installed package have an update?" — the POD's answer, read.
 *
 * The pod derives it ONCE for every installed kind (a space's template, the
 * overlay packs on it, capabilities, views, skills, automations) with one
 * rule: the catalog's content-hash version against the one the pod last
 * converged to (`packageHasUpdate`, `@synap-core/types/package-updates`,
 * served by Hub `GET /package-updates` → `installed[]`). Pod admin's Updates
 * tab reads the same list, so the CLI and pod admin can no longer disagree
 * (2 Nov 2026: the CLI said "brand-library: content changed" while pod admin
 * said nothing, because each derived it its own way).
 *
 * This module never compares versions. A pod that cannot answer (an older
 * pod, a key that is not a pod admin's) is said out loud by the caller:
 * never a verdict the CLI made up.
 */

import { hubGet, HubError, type HubConfig } from "./hub-client.js";
import type { InstalledKind } from "./installed.js";

/** One installed package and the pod's verdict (`PackageStanding` on the pod). */
export interface PackageStanding {
  slug: string;
  kind: InstalledKind;
  name: string;
  installedVersion: string | null;
  latestVersion: string | null;
  /** true / false = the pod compared it; null = it could not (`reason`). */
  hasUpdate: boolean | null;
  reason?: string;
}

/** Why the pod's answer could not be read. */
export type StandingsUnavailable =
  /** The key's person is not a pod admin: the pod answers updates to admins only. */
  | "not-pod-admin"
  /** The pod predates the one rule (no `GET /package-updates`, or no `installed[]`). */
  | "pod-too-old";

export class StandingsUnavailableError extends Error {
  constructor(
    readonly reason: StandingsUnavailable,
    message: string
  ) {
    super(message);
    this.name = "StandingsUnavailableError";
  }
}

const SENTENCES: Record<StandingsUnavailable, string> = {
  "not-pod-admin":
    "Only a pod admin can read the pod's package updates, and this key's person is not one. Nothing was checked.",
  "pod-too-old":
    "This pod is too old to answer which packages have an update (no installed[] on GET /package-updates). Update the pod, then run this again. Nothing was checked.",
};

/**
 * Every installed package with the pod's verdict. Throws
 * {@link StandingsUnavailableError} when the pod cannot answer, and the hub
 * error itself for anything else (unreachable, 5xx): never an empty list for
 * a read that failed.
 */
export async function fetchPackageStandings(cfg: HubConfig): Promise<PackageStanding[]> {
  let body: unknown;
  try {
    // One definition fetch per package with an update, on the pod: a cold
    // catalog can take a while.
    body = await hubGet("/package-updates", {}, cfg, 60_000);
  } catch (err) {
    if (err instanceof HubError && err.status === 403 && !/scope/i.test(`${err.message} ${err.detail ?? ""}`)) {
      throw new StandingsUnavailableError("not-pod-admin", SENTENCES["not-pod-admin"]);
    }
    if (err instanceof HubError && err.status === 404) {
      throw new StandingsUnavailableError("pod-too-old", SENTENCES["pod-too-old"]);
    }
    throw err;
  }
  const installed = (body as { installed?: unknown } | null)?.installed;
  if (!Array.isArray(installed)) {
    throw new StandingsUnavailableError("pod-too-old", SENTENCES["pod-too-old"]);
  }
  return installed as PackageStanding[];
}

/** The shape `market update` prints and returns in `checks[]`, from the pod's verdicts. */
export interface StandingCheck {
  slug: string;
  kind: InstalledKind;
  installedVersion: string;
  latestVersion: string | undefined;
  updateAvailable: boolean;
  /** No version stamp on the pod: it could not compare. */
  noVersionInfo: boolean;
  /** The pod's reason when it could not compare. */
  reason?: string;
}

/**
 * The pod's verdicts as `market update` checks. `updateAvailable` is the
 * pod's `hasUpdate === true`, nothing else: a package the pod could not
 * compare is never "up to date" (no latest version → "can't check"; no stamp
 * → "version unknown"; a space whose last update did not finish has an update
 * and no stamp → "not finished").
 */
export function checksFromStandings(standings: PackageStanding[]): StandingCheck[] {
  return standings.map((s) => ({
    slug: s.slug,
    kind: s.kind,
    installedVersion: s.installedVersion ?? "",
    latestVersion: s.hasUpdate === null && s.installedVersion ? undefined : (s.latestVersion ?? undefined),
    updateAvailable: s.hasUpdate === true,
    noVersionInfo: !s.installedVersion,
    ...(s.reason ? { reason: s.reason } : {}),
  }));
}
