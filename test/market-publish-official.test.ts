import { describe, it, expect } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  findTemplatesDir,
  marketPublishOfficial,
  nonOfficialUsageError,
  officialUsageError,
  type OfficialPublishDeps,
} from "../src/commands/market-official.js";

/**
 * `synap market publish --official` — the founder's door to the official
 * catalog, an alias of `synap catalog publish --official --kind workspace`.
 * The publish logic is NOT here: it is the ONE catalog lib in the monorepo
 * checkout (`synap-app/packages/workspace-templates/scripts/catalog-lib.mjs`).
 * So the wire tests below drive the REAL lib from the sibling checkout through
 * an injected fetch — skipped (never vacuously passed) when the sibling is
 * absent, the `it.runIf` shape `frame-import-map-parity.test.ts` established.
 */

const CHECKOUT = join(process.cwd(), "../synap-app/packages/workspace-templates");
const hasCheckout = existsSync(join(CHECKOUT, "scripts/catalog-lib.mjs"));

const OFFICIAL = { id: "5e9ae5e1-57b2-4a6a-b280-f586cf88b439", slug: "synap-official" };
const CREDS = {
  token: "tok",
  userId: "9c197945-0000-0000-0000-000000000000",
  email: "f@synap.live",
  expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
};

type Call = { url: string; method: string; body?: any };

/** A catalog row as the CP stores it (only the columns the preview reads). */
type Row = {
  id: string;
  slug: string;
  category: string;
  version: string;
  vendorId?: string | null;
  authorId?: string | null;
  createdAt: string;
  definition: Record<string, unknown>;
};

/**
 * THE ADOPTION RULE, as `GET /api/packages/:slug?category=` answers it: rows
 * of that slug AND category owned by the official vendor or unowned (no vendor,
 * no author); official first, then oldest, then lowest id. `undefined` = 404.
 */
function adoptionPick(rows: Row[], slug: string, category: string): Row | undefined {
  return rows
    .filter((r) => r.slug === slug && r.category === category)
    .filter((r) => r.vendorId === OFFICIAL.id || (r.vendorId == null && r.authorId == null))
    .sort(
      (a, b) =>
        Number(b.vendorId === OFFICIAL.id) - Number(a.vendorId === OFFICIAL.id) ||
        a.createdAt.localeCompare(b.createdAt) ||
        a.id.localeCompare(b.id),
    )[0];
}

/**
 * A fake control plane answering the reads the lib's preview makes:
 *   GET /api/vendors/mine
 *   GET /api/packages/:slug?category=<kind>   → the adoption pick, else 404
 *   GET /api/packages/:slug/:version          → that row, else 404
 *   GET /api/packages?search=&category=&limit=&offset=  → { packages, total }
 *   POST /api/packages
 * Anything else is a 500, which the lib treats as a failed read.
 */
function fakeCp(opts: { vendor?: unknown; rows?: Row[] } = {}) {
  const calls: Call[] = [];
  const rows = opts.rows ?? [];
  const fetchImpl = (async (url: string, init: RequestInit = {}) => {
    const method = init.method ?? "GET";
    const body = init.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ url, method, body });
    const json = (status: number, payload: unknown) =>
      new Response(JSON.stringify(payload), { status, headers: { "content-type": "application/json" } });
    const notFound = () => json(404, { error: "Package not found" });
    const u = new URL(url);
    const parts = u.pathname.split("/").filter(Boolean).map(decodeURIComponent); // ["api", "packages", slug?, version?]
    if (method === "GET" && u.pathname === "/api/vendors/mine") return json(200, { vendor: opts.vendor ?? OFFICIAL });
    if (method === "GET" && u.pathname === "/api/packages") {
      const search = u.searchParams.get("search") ?? "";
      const category = u.searchParams.get("category");
      const limit = Number(u.searchParams.get("limit") ?? 20);
      const offset = Number(u.searchParams.get("offset") ?? 0);
      const hits = rows.filter((r) => r.slug.includes(search) && (!category || r.category === category));
      return json(200, { packages: hits.slice(offset, offset + limit), total: hits.length });
    }
    if (method === "GET" && parts[0] === "api" && parts[1] === "packages" && parts.length === 3) {
      const category = u.searchParams.get("category");
      if (!category) return json(500, { error: "the preview must pass ?category=" });
      const row = adoptionPick(rows, parts[2], category);
      return row ? json(200, { package: row }) : notFound();
    }
    if (method === "GET" && parts[0] === "api" && parts[1] === "packages" && parts.length === 4) {
      const row = rows.find((r) => r.slug === parts[2] && r.version === parts[3]);
      return row ? json(200, { package: row }) : notFound();
    }
    if (method === "POST" && u.pathname === "/api/packages") {
      return json(200, { package: { slug: body.slug, version: "h-next", definition: body.definition } });
    }
    return json(500, { error: `unexpected ${method} ${url}` });
  }) as unknown as typeof fetch;
  return { calls, fetchImpl };
}

