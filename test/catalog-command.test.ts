import { describe, it, expect } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CATALOG_ERROR_HINTS,
  catalogLibShapeError,
  catalogUsageError,
  findCatalogDir,
  formatDiff,
  runCatalog,
  type CatalogDeps,
  type CatalogOpts,
} from "../src/commands/catalog.js";
import { marketPublishOfficial } from "../src/commands/market-official.js";

/**
 * `synap catalog validate|diff|publish` — the command WIRING, with the catalog
 * lib MOCKED (the real lib lives in synap-app and is driven by
 * `market-publish-official.test.ts` when the checkout has it). The mock records
 * every call so the tests assert what the CLI hands the lib, and what it never
 * calls.
 */

const CREDS = {
  token: "tok",
  userId: "9c197945-0000-0000-0000-000000000000",
  email: "f@synap.live",
  expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
};

/** A fake checkout: the catalog package.json + an (empty) lib file on disk. */
function fakeCheckout(name = "@synap-core/workspace-templates"): string {
  const root = mkdtempSync(join(tmpdir(), "synap-catalog-"));
  const pkg = join(root, "synap-app/packages/workspace-templates");
  mkdirSync(join(pkg, "scripts"), { recursive: true });
  writeFileSync(join(pkg, "package.json"), JSON.stringify({ name }));
  writeFileSync(join(pkg, "scripts/catalog-lib.mjs"), "// mocked in tests\n");
  return root;
}

const ENTRY = (kind: string, slug: string) => ({
  kind,
  slug,
  path: `${kind}s/${slug}.yaml`,
  meta: { slug },
  spec: {},
  dependencies: [],
  publishBody: { slug },
});

function mockLib(over: { problems?: unknown[]; validate?: unknown[]; diff?: unknown[]; entries?: unknown[] } = {}) {
  const calls: Array<{ fn: string; args: unknown }> = [];
  const lib = {
    loadCatalog: async (args: { root?: string; kinds?: string[]; slugs?: string[] }) => {
      calls.push({ fn: "loadCatalog", args: { kinds: args.kinds, slugs: args.slugs, hasRoot: typeof args.root === "string" } });
      const all = (over.entries as any[]) ?? [ENTRY("workspace", "content-os"), ENTRY("workspace", "foundation"), ENTRY("capability", "agency-skills")];
      const corpus = all.filter((e) => !args.kinds || args.kinds.includes(e.kind));
      const entries = corpus.filter((e) => !args.slugs || args.slugs.includes(e.slug));
      return { entries, corpus, problems: over.problems ?? [] };
    },
    // Like the real lib: a dependency must resolve in the CORPUS it is handed
    // (default: the entries themselves) — content-os composes foundation.
    validateCatalog: async (entries: any[], opts: { corpus?: any[] } = {}) => {
      const corpus = opts.corpus ?? entries;
      calls.push({ fn: "validateCatalog", args: { slugs: entries.map((e) => e.slug), corpus: corpus.length } });
      const dangling = entries.some((e) => e.slug === "content-os") && !corpus.some((e) => e.slug === "foundation")
        ? [{ severity: "error", code: "dangling-ref", kind: "workspace", slug: "content-os", message: "dependency workspace:foundation resolves to no catalog entry" }]
        : [];
      return [...dangling, ...((over.validate as any[]) ?? [])];
    },
    diffCatalog: async (entries: any[], opts: { cpUrl: string; token?: string }) => {
      calls.push({ fn: "diffCatalog", args: { slugs: entries.map((e) => e.slug), cpUrl: opts.cpUrl, token: opts.token } });
      return over.diff ?? entries.map((e) => ({ kind: e.kind, slug: e.slug, status: "changed", hashBefore: "h-a", hashAfter: "h-b" }));
    },
    publishCatalog: async (opts: any) => {
      calls.push({
        fn: "publishCatalog",
        args: { slugs: opts.entries.map((e: any) => e.slug), corpus: opts.corpus?.length, cpUrl: opts.cpUrl, token: opts.token, official: opts.official, dryRun: opts.dryRun },
      });
      return opts.entries.map((e: any) => ({ kind: e.kind, slug: e.slug, outcome: "updated" }));
    },
  };
  return { lib, calls };
}

