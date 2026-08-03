import { describe, it, expect } from "vitest";
import { computeUpdates } from "../src/commands/market.js";
import type { InstalledTemplateInfo } from "../src/lib/installed.js";

// A minimal MarketCatalog stub — the server-first path never reads it; these
// tests deliberately assert the CLI honors the pod's TemplateHealth verdict
// WITHOUT consulting the client catalog at all.
const stubCat = { entries: [], remoteVersionBySlug: new Map() } as never;

const base: InstalledTemplateInfo = {
  slug: "crm",
  version: "h-aaa",
  workspaceId: "w1",
  workspaceName: "CRM",
};

describe("computeUpdates — server-first TemplateHealth", () => {
  it("honors the pod's drifted:true verdict (and its latestVersion), ignoring the catalog", () => {
    const [c] = computeUpdates(
      [{ ...base, latestVersion: "h-bbb", drifted: true }],
      stubCat
    );
    expect(c).toMatchObject({
      slug: "crm",
      updateAvailable: true,
      latestVersion: "h-bbb",
      noVersionInfo: false,
    });
  });

  it("honors drifted:false → up to date", () => {
    const [c] = computeUpdates(
      [{ ...base, latestVersion: "h-aaa", drifted: false }],
      stubCat
    );
    expect(c.updateAvailable).toBe(false);
    expect(c.noVersionInfo).toBe(false);
  });

  it("falls back to the client path when the pod omits drifted (older pod) — a no-version install reports noVersionInfo", () => {
    const [c] = computeUpdates(
      [{ slug: "crm", version: undefined, workspaceId: "w1", workspaceName: "CRM" }],
      stubCat
    );
    expect(c.noVersionInfo).toBe(true);
    expect(c.updateAvailable).toBe(false);
  });
});
