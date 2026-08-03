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
  };
}

/**
 * `PATCH /api/packages/:slug` — owner-gated flip of a package to private.
 *
 * ⚠️ TODO(cp): the CP PATCH handler's body validator is
 * `z.object({ podId: z.string().min(1).nullable() })` TODAY — it does NOT accept
 * `isPublic`, so this call currently fails (400) until the CP adds `isPublic` to
 * that PATCH allow-list. This is deliberately the INTENDED endpoint (not a
 * faked flip): it will start working the moment the CP door is widened. The
 * command surfaces the CP's message honestly meanwhile.
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
