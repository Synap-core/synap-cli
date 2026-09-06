import { describe, it, expect, beforeEach, vi } from "vitest";

/**
 * A private package the caller OWNS must be discoverable and installable.
 *
 * Dogfooded 2026-09-05: a user published a private CELL package and then
 *
 *   $ synap market --list --type cell
 *   ! No packages match.  …or 'synap login' to see your private packages.
 *   $ synap market install probe-card-pack
 *   ✓ Installed  → an empty "New Workspace" appeared, no cell landed.
 *
 * Two distinct causes, both covered here:
 *
 *   1. `GET /api/packages/mine` — the ONLY door a private row can arrive
 *      through — does not project `category` (CP `routes/packages.ts` selects
 *      ~15 columns; `category` is not one). So every owned row is type-less,
 *      and the CLI's display default (`entry.category ?? "workspace"`) both
 *      filtered it out of `--type cell` and classified it as a workspace.
 *   2. install then provisioned that phantom workspace.
 *
 * These tests drive the REAL transport (`cp-packages.ts`) and the REAL merge
 * (`assembleCatalog`) with only `fetch`, `auth` and the pod's installed-slug
 * read stubbed, so they fail if either the hydration or the merge precedence
 * regresses.
 */

// ── auth seam: one mutable creds box, flipped per test ──────────────────────
const creds: { value: { token: string; email: string } | null } = { value: null };

vi.mock("../src/lib/auth.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getCpUrl: () => "https://cp.test",
  getStoredToken: () => creds.value,
  isTokenLocallyExpired: () => false,
}));

vi.mock("../src/lib/installed.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  fetchInstalledSlugs: async () => new Set<string>(),
  fetchInstalledTemplates: async () => [],
}));

const { buildMarketCatalog, market } = await import("../src/commands/market.js");
const { hydrateMineCategories, MINE_CATEGORY_HYDRATION_CAP, fetchPackageRecord } =
  await import("../src/lib/cp-packages.js");

// ── fetch stub, routed by URL ───────────────────────────────────────────────
interface Fixture {
  publicRows?: unknown[];
  mineRows?: unknown[];
  /** slug → the single-package row `GET /api/packages/:slug` returns. */
  detail?: Record<string, { category?: string | null }>;
}

let calls: string[] = [];

function installFetch(fx: Fixture): void {
  calls = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      const u = String(url);
      calls.push(`${u}${(init?.headers as Record<string, string>)?.Authorization ? " +auth" : ""}`);
      const json = (body: unknown) =>
        ({ ok: true, status: 200, json: async () => body }) as unknown as Response;
      if (u.includes("/api/packages/mine")) return json({ packages: fx.mineRows ?? [] });
      if (u.includes("/api/packages/available")) return json({ packages: [] });
      if (/\/api\/packages\?/.test(u)) return json({ packages: fx.publicRows ?? [] });
      const m = u.match(/\/api\/packages\/([^/?]+)$/);
      if (m) {
        const row = fx.detail?.[decodeURIComponent(m[1]!)];
        if (!row) return { ok: false, status: 404 } as unknown as Response;
        return json({ package: { slug: decodeURIComponent(m[1]!), ...row } });
      }
      throw new Error(`unexpected fetch: ${u}`);
    }),
  );
}

const PRIVATE_CELL = {
  id: "p1",
  slug: "probe-card-pack",
  displayName: "Probe Card Pack",
  description: "dogfood cell",
  isPublic: false,
  version: "h-15c5ee1c105a",
  // NOTE: no `category` — exactly what `/mine` returns.
};

beforeEach(() => {
  creds.value = null;
  vi.unstubAllGlobals();
});

describe("hydrateMineCategories", () => {
  it("resolves a missing category through the authed single-package door", async () => {
    const fetchRecord = vi.fn(async () => ({ slug: "probe-card-pack", category: "cell" }));
    const out = await hydrateMineCategories([{ ...PRIVATE_CELL }] as never, "tok", undefined, {
      fetchRecord: fetchRecord as never,
    });
    expect(out[0]!.category).toBe("cell");
    expect(fetchRecord).toHaveBeenCalledWith("probe-card-pack", "tok");
  });

  it("prefers an already-known public category over a network round-trip", async () => {
    const fetchRecord = vi.fn(async () => null);
    const out = await hydrateMineCategories(
      [{ ...PRIVATE_CELL }] as never,
      "tok",
      new Map([["probe-card-pack", "view"]]),
      { fetchRecord: fetchRecord as never },
    );
    expect(out[0]!.category).toBe("view");
    expect(fetchRecord).not.toHaveBeenCalled();
  });

  it("leaves the category ABSENT when it cannot be resolved — never 'workspace'", async () => {
    const out = await hydrateMineCategories([{ ...PRIVATE_CELL }] as never, "tok", undefined, {
      fetchRecord: (async () => null) as never,
    });
    expect(out[0]!.category).toBeUndefined();
  });

  it("does not touch a row that already declares its category", async () => {
    const fetchRecord = vi.fn(async () => ({ slug: "x", category: "cell" }));
    const out = await hydrateMineCategories(
      [{ ...PRIVATE_CELL, category: "skill" }] as never,
      "tok",
      undefined,
      { fetchRecord: fetchRecord as never },
    );
    expect(out[0]!.category).toBe("skill");
    expect(fetchRecord).not.toHaveBeenCalled();
  });

  it("bounds the fan-out — a prolific author's list is not 100 detail requests", async () => {
    const rows = Array.from({ length: MINE_CATEGORY_HYDRATION_CAP + 12 }, (_, i) => ({
      ...PRIVATE_CELL,
      slug: `pkg-${i}`,
    }));
    const fetchRecord = vi.fn(async (slug: string) => ({ slug, category: "cell" }));
    const out = await hydrateMineCategories(rows as never, "tok", undefined, {
      fetchRecord: fetchRecord as never,
    });
    expect(fetchRecord).toHaveBeenCalledTimes(MINE_CATEGORY_HYDRATION_CAP);
    // …and the rows past the cap stay HONESTLY unknown rather than defaulted.
    expect(out.filter((r) => r.category === "cell")).toHaveLength(MINE_CATEGORY_HYDRATION_CAP);
    expect(out.filter((r) => r.category == null)).toHaveLength(12);
  });
});

