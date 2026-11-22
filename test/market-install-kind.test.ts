/**
 * Unit tests for `marketInstallKind` — the pure CP-category → pod-verb-`kind`
 * translation that lets `synap market install <slug>` route non-workspace
 * packages through the pod's `market.install` verb. The CP's live PACKAGE_TYPES
 * and the pod's cache `kind` vocabulary diverge (cp-catalog-sync.ts), so this
 * map is the load-bearing seam: a wrong result means the verb's zod enum
 * rejects the request (400) or the wrong definition is resolved.
 *
 * The last test is a DOOR-PARITY tripwire. `marketInstallKind` used to return
 * null for `view` and `skill` — kinds the pod verb has always accepted — so the
 * 3 published view packages were uninstallable from the terminal with no error
 * anywhere, just a "the CLI can't install this type yet" line. Parity is
 * asserted by parsing the verb's own zod enum out of the backend source rather
 * than against a second hand-written list, because a hand-written expectation
 * would just pin the same lie.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { log } from "../src/utils/logger.js";
import { stripComments } from "./helpers/strip-comments.mjs";
import {
  marketInstall,
  buildMarketCatalog,
  installedLine,
  marketInstallKind,
  marketInstallNeedsWorkspace,
  MARKET_INSTALL_KINDS,
} from "../src/commands/market.js";

// `--kind` tests: the catalog (CP + installed reads) and the pod door are replaced by spies, so
// "no catalog call" is asserted on the real command path rather than read off its source.
const catalogCalls = vi.hoisted(() => ({ n: 0 }));
const hubPostSpy = vi.hoisted(() => vi.fn());
vi.mock("../src/lib/cp-packages.js", async (orig) => {
  const real = await orig<typeof import("../src/lib/cp-packages.js")>();
  const hit = <T>(v: T) => async () => {
    catalogCalls.n++;
    return v;
  };
  return {
    ...real,
    fetchPublicBrowseRows: hit([]),
    fetchMyRows: hit([]),
    fetchAvailableSlugs: hit(null),
    fetchRetiredWorkspaceSlugs: hit(null),
    fetchPackageRecord: hit(null),
  };
});
vi.mock("../src/lib/installed.js", async (orig) => {
  const real = await orig<typeof import("../src/lib/installed.js")>();
  return {
    ...real,
    fetchInstalledSlugs: async () => {
      catalogCalls.n++;
      return new Set<string>();
    },
    fetchInstalledTemplates: async () => {
      catalogCalls.n++;
      return [];
    },
  };
});
vi.mock("../src/lib/auth.js", async (orig) => ({
  ...(await orig<typeof import("../src/lib/auth.js")>()),
  getStoredToken: () => null,
}));
vi.mock("../src/lib/hub-client.js", async (orig) => ({
  ...(await orig<typeof import("../src/lib/hub-client.js")>()),
  resolveHubConfig: async () => ({ podUrl: "http://pod.test", apiKey: "k", userId: "cli" }),
  hubPost: hubPostSpy,
}));

describe("marketInstallKind", () => {
  it("maps a capability to the capability kind (the primary CLI case)", () => {
    expect(marketInstallKind("capability")).toBe("capability");
  });

  it("maps a cell to the cell kind", () => {
    expect(marketInstallKind("cell")).toBe("cell");
  });

  it("maps the CP's `workflow` category to the pod's `automation` kind", () => {
    expect(marketInstallKind("workflow")).toBe("automation");
  });

  it("accepts the pod's cache vocabulary verbatim (automation, template)", () => {
    expect(marketInstallKind("automation")).toBe("automation");
    expect(marketInstallKind("template")).toBe("template");
  });

  it("installs the kinds the verb accepts that the CLI used to refuse (view, skill)", () => {
    expect(marketInstallKind("view")).toBe("view");
    expect(marketInstallKind("skill")).toBe("skill");
  });

  it("installs an agent template (backend#890: the verb's `agent` kind, the catalog's `agent` category)", () => {
    expect(marketInstallKind("agent")).toBe("agent");
  });

  it("returns null for a workspace (installed via /packages/apply, never routed here)", () => {
    expect(marketInstallKind("workspace")).toBeNull();
  });

  it("maps a renderer bundle to the renderer-bundle kind", () => {
    expect(marketInstallKind("renderer-bundle")).toBe("renderer-bundle");
  });

  it("returns null for an unknown type", () => {
    expect(marketInstallKind("something-new")).toBeNull();
  });
});

describe("market.install workspace requirement", () => {
  it("requires a workspace exactly for automation and view", () => {
    // marketplace-install.ts 400s without workspaceId for these two arms.
    expect(marketInstallNeedsWorkspace("automation")).toBe(true);
    expect(marketInstallNeedsWorkspace("view")).toBe(true);
    // …and every other kind must stay pod-wide.
    expect(marketInstallNeedsWorkspace("capability")).toBe(false);
    expect(marketInstallNeedsWorkspace("cell")).toBe(false);
    expect(marketInstallNeedsWorkspace("skill")).toBe(false);
    expect(marketInstallNeedsWorkspace("template")).toBe(false);
    expect(marketInstallNeedsWorkspace("agent")).toBe(false);
    // A renderer bundle is pod-wide: `applyRendererBundleInstall` takes no workspace.
    expect(marketInstallNeedsWorkspace("renderer-bundle")).toBe(false);
  });
});

describe("a renderer bundle refusal reaches the person as the pod said it", () => {
  // The pod refuses a bundle with FORBIDDEN and a sentence (renderer_bundle_plan_required,
  // _pod_not_live, ...). The generic 403 path prints a "credentials or scopes" hint, which
  // sends the person to the wrong fix, so the install catch prints `detail` itself.
  it("prints the pod's own sentence for a 403 on kind renderer-bundle", () => {
    const src = stripComments(readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), "../src/commands/market.ts"), "utf-8"), "ts");
    const branch = /kind === "renderer-bundle"\s*&&\s*e instanceof HubError\s*&&\s*e\.status === 403[\s\S]{0,120}?log\.error\(e\.detail\)/.exec(src);
    expect(branch, "the renderer-bundle refusal branch is gone from market install").toBeTruthy();
  });
});

describe("market install --kind", () => {
  beforeEach(() => {
    catalogCalls.n = 0;
    hubPostSpy.mockReset();
    hubPostSpy.mockResolvedValue({ result: { status: "installed" } });
    vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
      throw new Error(`exit:${code}`);
    }) as never);
  });

  it("registers --kind on `market install`, listing every pod kind", () => {
    const index = readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), "../src/index.ts"), "utf-8");
    const start = index.indexOf('.command("install <slug>")');
    const block = index.slice(start, index.indexOf(".action(", start));
    expect(block).toContain('"--kind <kind>"');
    for (const k of MARKET_INSTALL_KINDS) expect(block).toContain(k);
  });

  it("renderer-bundle asks the pod directly: no catalog call, no workspace", async () => {
    await marketInstall("synap-renderers", { kind: "renderer-bundle", json: true });
    expect(catalogCalls.n).toBe(0);
    expect(hubPostSpy).toHaveBeenCalledTimes(1);
    const [path, body] = hubPostSpy.mock.calls[0];
    expect(path).toBe("/capabilities/execute");
    expect(body).toEqual({
      verbId: "market.install",
      parameters: { slug: "synap-renderers", kind: "renderer-bundle" },
    });
  });

  it("refuses an unknown --kind before any call", async () => {
    await expect(marketInstall("x", { kind: "nonsense" })).rejects.toThrow("exit:1");
    expect(catalogCalls.n).toBe(0);
    expect(hubPostSpy).not.toHaveBeenCalled();
  });

  it("refuses --dry-run for a renderer-bundle without writing", async () => {
    await expect(marketInstall("synap-renderers", { kind: "renderer-bundle", dryRun: true })).rejects.toThrow("exit:1");
    expect(hubPostSpy).not.toHaveBeenCalled();
  });

  it("refuses a --kind that disagrees with the package's category, installing nothing", async () => {
    const cat = await buildMarketCatalog();
    const entry = cat.entries[0];
    expect(entry, "the bundled catalog has at least one entry").toBeTruthy();
    // A bundled template is a `workspace`; asking for kind skill must be refused.
    const errors = vi.spyOn(log, "error").mockImplementation(() => {});
    await expect(marketInstall(entry.slug, { kind: "skill" })).rejects.toThrow("exit:1");
    expect(hubPostSpy).not.toHaveBeenCalled();
    // Names both sides, and is THIS refusal rather than the unknown-category one.
    expect(String(errors.mock.calls[0]?.[0])).toMatch(/package, but --kind says skill/);
  });
});

describe("the success line", () => {
  it("an agent template the pod already had (`exists`) is never called installed", () => {
    expect(installedLine("Hermes", "exists")).toBe("Hermes is already installed. Nothing was changed.");
    expect(installedLine("Hermes", "installed")).toBe("Installed Hermes.");
  });
});

/**
 * Path to the backend file that owns the `market.install` zod enum. Resolved
 * relative to this test so it works from the monorepo checkout (and in CI);
 * the parity assertion is skipped (not failed) when the CLI is checked out
 * standalone. `SYNAP_BACKEND_DIR` points it at another backend checkout: a
 * lane worktree's sibling can be a stale checkout that passes a parity main
 * no longer has (how backend#890's red went unseen on 2026-11-07).
 */
