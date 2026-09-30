import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { BUNDLE_DEPS_KEEP_EXTERNAL } from "../src/commands/cell.js";

/**
 * `BUNDLE_DEPS_KEEP_EXTERNAL` in `cell.ts` is a hand-maintained mirror of
 * what the frame host provides at runtime — exactly the drift class this
 * repo keeps losing to (see `kind-heading-vocabulary-parity.test.ts`,
 * `exporter-coverage-parity.test.ts`). This test reads the host's OWN import
 * map source across the repo boundary and fails the moment it starts
 * supplying a bare module this CLI's set does not know about — which is
 * exactly how `@synap/view-sdk` went unbundleable under `--bundle-deps`
 * (react/react-dom were added by hand; view-sdk shipped later and nobody
 * updated the mirror).
 *
 * Skipped (never failed vacuously) when the sibling checkout is absent, the
 * `it.runIf` shape `kind-heading-vocabulary-parity.test.ts` established.
 */
const FRAME_IMPORT_MAP = join(
  process.cwd(),
  "../synap-app/packages/core/cell-runtime/src/frame-import-map.ts",
);

/** `imports['@synap/view-sdk'] = blobs.viewSdk;` → "@synap/view-sdk" (top-level package name, subpaths folded to their package). */
function hostProvidedPackages(src: string): Set<string> {
  const names = new Set<string>();
  for (const m of src.matchAll(/imports\[['"]([^'"]+)['"]\]\s*=/g)) {
    const path = m[1];
    const parts = path.split("/");
    const pkgName =
      path.startsWith("@") && parts.length >= 2 ? `${parts[0]}/${parts[1]}` : parts[0];
    names.add(pkgName);
  }
  return names;
}

describe("BUNDLE_DEPS_KEEP_EXTERNAL matches the frame host's import map", () => {
  const hasHost = existsSync(FRAME_IMPORT_MAP);

  it("the local set is non-vacuous", () => {
    expect(BUNDLE_DEPS_KEEP_EXTERNAL.size).toBeGreaterThanOrEqual(2);
  });

  it.runIf(hasHost)("every host-provided package stays external under --bundle-deps", () => {
    const src = readFileSync(FRAME_IMPORT_MAP, "utf8");
    expect(src.length, "host import-map source unreadable — assertion would be vacuous").toBeGreaterThan(200);

    const hostPackages = hostProvidedPackages(src);
    expect(hostPackages.size, "no host-provided packages parsed — the assertion would be vacuous").toBeGreaterThan(0);

    for (const pkg of hostPackages) {
      expect(
        BUNDLE_DEPS_KEEP_EXTERNAL.has(pkg),
        `frame-import-map.ts host-supplies "${pkg}" but BUNDLE_DEPS_KEEP_EXTERNAL in cell.ts does not know it — a --bundle-deps build of a cell importing it will fail`,
      ).toBe(true);
    }
  });
});
