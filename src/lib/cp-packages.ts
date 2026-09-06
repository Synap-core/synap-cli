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
import type { PackageDefinitionLike } from "./template-file.js";

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

/** `/mine` returns `isPublic` (and, like the browse route, `version`) on top of the canonical row shape. */
export type CpMineRow = CpPackageRow & { isPublic?: boolean; version?: string };

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
export async function fetchMyRows(
  token: string,
  filters?: PackageFilters,
): Promise<CpMineRow[]> {
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
  return rows;
}

export async function fetchMyPackages(
  token: string,
  filters?: PackageFilters,
): Promise<RemoteEntry[]> {
  const rows = await fetchMyRows(token, filters);
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
 * The single-package row `GET /api/packages/:slug` returns. The CP hands back
 * the WHOLE `synap_packages` row (`getTableColumns`), so unlike the `/mine`
 * list projection this one DOES carry `category` — which is why it is the door
 * that can answer "what kind of package is this private thing I own?".
 */
export interface CpPackageRecord {
  slug: string;
  category?: string | null;
  definition?: Record<string, unknown> | null;
  isPublic?: boolean;
  displayName?: string;
}

/**
 * GET /api/packages/:slug — the full row (definition + `category` + visibility).
 * Authed when a token is given, which is REQUIRED for a private package (the
 * author-only visibility gate 404s otherwise). Returns `null` if the package is
 * absent / not visible / unreachable.
 *
 * This is the ONE authed single-package read; `fetchPackageDefinition` and the
 * category hydration below both go through it rather than re-rolling the fetch.
 */
export async function fetchPackageRecord(
  slug: string,
  token?: string,
): Promise<CpPackageRecord | null> {
  let res: Response;
  try {
    res = await fetch(`${packagesBase()}/${encodeURIComponent(slug)}`, {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
  } catch {
    return null; // unreachable — "unknown", never a guessed answer
  }
  if (!res.ok) return null;
  const data = (await res.json().catch(() => null)) as {
    package?: CpPackageRecord;
  } | null;
  return data?.package ?? null;
}

/**
 * GET /api/packages/:slug — just the `definition` (the install payload).
 * Delegates to {@link fetchPackageRecord}; kept as its own name because most
 * call sites want only the payload.
 */
export async function fetchPackageDefinition(
  slug: string,
  token?: string,
): Promise<Record<string, unknown> | null> {
  const rec = await fetchPackageRecord(slug, token);
  return rec?.definition ?? null;
}

/**
 * How many `/mine` rows will be hydrated over the network in one catalog build.
 * Bounded so a prolific author's `synap market --list` can't fan out to 100
 * detail requests. Beyond the cap the extra rows keep an ABSENT category —
 * honest under-resolution, which the install refusal then catches.
 */
export const MINE_CATEGORY_HYDRATION_CAP = 25;

/** Bounded-concurrency map — small, local, and only used by the hydration below. */
async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      out[i] = await fn(items[i]!);
    }
  });
  await Promise.all(workers);
  return out;
}

/**
 * Fill in the `category` the `/mine` LIST PROJECTION does not select.
 *
 * `GET /api/packages/mine` projects ~15 columns and `category` is not one of
 * them (`synap-control-plane-api/src/routes/packages.ts`), so every row the
 * caller owns arrives type-less. Downstream that is not cosmetic: the CLI's
 * display default turns an absent category into "workspace", which is exactly
 * how a published CELL package was listed as a workspace, filtered out of
 * `--type cell`, and installed as an empty "New Workspace".
 *
 * Resolution order per row, cheapest first:
 *   1. the row already declares a category → untouched;
 *   2. `fallbackBySlug` — a category already known from the PUBLIC browse rows
 *      this catalog build fetched anyway (free, no extra request);
 *   3. `GET /api/packages/:slug` with the caller's Bearer — the only door that
 *      can see a PRIVATE row's category.
 *
 * A failure at step 3 leaves the category ABSENT. It never invents one: "I
 * don't know" must stay distinguishable from "workspace".
 */