async function run(
  verb: string,
  slugs: string[],
  opts: CatalogOpts,
  deps: Partial<CatalogDeps> & { lib?: unknown } = {},
) {
  const lines: string[] = [];
  const { lib, ...rest } = deps;
  const code = await runCatalog(verb, slugs, opts, {
    cwd: rest.cwd ?? fakeCheckout(),
    credentials: CREDS,
    cpUrl: "https://cp.test",
    isInteractive: false,
    importLib: async () => lib,
    out: (l) => lines.push(l),
    ...rest,
  });
  return { code, text: lines.join("\n") };
}

describe("argument parsing", () => {
  it("rejects an unknown verb, an unknown kind, a file path, and publish-only flags elsewhere", () => {
    expect(catalogUsageError("ship", [], {})).toMatch(/Unknown catalog command/);
    expect(catalogUsageError("validate", [], { kind: "playbook" })).toMatch(/Unknown --kind "playbook"/);
    expect(catalogUsageError("diff", ["./x.yaml"], {})).toMatch(/SLUGS, not a file/);
    expect(catalogUsageError("validate", [], { dryRun: true })).toMatch(/only apply to "synap catalog publish"/);
    expect(catalogUsageError("diff", [], { official: true })).toMatch(/only apply/);
    expect(catalogUsageError("publish", [], {})).toMatch(/pass --official/);
    for (const kind of ["workspace", "capability", "skill", "pack", "automation"]) {
      expect(catalogUsageError("publish", ["a-slug"], { kind, official: true })).toBeNull();
    }
  });

  it("a usage error exits 2 before loading the lib", async () => {
    let loaded = false;
    const { code } = await run("publish", [], { kind: "nope", official: true }, {
      importLib: async () => {
        loaded = true;
        return {};
      },
    });
    expect(code).toBe(2);
    expect(loaded).toBe(false);
  });

  it("hands the lib --kind and the slugs, and refuses a slug the catalog does not have", async () => {
    const { lib, calls } = mockLib();
    const ok = await run("validate", ["content-os"], { kind: "workspace" }, { lib });
    expect(ok.code).toBe(0);
    expect(calls[0]).toEqual({ fn: "loadCatalog", args: { kinds: ["workspace"], slugs: undefined, hasRoot: true } });
    // One slug is validated against the WHOLE corpus (its compose dep is another entry).
    expect(calls[1]).toEqual({ fn: "validateCatalog", args: { slugs: ["content-os"], corpus: 2 } });
    const all = await run("validate", [], {}, { lib: mockLib().lib });
    expect(all.code).toBe(0);

    const missing = await run("validate", ["ghost"], { kind: "workspace", json: true }, { lib: mockLib().lib });
    expect(missing.code).toBe(1);
    expect(JSON.parse(missing.text).problems).toEqual([expect.objectContaining({ slug: "ghost", code: "unknown-slug" })]);
  });

  it("validate never reads credentials; diff passes the token only when the session is valid", async () => {
    const v = mockLib();
    expect((await run("validate", [], {}, { lib: v.lib, credentials: null })).code).toBe(0);
    const d = mockLib();
    expect((await run("diff", [], {}, { lib: d.lib, credentials: null })).code).toBe(0);
    expect(d.calls.find((c) => c.fn === "diffCatalog")?.args).toMatchObject({ token: undefined, cpUrl: "https://cp.test" });
    const d2 = mockLib();
    await run("diff", [], {}, { lib: d2.lib });
    expect(d2.calls.find((c) => c.fn === "diffCatalog")?.args).toMatchObject({ token: "tok" });
    expect(d2.calls.some((c) => c.fn === "publishCatalog")).toBe(false);
  });

  it("validation errors stop diff and publish; warnings do not", async () => {
    const bad = mockLib({ validate: [{ kind: "workspace", slug: "content-os", message: "goal uses @{arg:}" }] });
    const r = await run("publish", [], { official: true, yes: true }, { lib: bad.lib });
    expect(r.code).toBe(1);
    expect(r.text).toMatch(/workspace\/content-os: goal uses @\{arg:\}/);
    expect(bad.calls.map((c) => c.fn)).toEqual(["loadCatalog", "validateCatalog"]);

    const warn = mockLib({ problems: [{ severity: "warning", message: "system/* not checked (no sibling)" }] });
    expect((await run("diff", [], {}, { lib: warn.lib })).code).toBe(0);
  });
});

