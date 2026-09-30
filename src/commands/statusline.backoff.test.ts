/**
 * The statusline must back off when the POD is failing.
 *
 * 2026-09-19: `GET /api/hub/workspaces` returned 500 for days. Each failed
 * refresh preserved the previous cache with its OLD `ts` ("last success"), so
 * every render saw a stale cache and spawned another ~5-GET burst. That storm
 * ate the whole 500-per-15-min crud budget on the shared bearer, and the MCP
 * server using the same key got 429s. The fix is a separate attempt clock.
 *
 * These drive the REAL exported `statusline()` — refresh mode and render mode —
 * with fs, child_process and the hub client mocked at the module boundary.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const CACHE_FILE = "/tmp/synap-statusline-cache.json";
const LOCK_FILE = "/tmp/synap-statusline-refresh.lock";

const files = new Map<string, string>();

vi.mock("node:fs", () => {
  const fs = {
    readFileSync: (p: unknown) => {
      const key = String(p);
      if (!files.has(key)) throw new Error(`ENOENT ${key}`);
      return files.get(key)!;
    },
    writeFileSync: (p: unknown, data: unknown) => void files.set(String(p), String(data)),
    unlinkSync: (p: unknown) => void files.delete(String(p)),
    statSync: (p: unknown) => {
      const key = String(p);
      if (!files.has(key)) throw new Error(`ENOENT ${key}`);
      // Locks written by these tests are always fresh unless deleted.
      return { mtimeMs: Date.now() };
    },
    existsSync: (p: unknown) => files.has(String(p)),
  };
  return { default: fs, ...fs };
});

const spawn = vi.fn(() => ({ unref: () => {} }));
vi.mock("node:child_process", () => ({
  spawn: (...args: unknown[]) => spawn(...(args as [])),
  execSync: () => "",
}));

const hubGet = vi.fn();
vi.mock("../lib/hub-client.js", () => ({
  resolveHubConfig: async () => ({ podUrl: "https://pod.test", apiKey: "k", workspaceId: "w" }),
  hubGet: (...args: unknown[]) => hubGet(...(args as [])),
}));
vi.mock("../lib/session-lens.js", () => ({ resolveActiveLens: () => null }));
vi.mock("../lib/describe-lens.js", () => ({
  // Render only reads `structured.workspace` / `structured.project` from this.
  describeLens: () => ({ structured: {}, line: "" }),
}));
vi.mock("../lib/pod.js", () => ({ getSurfaceAgentKey: () => null, SURFACE_NAMES: [] }));

const { statusline } = await import("./statusline.js");

const readCache = () => JSON.parse(files.get(CACHE_FILE) ?? "{}");
const TTL_MS = 120_000;

beforeEach(() => {
  files.clear();
  spawn.mockClear();
  hubGet.mockReset();
});

describe("refresh stamps the attempt even when the pod fails", () => {
  it("a failing pod writes a cache whose attempt clock is NOW, keeping the old success time", async () => {
    const oldSuccess = Date.now() - 10 * TTL_MS;
    files.set(CACHE_FILE, JSON.stringify({ ts: oldSuccess, ok: true, workspaces: [{ id: "a", name: "A", count: 1 }] }));
    hubGet.mockRejectedValue(new Error("500 uuid = text"));

    await statusline({ refresh: true });

    const cache = readCache();
    expect(cache.ok).toBe(false);
    expect(cache.ts).toBe(oldSuccess); // `ts` still means LAST SUCCESS
    expect(Date.now() - cache.attemptedTs).toBeLessThan(TTL_MS); // the attempt is stamped
    expect(cache.workspaces).toHaveLength(1); // last good data kept for display
  });

  it("with NO previous cache a failing pod still writes a stamped one", async () => {
    hubGet.mockRejectedValue(new Error("500"));

    await statusline({ refresh: true });

    const cache = readCache();
    expect(cache.ok).toBe(false);
    expect(typeof cache.attemptedTs).toBe("number");
    expect(Date.now() - cache.attemptedTs).toBeLessThan(TTL_MS);
  });
});

describe("render respects the attempt clock", () => {
  it("does NOT spawn a refresh while a FAILED attempt is inside the window", async () => {
    files.set(
      CACHE_FILE,
      JSON.stringify({ ts: Date.now() - 10 * TTL_MS, attemptedTs: Date.now() - 1_000, ok: false, workspaces: [] })
    );

    await statusline();

    expect(spawn).not.toHaveBeenCalled(); // this is the storm that ate the rate limit
  });

  it("spawns once the attempt clock itself is stale", async () => {
    files.set(
      CACHE_FILE,
      JSON.stringify({ ts: Date.now() - 10 * TTL_MS, attemptedTs: Date.now() - 3 * TTL_MS, ok: false, workspaces: [] })
    );

    await statusline();

    expect(spawn).toHaveBeenCalledTimes(1);
  });

  it("an older cache with no attempt clock falls back to the success time", async () => {
    files.set(CACHE_FILE, JSON.stringify({ ts: Date.now() - 3 * TTL_MS, ok: true, workspaces: [] }));

    await statusline();

    expect(spawn).toHaveBeenCalledTimes(1);
  });
});