const BUILTIN_VERBS = resolve(
  process.env.SYNAP_BACKEND_DIR ?? resolve(dirname(fileURLToPath(import.meta.url)), "../../synap-backend"),
  "packages/api/src/services/capabilities/builtin-verbs.ts"
);

describe("door parity: CLI kinds vs the pod verb's zod enum", () => {
  it.skipIf(!existsSync(BUILTIN_VERBS))(
    "accepts every kind `marketInstallParams` accepts, and no others",
    () => {
      const src = readFileSync(BUILTIN_VERBS, "utf-8");
      const block = /const marketInstallParams = z\.object\(\{[\s\S]*?\n\}\);/.exec(src);
      expect(block, "marketInstallParams not found — did it move or get renamed?").toBeTruthy();

      const enumBlock = /kind:\s*(?:\w+\(\s*)?z\.enum\(\[([\s\S]*?)\]\)/.exec(block![0]);
      expect(enumBlock, "kind: z.enum([...]) not found in marketInstallParams").toBeTruthy();

      // Comments out first: the enum's own comment quotes a kind (`case "agent"`,
      // backend#890), which would otherwise be counted as a second kind.
      const podKinds = [...stripComments(enumBlock![1], "ts").matchAll(/"([a-z_-]+)"/g)].map((m) => m[1]);
      expect(podKinds.length).toBeGreaterThan(0);

      // Same set, order-insensitive.
      expect([...podKinds].sort()).toEqual([...MARKET_INSTALL_KINDS].sort());

      // And every one of them must actually resolve through the mapper, so the
      // declared list can't drift away from the switch below it.
      for (const kind of podKinds) {
        expect(marketInstallKind(kind), `marketInstallKind("${kind}")`).toBe(kind);
      }
    }
  );
});