const officialContentOs = (over: Partial<Row> = {}): Row => ({
  id: "row-official",
  slug: "content-os",
  category: "workspace",
  version: "h-448ffcae9220",
  vendorId: OFFICIAL.id,
  authorId: CREDS.userId,
  createdAt: "2026-09-01T00:00:00Z",
  definition: { profiles: [{ slug: "legacy-thing" }] },
  ...over,
});

function run(slugs: string[], opts: Record<string, unknown>, deps: Partial<OfficialPublishDeps> = {}) {
  const lines: string[] = [];
  const done = marketPublishOfficial(slugs, { official: true, templatesDir: CHECKOUT, ...opts }, {
    cwd: process.cwd(),
    credentials: CREDS,
    cpUrl: "https://cp.test",
    isInteractive: false,
    out: (l) => lines.push(l),
    ...deps,
  });
  return done.then((code) => ({ code, text: lines.join("\n") }));
}

describe("usage errors", () => {
  it("--official refuses a file, --from-workspace, --from-project, visibility and price", () => {
    expect(officialUsageError("./my.template.yaml", {})).toMatch(/SLUGS, not a file/);
    expect(officialUsageError(undefined, { fromWorkspace: "w" })).toMatch(/--from-workspace/);
    expect(officialUsageError(undefined, { fromProject: "p" })).toMatch(/--from-project/);
    expect(officialUsageError(undefined, { public: true })).toMatch(/isPublic/);
    expect(officialUsageError(undefined, { price: "5" })).toMatch(/--price/);
    expect(officialUsageError(undefined, {})).toBeNull();
  });

  it("a file passed with --official exits 2 before loading anything or touching the network", async () => {
    let loaded = false;
    const { calls, fetchImpl } = fakeCp();
    const { code } = await run(["content-os", "./content-os.yaml"], {}, {
      fetchImpl,
      importLib: async () => {
        loaded = true;
        throw new Error("must not load");
      },
    });
    expect(code).toBe(2);
    expect(loaded).toBe(false);
    expect(calls).toHaveLength(0);
  });

  it("--dry-run / --yes / --templates-dir without --official, or two files, are usage errors", () => {
    expect(nonOfficialUsageError([], { dryRun: true })).toMatch(/only apply with --official/);
    expect(nonOfficialUsageError([], { yes: true })).toMatch(/only apply with --official/);
    expect(nonOfficialUsageError(["a.yaml", "b.yaml"], {})).toMatch(/one file at a time/);
    expect(nonOfficialUsageError(["a.yaml"], {})).toBeNull();
  });
});

describe("locating the checkout", () => {
  it("walks up from cwd to synap-app/packages/workspace-templates by package NAME", () => {
    const root = mkdtempSync(join(tmpdir(), "synap-official-"));
    const pkg = join(root, "synap-app/packages/workspace-templates");
    mkdirSync(pkg, { recursive: true });
    writeFileSync(join(pkg, "package.json"), JSON.stringify({ name: "@synap-core/workspace-templates" }));
    const deep = join(root, "synap-cli/src/commands");
    mkdirSync(deep, { recursive: true });
    expect(findTemplatesDir(deep)).toBe(pkg);
    // A dir with the right PATH but the wrong package name is not it.
    const impostor = mkdtempSync(join(tmpdir(), "synap-official-"));
    mkdirSync(join(impostor, "packages/workspace-templates"), { recursive: true });
    writeFileSync(join(impostor, "packages/workspace-templates/package.json"), JSON.stringify({ name: "other" }));
    expect(findTemplatesDir(impostor, "packages/workspace-templates")).toBeNull();
  });

  it("a cwd outside any checkout is a clear refusal", async () => {
    const outside = mkdtempSync(join(tmpdir(), "synap-nowhere-"));
    const lines: string[] = [];
    const code = await marketPublishOfficial([], { official: true, json: true }, {
      cwd: outside,
      credentials: CREDS,
      out: (l) => lines.push(l),
    });
    expect(code).toBe(1);
    expect(JSON.parse(lines.join("\n"))).toMatchObject({ ok: false, error: "checkout-not-found" });
  });
});