export async function hydrateMineCategories(
  rows: CpMineRow[],
  token: string,
  fallbackBySlug?: Map<string, string | undefined>,
  deps: { fetchRecord?: typeof fetchPackageRecord } = {},
): Promise<CpMineRow[]> {
  const fetchRecord = deps.fetchRecord ?? fetchPackageRecord;

  const patched = rows.map((r) => {
    if (r.category != null) return r;
    const fromPublic = fallbackBySlug?.get(r.slug);
    return fromPublic != null ? { ...r, category: fromPublic } : r;
  });

  const needing = patched.filter((r) => r.category == null).slice(0, MINE_CATEGORY_HYDRATION_CAP);
  if (needing.length === 0) return patched;

  const resolved = new Map<string, string>();
  await mapWithConcurrency(needing, 5, async (r) => {
    const rec = await fetchRecord(r.slug, token);
    if (rec?.category != null) resolved.set(r.slug, rec.category);
  });

  return patched.map((r) =>
    r.category == null && resolved.has(r.slug)
      ? { ...r, category: resolved.get(r.slug)! }
      : r,
  );
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

// ─── WRITE half: publish / unpublish ────────────────────────────────────────
// Everything above is GET-only. These are the CLI's publish-loop write door to
// `POST /api/packages` (upsert on (slug, authorId), content-hash version) and
// `PATCH /api/packages/:slug` (owner-gated). All CP HTTP goes through THIS file
// — the command layer never hand-rolls a `fetch`.

/**
 * A CP write failure carrying the server's OWN message + status, so the caller
 * can surface `detail` (never swallow it — the `readErrorBody`/`detail` lesson)
 * and special-case a 403 reserved-slug rejection.
 */
export class CpWriteError extends Error {
  constructor(
    readonly status: number,
    readonly serverMessage: string,
  ) {
    super(serverMessage);
    this.name = "CpWriteError";
  }
}

/** Test seams — inject a fetch + token + base URL instead of touching the network / `~/.synap`. */
export interface CpWriteDeps {
  fetchImpl?: typeof fetch;
  token?: string;
  cpUrl?: string;
}

export interface PublishResult {
  /** `created` (201) · `updated` (200, content changed) · `no-op` (200, identical content). */
  outcome: "created" | "updated" | "no-op";
  slug: string;
  displayName: string;
  /** The `h-<hash>` version the CP derived from the definition. */
  version: string;
  isPublic: boolean;
  /**
   * Whether the package was attributed to a publisher profile. False means the
   * author has no vendor yet, so this package will never appear on
   * `GET /api/vendors/:slug` — the command says so and points at
   * `synap vendor create`, because the CP never back-fills attribution later.
   */
  vendorAttached: boolean;
}

/**
 * Extract the human cause from a CP error body, mirroring `hub-client`'s
 * `readErrorBody` precedence (message → error+detail → error → detail) so the
 * SPECIFIC cause in `detail` is never thrown away for the generic `error`.
 */
function extractServerMessage(raw: string, status: number): string {
  const trimmed = raw.trim();
  if (!trimmed) return `HTTP ${status}`;
  try {
    const o = JSON.parse(trimmed) as {
      error?: unknown;
      detail?: unknown;
      message?: unknown;
      issues?: unknown;
    };
    const str = (v: unknown) =>
      typeof v === "string" && v.trim() ? v.trim() : undefined;
    const err = str(o.error);
    const detail = str(o.detail);
    const msg = str(o.message);
    const base = msg ?? (err && detail ? `${err}: ${detail}` : (err ?? detail));
    if (base) {
      if (Array.isArray(o.issues) && o.issues.length) {
        return `${base} (${o.issues.length} validation issue(s))`;
      }
      return base;
    }
  } catch {
    // not JSON — fall through to the plain-text body
  }
  return trimmed.length > 200 ? `${trimmed.slice(0, 200)}…` : trimmed;
}

function requireToken(deps: CpWriteDeps): string {
  const token = deps.token ?? getStoredToken()?.token;
  if (!token) throw new CpWriteError(401, "Not logged in — run: synap login");
  return token;
}

/**
 * `POST /api/packages` — publish (upsert) a package definition under the caller's
 * account. `isPublic` decides visibility (default private — the command flips it
 * with `--public`). The version is DERIVED server-side from the definition, so
 * identical content re-published is a no-op. Surfaces a 403 reserved-slug
 * rejection (and any other failure) as a `CpWriteError` carrying the server's
 * own message.
 *
 * The definition's identity (`slug`, `displayName`) is read off its `_meta`/
 * `workspaceName` by default (the workspace-template shape); `opts.slug`/
 * `opts.displayName` override that for a standalone (non-workspace) package —
 * e.g. a `category: "cell"` file, which has neither field (see
 * `lib/kind-package.ts`). `_meta.icon`/`.color`/`.domain` are hoisted onto the
 * definition's top level because the CP reads those off `definition.icon`/… for
 * the list DTO (it strips the unknown `_meta` key).
 */
/**
 * The caller's vendor (publisher) profile, or null if they have never created one.
 *
 * `GET /api/vendors/mine` — an existing authed door; this adds no new endpoint.
 *
 * WHY publish needs it: the CP's publish handler is `if (body.vendorId) { … }`
 * with NO else (`routes/packages.ts:1465`) — it never auto-creates and never
 * infers one. The CLI has never sent the field, so every CLI-published package
 * is permanently ORPHANED from its author's publisher profile and can never
 * appear on `GET /api/vendors/:slug`. Vendor identity is already load-bearing
 * elsewhere (reserved bedrock slugs gate on `isOfficialVendor`), so an orphaned
 * package is not cosmetic.
 *
 * Failure is non-fatal by design: publishing must not break because a publisher
 * profile does not exist yet. No vendor ⇒ publish exactly as before.
 */
export async function fetchMyVendorId(
  base: string,
  token: string,
  fetchImpl: typeof fetch = fetch,
): Promise<string | null> {
  try {
    const res = await fetchImpl(`${base}/api/vendors/mine`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!res.ok) return null;
    const json = (await res.json()) as { vendor?: { id?: string } | null };
    return json?.vendor?.id ?? null;
  } catch {
    return null;
  }
}

/**
 * A publisher (vendor) profile — the author identity a package is attributed to.
 * Only the fields the CLI prints; the CP returns the whole row.
 */
export interface VendorProfile {
  id: string;
  slug: string;
  displayName: string;
}

/**
 * `POST /api/vendors` — create the caller's publisher profile.
 *
 * WHY the CLI needs its own verb: the endpoint is self-serve and the BROWSER
 * already calls it inline (`PublishWizard.tsx`'s Publisher step, which blocks
 * the wizard until a vendor exists). The CLI only ever READ one
 * (`fetchMyVendorId`), so a CLI-only author had no way to make one and every
 * package they published was attributed to nobody — no `/superpowers/by/<slug>`
 * page, permanently, since the CP never auto-creates or back-fills a vendor.
 *
 * The contract mirrors the wizard's call exactly — same endpoint, same field
 * names (`slug`, `displayName`, `description`, `website`) — with ONE deliberate
 * difference: empty optionals are OMITTED rather than sent as `""`. The CP
 * declares `website: z.string().url().optional()`, so an empty string is a 400;
 * the wizard sends its blank fields unconditionally and hits that.
 *
 * Errors surface as `CpWriteError` carrying the server's own message: the CP
 * returns 409 both for "you already have a vendor profile" and for a taken slug,
 * and those are the two an author actually hits.
 */
export async function createVendor(
  input: {
    slug: string;
    displayName: string;
    description?: string;
    website?: string;
  },
  deps: CpWriteDeps = {},
): Promise<VendorProfile> {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const token = requireToken(deps);
  const base = deps.cpUrl ?? getCpUrl();

  const res = await fetchImpl(`${base}/api/vendors`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      slug: input.slug,
      displayName: input.displayName,
      ...(input.description ? { description: input.description } : {}),
      ...(input.website ? { website: input.website } : {}),
    }),
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });

  if (!res.ok) {
    const raw = await res.text().catch(() => "");
    throw new CpWriteError(res.status, extractServerMessage(raw, res.status));
  }

  const data = (await res.json()) as { vendor?: VendorProfile };
  if (!data?.vendor?.id) {
    throw new CpWriteError(0, "The control plane returned no vendor profile.");
  }
  return data.vendor;
}

