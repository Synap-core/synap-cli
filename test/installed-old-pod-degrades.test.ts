import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * AN OLDER POD DOES NOT SERVE `GET /api/hub/installed`.
 *
 * A 404 there must degrade to the historical `GET /workspaces` behaviour and
 * SAY so — not error, and above all not report "nothing installed". Absence of
 * a route is not absence of installs; that exact reflex is the defect this
 * whole consolidation exists to remove.
 */

const hubGet = vi.fn();

class FakeHubError extends Error {
  status: number;
  constructor(status: number) {
    super(`HTTP ${status}`);
    this.status = status;
  }
}

vi.mock("../src/lib/hub-client.js", () => ({
  hubGet: (...args: unknown[]) => hubGet(...args),
  resolveHubConfig: async () => ({ podUrl: "https://pod.test", apiKey: "k" }),
  HubError: FakeHubError,
}));

const WORKSPACES = {
  workspaces: [
    {
      id: "w1",
      name: "CRM",
      packageSlug: "crm",
      packageVersion: "h-aaa",
      latestVersion: "h-bbb",
      drifted: true,
      installedPacks: [{ slug: "task-views-pack", version: "1.0.0" }],
    },
    { id: "w2", name: "Hand-built", packageSlug: null, installedPacks: [] },
  ],
};

// Braces matter: a `beforeEach` that RETURNS the mock hands Vitest a teardown
// function, which then calls `hubGet()` with no args after every test.
beforeEach(() => {
  hubGet.mockReset();
});

describe("fetchInstalledInventoryStrict — 404 on the new door", () => {
  it("degrades to /workspaces, flags it, and still lists what IS installed", async () => {
    hubGet.mockImplementation(async (path: string) => {
      if (path === "/workspaces") return WORKSPACES;
      throw new FakeHubError(404);
    });
    const { fetchInstalledInventoryStrict, installedRowsToTemplates } = await import(
      "../src/lib/installed.js"
    );
    const inv = await fetchInstalledInventoryStrict();

    expect(inv.degraded, "an older pod must be reported as degraded, not as truth").toBe(true);
    expect(inv.rows.length, "degrading must not empty the list").toBeGreaterThan(0);

    const templates = installedRowsToTemplates(inv.rows);
    // The pre-existing workspace behaviour, byte for byte: the workspace's own
    // package AND its additive pack.
    expect(templates.map((t) => t.slug).sort()).toEqual(["crm", "task-views-pack"]);
    const crm = templates.find((t) => t.slug === "crm")!;
    expect(crm.drifted).toBe(true);
    expect(crm.latestVersion).toBe("h-bbb");
    // An additive pack was never health-checked → UNKNOWN, not clean.
    expect(templates.find((t) => t.slug === "task-views-pack")!.drifted).toBeUndefined();
  });

  it("does NOT swallow a real failure as 'old pod'", async () => {
    hubGet.mockImplementation(async (path: string) => {
      if (path === "/workspaces") return WORKSPACES;
      throw new FakeHubError(500);
    });
    const { fetchInstalledInventoryStrict } = await import("../src/lib/installed.js");
    await expect(fetchInstalledInventoryStrict()).rejects.toThrow();
  });

  it("on a current pod, unions the door's kinds with the packs /installed never emits", async () => {
    hubGet.mockImplementation(async (path: string) => {
      if (path === "/workspaces") return WORKSPACES;
      return {
        driftComputed: false,
        installed: [
          {
            kind: "capability",
            id: "c1",
            name: "Exa",
            packageSlug: null,
            templateKey: "exa",
            installedVersion: "abc",
            latestVersion: null,
            drift: null,
            installedAt: null,
            workspaceId: null,
            provisioningStatus: null,
            failedStep: null,
          },
          {
            kind: "view",
            id: "v1",
            name: "Task board",
            packageSlug: "bookmark-views-pack",
            templateKey: null,
            installedVersion: "1.0.0",
            latestVersion: null,
            drift: null,
            installedAt: null,
            workspaceId: "w1",
            provisioningStatus: null,
            failedStep: null,
          },
        ],
      };
    });
    const { fetchInstalledInventoryStrict } = await import("../src/lib/installed.js");
    const inv = await fetchInstalledInventoryStrict();

    expect(inv.degraded).toBe(false);
    expect(inv.rows.map((r) => r.kind)).toEqual(["capability", "view", "workspace"]);
    // The pack row `/installed` structurally never emits is still here.
    expect(inv.rows.some((r) => r.packageSlug === "task-views-pack")).toBe(true);
    // The workspace NAME is joined locally — the door only carries the id.
    expect(inv.rows.find((r) => r.kind === "view")!.workspaceName).toBe("CRM");
    expect(inv.rows.find((r) => r.kind === "capability")!.workspaceName).toBeNull();
  });
});
