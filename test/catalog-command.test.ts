import { describe, it, expect } from "vitest";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  catalogLibShapeError,
  catalogUsageError,
  findCatalogDir,
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
    loadCatalog: async (args: { kinds?: string[]; slugs?: string[] }) => {
      calls.push({ fn: "loadCatalog", args });
      const all = (over.entries as any[]) ?? [ENTRY("workspace", "content-os"), ENTRY("capability", "agency-skills")];
      const entries = all.filter(
        (e) => (!args.kinds || args.kinds.includes(e.kind)) && (!args.slugs || args.slugs.includes(e.slug)),
      );
      return { entries, problems: over.problems ?? [] };
    },
    validateCatalog: async (entries: unknown[]) => {
      calls.push({ fn: "validateCatalog", args: (entries as any[]).map((e) => e.slug) });
      return over.validate ?? [];
    },
    diffCatalog: async (entries: any[], opts: { cpUrl: string; token?: string }) => {
      calls.push({ fn: "diffCatalog", args: { slugs: entries.map((e) => e.slug), cpUrl: opts.cpUrl, token: opts.token } });
      return over.diff ?? entries.map((e) => ({ kind: e.kind, slug: e.slug, status: "changed", hashBefore: "h-a", hashAfter: "h-b" }));
    },
    publishCatalog: async (opts: any) => {
      calls.push({
        fn: "publishCatalog",
        args: { slugs: opts.entries.map((e: any) => e.slug), cpUrl: opts.cpUrl, token: opts.token, official: opts.official, dryRun: opts.dryRun },
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
    expect(calls[0]).toEqual({ fn: "loadCatalog", args: { kinds: ["workspace"], slugs: ["content-os"] } });
    const all = await run("validate", [], {}, { lib: mockLib().lib });
    expect(all.code).toBe(0);

    const missing = await run("validate", ["ghost"], { kind: "workspace", json: true }, { lib: mockLib().lib });
    expect(missing.code).toBe(1);
    expect(JSON.parse(missing.text).problems).toEqual([expect.objectContaining({ slug: "ghost" })]);
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
    expect(JSON.parse(text).message).toMatch(/catalog-lib\.mjs not found.*Pull synap-app/);
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
      args: { slugs: ["agency-skills"], cpUrl: "https://cp.test", token: "tok", official: true, dryRun: false },
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
