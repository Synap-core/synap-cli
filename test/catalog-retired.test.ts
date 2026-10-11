import { describe, it, expect } from "vitest";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { formatDiff, runCatalog, selectTombstones, type CatalogOpts } from "../src/commands/catalog.js";

/**
 * `synap catalog diff|publish` and `retired.yaml` tombstones (template-lifecycle
 * contract A). The lib loads the tombstones; the CLI must HAND them to
 * `diffCatalog` and `publishCatalog` (filtered by --kind and named slugs), and
 * render the `action: 'retire'` rows with the lib's `formatRetirement`. Before
 * this, `synap catalog publish` sent no tombstone at all. Lib mocked; the
 * recorded calls are what is asserted.
 */

const CREDS = {
  token: "tok",
  userId: "9c197945-0000-0000-0000-000000000000",
  email: "f@synap.live",
  expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
};

function fakeCheckout(): string {
  const root = mkdtempSync(join(tmpdir(), "synap-catalog-retired-"));
  const pkg = join(root, "synap-app/packages/workspace-templates");
  mkdirSync(join(pkg, "scripts"), { recursive: true });
  writeFileSync(join(pkg, "package.json"), JSON.stringify({ name: "@synap-core/workspace-templates" }));
  writeFileSync(join(pkg, "scripts/catalog-lib.mjs"), "// mocked\n");
  return root;
}

const ENTRY = (kind: string, slug: string) => ({ kind, slug, path: `${slug}.yaml`, meta: { slug }, spec: {}, dependencies: [], publishBody: { slug } });
const RADAR = { slug: "radar", kind: "workspace", replacedBy: "ecosystem", reason: "Folded into Ecosystem.", since: "2026-10-11", category: "workspace" };
const POSTHOG = { slug: "posthog-analytics", kind: "workspace", reason: "It is a capability now.", since: "2026-10-11", category: "workspace" };
const OLD_CAP = { slug: "old-cap", kind: "capability", reason: "Gone.", since: "2026-10-11", category: "capability" };

function mockLib(opts: { retired?: unknown[] | undefined; withFormatter?: boolean } = {}) {
  const calls: Array<{ fn: string; retired?: string[] | undefined; slugs?: string[] }> = [];
  const lib: Record<string, unknown> = {
    loadCatalog: async (a: { kinds?: string[] }) => {
      const all = [ENTRY("workspace", "ecosystem"), ENTRY("workspace", "crm"), ENTRY("capability", "apollo")];
      const entries = all.filter((e) => !a.kinds || a.kinds.includes(e.kind));
      return {
        entries,
        corpus: entries,
        problems: [],
        ...(opts.retired === undefined ? {} : { retired: opts.retired }),
      };
    },
    validateCatalog: async () => [],
    diffCatalog: async (entries: any[], o: { retired?: any[] }) => {
      calls.push({ fn: "diffCatalog", slugs: entries.map((e) => e.slug), retired: o.retired?.map((t) => t.slug) });
      return [
        ...entries.map((e) => ({ kind: e.kind, slug: e.slug, status: "unchanged", columns: [], warnings: [] })),
        ...(o.retired ?? []).map((t: any) => ({
          action: "retire",
          kind: t.kind,
          slug: t.slug,
          replacedBy: t.replacedBy ?? null,
          reason: t.reason,
          status: "new",
          columns: [],
          warnings: [],
        })),
      ];
    },
    publishCatalog: async (o: any) => {
      calls.push({ fn: "publishCatalog", slugs: o.entries.map((e: any) => e.slug), retired: o.retired?.map((t: any) => t.slug) });
      return [];
    },
  };
  if (opts.withFormatter !== false) {
    lib.formatRetirement = (r: any) => [`  LIBFMT retire ${r.slug}${r.replacedBy ? ` → ${r.replacedBy}` : ""} [${r.status}]`, `      reason: ${r.reason}`];
  }
  return { lib, calls };
}

async function run(verb: string, slugs: string[], opts: CatalogOpts, lib: unknown) {
  const lines: string[] = [];
  const code = await runCatalog(verb, slugs, opts, {
    cwd: fakeCheckout(),
    credentials: CREDS,
    cpUrl: "https://cp.test",
    isInteractive: false,
    importLib: async () => lib as never,
    out: (l) => lines.push(l),
  });
  return { code, text: lines.join("\n") };
}