describe("the lib shape check", () => {
  it("names every missing export instead of crashing", () => {
    expect(catalogLibShapeError({}, "/x/catalog-lib.mjs")).toMatch(
      /missing or not a function: loadCatalog, validateCatalog, diffCatalog, publishCatalog/,
    );
    const { lib } = mockLib();
    expect(catalogLibShapeError(lib, "/x")).toBeNull();
    expect(catalogLibShapeError({ ...lib, diffCatalog: "nope" }, "/x")).toMatch(/: diffCatalog\./);
  });

  it("an old checkout's lib (publish-official exports only) fails clearly, nothing is called", async () => {
    const old = { planOfficialPublish: async () => ({}), executeOfficialPublish: async () => [] };
    const { code, text } = await run("publish", [], { official: true, yes: true, json: true }, { lib: old });
    expect(code).toBe(1);
    const body = JSON.parse(text);
    expect(body).toMatchObject({ ok: false, error: "lib-load-failed" });
    expect(body.message).toMatch(/does not export the catalog interface/);
  });

  it("a checkout with no catalog-lib.mjs on disk says to pull, without importing", async () => {
    const root = mkdtempSync(join(tmpdir(), "synap-catalog-old-"));
    const pkg = join(root, "synap-app/packages/workspace-templates");
    mkdirSync(pkg, { recursive: true });
    writeFileSync(join(pkg, "package.json"), JSON.stringify({ name: "@synap-core/workspace-templates" }));
    let imported = false;
    const { code, text } = await run("validate", [], { json: true }, {
      cwd: root,
      importLib: async () => {
        imported = true;
        return {};
      },
    });
    expect(code).toBe(1);
    expect(JSON.parse(text)).toMatchObject({ message: expect.stringMatching(/catalog-lib\.mjs not found/), hint: expect.stringMatching(/Pull synap-app/) });
    expect(imported).toBe(false);
  });

  it("a lib whose loadCatalog returns the wrong shape is refused, not crashed on", async () => {
    const { lib } = mockLib();
    const weird = { ...lib, loadCatalog: async () => ({ templates: [] }) };
    const { code, text } = await run("validate", [], { json: true }, { lib: weird });
    expect(code).toBe(1);
    expect(JSON.parse(text)).toMatchObject({ error: "lib-shape" });
  });
});

describe("publish safety", () => {
  it("--dry-run previews the diff and NEVER calls publishCatalog", async () => {
    const { lib, calls } = mockLib();
    const { code, text } = await run("publish", [], { official: true, dryRun: true }, { lib });
    expect(code).toBe(0);
    expect(text).toMatch(/CHANGED\s+workspace\/content-os\s+h-a → h-b/);
    expect(calls.map((c) => c.fn)).toEqual(["loadCatalog", "validateCatalog", "diffCatalog"]);
  });

  it("--dry-run --yes still never publishes", async () => {
    const { lib, calls } = mockLib();
    expect((await run("publish", [], { official: true, dryRun: true, yes: true }, { lib })).code).toBe(0);
    expect(calls.some((c) => c.fn === "publishCatalog")).toBe(false);
  });

  it("publish needs a session and a confirmation; a declined one publishes nothing", async () => {
    const a = mockLib();
    const none = await run("publish", [], { official: true, yes: true, json: true }, { lib: a.lib, credentials: null });
    expect(JSON.parse(none.text)).toMatchObject({ error: "not-logged-in" });
    const nonInteractive = await run("publish", [], { official: true, json: true }, { lib: a.lib });
    expect(JSON.parse(nonInteractive.text)).toMatchObject({ error: "confirmation-required" });
    expect(a.calls).toHaveLength(0);

    const b = mockLib();
    const declined = await run("publish", [], { official: true }, { lib: b.lib, isInteractive: true, confirm: async () => false });
    expect(declined.code).toBe(1);
    expect(b.calls.some((c) => c.fn === "publishCatalog")).toBe(false);
  });

  it("a confirmed publish hands the lib official:true, dryRun:false and the CP session", async () => {
    const { lib, calls } = mockLib();
    let asked = "";
    const { code } = await run("publish", [], { official: true, kind: "capability" }, {
      lib,
      isInteractive: true,
      confirm: async (q) => {
        asked = q;
        return true;
      },
    });
    expect(code).toBe(0);
    expect(asked).toMatch(/Publish 1 catalog entry \(capability\)/);
    expect(calls.at(-1)).toEqual({
      fn: "publishCatalog",
      args: { slugs: ["agency-skills"], corpus: 1, cpUrl: "https://cp.test", token: "tok", official: true, dryRun: false },
    });
  });
});

