import { describe, it, expect, beforeEach, vi } from "vitest";

/**
 * `synap market install <private-slug>` must route on the package's REAL kind.
 *
 * On 2026-09-05 it did not: a private CELL package arrived from
 * `GET /api/packages/mine` with no `category` (that projection omits the
 * column), so the install classified it as a workspace and created an empty
 * "New Workspace" while printing "✓ Installed".
 *
 * The floor added that day — refuse when the category is genuinely unknown —
 * stays (third test). What is added on top is the GOOD path: for a package the
 * caller owns, the authed single-package door (`GET /api/packages/:slug`, the
 * only door that can see a private row's category) resolves it.
 */

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

const hubPost = vi.fn(async () => ({ result: { status: "installed", kind: "cell" } }));

vi.mock("../src/lib/hub-client.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  resolveHubConfig: async () => ({ podUrl: "https://pod.test", apiKey: "k", workspaceId: undefined }),
  hubPost: (...args: unknown[]) => hubPost(...(args as [])),
}));

const { marketInstall } = await import("../src/commands/market.js");
const { MINE_CATEGORY_HYDRATION_CAP } = await import("../src/lib/cp-packages.js");

const PRIVATE_CELL = {
  id: "p1",
  slug: "probe-card-pack",
  displayName: "Probe Card Pack",
  description: "dogfood cell",
  isPublic: false,
  version: "h-15c5ee1c105a",
  // no `category` — exactly what `/mine` returns
};

function installFetch(fx: {
  publicRows?: unknown[];
  mineRows?: unknown[];
  detail?: Record<string, { category?: string }>;
}): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      const u = String(url);
      const json = (body: unknown) =>
        ({ ok: true, status: 200, json: async () => body }) as unknown as Response;
      if (u.includes("/api/packages/mine")) return json({ packages: fx.mineRows ?? [] });
      if (u.includes("/api/packages/available")) return json({ packages: [] });
      if (/\/api\/packages\?/.test(u)) return json({ packages: fx.publicRows ?? [] });
      const m = u.match(/\/api\/packages\/([^/?]+)$/);
      if (m) {
        const slug = decodeURIComponent(m[1]!);
        const row = fx.detail?.[slug];
        if (!row) return { ok: false, status: 404 } as unknown as Response;
        return json({ package: { slug, ...row } });
      }
      throw new Error(`unexpected fetch: ${u}`);
    }),
  );
}

beforeEach(() => {
  hubPost.mockClear();
  creds.value = null;
  vi.unstubAllGlobals();
  vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
    throw new Error(`process.exit(${code})`);
  }) as never);
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("installing a private package the caller owns", () => {
  it("routes it as a CELL — not as a workspace", async () => {
    creds.value = { token: "tok", email: "a@b.c" };
    installFetch({
      mineRows: [PRIVATE_CELL],
      detail: { "probe-card-pack": { category: "cell" } },
    });

    await marketInstall("probe-card-pack", { json: true });

    expect(hubPost).toHaveBeenCalledTimes(1);
    const [path, body] = hubPost.mock.calls[0] as unknown as [string, Record<string, unknown>];
    expect(path, "a non-workspace kind installs through the market.install verb").toBe(
      "/capabilities/execute",
    );
    expect(body.verbId).toBe("market.install");
    expect((body.parameters as { kind: string }).kind).toBe("cell");
    expect((body.parameters as { slug: string }).slug).toBe("probe-card-pack");
  });

  it("still resolves when the row fell past the catalog's hydration cap", async () => {
    creds.value = { token: "tok", email: "a@b.c" };
    // Enough owned rows that `probe-card-pack` (last) is not hydrated by the
    // bounded catalog pass — the install-site resolve is the only thing left.
    const filler = Array.from({ length: MINE_CATEGORY_HYDRATION_CAP + 5 }, (_, i) => ({
      ...PRIVATE_CELL,
      id: `f${i}`,
      slug: `filler-${i}`,
    }));
    installFetch({
      mineRows: [...filler, PRIVATE_CELL],
      detail: Object.fromEntries([
        ...filler.map((f) => [f.slug, { category: "cell" }]),
        ["probe-card-pack", { category: "cell" }],
      ]),
    });

    await marketInstall("probe-card-pack", { json: true });

    expect(hubPost).toHaveBeenCalledTimes(1);
    const [, body] = hubPost.mock.calls[0] as unknown as [string, Record<string, unknown>];
    expect((body.parameters as { kind: string }).kind).toBe("cell");
  });

  it("still REFUSES when the category is genuinely unknown (the floor stays)", async () => {
    creds.value = null; // logged out — the private row is invisible, and so is its type
    installFetch({
      publicRows: [{ id: "u", slug: "mystery-pack", displayName: "Mystery" }], // no category
    });

    await expect(marketInstall("mystery-pack", { json: true })).rejects.toThrow("process.exit(1)");
    expect(hubPost, "nothing may be installed for a package we cannot classify").not.toHaveBeenCalled();
  });
});
