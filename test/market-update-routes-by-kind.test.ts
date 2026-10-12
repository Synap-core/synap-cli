import { describe, it, expect, beforeEach, vi } from "vitest";

/**
 * `market update` routes each installed package to its KIND's update door.
 *
 * INCIDENT (2026-10-12): `synap market update` sent the installed
 * `creative-director` SKILL — which had an update — to `POST /packages/apply`,
 * the WORKSPACE door. The pod minted an empty "New Workspace" from it. Install
 * had been fixed for this class on 2026-09-05; update had not.
 *
 * Driven through the real `marketUpdate` with only the network seams mocked:
 * the installed inventory, the CP fetches and the hub transport.
 */

vi.mock("../src/lib/auth.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getCpUrl: () => "https://cp.test",
  getStoredToken: () => null,
  isTokenLocallyExpired: () => false,
}));

const row = (kind: string, slug: string) => ({
  kind,
  id: `${kind}-1`,
  name: slug,
  packageSlug: slug,
  templateKey: null,
  installedVersion: "1.0.0",
  latestVersion: "1.1.0",
  drift: true,
  installedAt: null,
  workspaceId: kind === "workspace" ? "ws-1" : null,
  workspaceName: null,
  provisioningStatus: null,
  failedStep: null,
});
const inventory: { rows: unknown[] } = { rows: [] };
vi.mock("../src/lib/installed.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  fetchInstalledInventoryStrict: async () => ({ rows: inventory.rows, driftComputed: true, degraded: false }),
  fetchWorkspaceAttachmentsStrict: async () => [],
}));

vi.mock("../src/lib/cp-packages.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  fetchPackageDefinition: async (slug: string) =>
    slug === "creative-director" ? { skill: { slug: "creative-director", body: "# Creative director" } } : { workspaceName: "Content OS" },
}));

const hubPost = vi.fn(async (path: string) => {
  if (path === "/configs/reconcile")
    return { updated: [{ kind: "skill", id: "skill-1", name: "Creative director", packageSlug: "creative-director", reason: "advanced" }] };
  if (path === "/packages/preflight") return {};
  return { workspace: { status: "updated", workspaceId: "ws-1", outcome: "reconciled" } };
});
vi.mock("../src/lib/hub-client.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  resolveHubConfig: async () => ({ podUrl: "https://pod.test", apiKey: "k", workspaceId: undefined }),
  hubPost: (...args: unknown[]) => hubPost(...(args as [string])),
}));

const { marketUpdate, updateDoorFor } = await import("../src/commands/market.js");
const { log } = await import("../src/utils/logger.js");

beforeEach(() => {
  hubPost.mockClear();
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
            { id: "s", slug: "creative-director", displayName: "Creative director", category: "skill", version: "1.1.0" },
            { id: "c", slug: "content-os", displayName: "Content OS", category: "workspace", version: "1.1.0" },
            // In the catalog, so the workspace door COULD resolve it — the routing is what keeps it out.
            { id: "p", slug: "probe-card-pack", displayName: "Probe cards", category: "cell", version: "1.1.0" },
          ],
        });
      throw new Error(`unexpected fetch: ${u}`);
    }),
  );
  vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
    throw new Error(`process.exit(${code})`);
  }) as never);
  vi.spyOn(console, "log").mockImplementation(() => {});
  for (const level of ["success", "info", "warn", "error", "hint", "dim", "heading", "blank"] as const) {
    vi.spyOn(log, level).mockImplementation((() => {}) as never);
  }
});

const paths = () => hubPost.mock.calls.map((c) => c[0]);

describe("market update — routes by installed kind, never a skill through the workspace door", () => {
  it("an installed SKILL with an update is never sent to /packages/apply (nor its preflight)", async () => {
    inventory.rows = [row("skill", "creative-director")];
    await marketUpdate(["creative-director"], {});
    expect(paths()).not.toContain("/packages/apply");
    expect(paths()).not.toContain("/packages/preflight");
    expect(paths()).toEqual(["/configs/reconcile"]);
  });

  it("control: an installed WORKSPACE with an update still goes to /packages/apply", async () => {
    inventory.rows = [row("workspace", "content-os"), row("skill", "creative-director")];
    await marketUpdate(undefined, { all: true });
    const applied = hubPost.mock.calls.filter((c) => c[0] === "/packages/apply");
    expect(applied).toHaveLength(1);
    expect((applied[0] as unknown as [string, { _meta?: { slug?: string } }])[1]._meta?.slug).toBe("content-os");
    expect(paths().filter((p) => p === "/configs/reconcile")).toHaveLength(1);
  });

  it("a kind with no per-package updater (cell) writes nothing", async () => {
    inventory.rows = [row("cell", "probe-card-pack")];
    await marketUpdate(undefined, { all: true });
    expect(paths()).toEqual([]);
  });

  it("a cell skip is SAID (warned + in the applied results), never silently dropped", async () => {
    inventory.rows = [row("cell", "probe-card-pack")];
    const out = vi.mocked(console.log);
    await marketUpdate(undefined, { all: true, json: true });
    const json = JSON.parse(String(out.mock.calls.at(-1)?.[0]));
    expect(json.applied).toEqual([expect.objectContaining({ slug: "probe-card-pack", status: "no-updater" })]);
    expect(json.summary.failed).toBe(1);
    out.mockClear();
    await marketUpdate(undefined, { all: true });
    expect(vi.mocked(log.warn).mock.calls.some((c) => String(c[0]).includes("probe-card-pack"))).toBe(true);
  });

  it("an unreadable reconcile report is a FAILURE, never 'up to date'", async () => {
    inventory.rows = [row("skill", "creative-director")];
    hubPost.mockImplementationOnce(async () => "<html>bad gateway</html>" as never);
    const out = vi.mocked(console.log);
    await marketUpdate(["creative-director"], { json: true });
    const json = JSON.parse(String(out.mock.calls.at(-1)?.[0]));
    expect(json.applied).toEqual([expect.objectContaining({ slug: "creative-director", status: "failed" })]);
    expect(json.summary.updated + json.summary.unchanged).toBe(0);
  });

  it("an absent kind (older pod: workspace-only rows) reads as workspace; nothing else defaults to it", () => {
    expect(updateDoorFor(undefined)).toBe("packages-apply");
    for (const k of ["skill", "view", "automation"] as const) expect(updateDoorFor(k)).toBe("configs-reconcile");
    for (const k of ["cell", "capability"] as const) expect(updateDoorFor(k)).toBeNull();
  });
});