describe("alias parity: market publish --official === catalog publish --official --kind workspace", () => {
  async function both(slugs: string[], flags: { dryRun?: boolean; yes?: boolean; json?: boolean }) {
    const cwd = fakeCheckout();
    const viaCatalog = mockLib();
    const viaMarket = mockLib();
    const lc: string[] = [];
    const lm: string[] = [];
    const base = { cwd, credentials: CREDS, cpUrl: "https://cp.test", isInteractive: false };
    const c = await runCatalog("publish", slugs, { official: true, kind: "workspace", ...flags }, {
      ...base,
      importLib: async () => viaCatalog.lib,
      out: (l) => lc.push(l),
    });
    const m = await marketPublishOfficial(slugs, { official: true, ...flags }, {
      ...base,
      importLib: async () => viaMarket.lib,
      out: (l) => lm.push(l),
    });
    return { c, m, catalogCalls: viaCatalog.calls, marketCalls: viaMarket.calls, lc, lm };
  }

  it.each([
    ["dry run, all", [], { dryRun: true }],
    ["dry run, one slug", ["content-os"], { dryRun: true, json: true }],
    ["publish --yes", [], { yes: true, json: true }],
    ["refusal (no --yes, non-interactive)", [], { json: true }],
  ] as const)("%s: same lib calls, same output, same exit", async (_n, slugs, flags) => {
    const r = await both([...slugs], flags);
    expect(r.m).toBe(r.c);
    expect(r.marketCalls).toEqual(r.catalogCalls);
    expect(r.lm).toEqual(r.lc);
    if (r.catalogCalls.length > 0) {
      expect(r.marketCalls[0]).toMatchObject({ fn: "loadCatalog", args: { kinds: ["workspace"] } });
    }
  });

  it("the market spelling keeps its own usage errors (a file, --from-workspace) and loads nothing", async () => {
    let loaded = false;
    const code = await marketPublishOfficial(["./x.yaml"], { official: true, json: true }, {
      cwd: fakeCheckout(),
      credentials: CREDS,
      out: () => {},
      importLib: async () => {
        loaded = true;
        return {};
      },
    });
    expect(code).toBe(2);
    expect(loaded).toBe(false);
  });
});

describe("locating the checkout", () => {
  it("prefers @synap-core/catalog over the workspace-templates shim, identified by NAME", () => {
    const root = fakeCheckout();
    const cat = join(root, "synap-app/packages/catalog");
    mkdirSync(cat, { recursive: true });
    writeFileSync(join(cat, "package.json"), JSON.stringify({ name: "@synap-core/catalog" }));
    expect(findCatalogDir(join(root, "synap-app"))).toBe(cat);
    expect(findCatalogDir(root, "synap-app/packages/workspace-templates")).toBe(
      join(root, "synap-app/packages/workspace-templates"),
    );
    const impostor = mkdtempSync(join(tmpdir(), "synap-catalog-imp-"));
    writeFileSync(join(impostor, "package.json"), JSON.stringify({ name: "other" }));
    expect(findCatalogDir(impostor, ".")).toBeNull();
  });
});

// ── One read path ────────────────────────────────────────────────────────────

describe("one read path: every kind comes from the catalog package", () => {
  it("validate and diff never ask the lib for the CP repo's capabilities, even when it still offers them", async () => {
    const cpRoot = mkdtempSync(join(tmpdir(), "synap-cp-"));
    for (const verb of ["validate", "diff"]) {
      const m = mockLib();
      let cpAsked = false;
      const lib = {
        ...m.lib,
        DEFAULT_SIBLING_REPOS: { cp: cpRoot },
        cpCapabilitySource: async () => {
          cpAsked = true;
          return { root: cpRoot };
        },
        mergeCatalogs: () => {
          cpAsked = true;
          return { entries: [], corpus: [], problems: [] };
        },
      };
      expect((await run(verb, [], { kind: "capability" }, { lib })).code).toBe(0);
      expect(cpAsked).toBe(false);
      expect(m.calls.filter((c) => c.fn === "loadCatalog")).toEqual([{ fn: "loadCatalog", args: { kinds: ["capability"], slugs: undefined, hasRoot: true } }]);
    }
  });
});

