/**
 * Control-plane package registry client (read-only).
 * ==================================================
 *
 * The ONE authed HTTP client for the CP package registry (`/api/packages`).
 * Before this file there was NO `/api/packages` client in the CLI — `launch`
 * read the whole catalog from the bundled `@synap-core/workspace-templates`
 * package. The ratified architecture is: PUBLIC templates ship in the bundle,
 * PRIVATE templates live in the CP behind the user's login. This client is the
 * private half.
 *
 * Two list endpoints, one detail endpoint:
 *   • GET /api/packages            — public browse rows (no auth, `definition` stripped)
 *   • GET /api/packages/mine       — the caller's own packages (Bearer, incl. private)
 *   • GET /api/packages/:slug      — full row WITH `definition` (Bearer → private visible to author)
 *
 * The row→`RemoteEntry` mapping is NOT here — it is the canonical
 * `rowToRemoteEntry` in `@synap-core/workspace-templates` (browser + CLI share
 * the ONE copy; the two hand-copies had already drifted). This file owns only
 * TRANSPORT: the Bearer token, the base URL (`auth.ts`'s `getCpUrl()`), and the
 * query params the CP `/api/packages` route supports (`search`/`category`/`tag`/
 * `verified`).
 */

import {
  rowToRemoteEntry,
  type CpPackageRow,
  type RemoteEntry,
  type RemoteSourceStatus,
} from "@synap-core/workspace-templates";
import { getCpUrl, getStoredToken, isTokenLocallyExpired } from "./auth.js";

// Packages mount under `/api/packages` (CP `routes/index.ts`), unlike `/auth`
// and `/pods` which sit at the root — hence the explicit `/api` segment here.
const packagesBase = (): string => `${getCpUrl()}/api/packages`;
const FETCH_TIMEOUT_MS = 10_000;

/**
 * The server-side filters `GET /api/packages` accepts (CP `routes/packages.ts`).
 * `category` is a PACKAGE_TYPES value (`workspace`/`capability`/`skill`/…). The
 * `/mine` route supports none of these — it is the caller's own small set — so
 * they are applied CLIENT-side there.
 */
export interface PackageFilters {
  search?: string;
  category?: string;
  tag?: string;
  verified?: boolean;
}

/** Tier / pricing signal the browse route carries but `RemoteEntry` drops. */
export interface TierInfo {
  requiredTier?: string | null;
  pricingModel?: string | null;
}

/**
 * A public browse row — the canonical `CpPackageRow` PLUS the tier/pricing and
 * count fields the browse route (`GET /api/packages`) returns but the shared
 * `RemoteEntry` shape does not carry. Kept local because they are a
 * discovery-surface concern, not part of the merge door's contract.
 */
export interface CpBrowseRow extends CpPackageRow {
  version?: string;
  requiredTier?: string | null;
  pricingModel?: string | null;
  isVerified?: boolean;
  installCount?: number;
}

/** `/mine` returns `isPublic` on top of the canonical row shape. */
type CpMineRow = CpPackageRow & { isPublic?: boolean };

/** Build the `/api/packages` query string from filters + any extra params. */
function buildQuery(
  filters: PackageFilters | undefined,
  extra: Record<string, string>,
): string {
  const p = new URLSearchParams(extra);
  if (filters?.search) p.set("search", filters.search);
  if (filters?.category) p.set("category", filters.category);
  if (filters?.tag) p.set("tag", filters.tag);
  if (filters?.verified) p.set("verified", "true");
  return p.toString();
}

/** An auth failure (401/403) — distinct from an unreachable-network failure. */
class CpAuthError extends Error {
  readonly authFailed = true;
}

/**
 * GET /api/packages — public browse rows, RAW (incl. `requiredTier`/
 * `pricingModel`/`category`). No auth. Throws on non-2xx / network. This is the
 * source both the merged launch catalog and the `market` command read from.
 */
