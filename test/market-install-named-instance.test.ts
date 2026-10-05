import { describe, it, expect, beforeEach, vi } from "vitest";

/**
 * `synap market install <template> --as <name>` — a NAMED instance.
 *
 * A template install is idempotent on its slug, so installing `brand-library`
 * for a second brand silently returned the existing Brand Library and the
 * report said "created". `--as` sends `instanceName` (the pod keys the
 * workspace on `<slug>:<name>`), and the verdict must say whether a NEW
 * workspace appeared or an existing one with that name was REUSED.
 *
 * Driven through the real `marketInstall` with only the network seams mocked
 * (CP fetch, hub POST, installed reads).
 */

vi.mock("../src/lib/auth.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getCpUrl: () => "https://cp.test",
  getStoredToken: () => null,
  isTokenLocallyExpired: () => false,
}));

vi.mock("../src/lib/installed.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  fetchInstalledSlugs: async () => new Set<string>(),
  fetchInstalledTemplates: async () => [],
  verifyStampLanded: async () => null,
}));

vi.mock("../src/lib/cp-packages.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  fetchPackageDefinition: async () => ({ _meta: { slug: "brand-library" }, workspaceName: "Brand Library" }),
}));

const applyResponse: { value: Record<string, unknown> } = { value: {} };
const hubPost = vi.fn(async () => applyResponse.value);

vi.mock("../src/lib/hub-client.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  resolveHubConfig: async () => ({ podUrl: "https://pod.test", apiKey: "k", workspaceId: undefined }),
  hubPost: (...args: unknown[]) => hubPost(...(args as [])),
}));

const { marketInstall, instanceVerdictLine } = await import("../src/commands/market.js");
const { log } = await import("../src/utils/logger.js");

function catalogFetch(): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      const u = String(url);
      const json = (body: unknown) =>
        ({ ok: true, status: 200, json: async () => body }) as unknown as Response;
      if (u.includes("/api/packages/available")) return json({ packages: [] });
      if (/\/api\/packages\?/.test(u))
        return json({
          packages: [{ id: "b", slug: "brand-library", displayName: "Brand Library", category: "workspace" }],
        });
      throw new Error(`unexpected fetch: ${u}`);
    }),
  );
}

const lines: string[] = [];
beforeEach(() => {
  hubPost.mockClear();
  lines.length = 0;
  vi.unstubAllGlobals();
  catalogFetch();
  vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
    throw new Error(`process.exit(${code})`);
  }) as never);
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  for (const level of ["success", "info", "warn", "error"] as const) {
    vi.spyOn(log, level).mockImplementation(((msg: string) => {
      lines.push(`${level}:${msg}`);
    }) as never);
  }
});

function sentBody(): Record<string, unknown> {
  const call = hubPost.mock.calls.find((c) => (c as unknown[])[0] === "/packages/apply");
  expect(call, "the install reached POST /packages/apply").toBeTruthy();
  return (call as unknown as [string, Record<string, unknown>])[1];
}

describe("market install --as <name>", () => {
  it("sends instanceName to /packages/apply", async () => {
    applyResponse.value = { workspace: { status: "created", workspaceId: "ws-2", outcome: "created" } };
    await marketInstall("brand-library", { as: "Architech Brand" });
    expect(sentBody().instanceName).toBe("Architech Brand");
  });

  it("without --as sends NO instanceName (singleton default unchanged)", async () => {
    applyResponse.value = { workspace: { status: "created", workspaceId: "ws-1", outcome: "unchanged" } };
    await marketInstall("brand-library", {});
    expect("instanceName" in sentBody()).toBe(false);
  });

  it("a NEW instance reads 'Created workspace'", async () => {
    applyResponse.value = { workspace: { status: "created", workspaceId: "ws-2", outcome: "created" } };
    await marketInstall("brand-library", { as: "Architech Brand" });
    expect(lines).toContain('success:Created workspace "Architech Brand".');
  });

  it("an existing instance reads 'Reused existing workspace', never created", async () => {
    applyResponse.value = { workspace: { status: "created", workspaceId: "ws-2", outcome: "unchanged" } };
    await marketInstall("brand-library", { as: "Architech Brand" });
    expect(lines).toContain('info:Reused existing workspace "Architech Brand" — already up to date.');
    expect(lines.some((l) => l.includes("Created workspace"))).toBe(false);
  });

  it("--as with --onto is refused before anything is sent", async () => {
    await expect(
      marketInstall("brand-library", { as: "Architech Brand", onto: "8f894661-db21-4f6d-ba30-5334f7b67bef" }),
    ).rejects.toThrow("process.exit(1)");
    expect(hubPost).not.toHaveBeenCalled();
  });

  it("a blank --as is refused", async () => {
    await expect(marketInstall("brand-library", { as: "   " })).rejects.toThrow("process.exit(1)");
    expect(hubPost).not.toHaveBeenCalled();
  });
});

describe("instanceVerdictLine", () => {
  it("reconciled re-hit = reused (updated), not created", () => {
    expect(instanceVerdictLine("X", { status: "updated", warnings: [] })?.text).toMatch(/^Reused existing workspace "X"/);
  });
  it("compose / unknown verdicts fall back to the generic printer", () => {
    expect(instanceVerdictLine("X", { status: "composed", warnings: [] })).toBeNull();
  });
});