export async function publishPackage(
  def: PackageDefinitionLike,
  opts: { isPublic: boolean; category?: string; slug?: string; displayName?: string },
  deps: CpWriteDeps = {},
): Promise<PublishResult> {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const token = requireToken(deps);
  const base = deps.cpUrl ?? getCpUrl();

  const slug = opts.slug ?? def._meta?.slug;
  const displayName = opts.displayName ?? def.workspaceName;
  if (!slug) throw new CpWriteError(0, "Template has no slug (meta.slug) — cannot publish");
  if (!displayName)
    throw new CpWriteError(0, "Template has no workspace name — cannot publish");

  // Best-effort pre-read of the caller's OWN row for this slug, so a
  // content-identical no-op is told apart from an in-place update (the CP
  // returns 200 for both). A failure here only loses that precision.
  let priorVersion: string | undefined;
  let existed = false;
  try {
    const pre = await fetchImpl(`${base}/api/packages/mine?limit=100`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (pre.ok) {
      const data = (await pre.json()) as { packages?: CpMineRow[] };
      const row = (data.packages ?? []).find((r) => r.slug === slug);
      if (row) {
        existed = true;
        priorVersion = row.version;
      }
    }
  } catch {
    // best-effort
  }

  const definition = {
    ...def,
    icon: def._meta?.icon ?? def.icon,
    color: def._meta?.color ?? def.color,
    domain: def._meta?.domain ?? def.domain,
  };

  // Best-effort: a package published without it is orphaned from its author's
  // publisher profile forever (the CP has no auto-create and no back-fill).
  // A failure here must never block a publish, so this resolves to null.
  const vendorId = await fetchMyVendorId(base, token, fetchImpl);

  const res = await fetchImpl(`${base}/api/packages`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      slug,
      displayName,
      description: def.description,
      isPublic: opts.isPublic,
      tags: def._meta?.tags,
      category: opts.category ?? "workspace",
      // Attribute the package to the author's publisher profile when they have
      // one. Omitted (not null) when they do not — the CP branches on presence.
      ...(vendorId ? { vendorId } : {}),
      definition,
    }),
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });

  if (!res.ok) {
    const raw = await res.text().catch(() => "");
    throw new CpWriteError(res.status, extractServerMessage(raw, res.status));
  }

  const data = (await res.json()) as {
    package?: { version?: string; isPublic?: boolean };
  };
  const version = data.package?.version ?? "";
  const outcome: PublishResult["outcome"] =
    res.status === 201
      ? "created"
      : existed && priorVersion === version
        ? "no-op"
        : "updated";

  return {
    outcome,
    slug,
    displayName,
    version,
    isPublic: data.package?.isPublic ?? opts.isPublic,
    vendorAttached: !!vendorId,
  };
}

