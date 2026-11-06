/**
 * `market update` reads the POD's verdict of "this package has an update"
 * (Hub `GET /package-updates` → `installed[]`), the one the pod admin Updates
 * tab reads too, and never computes one itself. 2 Nov 2026: the CLI said
 * "brand-library: content changed h-ee6503 → h-336546" while pod admin said
 * "up to date", because each derived it its own way.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const hubGet = vi.fn();
vi.mock("../src/lib/hub-client.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  hubGet: (...args: unknown[]) => hubGet(...args),
}));

import { HubError } from "../src/lib/hub-client.js";
import {
  checksFromStandings,
  fetchPackageStandings,
  StandingsUnavailableError,
  type PackageStanding,
} from "../src/lib/package-updates.js";
import { cliUpdatableSlugs, installedStatusLabel } from "../src/commands/market.js";
import { FLOW } from "../src/lib/next-steps.js";
import { readFileSync } from "node:fs";

const cfg = { podUrl: "https://pod.example", apiKey: "k" } as never;

function hubError(status: number, message: string): HubError {
  return new HubError({
    message,
    status,
    rawBody: "",
    path: "/package-updates",
    method: "GET",
  });
}

const standing = (over: Partial<PackageStanding>): PackageStanding => ({
  slug: "brand-library",
  kind: "workspace",
  name: "Brand Library",
  installedVersion: "h-ee6503",
  latestVersion: "h-336546",
  hasUpdate: true,
  ...over,
});

beforeEach(() => {
  hubGet.mockReset();
});

describe("market update reads the pod's verdict", () => {
  it("asks the pod's one list, and returns its installed[] as is", async () => {
    const installed = [standing({}), standing({ slug: "operations", hasUpdate: false, installedVersion: "h-1", latestVersion: "h-1" })];
    hubGet.mockResolvedValue({ updates: [], unreadable: [], installed });
    await expect(fetchPackageStandings(cfg)).resolves.toEqual(installed);
    expect(hubGet.mock.calls[0]![0]).toBe("/package-updates");
  });

  it("a pod with no installed[] (older) is said, never guessed", async () => {
    hubGet.mockResolvedValue({ updates: [], unreadable: [] });
    await expect(fetchPackageStandings(cfg)).rejects.toMatchObject({ reason: "pod-too-old" });
    hubGet.mockRejectedValue(hubError(404, "Not found (HTTP 404)"));
    await expect(fetchPackageStandings(cfg)).rejects.toBeInstanceOf(StandingsUnavailableError);
  });

  it("a key whose person is not a pod admin is said, never guessed", async () => {
    hubGet.mockRejectedValue(hubError(403, "Only pod admins can do this (HTTP 403)"));
    await expect(fetchPackageStandings(cfg)).rejects.toMatchObject({ reason: "not-pod-admin" });
  });

  it("an unreachable pod is the hub error itself, never an empty list", async () => {
    hubGet.mockRejectedValue(hubError(503, "Unavailable (HTTP 503)"));
    await expect(fetchPackageStandings(cfg)).rejects.toBeInstanceOf(HubError);
  });

  it("checks carry the pod's verdict: update, current, can't check, version unknown, not finished", () => {
    const checks = checksFromStandings([
      standing({}),
      standing({ slug: "operations", installedVersion: "h-1", latestVersion: "h-1", hasUpdate: false }),
      standing({ slug: "retired-one", installedVersion: "h-2", latestVersion: null, hasUpdate: null, reason: "retired" }),
      standing({ slug: "crm", installedVersion: null, latestVersion: "h-3", hasUpdate: null, reason: "no stamp" }),
      standing({ slug: "half-done", installedVersion: null, latestVersion: "h-4", hasUpdate: true }),
      standing({ slug: "gmail", kind: "capability", installedVersion: "h-aaaaaaaaaaaa", latestVersion: "h-bbbbbbbbbbbb" }),
    ]);
    const label = (slug: string) =>
      // chalk adds no colour codes when the test runner has no TTY.
      installedStatusLabel(checks.find((c) => c.slug === slug)!, false, true).replace(/\x1b\[[0-9;]*m/g, "");
    expect(label("brand-library")).toContain("content changed");
    expect(label("brand-library")).toContain("h-ee6503 → h-336546");
    expect(label("operations")).not.toMatch(/changed|can't|unknown/);
    expect(label("retired-one")).toContain("can't check");
    expect(label("crm")).toContain("version unknown");
    expect(checks.find((c) => c.slug === "half-done")).toMatchObject({ updateAvailable: true, noVersionInfo: true });
    expect(checks.find((c) => c.slug === "gmail")).toMatchObject({ kind: "capability", updateAvailable: true });
    expect(checks.find((c) => c.slug === "crm")!.reason).toBe("no stamp");
  });
});

describe("tripwire: market update never derives the verdict itself", () => {
  it("its body reads the pod's standings, and calls no client-side drift derivation", async () => {
    const { readFileSync } = await import("node:fs");
    const src = readFileSync(new URL("../src/commands/market.ts", import.meta.url), "utf8");
    const start = src.indexOf("export async function marketUpdate(");
    expect(start).toBeGreaterThan(0);
    const end = src.indexOf("\nexport ", start + 1);
    const body = src.slice(start, end);
    expect(body).toContain("fetchPackageStandings(");
    // The forks this replaced: the pod's inventory drift + the CLI's own
    // fallback comparison (`computeUpdates` → `computeTemplateUpdates`).
    expect(body).not.toMatch(/\bcomputeUpdates\(|\bcomputeTemplateUpdates\(|\bfetchInstalledInventoryStrict\(/);
  });
});

describe("next steps offer only what market update can run", () => {
  // Live pod, 2 Nov 2026: "Next: synap market update fal-ai" was printed for a
  // capability, and that command then refused it. Since the one update door
  // (`POST /package-updates/{slug}/apply`) applies every kind, a capability's
  // update IS a command this CLI runs: it is offered, and the current one is not.
  it("every update is offered, a capability's too; a current package is not", () => {
    const checks = checksFromStandings([
      standing({}),
      standing({ slug: "fal-ai", kind: "capability", installedVersion: "h-c10a96", latestVersion: "h-9f8036" }),
      standing({ slug: "daily-brief", kind: "view", installedVersion: "h-1", latestVersion: "h-2" }),
      standing({ slug: "operations", installedVersion: "h-1", latestVersion: "h-1", hasUpdate: false }),
    ]);
    expect(cliUpdatableSlugs(checks)).toEqual(["brand-library", "fal-ai", "daily-brief"]);
    const commands = FLOW.afterMarketUpdateCheck(cliUpdatableSlugs(checks)).map((s) => s.command);
    expect(commands.some((c) => c.includes("operations"))).toBe(false);
    expect(commands).toContain("synap market update brand-library");
  });

  it("every next-step call in market.ts goes through cliUpdatableSlugs", () => {
    const src = readFileSync(new URL("../src/commands/market.ts", import.meta.url), "utf8");
    const calls = src.match(/FLOW\.afterMarket(Update|Installed)Check\(([^)]*\)?)/g) ?? [];
    expect(calls.length).toBeGreaterThanOrEqual(5);
    for (const call of calls) expect(call).toContain("cliUpdatableSlugs(");
  });
});
