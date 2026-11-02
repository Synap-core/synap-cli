/**
 * `synap market update` with a computer / agent key (founder, 2 Nov 2026,
 * CLI 1.13.1-next.20261102.ec3d166): the summary counts what is the person's
 * ("to apply in pod admin") apart from failures, and the slug column fits a
 * long slug and keeps two spaces. How each kind is applied for such a key is
 * the one door's (`market-update-one-door.test.ts`).
 *
 * Driven through the real `marketUpdate`; the pod is stubbed at the hub transport.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("../src/lib/auth.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getCpUrl: () => "https://cp.test",
  getStoredToken: () => null,
  isTokenLocallyExpired: () => false,
}));

const row = (kind: string, slug: string) => ({
  kind,
  id: `${kind}-${slug}`,
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
vi.mock("../src/lib/package-updates.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  fetchPackageStandings: async () => (await import("./helpers/standings-from-inventory.js")).standingsFromMockedInventory(),
}));
vi.mock("../src/lib/installed.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  fetchInstalledInventoryStrict: async () => ({ rows: inventory.rows, driftComputed: true, degraded: false }),
  fetchWorkspaceAttachmentsStrict: async () => [],
}));
vi.mock("../src/lib/cp-packages.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  fetchPackageDefinition: async () => ({ skill: { slug: "x", body: "# x" } }),
}));

const key: { status: Record<string, unknown> } = { status: {} };
const hubPost = vi.fn(async (_path: string): Promise<unknown> => ({}));
const hubGet = vi.fn(async (path: string): Promise<unknown> => {
  if (path === "/auth/status") return key.status;
  return {};
});
vi.mock("../src/lib/hub-client.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  resolveHubConfig: async () => ({ podUrl: "https://pod.antoinesrvt.synap.live", apiKey: "k", workspaceId: undefined }),
  hubPost: (...args: unknown[]) => hubPost(...(args as [string])),
  hubGet: (...args: unknown[]) => hubGet(...(args as [string])),
}));

const { marketUpdate, summarizeApplyResults } = await import("../src/commands/market.js");
const { log } = await import("../src/utils/logger.js");

const personKey = { userId: "u2", userEmail: "me@example.com", keyType: "user_pat" };
const LONG = "designing-with-real-components"; // 30 characters

let said: string[] = [];
beforeEach(() => {
  hubPost.mockClear();
  hubGet.mockClear();
  said = [];
  vi.unstubAllGlobals();
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      const u = String(url);
      const json = (body: unknown) => ({ ok: true, status: 200, json: async () => body }) as unknown as Response;
      if (u.includes("/api/packages/available")) return json({ packages: [] });
      if (/\/api\/packages\?/.test(u)) return json({ packages: [] });
      throw new Error(`unexpected fetch: ${u}`);
    }),
  );
  vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
    throw new Error(`process.exit(${code})`);
  }) as never);
  vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => void said.push(a.map(String).join(" ")));
  for (const level of ["success", "info", "warn", "error", "hint", "dim", "heading", "blank"] as const) {
    vi.spyOn(log, level).mockImplementation(((...a: unknown[]) => void said.push(a.map(String).join(" "))) as never);
  }
});

const plain = () => said.join("\n").replace(/\x1b\[[0-9;]*m/g, "");

describe("the summary", () => {
  it("counts what is the person's apart from failures", () => {
    const s = summarizeApplyResults([
      { slug: "a", status: "apply-in-pod-admin" },
      { slug: "b", status: "apply-in-pod-admin" },
      { slug: "c", status: "apply-in-pod-admin" },
      { slug: "d", status: "proposed" },
      { slug: "e", status: "failed" },
    ]);
    expect(s.toApplyInPodAdmin).toBe(3);
    expect(s.failed).toBe(1);
    expect(s.line).toContain("3 to apply in pod admin");
    expect(s.line).toContain("1 failed");
  });

  it("with nothing failed it is not a warning", () => {
    const s = summarizeApplyResults([{ slug: "a", status: "apply-in-pod-admin" }]);
    expect(s.line).toContain("→");
    expect(s.line).not.toContain("⚠");
  });
});

describe("the installed list's slug column", () => {
  it("keeps two spaces after a 30-character slug", async () => {
    key.status = personKey;
    inventory.rows = [row("workspace", LONG), row("workspace", "crm")];
    await marketUpdate(undefined, {});
    const line = plain().split("\n").find((l) => l.includes(LONG))!;
    expect(LONG).toHaveLength(30);
    expect(line).toMatch(new RegExp(`${LONG}  \\S`));
    const crm = plain().split("\n").find((l) => /\bcrm\b/.test(l) && !l.includes(LONG))!;
    // every label starts in the same column
    expect(crm.search(/\S/, crm.indexOf("crm") + 3)).toBe(line.search(/\S/, line.indexOf(LONG) + 30));
  });
});
