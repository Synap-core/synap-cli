import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { HOST_PROVIDED_FRAME_SPECIFIERS, BUNDLE_DEPS_KEEP_EXTERNAL } from "../src/commands/cell.js";

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
  "../synap-app/packages/web/src/cell-runtime/frame-import-map.ts",
);

/** Every exact specifier the host registers: `imports['react-dom/client'] = …` gives "react-dom/client". */
function hostProvidedSpecifiers(src: string): Set<string> {
  return new Set([...src.matchAll(/imports\[['"]([^'"]+)['"]\]\s*=/g)].map((m) => m[1]!));
}

describe("BUNDLE_DEPS_KEEP_EXTERNAL matches the frame host's import map", () => {
  // A sibling synap-app checkout without the file is a stale path, never a skip.
  const siblingExists = existsSync(join(process.cwd(), "../synap-app/packages"));
  const hasHost = existsSync(FRAME_IMPORT_MAP);

  it("the local set is non-vacuous and exact-specifier", () => {
    expect(BUNDLE_DEPS_KEEP_EXTERNAL.size).toBeGreaterThanOrEqual(2);
    expect(BUNDLE_DEPS_KEEP_EXTERNAL.has("react-dom/server")).toBe(false);
    expect(BUNDLE_DEPS_KEEP_EXTERNAL.has("@synap/kit/charts")).toBe(false);
  });

  it.runIf(siblingExists)("the host import-map file exists where this test looks for it", () => {
    expect(hasHost, `synap-app is checked out beside the CLI but ${FRAME_IMPORT_MAP} is missing: the path went stale`).toBe(true);
  });

  it.runIf(hasHost)("the host provides exactly the specifiers the CLI keeps external", () => {
    const src = readFileSync(FRAME_IMPORT_MAP, "utf8");
    expect(src.length, "host import-map source unreadable, assertion would be vacuous").toBeGreaterThan(200);
    const host = hostProvidedSpecifiers(src);
    expect(host.size, "no host-provided specifiers parsed, assertion would be vacuous").toBeGreaterThan(0);
    expect([...host].sort()).toEqual([...HOST_PROVIDED_FRAME_SPECIFIERS].sort());
  });
});