// ── Official preflight (checkPublisher) ────────────────────────────────────

describe("official preflight before the preview", () => {
  const NOT_OFFICIAL = {
    official: false,
    reason: "not-official-publisher",
    message: 'This account is not the official Synap publisher (its vendor is "acme").',
    vendor: { slug: "acme" },
  };
  function withPreflight(answer: unknown) {
    const m = mockLib();
    const lib = {
      ...m.lib,
      checkPublisher: async (opts: { cpUrl: string; token?: string }) => {
        m.calls.push({ fn: "checkPublisher", args: { cpUrl: opts.cpUrl, token: opts.token } });
        if (answer instanceof Error) throw answer;
        return answer;
      },
    };
    return { lib, calls: m.calls };
  }

  it("publish: a non-official account is refused BEFORE the diff, the question and any write", async () => {
    const { lib, calls } = withPreflight(NOT_OFFICIAL);
    let asked = false;
    const r = await run("publish", [], { official: true, json: true }, { lib, isInteractive: true, confirm: async () => (asked = true) });
    expect(r.code).toBe(1);
    expect(JSON.parse(r.text)).toMatchObject({ ok: false, error: "not-official-publisher", hint: CATALOG_ERROR_HINTS["not-official-publisher"] });
    expect(calls.map((c) => c.fn)).toEqual(["loadCatalog", "validateCatalog", "checkPublisher"]);
    expect(asked).toBe(false);
  });

  it("publish --dry-run is refused the same way (no preview of a publish that cannot happen)", async () => {
    const { lib, calls } = withPreflight(NOT_OFFICIAL);
    expect((await run("publish", [], { official: true, dryRun: true }, { lib })).code).toBe(1);
    expect(calls.some((c) => c.fn === "diffCatalog")).toBe(false);
  });

  it("diff: warns that publishing would be refused, and still shows the diff", async () => {
    const { lib, calls } = withPreflight(NOT_OFFICIAL);
    const human = await run("diff", [], {}, { lib });
    expect(human.code).toBe(0);
    expect(human.text).toContain(CATALOG_ERROR_HINTS["not-official-publisher"]);
    expect(calls.map((c) => c.fn)).toEqual(["loadCatalog", "validateCatalog", "checkPublisher", "diffCatalog"]);
    const json = await run("diff", [], { json: true }, { lib: withPreflight(NOT_OFFICIAL).lib });
    expect(JSON.parse(json.text)).toMatchObject({ ok: true, publishable: false, publishRefusal: { code: "not-official-publisher" } });
  });

  it("an official account goes on to the diff and publish, the session token handed to the preflight", async () => {
    const { lib, calls } = withPreflight({ official: true, vendor: { id: "v", slug: "synap-official" } });
    expect((await run("publish", [], { official: true, yes: true }, { lib })).code).toBe(0);
    expect(calls.find((c) => c.fn === "checkPublisher")?.args).toEqual({ cpUrl: "https://cp.test", token: "tok" });
    expect(calls.at(-1)?.fn).toBe("publishCatalog");
  });

  it("a FAILED preflight read is a failure with its code, never a warning (diff included)", async () => {
    const down = Object.assign(new Error("Could not reach the control plane"), { code: "cp-unreachable" });
    const { lib, calls } = withPreflight(down);
    const r = await run("diff", [], { json: true }, { lib });
    expect(r.code).toBe(1);
    expect(JSON.parse(r.text)).toMatchObject({ error: "cp-unreachable", hint: CATALOG_ERROR_HINTS["cp-unreachable"] });
    expect(calls.some((c) => c.fn === "diffCatalog")).toBe(false);
  });
});

// ── One error table ──────────────────────────────────────────────────────────

const SRC = readFileSync(join(process.cwd(), "src/commands/catalog.ts"), "utf8");
const LIB_DIR = join(process.cwd(), "../synap-app/packages/workspace-templates/scripts");
const hasLib = existsSync(join(LIB_DIR, "catalog-lib.mjs"));

