/**
 * `synap market update` with a computer's key: the pod refuses the apply
 * because the key's grant leaves out `workspace.update` (by design, backend
 * #641: applying a workspace package is the person's act). The CLI must say
 * that, and where the person does it, never "That workspace is not accessible
 * on this pod" (founder, 2 Nov 2026: the workspace exists).
 *
 * The pod sends no structured code for this refusal (`{ error }` only,
 * synap-backend `utils/grant-write-check.ts`), so the CLI reads its words.
 *
 * Driven through the REAL `marketUpdate`, `hubPost` and `renderHubError` (a
 * stubbed fetch is the pod and the CP); what is asserted is what the person
 * reads.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const POD = "https://pod.antoinesrvt.synap.live";
const WS = "808939d1-86b3-4c52-a153-ae06ece2c54e";
const GRANT_REFUSAL = { error: `This key's grant does not allow "workspace.update".` };

vi.mock("../src/lib/auth.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getCpUrl: () => "https://cp.test",
  getStoredToken: () => null,
  isTokenLocallyExpired: () => false,
}));

vi.mock("../src/lib/installed.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  fetchInstalledInventoryStrict: async () => ({
    rows: [
      {
        kind: "workspace",
        id: "workspace-1",
        name: "content-os",
        packageSlug: "content-os",
        templateKey: null,
        installedVersion: "1.0.0",
        latestVersion: "1.1.0",
        drift: true,
        installedAt: null,
        workspaceId: WS,
        workspaceName: null,
        provisioningStatus: null,
        failedStep: null,
      },
    ],
    driftComputed: true,
    degraded: false,
  }),
  fetchWorkspaceAttachmentsStrict: async () => [],
}));

vi.mock("../src/lib/cp-packages.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  fetchPackageDefinition: async () => ({ workspaceName: "Content OS" }),
}));

vi.mock("../src/lib/hub-client.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  resolveHubConfig: async () => ({ podUrl: POD, apiKey: "computer-key", userId: "cli", workspaceId: WS }),
}));

const { marketUpdate } = await import("../src/commands/market.js");

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

let printed: string[] = [];

beforeEach(() => {
  printed = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      const u = String(url);
      if (u.includes("/api/packages/available")) return json(200, { packages: [] });
      if (/\/api\/packages\?/.test(u))
        return json(200, {
          packages: [{ id: "c", slug: "content-os", displayName: "Content OS", category: "workspace", version: "1.1.0" }],
        });
      if (u.endsWith("/packages/preflight")) return json(200, {});
      if (u.endsWith("/packages/apply")) return json(403, GRANT_REFUSAL);
      throw new Error(`unexpected fetch: ${u}`);
    })
  );
  const keep = (m: unknown) => void printed.push(String(m));
  vi.spyOn(console, "error").mockImplementation(keep);
  vi.spyOn(console, "log").mockImplementation(keep);
  vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
    throw new Error(`process.exit(${code})`);
  }) as never);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("market update refused by a computer key's grant", () => {
  it("says the key may not apply it and names the person's door, never a missing workspace", async () => {
    await marketUpdate(["content-os"], {});
    const out = printed.join("\n");
    expect(out).toContain("Content OS update failed");
    // The pod's own words stay on the error line.
    expect(out).toContain(`This key's grant does not allow "workspace.update"`);
    expect(out).toContain(`This key may not do "workspace.update"`);
    expect(out).toContain("Nothing is wrong with your workspace");
    expect(out).toContain(
      "Apply it yourself from pod admin → Marketplace → Updates: https://pod-admin.antoinesrvt.synap.live/marketplace/updates"
    );
    expect(out).not.toContain("not accessible on this pod");
    expect(out).not.toContain(`Sent workspace ${WS}`);
    expect(out).not.toContain("synap use <id>");
  });

  it("the summary still counts it as failed", async () => {
    await marketUpdate(["content-os"], {});
    expect(printed.join("\n")).toMatch(/0 updated · 0 already current · 1 failed/);
  });

  it("--json keeps the failure and the pod's words", async () => {
    await marketUpdate(["content-os"], { json: true });
    const report = JSON.parse(printed.at(-1)!);
    expect(report.applied).toEqual([
      expect.objectContaining({ slug: "content-os", status: "failed", error: expect.stringContaining("workspace.update") }),
    ]);
    expect(report.summary.failed).toBe(1);
  });
});
