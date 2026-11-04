/**
 * Before reading the pod's update verdict, `market update` (and the other
 * commands that print one) asks the pod to refresh its catalog
 * (Hub `POST /catalog/refresh`). Founder, 3 Nov 2026: after a publish,
 * `market update` said "up to date" for up to 10 minutes because the pod's
 * copy of the catalog refreshes every 10 minutes.
 *
 * Three branches: the pod refreshed; the pod is older than the door (404/405:
 * one line, go on); the refresh failed (one warning naming the reason, go on,
 * never a green "Nothing to update"). Driven through the real `marketUpdate`;
 * the pod is stubbed at the hub transport.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("../src/lib/auth.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getCpUrl: () => "https://cp.test",
  getStoredToken: () => null,
  isTokenLocallyExpired: () => false,
}));
vi.mock("../src/lib/installed.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  fetchInstalledInventoryStrict: async () => ({ rows: [], driftComputed: true, degraded: false }),
  fetchWorkspaceAttachmentsStrict: async () => [],
}));

/** Every hub call, in order: `POST /catalog/refresh`, `GET /package-updates`, … */
const calls: string[] = [];
const refresh: { answer: () => Promise<unknown> } = { answer: async () => ({}) };
const hubPost = vi.fn(async (path: string): Promise<unknown> => {
  calls.push(`POST ${path}`);
  if (path === "/catalog/refresh") return refresh.answer();
  return {};
});
const hubGet = vi.fn(async (path: string): Promise<unknown> => {
  calls.push(`GET ${path}`);
  if (path === "/package-updates") {
    return {
      updates: [],
      unreadable: [],
      installed: [
        {
          slug: "content-os",
          kind: "workspace",
          name: "Content OS",
          installedVersion: "h-1",
          latestVersion: "h-1",
          hasUpdate: false,
        },
      ],
    };
  }
  return {};
});
vi.mock("../src/lib/hub-client.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  resolveHubConfig: async () => ({ podUrl: "https://pod.example", apiKey: "k", workspaceId: undefined }),
  hubPost: (...args: unknown[]) => hubPost(...(args as [string])),
  hubGet: (...args: unknown[]) => hubGet(...(args as [string])),
}));

const { HubError, HubNetworkError } = await import("../src/lib/hub-client.js");
const { refreshPodCatalog, catalogRefreshLine } = await import("../src/lib/catalog-refresh.js");
const { marketUpdate } = await import("../src/commands/market.js");
const { log } = await import("../src/utils/logger.js");

const cfg = { podUrl: "https://pod.example", apiKey: "k" } as never;

function hubError(status: number, detail: string) {
  return new HubError({
    message: `Hub POST /catalog/refresh failed (HTTP ${status}): ${detail}`,
    status,
    detail,
    rawBody: "",
    path: "/catalog/refresh",
    method: "POST",
  });
}

let said: string[] = [];
const plain = () => said.join("\n").replace(/\x1b\[[0-9;]*m/g, "");

beforeEach(() => {
  calls.length = 0;
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
    vi.spyOn(log, level).mockImplementation(((...a: unknown[]) => void said.push(`[${level}] ${a.map(String).join(" ")}`)) as never);
  }
});

describe("refreshPodCatalog: the three answers", () => {
  it("ok → refreshed, with when and whether the run was shared", async () => {
    refresh.answer = async () => ({ ok: true, refreshedAt: "2026-11-03T10:00:00.000Z", reused: true, kinds: {} });
    await expect(refreshPodCatalog(cfg)).resolves.toEqual({
      state: "refreshed",
      refreshedAt: "2026-11-03T10:00:00.000Z",
      reused: true,
    });
    expect(calls).toEqual(["POST /catalog/refresh"]);
  });

  it("404 / 405 → an older pod: unsupported, with the 10-minute line", async () => {
    for (const status of [404, 405]) {
      refresh.answer = async () => {
        throw hubError(status, "Not found");
      };
      const r = await refreshPodCatalog(cfg);
      expect(r).toEqual({ state: "unsupported" });
      expect(catalogRefreshLine(r)).toContain("every 10 minutes");
    }
  });

  it("a refused or unreachable refresh → failed, naming the reason", async () => {
    refresh.answer = async () => {
      throw hubError(502, "Could not reach the catalog for template");
    };
    const r = await refreshPodCatalog(cfg);
    expect(r).toEqual({ state: "failed", reason: "Could not reach the catalog for template" });
    expect(catalogRefreshLine(r)).toContain("Could not refresh the pod's catalog (Could not reach the catalog for template)");

    refresh.answer = async () => {
      throw new HubNetworkError({ kind: "timeout", message: "The pod did not answer in time" } as never);
    };
    expect((await refreshPodCatalog(cfg)).state).toBe("failed");

    // A 200 that does not say ok is not a refresh.
    refresh.answer = async () => ({});
    expect((await refreshPodCatalog(cfg)).state).toBe("failed");
  });
});

