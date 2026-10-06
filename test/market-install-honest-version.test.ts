import { describe, it, expect, beforeEach, vi } from "vitest";

/**
 * A client never labels a definition with a version it did not take it from.
 *
 * INCIDENT (2026-10-06): `synap market install content-os --onto <ws>` sent
 * the CLI's BUNDLED content-os (0.11 — `primarySurface: null`) labelled with
 * the CATALOG row's `_meta.version: "h-448ffcae9220"`. The pod stamped it, and
 * `template_health` reported a stale layout as up to date.
 *
 * Driven through the real `marketInstall` (real bundle, real `mergeCatalog`)
 * with only the network seams mocked: the CP list/detail fetches and the hub.
 */

const CATALOG_VERSION = "h-448ffcae9220";

vi.mock("../src/lib/auth.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getCpUrl: () => "https://cp.test",
  getStoredToken: () => null,
  isTokenLocallyExpired: () => false,
}));

const verifyStampLanded = vi.fn(async () => true);
vi.mock("../src/lib/installed.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  fetchInstalledSlugs: async () => new Set<string>(),
  fetchInstalledTemplates: async () => [],
  verifyStampLanded: (...a: unknown[]) => verifyStampLanded(...(a as [])),
}));

const remoteDefinition: { value: Record<string, unknown> | null } = { value: null };
vi.mock("../src/lib/cp-packages.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  fetchPackageDefinition: async () => remoteDefinition.value,
}));

const hubPost = vi.fn(async () => ({ workspace: { status: "created", workspaceId: "ws-1", outcome: "reconciled" } }));
vi.mock("../src/lib/hub-client.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  resolveHubConfig: async () => ({ podUrl: "https://pod.test", apiKey: "k", workspaceId: undefined }),
  hubPost: (...args: unknown[]) => hubPost(...(args as [])),
}));

const { marketInstall } = await import("../src/commands/market.js");
const { bundledTemplatesVersion } = await import("../src/lib/bundle-version.js");
const { log } = await import("../src/utils/logger.js");

beforeEach(() => {
  hubPost.mockClear();
  verifyStampLanded.mockClear();
  vi.unstubAllGlobals();
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      const u = String(url);
      const json = (body: unknown) => ({ ok: true, status: 200, json: async () => body }) as unknown as Response;
      if (u.includes("/api/packages/available")) return json({ packages: [] });
      if (/\/api\/packages\?/.test(u))
        return json({
          packages: [
            { id: "c", slug: "content-os", displayName: "Content OS", category: "workspace", version: CATALOG_VERSION },
          ],
        });
      throw new Error(`unexpected fetch: ${u}`);
    }),
  );
  vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
    throw new Error(`process.exit(${code})`);
  }) as never);
  vi.spyOn(console, "log").mockImplementation(() => {});
  for (const level of ["success", "info", "warn", "error", "hint"] as const) {
    vi.spyOn(log, level).mockImplementation((() => {}) as never);
  }
});

function sentBody(): Record<string, unknown> & { _meta?: { version?: string }; layoutConfig?: { primarySurface?: unknown } } {
  const call = hubPost.mock.calls.find((c) => (c as unknown[])[0] === "/packages/apply");
  expect(call, "the install reached POST /packages/apply").toBeTruthy();
  return (call as unknown as [string, Record<string, unknown>])[1];
}

const FRESH_SURFACE = { kind: "cell", cellKey: "content-home" };
function catalogRow(sourceVersion?: string): Record<string, unknown> {
  return {
    workspaceName: "Content OS",
    layoutConfig: { primarySurface: FRESH_SURFACE },
    ...(sourceVersion ? { sourcePackage: { name: "@synap-core/workspace-templates", version: sourceVersion } } : {}),
  };
}

describe("market install — the version label matches the definition sent", () => {
  it("non-vacuity: this CLI resolves its own bundle version", () => {
    expect(bundledTemplatesVersion()).toMatch(/^\d+\.\d+\.\d+/);
  });

  it("bundle wins (row has no sourcePackage) ⇒ bundle definition, labelled with the BUNDLE, never the catalog version", async () => {
    remoteDefinition.value = catalogRow(undefined);
    await marketInstall("content-os", { onto: "8f894661-db21-4f6d-ba30-5334f7b67bef" });
    const body = sentBody();
    expect(body.layoutConfig?.primarySurface ?? null).toBeNull();
    expect(body._meta?.version).toBe(`bundle@${bundledTemplatesVersion()}`);
    expect(body._meta?.version).not.toBe(CATALOG_VERSION);
    expect((body._meta as { slug?: string } | undefined)?.slug).toBe("content-os");
    // The pod's stamp can't be predicted for a bundle — never "verify" against the catalog.
    expect(verifyStampLanded).not.toHaveBeenCalled();
  });

  it("an official row strictly newer than the bundle wins ⇒ the CATALOG definition, labelled with the catalog version", async () => {
    remoteDefinition.value = catalogRow("999.0.0");
    await marketInstall("content-os", { onto: "8f894661-db21-4f6d-ba30-5334f7b67bef" });
    const body = sentBody();
    expect(body.layoutConfig?.primarySurface).toEqual(FRESH_SURFACE);
    expect(body._meta?.version).toBe(CATALOG_VERSION);
    // A catalog row has no `_meta`; the pod finds the existing workspace by
    // `_meta.slug` — without it an approved apply created a duplicate space.
    expect((body._meta as { slug?: string } | undefined)?.slug).toBe("content-os");
    expect(verifyStampLanded).toHaveBeenCalledWith("ws-1", CATALOG_VERSION, expect.anything());
  });

  it("CP detail fetch fails ⇒ offline bundle, still labelled as the bundle", async () => {
    remoteDefinition.value = null;
    await marketInstall("content-os", {});
    expect(sentBody()._meta?.version).toBe(`bundle@${bundledTemplatesVersion()}`);
  });
});
