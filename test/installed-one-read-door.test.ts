import { describe, it, expect } from "vitest";
import {
  INSTALLED_KINDS,
  installedRowsToTemplates,
  type InstalledRow,
} from "../src/lib/installed.js";
import { collectUnlinked, dedupeBySlug, fanOutLabel } from "../src/commands/market.js";
import { computeUpdates } from "../src/commands/market.js";

/**
 * `GET /api/hub/installed` is the ONE read door over the four install ledgers.
 * These pin the three field contracts that, if mistranslated, turn a wider
 * inventory into a wider LIE:
 *
 *  1. `drift: null` = NOT COMPUTED — it must never become "up to date".
 *  2. `packageSlug: null` = not source-linked — never an update target, and
 *     never rendered as a package name.
 *  3. a POD-GLOBAL row has no workspace — it must not be invented.
 */

function row(over: Partial<InstalledRow>): InstalledRow {
  return {
    kind: "view",
    id: "v1",
    name: "Task board",
    packageSlug: "task-views-pack",
    templateKey: null,
    installedVersion: "1.0.0",
    latestVersion: null,
    drift: null,
    installedAt: null,
    workspaceId: "w1",
    workspaceName: "CRM",
    provisioningStatus: null,
    failedStep: null,
    ...over,
  };
}

const stubCat = { entries: [], remoteVersionBySlug: new Map() } as never;

describe("installedRowsToTemplates — the door's contract, translated", () => {
  it("carries every kind through, not just workspace", () => {
    const rows = INSTALLED_KINDS.map((kind, i) =>
      row({ kind, id: `x${i}`, packageSlug: `pkg-${kind}` })
    );
    const kinds = installedRowsToTemplates(rows).map((t) => t.kind);
    expect(kinds).toEqual([...INSTALLED_KINDS]);
  });

  it("drops rows with no packageSlug — a templateKey is not an update target", () => {
    const out = installedRowsToTemplates([
      row({ kind: "capability", packageSlug: null, templateKey: "exa" }),
      row({ packageSlug: "task-views-pack" }),
    ]);
    expect(out.map((t) => t.slug)).toEqual(["task-views-pack"]);
  });

  it("maps drift:null to UNKNOWN, never to drifted:false", () => {
    const [t] = installedRowsToTemplates([row({ drift: null })]);
    expect(t.drifted).toBeUndefined();
    // …and downstream that stays "couldn't check", not "up to date".
    const [c] = computeUpdates([{ ...t, version: undefined }], stubCat);
    expect(c.noVersionInfo).toBe(true);
    expect(c.updateAvailable).toBe(false);
  });

  it("preserves a computed drift verdict in both directions", () => {
    const [yes] = installedRowsToTemplates([row({ drift: true, latestVersion: "2.0.0" })]);
    const [no] = installedRowsToTemplates([row({ drift: false })]);
    expect(yes.drifted).toBe(true);
    expect(no.drifted).toBe(false);
    expect(computeUpdates([yes], stubCat)[0].updateAvailable).toBe(true);
    expect(computeUpdates([no], stubCat)[0].updateAvailable).toBe(false);
  });

  it("keeps a pod-global row's workspaceId null rather than inventing one", () => {
    const [t] = installedRowsToTemplates([
      row({ kind: "cell", packageSlug: "c", workspaceId: null, workspaceName: null }),
    ]);
    expect(t.workspaceId).toBeNull();
    expect(t.workspaceName).toBe("pod-wide");
  });
});

describe("collectUnlinked — inventory that has no update path", () => {
  it("groups capability rows by templateKey and never prints a slug", () => {
    const out = collectUnlinked([
      row({ kind: "capability", packageSlug: null, templateKey: "exa", workspaceId: null }),
      row({ kind: "capability", packageSlug: null, templateKey: "exa", workspaceId: "w1" }),
      row({ kind: "capability", packageSlug: null, templateKey: "apify", workspaceId: null }),
      row({ packageSlug: "task-views-pack" }),
    ]);
    expect(out.map((u) => u.name)).toEqual(["exa", "apify"]);
    expect(out[0].placements.size).toBe(2);
    expect(out.every((u) => u.kind === "capability")).toBe(true);
  });

  it("never surfaces the string 'unknown' as a name for an unsourced cell", () => {
    // The pod already nulls the `cell:unknown:<key>` sentinel; assert we render
    // the row's real name rather than reintroducing a fake package.
    const [u] = collectUnlinked([
      row({ kind: "cell", packageSlug: null, templateKey: null, name: "Sparkline" }),
    ]);
    expect(u.name).toBe("Sparkline");
    expect(u.templateKey).toBeNull();
  });
});

describe("fanOutLabel — placements, not row counts", () => {
  it("counts distinct workspaces", () => {
    expect(fanOutLabel(new Set(["w1"]))).toBe("1 workspace");
    expect(fanOutLabel(new Set(["w1", "w2"]))).toBe("2 workspaces");
  });

  it("names a pod-wide install instead of calling it a workspace", () => {
    const podWide = collectUnlinked([
      row({ kind: "capability", packageSlug: null, templateKey: "exa", workspaceId: null }),
    ])[0].placements;
    expect(fanOutLabel(podWide)).toBe("pod-wide");
  });

  it("reports both when a slug landed in workspaces AND pod-wide", () => {
    const mixed = collectUnlinked([
      row({ kind: "capability", packageSlug: null, templateKey: "exa", workspaceId: null }),
      row({ kind: "capability", packageSlug: null, templateKey: "exa", workspaceId: "w1" }),
    ])[0].placements;
    expect(fanOutLabel(mixed)).toBe("1 workspace · pod-wide");
  });
});

describe("dedupeBySlug — an update applies per package, not per object", () => {
  it("collapses the N rows one views pack contributes into one", () => {
    // `GET /installed` reports one row per installed VIEW; `market update`
    // applies per package. Four rows must not become four preview lines, nor
    // four entries in the "N up to date" tally.
    const rows = installedRowsToTemplates([
      row({ id: "v1" }),
      row({ id: "v2" }),
      row({ id: "v3" }),
      row({ id: "v4", packageSlug: "event-views-pack" }),
    ]);
    const checks = computeUpdates(rows, stubCat);
    expect(checks).toHaveLength(4);
    expect(dedupeBySlug(checks).map((c) => c.slug)).toEqual([
      "task-views-pack",
      "event-views-pack",
    ]);
  });
});