describe("one error table: every code has exactly one next step", () => {
  it("every code this command fails with is in CATALOG_ERROR_HINTS (derived from the source)", () => {
    const own = [...SRC.matchAll(/fail\(\s*"([a-z-]+)"/g)].map((m) => m[1]!);
    expect(own.length).toBeGreaterThanOrEqual(5); // non-vacuity: the scan still sees the fail() calls
    expect(own).toContain("checkout-not-found"); // self-check on a literal sample
    for (const code of own) expect(CATALOG_ERROR_HINTS, code).toHaveProperty(code);
  });

  it("no remedy is spelled twice: every hint is distinct, and none is hand-written into a fail() message", () => {
    const hints = Object.values(CATALOG_ERROR_HINTS);
    expect(new Set(hints).size).toBe(hints.length);
    expect(SRC.match(/run: synap login/g)?.length).toBe(1); // only in the table
    expect(SRC).not.toMatch(/Pull synap-app\./);
  });

  it.runIf(hasLib)("covers every code the checkout's lib can throw (its .d.mts union AND its literal throws)", () => {
    const dts = readFileSync(join(LIB_DIR, "catalog-lib.d.mts"), "utf8");
    const union = dts.match(/export type CatalogErrorCode =([^;]+);/)?.[1] ?? "";
    const fromTypes = [...union.matchAll(/'([a-z-]+)'/g)].map((m) => m[1]!);
    const mjs = readFileSync(join(LIB_DIR, "catalog-lib.mjs"), "utf8");
    const fromThrows = [...mjs.matchAll(/OfficialPublishError\(\s*'([a-z-]+)'/g)].map((m) => m[1]!);
    expect(fromTypes.length).toBeGreaterThanOrEqual(8);
    expect(fromThrows).toContain("not-official-publisher");
    for (const code of new Set([...fromTypes, ...fromThrows])) expect(CATALOG_ERROR_HINTS, code).toHaveProperty(code);
  });
});

describe.runIf(hasLib)("the CLI's typed lib surface declares no option the lib does not accept", () => {
  it("every CatalogLoadOptions key is a key of the lib's LoadOptions", () => {
    const keysOf = (src: string, iface: string) => {
      const body = src.match(new RegExp(`export interface ${iface} \\{([\\s\\S]*?)\\n\\}`))?.[1] ?? "";
      return [...body.matchAll(/^\s+([A-Za-z]+)\??:/gm)].map((m) => m[1]!);
    };
    const cli = keysOf(SRC, "CatalogLoadOptions");
    const lib = keysOf(readFileSync(join(LIB_DIR, "catalog-lib.d.mts"), "utf8"), "LoadOptions");
    expect(cli).toContain("root"); // non-vacuity: both scans still see the interfaces
    expect(lib).toContain("compiler");
    expect(cli.filter((k) => !lib.includes(k))).toEqual([]);
  });
});

// ── The real lib, every kind (sibling checkout) ─────────────────────────────

describe.runIf(hasLib)("catalog validate over EVERY kind, against the real checkout", () => {
  it("is clean, and capabilities come from the catalog package (no CP read)", async () => {
    const lines: string[] = [];
    const code = await runCatalog("validate", [], { json: true, catalogDir: join(LIB_DIR, "..") }, { cwd: process.cwd(), out: (l) => lines.push(l) });
    const body = JSON.parse(lines.join("\n"));
    expect(body.problems.filter((p: { severity?: string }) => p.severity !== "warning")).toEqual([]);
    expect(code).toBe(0);
    expect(body.entries).toBeGreaterThanOrEqual(70);
    const cap = await runCatalog("validate", [], { json: true, kind: "capability", catalogDir: join(LIB_DIR, "..") }, { cwd: process.cwd(), out: () => {} });
    expect(cap).toBe(0);
  }, 60_000);
});

describe("the preview names what changes", () => {
  it("prints each changed column and a content-version change, so a source-only flip reads as one", () => {
    const text = formatDiff([
      {
        kind: "capability",
        slug: "fireflies",
        status: "changed",
        hashBefore: "h-a",
        hashAfter: "h-a",
        columns: [{ column: "source", before: "file-seed", after: "api" }],
      },
      {
        kind: "capability",
        slug: "proton",
        status: "changed",
        hashBefore: "h-a",
        hashAfter: "h-b",
        columns: [],
      },
    ]);
    expect(text).toContain('capability/fireflies  h-a → h-a\n      ~ source: "file-seed" → "api"');
    expect(text).not.toMatch(/fireflies[^\n]*\n\s+~ definition/);
    expect(text).toContain("capability/proton  h-a → h-b\n      ~ definition: new content version");
  });
});
