/**
 * THE WIRE for "`--bundle-deps` defaults ON for a published cell, `cell
 * build` invoked directly stays byte-identical".
 *
 * `kind-package-cell-codefile.test.ts` proves `resolveCellCodeFiles` itself
 * defaults to `bundleDeps: true` and `cell-build-bundle-deps.test.ts` proves
 * `cellBuild`'s own default is unaffected (still externalizes every bare
 * import) — neither of those, on its own, proves `market publish` actually
 * calls the resolver with that default rather than, say, always passing
 * `bundleDeps: false` or never wiring the flag at all. This pins the wire.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const AUTHORING_SRC = readFileSync(
  join(process.cwd(), "src/commands/market-authoring.ts"),
  "utf8",
);
const INDEX_SRC = readFileSync(join(process.cwd(), "src/index.ts"), "utf8");

describe("market publish → resolveCellCodeFiles bundle-deps default", () => {
  it("marketPublishStandalone defaults bundleDeps to true (only `--no-bundle-deps` flips it)", () => {
    expect(AUTHORING_SRC).toContain("bundleDeps: opts.bundleDeps !== false");
  });

  it("resolveCellCodeFiles is actually called on the cell publish path", () => {
    expect(AUTHORING_SRC).toContain("resolveCellCodeFiles(pkg, baseDir");
  });

  it("`market publish` registers --no-bundle-deps as the escape hatch", () => {
    expect(INDEX_SRC).toContain('"--no-bundle-deps"');
  });
});
