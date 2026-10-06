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
 * catalog. The publish logic is NOT here: it is the ONE lib in the monorepo
 * checkout (`synap-app/packages/workspace-templates/scripts/publish-official-lib.mjs`).
 * So the wire tests below drive the REAL lib from the sibling checkout through
 * an injected fetch — skipped (never vacuously passed) when the sibling is
 * absent, the `it.runIf` shape `frame-import-map-parity.test.ts` established.
 */

const CHECKOUT = join(process.cwd(), "../synap-app/packages/workspace-templates");
const hasCheckout = existsSync(join(CHECKOUT, "scripts/publish-official-lib.mjs"));

const OFFICIAL = { id: "5e9ae5e1-57b2-4a6a-b280-f586cf88b439", slug: "synap-official" };
const CREDS = {
  token: "tok",
  userId: "9c197945-0000-0000-0000-000000000000",
  email: "f@synap.live",
  expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
};

type Call = { url: string; method: string; body?: any };

function fakeCp(opts: { vendor?: unknown; live?: Record<string, unknown> } = {}) {
  const calls: Call[] = [];
  const fetchImpl = (async (url: string, init: RequestInit = {}) => {
    const method = init.method ?? "GET";
    const body = init.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ url, method, body });
    const json = (status: number, payload: unknown) =>
      new Response(JSON.stringify(payload), { status, headers: { "content-type": "application/json" } });
    if (url.endsWith("/api/vendors/mine")) return json(200, { vendor: opts.vendor ?? OFFICIAL });
    if (method === "GET" && url.includes("/api/packages/")) {
      const slug = decodeURIComponent(url.split("/api/packages/")[1]);
      const row = opts.live?.[slug];
      return row ? json(200, { package: row }) : json(404, { error: "Package not found" });
    }
    if (method === "POST" && url.endsWith("/api/packages")) {
      return json(200, { package: { slug: body.slug, version: "h-next", definition: body.definition } });
    }
    return json(500, { error: `unexpected ${method} ${url}` });
  }) as unknown as typeof fetch;
  return { calls, fetchImpl };
}

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
      loadLib: async () => {
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
    expect(JSON.parse(expired.text).message).toMatch(/synap login/);
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
  });

  it("dry run shows added/removed profiles, the removal warning and the stamp, and writes nothing", async () => {
    const { calls, fetchImpl } = fakeCp({
      live: {
        "content-os": {
          slug: "content-os",
          version: "h-448ffcae9220",
          authorId: CREDS.userId,
          definition: {
            profiles: [{ slug: "post", properties: [{ slug: "post-status" }] }, { slug: "legacy-thing" }],
          },
        },
      },
    });
    const { code, text } = await run(["content-os"], { dryRun: true }, { fetchImpl });
    expect(code).toBe(0);
    expect(text).toMatch(/UPDATED\s+content-os/);
    expect(text).toMatch(/\+ profiles: .*content-composition/);
    expect(text).toMatch(/− profiles: legacy-thing/);
    expect(text).toMatch(/sourcePackage: none → \d+\.\d+\.\d+/);
    expect(text).toMatch(/pod reconciler is add-only/);
    expect(calls.filter((c) => c.method === "POST")).toHaveLength(0);
  });

  it("--yes POSTs with the official vendorId and definition.sourcePackage", async () => {
    const { calls, fetchImpl } = fakeCp();
    const { code, text } = await run(["content-os"], { yes: true, json: true }, { fetchImpl });
    expect(code).toBe(0);
    const posts = calls.filter((c) => c.method === "POST");
    expect(posts).toHaveLength(1);
    expect(posts[0].body.vendorId).toBe(OFFICIAL.id);
    expect(posts[0].body.definition.sourcePackage).toMatchObject({
      name: "@synap-core/workspace-templates",
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