describe("catalog diff/publish hand the tombstones to the lib", () => {
  it("diff passes every tombstone when no kind or slug narrows it", async () => {
    const { lib, calls } = mockLib({ retired: [RADAR, POSTHOG, OLD_CAP] });
    const { code } = await run("diff", [], {}, lib);
    expect(code).toBe(0);
    expect(calls.find((c) => c.fn === "diffCatalog")!.retired).toEqual(["radar", "posthog-analytics", "old-cap"]);
  });

  it("--kind filters tombstones the same way it filters entries", async () => {
    const { lib, calls } = mockLib({ retired: [RADAR, OLD_CAP] });
    await run("diff", [], { kind: "workspace" }, lib);
    expect(calls.find((c) => c.fn === "diffCatalog")!.retired).toEqual(["radar"]);
  });

  it("a named slug that is only a tombstone is a valid selection, and only it is sent", async () => {
    const { lib, calls } = mockLib({ retired: [RADAR, POSTHOG] });
    const { code, text } = await run("diff", ["radar"], {}, lib);
    expect(code).toBe(0);
    expect(text).not.toMatch(/no .*entry with this slug/);
    const diff = calls.find((c) => c.fn === "diffCatalog")!;
    expect(diff.retired).toEqual(["radar"]);
    expect(diff.slugs).toEqual([]);
  });

  it("publish --yes sends the selected tombstones through publishCatalog", async () => {
    const { lib, calls } = mockLib({ retired: [RADAR, OLD_CAP] });
    const { code } = await run("publish", [], { official: true, yes: true, kind: "workspace" }, lib);
    expect(code).toBe(0);
    expect(calls.find((c) => c.fn === "publishCatalog")!.retired).toEqual(["radar"]);
  });

  it("an older lib (no `retired` in the load result) sends none and does not crash", async () => {
    const { lib, calls } = mockLib({ retired: undefined });
    const { code } = await run("publish", [], { official: true, yes: true }, lib);
    expect(code).toBe(0);
    expect(calls.find((c) => c.fn === "publishCatalog")!.retired).toEqual([]);
  });

  it("the preview renders retire rows through the lib's formatRetirement", async () => {
    const { lib } = mockLib({ retired: [RADAR] });
    const { text } = await run("diff", [], {}, lib);
    expect(text).toContain("LIBFMT retire radar → ecosystem [new]");
    expect(text).toContain("1 retired: 1 to send · 0 unchanged");
  });
});

describe("formatDiff with tombstone rows", () => {
  const rows = [
    { kind: "workspace", slug: "crm", status: "unchanged" as const },
    { action: "retire" as const, kind: "workspace", slug: "radar", replacedBy: "ecosystem", reason: "Folded.", status: "unchanged" as const },
    { action: "retire" as const, kind: "workspace", slug: "personal", replacedBy: null, reason: "Gone.", status: "changed" as const },
  ];
  it("retire rows are not counted as live entries", () => {
    const text = formatDiff(rows);
    expect(text).toContain("0 new · 0 changed · 1 unchanged");
    expect(text).toContain("2 retired: 1 to send · 1 unchanged");
  });
  it("without the lib formatter (older lib) the same facts print", () => {
    const text = formatDiff(rows);
    expect(text).toContain("retire workspace/radar → ecosystem");
    expect(text).toContain("retire workspace/personal (no replacement)");
    expect(text).toContain("reason: Folded.");
  });
});

describe("selectTombstones", () => {
  it("filters by kind and by named slugs", () => {
    expect(selectTombstones([RADAR, OLD_CAP], { kind: "capability", slugs: [] }).map((t) => t.slug)).toEqual(["old-cap"]);
    expect(selectTombstones([RADAR, POSTHOG], { slugs: ["posthog-analytics"] }).map((t) => t.slug)).toEqual(["posthog-analytics"]);
    expect(selectTombstones(undefined, { slugs: [] })).toEqual([]);
  });
});