export async function fetchPublicBrowseRows(
  filters?: PackageFilters,
): Promise<CpBrowseRow[]> {
  const qs = buildQuery(filters, { limit: "100" });
  const res = await fetch(`${packagesBase()}?${qs}`, {
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`CP GET /api/packages → HTTP ${res.status}`);
  const data = (await res.json()) as { packages?: CpBrowseRow[] };
  return data.packages ?? [];
}

/** GET /api/packages — public workspace templates as `RemoteEntry`. No auth. */
export async function fetchPublicPackages(
  filters?: PackageFilters,
): Promise<RemoteEntry[]> {
  const rows = await fetchPublicBrowseRows(filters);
  // Browse rows are all public by construction — pass `isPrivate` undefined.
  return rows.map((r) => rowToRemoteEntry(r, undefined));
}

/**
 * GET /api/packages/mine — the caller's own packages (incl. private). Bearer
 * required. The route has no `search`/`category` params, so those filters are
 * applied client-side over this (small) set; `search` is honored, `category`
 * only when the row actually carries one (the `/mine` select omits it, so a
 * type filter never silently drops the user's own rows).
 */
export async function fetchMyPackages(
  token: string,
  filters?: PackageFilters,
): Promise<RemoteEntry[]> {
  const res = await fetch(`${packagesBase()}/mine?limit=100`, {
    headers: { Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (res.status === 401 || res.status === 403) {
    throw new CpAuthError(`CP GET /api/packages/mine → HTTP ${res.status}`);
  }
  if (!res.ok) throw new Error(`CP GET /api/packages/mine → HTTP ${res.status}`);
  const data = (await res.json()) as { packages?: CpMineRow[] };
  let rows = data.packages ?? [];
  if (filters?.category) {
    rows = rows.filter((r) => r.category == null || r.category === filters.category);
  }
  if (filters?.search) {
    const q = filters.search.toLowerCase();
    rows = rows.filter(
      (r) =>
        r.slug.toLowerCase().includes(q) ||
        r.displayName.toLowerCase().includes(q) ||
        (r.description ?? "").toLowerCase().includes(q),
    );
  }
  return rows.map((r) => rowToRemoteEntry(r, r.isPublic === false ? true : undefined));
}

/**
 * GET /api/packages/available — the slugs THIS account's subscription tier can
 * install (Bearer required; the route reads the user's `subscriptions.tier`).
 * Used to compute the "locked" set: a public package that declares a
 * `requiredTier` but is absent here is ungrantable for this account. Only
 * `category` is a real filter on this route — the others are ignored server-side.
 */
export async function fetchAvailableSlugs(
  token: string,
  filters?: PackageFilters,
): Promise<Set<string>> {
  const qs = buildQuery({ category: filters?.category }, { limit: "100" });
  const res = await fetch(`${packagesBase()}/available?${qs}`, {
    headers: { Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`CP GET /api/packages/available → HTTP ${res.status}`);
  const data = (await res.json()) as { packages?: Array<{ slug: string }> };
  return new Set((data.packages ?? []).map((p) => p.slug));
}

/**
 * GET /api/packages/:slug — the full row, INCLUDING `definition` (the install
 * payload). Authed when a token is given, which is REQUIRED for a private
 * template (the author-only visibility gate 404s otherwise). Returns `null` if
 * the package is absent / not visible.
 */
export async function fetchPackageDefinition(
  slug: string,
  token?: string,
): Promise<Record<string, unknown> | null> {
  const res = await fetch(`${packagesBase()}/${encodeURIComponent(slug)}`, {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!res.ok) return null;
  const data = (await res.json()) as {
    package?: { definition?: Record<string, unknown>; category?: string };
  };
  return data.package?.definition ?? null;
}

/** The remote half of the catalog, plus the health `mergeCatalog` needs. */
export interface RemoteCatalog {
  rows: RemoteEntry[];
  status: RemoteSourceStatus;
  loggedIn: boolean;
  email?: string;
  /** How many private rows we actually fetched (meaningful only when status === "ok"). */
  privateCount: number;
  /** Tier/pricing per public slug — the browse route carries it, `RemoteEntry` drops it. */
  tierBySlug: Map<string, TierInfo>;
  /**
   * Slugs that declare a `requiredTier` this account CANNOT install (browse ∖
   * `/available`). Empty when logged out or when `/available` couldn't be read
   * (older pod / failure) — absence means "unknown", never "locked".
   */
  lockedSlugs: Set<string>;
}

/**
 * Assemble the remote catalog for `launch`, degrading HONESTLY rather than
 * failing open empty:
 *
 *   • Logged out → NO network. The bundle already IS the public catalog, and
 *     private templates are invisible without auth. Status "unauthenticated"
 *     tells the consumer to render the `synap login` path.
 *   • Logged in → fetch `/mine` (private + own public) and best-effort `/packages`
 *     (official / third-party public); merge, private-carrying rows win a tie.
 *   • `/mine` 401/403 → "unauthenticated" (session expired). Network failure →
 *     "unreachable". Either way `rows` is empty and the door keeps the bundle.
 */
export async function fetchRemoteCatalog(
  filters?: PackageFilters,
): Promise<RemoteCatalog> {
  const creds = getStoredToken();
  const loggedIn = !!creds && !isTokenLocallyExpired(creds);

  if (!loggedIn) {
    return {
      rows: [],
      status: "unauthenticated",
      loggedIn: false,
      privateCount: 0,
      tierBySlug: new Map(),
      lockedSlugs: new Set(),
    };
  }

  let publicRows: CpBrowseRow[] = [];
  let mineRows: RemoteEntry[] = [];
  let availableSlugs: Set<string> | null = null;
  try {
    [publicRows, mineRows, availableSlugs] = await Promise.all([
      // Public is best-effort: a private catalog that resolves is still useful
      // even if the browse route hiccups.
      fetchPublicBrowseRows(filters).catch(() => [] as CpBrowseRow[]),
      fetchMyPackages(creds!.token, filters),
      // Tier gate is best-effort: an older pod without `/available` ⇒ null ⇒
      // "unknown", never "locked".
      fetchAvailableSlugs(creds!.token, filters).catch(() => null),
    ]);
  } catch (e) {
    const authFailed = (e as { authFailed?: boolean }).authFailed === true;
    return {
      rows: [],
      status: authFailed ? "unauthenticated" : "unreachable",
      loggedIn: true,
      email: creds!.email,
      privateCount: 0,
      tierBySlug: new Map(),
      lockedSlugs: new Set(),
    };
  }

  const tierBySlug = new Map<string, TierInfo>();
  const lockedSlugs = new Set<string>();
  for (const r of publicRows) {
    if (r.requiredTier != null || r.pricingModel != null) {
      tierBySlug.set(r.slug, {
        requiredTier: r.requiredTier ?? null,
        pricingModel: r.pricingModel ?? null,
      });
    }
    // Locked = declares a tier this account's `/available` set doesn't include.
    if (availableSlugs && r.requiredTier && !availableSlugs.has(r.slug)) {
      lockedSlugs.add(r.slug);
    }
  }

  // Dedup by slug; `/mine` rows overwrite public ones so the private flag wins.
  const bySlug = new Map<string, RemoteEntry>();
  for (const r of publicRows) bySlug.set(r.slug, rowToRemoteEntry(r, undefined));
  for (const r of mineRows) bySlug.set(r.slug, r);
  const rows = [...bySlug.values()];

  return {
    rows,
    status: "ok",
    loggedIn: true,
    email: creds!.email,
    privateCount: rows.filter((r) => r.isPrivate).length,
    tierBySlug,
    lockedSlugs,
  };
}
