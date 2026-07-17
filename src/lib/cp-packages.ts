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
 * Transport is intentionally NOT in `@synap-core/workspace-templates` (that
 * package stays pure — see `catalog.ts`). It reuses `auth.ts`'s `getCpUrl()`
 * base URL and stored Bearer token — NO new `CP_URL` literal.
 */

import type {
  RemoteEntry,
  RemoteSourceStatus,
} from "@synap-core/workspace-templates";
import { getCpUrl, getStoredToken, isTokenLocallyExpired } from "./auth.js";

// Packages mount under `/api/packages` (CP `routes/index.ts`), unlike `/auth`
// and `/pods` which sit at the root — hence the explicit `/api` segment here.
const packagesBase = (): string => `${getCpUrl()}/api/packages`;
const FETCH_TIMEOUT_MS = 10_000;

/** Common subset the two list DTOs share; `/mine` additionally returns `isPublic`. */
interface CpPackageListRow {
  slug: string;
  displayName: string;
  description?: string | null;
  category?: string;
  tags?: string[] | null;
  icon?: string | null;
  /** Present only on `/mine` rows. `false` ⇒ private. */
  isPublic?: boolean;
}

/**
 * Map a CP list row into the merge door's `RemoteEntry` shape. List endpoints
 * strip `definition`, so it is always absent here — which the door reads as
 * "no version signal ⇒ bundle wins", and the install path resolves on demand.
 */
function rowToRemoteEntry(
  row: CpPackageListRow,
  opts: { fromMine: boolean },
): RemoteEntry {
  return {
    slug: row.slug,
    name: row.displayName,
    description: row.description ?? undefined,
    category: row.category,
    tags: row.tags ?? [],
    icon: row.icon ?? null,
    // Browse rows are all public by construction — leave `isPrivate` undefined
    // (⇒ public), never "unknown-so-hide". `/mine` rows carry the real flag.
    isPrivate: opts.fromMine ? row.isPublic === false : undefined,
  };
}

/** An auth failure (401/403) — distinct from an unreachable-network failure. */
class CpAuthError extends Error {
  readonly authFailed = true;
}

/** GET /api/packages — public workspace templates. No auth. Throws on non-2xx / network. */
export async function fetchPublicPackages(): Promise<RemoteEntry[]> {
  const res = await fetch(`${packagesBase()}?category=workspace&limit=100`, {
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`CP GET /api/packages → HTTP ${res.status}`);
  const data = (await res.json()) as { packages?: CpPackageListRow[] };
  return (data.packages ?? []).map((r) => rowToRemoteEntry(r, { fromMine: false }));
}

/** GET /api/packages/mine — the caller's own packages (incl. private). Bearer required. */
export async function fetchMyPackages(token: string): Promise<RemoteEntry[]> {
  const res = await fetch(`${packagesBase()}/mine?limit=100`, {
    headers: { Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (res.status === 401 || res.status === 403) {
    throw new CpAuthError(`CP GET /api/packages/mine → HTTP ${res.status}`);
  }
  if (!res.ok) throw new Error(`CP GET /api/packages/mine → HTTP ${res.status}`);
  const data = (await res.json()) as { packages?: CpPackageListRow[] };
  return (data.packages ?? []).map((r) => rowToRemoteEntry(r, { fromMine: true }));
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
    package?: { definition?: Record<string, unknown> };
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
export async function fetchRemoteCatalog(): Promise<RemoteCatalog> {
  const creds = getStoredToken();
  const loggedIn = !!creds && !isTokenLocallyExpired(creds);

  if (!loggedIn) {
    return { rows: [], status: "unauthenticated", loggedIn: false, privateCount: 0 };
  }

  let publicRows: RemoteEntry[] = [];
  let mineRows: RemoteEntry[] = [];
  try {
    [publicRows, mineRows] = await Promise.all([
      // Public is best-effort: a private catalog that resolves is still useful
      // even if the browse route hiccups.
      fetchPublicPackages().catch(() => [] as RemoteEntry[]),
      fetchMyPackages(creds!.token),
    ]);
  } catch (e) {
    const authFailed = (e as { authFailed?: boolean }).authFailed === true;
    return {
      rows: [],
      status: authFailed ? "unauthenticated" : "unreachable",
      loggedIn: true,
      email: creds!.email,
      privateCount: 0,
    };
  }

  // Dedup by slug; `/mine` rows overwrite public ones so the private flag wins.
  const bySlug = new Map<string, RemoteEntry>();
  for (const r of publicRows) bySlug.set(r.slug, r);
  for (const r of mineRows) bySlug.set(r.slug, r);
  const rows = [...bySlug.values()];

  return {
    rows,
    status: "ok",
    loggedIn: true,
    email: creds!.email,
    privateCount: rows.filter((r) => r.isPrivate).length,
  };
}
