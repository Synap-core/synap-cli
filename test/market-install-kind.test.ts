/**
 * Unit tests for `marketInstallKind` — the pure CP-category → pod-verb-`kind`
 * translation that lets `synap market install <slug>` route non-workspace
 * packages through the pod's `market.install` verb. The CP's live PACKAGE_TYPES
 * and the pod's cache `kind` vocabulary diverge (cp-catalog-sync.ts), so this
 * map is the load-bearing seam: a wrong result means the verb's zod enum
 * rejects the request (400) or the wrong definition is resolved.
 */
import { describe, it, expect } from "vitest";
import { marketInstallKind } from "../src/commands/market.js";

describe("marketInstallKind", () => {
  it("maps a capability to the capability kind (the primary CLI case)", () => {
    expect(marketInstallKind("capability")).toBe("capability");
  });

  it("maps a cell to the cell kind", () => {
    expect(marketInstallKind("cell")).toBe("cell");
  });

  it("maps the CP's `workflow` category to the pod's `automation` kind", () => {
    expect(marketInstallKind("workflow")).toBe("automation");
  });

  it("accepts the pod's cache vocabulary verbatim (automation, template)", () => {
    expect(marketInstallKind("automation")).toBe("automation");
    expect(marketInstallKind("template")).toBe("template");
  });

  it("returns null for a workspace (installed via /packages/apply, never routed here)", () => {
    expect(marketInstallKind("workspace")).toBeNull();
  });

  it("returns null for types the verb can't install (skill, view, unknown)", () => {
    expect(marketInstallKind("skill")).toBeNull();
    expect(marketInstallKind("view")).toBeNull();
    expect(marketInstallKind("something-new")).toBeNull();
  });
});
