/**
 * TRANSITION TRIPWIRE: `src/lib/package-wire.ts` is a MIRROR of the catalog's
 * wire contract (`synap-app/packages/workspace-templates/src/wire-core.ts`,
 * public as `@synap-core/workspace-templates/wire`).
 *
 * The CLI resolves `@synap-core/workspace-templates` from npm (0.12.0 today),
 * which predates the `./wire` subpath, so it carries the import-free core as a
 * copy. Until it can import the subpath, an edit on ONE side silently forks the
 * envelope every consumer reads, so the two files must be byte-identical.
 *
 * Skips, with the reason logged, when the sibling synap-app checkout is absent
 * (CLI CI checks out this repo alone).
 *
 * RETIRES when the CLI depends on a published version that exports `./wire`:
 * delete `src/lib/package-wire.ts`, import `@synap-core/workspace-templates/wire`,
 * and delete this file in that same change.
 */

import { describe, it, expect } from "vitest";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { unwrapPackage } from "../src/lib/package-wire.js";

const CLI = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const MIRROR = path.join(CLI, "src", "lib", "package-wire.ts");
const SOURCE = ["catalog", "workspace-templates"]
  .map((d) => path.resolve(CLI, "..", "synap-app", "packages", d, "src", "wire-core.ts"))
  .find((f) => fs.existsSync(f));

if (!SOURCE) console.warn("[package-wire-mirror] SKIP: no synap-app checkout with src/wire-core.ts beside this repo");

describe.skipIf(!SOURCE)("package-wire mirror equals the catalog's wire core", () => {
  it("is byte-identical", () => {
    const a = fs.readFileSync(MIRROR);
    const b = fs.readFileSync(SOURCE!);
    expect(a.length).toBeGreaterThan(1000);
    expect(a.equals(b), `${MIRROR} differs from ${SOURCE} — copy the catalog file over the mirror`).toBe(true);
  });
});

describe("package-wire mirror behaves as the contract says", () => {
  it("unwraps a served skill to its body, and refuses a non-object", () => {
    const served = { _meta: { slug: "creative-director" }, icon: "x", skill: { name: "Creative director", body: "# body" } };
    expect(unwrapPackage("skill", served).body).toBe("# body");
    expect(unwrapPackage("workflow", { profiles: [], automations: [{ name: "a", triggerType: "manual" }] })).toHaveLength(1);
    expect(() => unwrapPackage("skill", null)).toThrow(/not an object/);
  });
});
