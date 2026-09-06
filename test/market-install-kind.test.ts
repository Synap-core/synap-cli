/**
 * Unit tests for `marketInstallKind` — the pure CP-category → pod-verb-`kind`
 * translation that lets `synap market install <slug>` route non-workspace
 * packages through the pod's `market.install` verb. The CP's live PACKAGE_TYPES
 * and the pod's cache `kind` vocabulary diverge (cp-catalog-sync.ts), so this
 * map is the load-bearing seam: a wrong result means the verb's zod enum
 * rejects the request (400) or the wrong definition is resolved.
 *
 * The last test is a DOOR-PARITY tripwire. `marketInstallKind` used to return
 * null for `view` and `skill` — kinds the pod verb has always accepted — so the
 * 3 published view packages were uninstallable from the terminal with no error
 * anywhere, just a "the CLI can't install this type yet" line. Parity is
 * asserted by parsing the verb's own zod enum out of the backend source rather
 * than against a second hand-written list, because a hand-written expectation
 * would just pin the same lie.
 */
import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import {
  marketInstallKind,
  marketInstallNeedsWorkspace,
  MARKET_INSTALL_KINDS,
} from "../src/commands/market.js";

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

  it("installs the kinds the verb accepts that the CLI used to refuse (view, skill)", () => {
    expect(marketInstallKind("view")).toBe("view");
    expect(marketInstallKind("skill")).toBe("skill");
  });

  it("returns null for a workspace (installed via /packages/apply, never routed here)", () => {
    expect(marketInstallKind("workspace")).toBeNull();
  });

  it("returns null for an unknown type", () => {
    expect(marketInstallKind("something-new")).toBeNull();
  });
});

describe("market.install workspace requirement", () => {
  it("requires a workspace exactly for automation and view", () => {
    // marketplace-install.ts 400s without workspaceId for these two arms.
    expect(marketInstallNeedsWorkspace("automation")).toBe(true);
    expect(marketInstallNeedsWorkspace("view")).toBe(true);
    // …and every other kind must stay pod-wide.
    expect(marketInstallNeedsWorkspace("capability")).toBe(false);
    expect(marketInstallNeedsWorkspace("cell")).toBe(false);
    expect(marketInstallNeedsWorkspace("skill")).toBe(false);
    expect(marketInstallNeedsWorkspace("template")).toBe(false);
  });
});

/**
 * Path to the backend file that owns the `market.install` zod enum. Resolved
 * relative to this test so it works from the monorepo checkout; the parity
 * assertion is skipped (not failed) when the CLI is checked out standalone.
 */
const BUILTIN_VERBS = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../synap-backend/packages/api/src/services/capabilities/builtin-verbs.ts"
);

describe("door parity: CLI kinds vs the pod verb's zod enum", () => {
  it.skipIf(!existsSync(BUILTIN_VERBS))(
    "accepts every kind `marketInstallParams` accepts, and no others",
    () => {
      const src = readFileSync(BUILTIN_VERBS, "utf-8");
      const block = /const marketInstallParams = z\.object\(\{[\s\S]*?\n\}\);/.exec(src);
      expect(block, "marketInstallParams not found — did it move or get renamed?").toBeTruthy();

      const enumBlock = /kind:\s*z\.enum\(\[([\s\S]*?)\]\)/.exec(block![0]);
      expect(enumBlock, "kind: z.enum([...]) not found in marketInstallParams").toBeTruthy();

      const podKinds = [...enumBlock![1].matchAll(/"([a-z_]+)"/g)].map((m) => m[1]);
      expect(podKinds.length).toBeGreaterThan(0);

      // Same set, order-insensitive.
      expect([...podKinds].sort()).toEqual([...MARKET_INSTALL_KINDS].sort());

      // And every one of them must actually resolve through the mapper, so the
      // declared list can't drift away from the switch below it.
      for (const kind of podKinds) {
        expect(marketInstallKind(kind), `marketInstallKind("${kind}")`).toBe(kind);
      }
    }
  );
});