describe("auth", () => {
  it("no session / expired session → run synap login, no network", async () => {
    const { calls, fetchImpl } = fakeCp();
    const none = await run([], { json: true }, { credentials: null, fetchImpl });
    expect(none.code).toBe(1);
    expect(JSON.parse(none.text)).toMatchObject({ error: "not-logged-in" });
    const expired = await run([], { json: true }, {
      credentials: { ...CREDS, expiresAt: "2000-01-01T00:00:00Z" },
      fetchImpl,
    });
    // The remedy lives in the one error table (`hint`), the message says what happened.
    expect(JSON.parse(expired.text)).toMatchObject({ error: "not-logged-in", message: expect.stringMatching(/expired/), hint: expect.stringMatching(/synap login/) });
    expect(calls).toHaveLength(0);
  });

  it("non-interactive without --yes or --dry-run refuses rather than publish", async () => {
    const { calls, fetchImpl } = fakeCp();
    const { code, text } = await run([], { json: true }, { fetchImpl });
    expect(code).toBe(1);
    expect(JSON.parse(text)).toMatchObject({ error: "confirmation-required" });
    expect(calls).toHaveLength(0);
  });
});

describe.runIf(hasCheckout)("against the REAL lib in the checkout", () => {
  it("preflight: an account that is not synap-official is refused, nothing is POSTed", async () => {
    const { calls, fetchImpl } = fakeCp({ vendor: { id: "v-1", slug: "antoine" } });
    const { code, text } = await run(["content-os"], { yes: true, json: true }, { fetchImpl });
    expect(code).toBe(1);
    expect(JSON.parse(text)).toMatchObject({ ok: false, error: "not-official-publisher" });
    expect(calls.filter((c) => c.method === "POST")).toHaveLength(0);
    // Refused by the read-only preflight BEFORE the preview: not one live row is read.
    expect(calls.map((c) => c.url)).toEqual(["https://cp.test/api/vendors/mine"]);
  });

  it("dry run previews the diff against the row the publish adopts, and writes nothing", async () => {
    const { calls, fetchImpl } = fakeCp({ rows: [officialContentOs()] });
    const { code, text } = await run(["content-os"], { dryRun: true }, { fetchImpl });
    expect(code).toBe(0);
    expect(text).toMatch(/CHANGED\s+workspace\/content-os/);
    expect(calls.filter((c) => c.method === "POST")).toHaveLength(0);
    // the live row was read for THIS kind
    expect(calls.some((c) => c.url.startsWith("https://cp.test/api/packages/content-os?category=workspace"))).toBe(true);
  });

  it("a same-slug row of ANOTHER kind is never the target: the preview says NEW", async () => {
    const { fetchImpl } = fakeCp({ rows: [officialContentOs({ category: "capability" })] });
    const { code, text } = await run(["content-os"], { dryRun: true }, { fetchImpl });
    expect(code).toBe(0);
    expect(text).toMatch(/NEW\s+workspace\/content-os/);
  });

  it("a failed live read is an error, never NEW", async () => {
    const { fetchImpl: ok } = fakeCp({ rows: [officialContentOs()] });
    const failing = (async (url: string, init?: RequestInit) =>
      String(url).includes("/api/packages/content-os?")
        ? new Response(JSON.stringify({ error: "boom" }), { status: 502 })
        : ok(url, init)) as unknown as typeof fetch;
    const { code, text } = await run(["content-os"], { dryRun: true, json: true }, { fetchImpl: failing });
    expect(code).toBe(1);
    expect(JSON.parse(text)).toMatchObject({ ok: false, error: "live-read-failed" });
  });

  it("--yes POSTs with the official vendorId and definition.sourcePackage", async () => {
    const { calls, fetchImpl } = fakeCp();
    const { code, text } = await run(["content-os"], { yes: true, json: true }, { fetchImpl });
    expect(code).toBe(0);
    const posts = calls.filter((c) => c.method === "POST");
    expect(posts).toHaveLength(1);
    expect(posts[0].body.vendorId).toBe(OFFICIAL.id);
    expect(posts[0].body.definition.sourcePackage).toMatchObject({
      name: expect.stringMatching(/^@synap-core\/(catalog|workspace-templates)$/),
      version: expect.stringMatching(/^\d+\.\d+\.\d+$/),
    });
    expect(JSON.parse(text)).toMatchObject({ ok: true, results: [{ slug: "content-os", stampStored: true }] });
  });

  it("a declined confirmation publishes nothing", async () => {
    const { calls, fetchImpl } = fakeCp();
    const { code } = await run(["content-os"], {}, { fetchImpl, isInteractive: true, confirm: async () => false });
    expect(code).toBe(1);
    expect(calls.filter((c) => c.method === "POST")).toHaveLength(0);
  });
});