/**
 * `PATCH /api/packages/:slug` — owner-gated flip of a package to private.
 *
 * ✅ RESOLVED 2026-09-05 — this block used to carry a TODO saying the CP's PATCH
 * validator accepted only `podId` and that this call therefore 400'd. That is no
 * longer true: the handler declares `isPublic: z.boolean().optional()`
 * (`synap-control-plane-api/src/routes/packages.ts:1618`) and the flip works.
 * Kept as a tombstone rather than deleted because the stale warning outlived its
 * fix and would otherwise keep sending readers to "widen the CP door" work that
 * is already done — the same way a stale comment sent an auditor down the wrong
 * path on `kind-package.ts` a day earlier.
 *
 * Note the browser uses `DELETE /api/packages/:slug` for the same act; both
 * doors now route through the CP's shared owned-package helpers and both are a
 * SOFT delist (`is_public = false`), never a destroy.
 */
export async function unpublishPackage(
  slug: string,
  deps: CpWriteDeps = {},
): Promise<{ slug: string; isPublic: boolean }> {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const token = requireToken(deps);
  const base = deps.cpUrl ?? getCpUrl();

  const res = await fetchImpl(
    `${base}/api/packages/${encodeURIComponent(slug)}`,
    {
      method: "PATCH",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ isPublic: false }),
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    },
  );
  if (!res.ok) {
    const raw = await res.text().catch(() => "");
    throw new CpWriteError(res.status, extractServerMessage(raw, res.status));
  }
  const data = (await res.json()) as { isPublic?: boolean };
  return { slug, isPublic: data.isPublic ?? false };
}