describe("buildMarketCatalog — logged in", () => {
  beforeEach(() => {
    creds.value = { token: "tok", email: "a@b.c" };
  });

  it("includes the caller's own PRIVATE package, typed by its real category", async () => {
    installFetch({
      publicRows: [],
      mineRows: [PRIVATE_CELL],
      detail: { "probe-card-pack": { category: "cell" } },
    });
    const cat = await buildMarketCatalog();
    const entry = cat.entries.find((e) => e.slug === "probe-card-pack");
    expect(entry, "the caller's own private package must reach the catalog").toBeDefined();
    expect(entry!.category, "a cell package must not be typed as a workspace").toBe("cell");
    expect(entry!.isPrivate, "a private row must be flagged so the user sees WHY nobody else can see it").toBe(true);
    // The authed detail door was actually used (private rows are invisible elsewhere).
    expect(calls.some((c) => c.endsWith("/api/packages/probe-card-pack +auth"))).toBe(true);
  });

  it("survives a `--type cell` filter, which the untyped row used to fail", async () => {
    installFetch({
      publicRows: [],
      mineRows: [PRIVATE_CELL],
      detail: { "probe-card-pack": { category: "cell" } },
    });
    const cat = await buildMarketCatalog({ category: "cell" });
    expect(cat.entries.map((e) => e.slug)).toContain("probe-card-pack");
    expect(cat.entries.find((e) => e.slug === "probe-card-pack")!.category).toBe("cell");
  });

  it("dedupe: the caller's OWN row wins a slug a public package also claims", async () => {
    installFetch({
      publicRows: [
        {
          id: "pub",
          slug: "probe-card-pack",
          displayName: "Someone Else's",
          category: "view",
          version: "9.9.9",
        },
      ],
      mineRows: [PRIVATE_CELL],
      detail: { "probe-card-pack": { category: "cell" } },
    });
    const cat = await buildMarketCatalog();
    const entry = cat.entries.find((e) => e.slug === "probe-card-pack")!;
    expect(entry.name, "own row must win — it is the one the caller can actually install").toBe(
      "Probe Card Pack",
    );
    expect(entry.isPrivate).toBe(true);
    // …and the version map agrees with the merge (both say /mine wins).
    expect(cat.remoteVersionBySlug.get("probe-card-pack")).toBe("h-15c5ee1c105a");
  });
});

describe("the rendered list marks a private row as private", () => {
  it("prints the slug AND a `private` tag, so the user can see why nobody else sees it", async () => {
    creds.value = { token: "tok", email: "a@b.c" };
    installFetch({
      publicRows: [],
      mineRows: [PRIVATE_CELL],
      detail: { "probe-card-pack": { category: "cell" } },
    });
    const lines: string[] = [];
    const spy = vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => {
      lines.push(a.join(" "));
    });
    try {
      await market({ list: true, type: "cell" });
    } finally {
      spy.mockRestore();
    }
    // eslint-disable-next-line no-control-regex
    const out = lines.join("\n").replace(/\u001b\[[0-9;]*m/g, "");
    expect(out).toContain("probe-card-pack");
    const row = out.split("\n").find((l) => l.includes("probe-card-pack"))!;
    expect(row, "a private package must be badged in the human output").toContain("private");
  });
});

describe("buildMarketCatalog — logged out is unchanged", () => {
  it("fetches only the PUBLIC browse route: no /mine, no /available, no detail, no error", async () => {
    installFetch({
      publicRows: [
        { id: "x", slug: "public-thing", displayName: "Public Thing", category: "cell" },
      ],
      mineRows: [PRIVATE_CELL],
      detail: { "probe-card-pack": { category: "cell" } },
    });
    const cat = await buildMarketCatalog();
    expect(cat.loggedIn).toBe(false);
    expect(cat.entries.map((e) => e.slug)).toContain("public-thing");
    expect(cat.entries.map((e) => e.slug)).not.toContain("probe-card-pack");
    expect(calls.filter((c) => c.includes("/mine"))).toHaveLength(0);
    expect(calls.filter((c) => c.includes("/available"))).toHaveLength(0);
    expect(calls.filter((c) => c.includes("+auth"))).toHaveLength(0);
    expect(calls.filter((c) => /\/api\/packages\/[^/?]+$/.test(c))).toHaveLength(0);
  });
});

describe("fetchPackageRecord", () => {
  it("returns the category off the single-package row", async () => {
    installFetch({ detail: { "probe-card-pack": { category: "cell" } } });
    const rec = await fetchPackageRecord("probe-card-pack", "tok");
    expect(rec?.category).toBe("cell");
  });

  it("returns null (not a guess) on 404 / unreachable", async () => {
    installFetch({ detail: {} });
    expect(await fetchPackageRecord("nope", "tok")).toBeNull();
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("ECONNREFUSED"); }));
    expect(await fetchPackageRecord("nope", "tok")).toBeNull();
  });
});