describe("market update refreshes the catalog before it reads the verdict", () => {
  it("refreshed: the refresh comes first, nothing extra is said, and the JSON carries it", async () => {
    refresh.answer = async () => ({ ok: true, refreshedAt: "2026-11-03T10:00:00.000Z", reused: false, kinds: {} });
    await marketUpdate(undefined, { json: true });
    expect(calls[0]).toBe("POST /catalog/refresh");
    expect(calls.indexOf("GET /package-updates")).toBeGreaterThan(0);
    const out = JSON.parse(said.find((l) => l.trim().startsWith("{"))!);
    expect(out.catalogRefresh).toEqual({ state: "refreshed", refreshedAt: "2026-11-03T10:00:00.000Z", reused: false });
    expect(out.status).toBe("clean");
  });

  it("refreshed (text): a clean verdict is said as verified", async () => {
    refresh.answer = async () => ({ ok: true, refreshedAt: "2026-11-03T10:00:00.000Z", reused: false, kinds: {} });
    await marketUpdate(undefined, {});
    expect(plain()).toContain("[success] Nothing to update.");
    expect(plain()).not.toMatch(/Could not refresh|every 10 minutes/);
  });

  it("older pod: one line about the 10-minute refresh, and the check goes on", async () => {
    refresh.answer = async () => {
      throw hubError(404, "Not found");
    };
    await marketUpdate(undefined, {});
    expect(plain()).toContain("This pod refreshes its catalog every 10 minutes");
    expect(calls).toContain("GET /package-updates");
    expect(plain()).toContain("content-os");
  });

  it("failed: one warning naming the reason, the check goes on, never a green 'Nothing to update'", async () => {
    refresh.answer = async () => {
      throw hubError(502, "Could not reach the catalog for template");
    };
    await marketUpdate(undefined, {});
    const warnings = said.filter((l) => l.startsWith("[warn]"));
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("Could not reach the catalog for template");
    expect(calls).toContain("GET /package-updates");
    expect(plain()).not.toContain("[success] Nothing to update.");
    expect(plain()).toContain("Nothing to update in the pod's last copy of the catalog");
  });

  it("failed (--json): the status is in the JSON, and nothing else is printed", async () => {
    refresh.answer = async () => {
      throw hubError(502, "Could not reach the catalog for template");
    };
    await marketUpdate(undefined, { json: true });
    expect(said.filter((l) => l.startsWith("[warn]"))).toEqual([]);
    const out = JSON.parse(said.find((l) => l.trim().startsWith("{"))!);
    expect(out.catalogRefresh).toEqual({ state: "failed", reason: "Could not reach the catalog for template" });
  });
});

describe("every command that prints the update verdict refreshes first", () => {
  it("market update, installed, workspaces and templates each call refreshCatalogFirst before their reads", async () => {
    const { readFileSync } = await import("node:fs");
    const src = readFileSync(new URL("../src/commands/market.ts", import.meta.url), "utf8");
    const fns = ["marketUpdate", "marketInstalled", "marketWorkspaces", "marketTemplates"];
    for (const fn of fns) {
      const start = src.indexOf(`export async function ${fn}(`);
      expect(start, fn).toBeGreaterThan(0);
      const body = src.slice(start, src.indexOf("\nexport ", start + 1));
      const at = body.indexOf("await refreshCatalogFirst(");
      expect(at, `${fn} refreshes the catalog`).toBeGreaterThan(0);
      // Before every read of the pod's verdict in that command.
      for (const read of ["fetchPackageStandings(", "fetchInstalledInventory(", "fetchWorkspaceAttachments(", "fetchWorkspaceAttachmentsStrict("]) {
        const r = body.indexOf(read);
        if (r >= 0) expect(at, `${fn}: refresh before ${read}`).toBeLessThan(r);
      }
    }
    // Every verdict reader in market.ts is one of the four (a new one joins the list above).
    const readers = [...src.matchAll(/export async function (\w+)\([^]*?(?=\nexport )/g)]
      .filter((m) => /fetchPackageStandings\(|computeUpdates\(/.test(m[0]))
      .map((m) => m[1]);
    expect(readers.sort()).toEqual([...fns].sort());
  });
});
