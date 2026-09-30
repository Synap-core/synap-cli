/**
 * The cell authoring hop: `codeFile` indirection + the contentKind/viewTypes
 * validation gate.
 *
 * Before this file: a cell author had no way to reach a published package
 * from a source file without hand-pasting a minified bundle into `code` —
 * `market scaffold --kind cell` wrote an inline placeholder and nothing
 * resolved a referenced source file at publish time. `resolveCellCodeFiles`
 * closes that hop by inlining `codeFile` through the SAME esbuild path `cell
 * build` uses (`buildCellFromSource`, `commands/cell.ts`).
 *
 * `validateStandalonePackage` used to check only that `cells[]` was
 * non-empty — a cell missing `contentKind`/`viewTypes` validated GREEN and
 * then installed permanently unpickable (see `cell.ts`'s SELECTABILITY
 * note). These tests pin the new rejections.
 */
import { describe, it, expect } from "vitest";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import {
  validateStandalonePackage,
  resolveCellCodeFiles,
  type StandalonePackageFile,
} from "../src/lib/kind-package.js";

const here = dirname(fileURLToPath(import.meta.url));
const fixturesDir = resolve(here, "fixtures/cell-build");

function cellPkg(cell: Record<string, unknown>): StandalonePackageFile {
  return {
    category: "cell",
    slug: "probe-cell",
    displayName: "Probe Cell",
    definition: { cells: [cell] },
  };
}

// `contentKind: "collection"` + `viewTypes` is the one pairing where both
// fields are simultaneously legal — see the door-parity tests in
// `kind-package-content-kind-view-types-parity.test.ts`. This fixture used to
// pair `viewTypes` with `contentKind: "widget"`, which is the contradiction
// that validator now rejects (it used to CERTIFY it — see that file's
// top-of-file comment).
const VALID_CELL = {
  key: "probe-cell",
  name: "Probe Cell",
  code: "export default function Cell() { return null; }",
  contentKind: "collection",
  viewTypes: ["list"],
};

describe("validateStandalonePackage — cell fields", () => {
  it("accepts a cell with code, contentKind and viewTypes", () => {
    expect(validateStandalonePackage(cellPkg(VALID_CELL))).toEqual([]);
  });

  it("rejects a cell with neither code nor codeFile", () => {
    const { code: _drop, ...rest } = VALID_CELL;
    const errors = validateStandalonePackage(cellPkg(rest));
    expect(errors.some((e) => e.includes('"code"') && e.includes("codeFile"))).toBe(
      true,
    );
  });

  it("rejects a cell missing contentKind", () => {
    const { contentKind: _drop, ...rest } = VALID_CELL;
    const errors = validateStandalonePackage(cellPkg(rest));
    expect(errors.some((e) => e.includes("contentKind"))).toBe(true);
  });

  it("rejects a cell with an invalid contentKind (the silently-stripped-by-zod case)", () => {
    const errors = validateStandalonePackage(
      cellPkg({ ...VALID_CELL, contentKind: "detail" }),
    );
    expect(errors.some((e) => e.includes("contentKind"))).toBe(true);
  });

  // `viewTypes` is view-renderer AFFINITY — a different axis from
  // `contentKind`'s renderer slot. It is optional on purpose. An earlier
  // version of this suite pinned "missing viewTypes ⇒ reject" as correct,
  // which would have forced authors of entity-detail/widget cells to invent a
  // meaningless ["list"] to pass validation — manufacturing a false affinity
  // and making the cell offered as a renderer it was never built to be.
  it("ACCEPTS a non-view-renderer cell that omits viewTypes entirely", () => {
    const { viewTypes: _drop, ...rest } = VALID_CELL;
    // Explicitly "widget", not derived from VALID_CELL's "collection" — a
    // widget cell has no business declaring viewTypes at all, which is
    // exactly what this test is pinning.
    expect(
      validateStandalonePackage(cellPkg({ ...rest, contentKind: "widget" })),
    ).toEqual([]);
  });

  it("accepts an entity-detail cell with no viewTypes (a profile renderer, not a view one)", () => {
    const { viewTypes: _drop, ...rest } = VALID_CELL;
    const errors = validateStandalonePackage(
      cellPkg({ ...rest, contentKind: "entity-detail" }),
    );
    expect(errors).toEqual([]);
  });

  it("REJECTS a collection cell that omits viewTypes — the one case absence is fatal", () => {
    const { viewTypes: _drop, ...rest } = VALID_CELL;
    const errors = validateStandalonePackage(
      cellPkg({ ...rest, contentKind: "collection" }),
    );
    expect(errors.some((e) => e.includes("viewTypes"))).toBe(true);
  });

  it("rejects an empty viewTypes[] when the key IS present (shape check)", () => {
    const errors = validateStandalonePackage(
      cellPkg({ ...VALID_CELL, viewTypes: [] }),
    );
    expect(errors.some((e) => e.includes("viewTypes"))).toBe(true);
  });

  it("accepts codeFile in place of code, structurally", () => {
    const { code: _drop, ...rest } = VALID_CELL;
    const errors = validateStandalonePackage(
      cellPkg({ ...rest, codeFile: "./chalk-cell.ts" }),
      { baseDir: fixturesDir },
    );
    expect(errors).toEqual([]);
  });

  it("rejects a codeFile that does not resolve, when a baseDir is given", () => {
    const { code: _drop, ...rest } = VALID_CELL;
    const errors = validateStandalonePackage(
      cellPkg({ ...rest, codeFile: "./nope.ts" }),
      { baseDir: fixturesDir },
    );
    expect(errors.some((e) => e.includes("nope.ts") && e.includes("not found"))).toBe(
      true,
    );
  });
});

describe("resolveCellCodeFiles", () => {
  it("is a no-op for a plain inline code cell", async () => {
    const pkg = cellPkg(VALID_CELL);
    const { definition, errors } = await resolveCellCodeFiles(pkg, fixturesDir);
    expect(errors).toEqual([]);
    expect(definition.cells).toEqual([VALID_CELL]);
  });

  it("bundles codeFile and inlines the result into code (default: bundled deps)", async () => {
    const { code: _drop, ...rest } = VALID_CELL;
    const pkg = cellPkg({ ...rest, codeFile: "./chalk-cell.ts" });
    const { definition, errors } = await resolveCellCodeFiles(pkg, fixturesDir);
    expect(errors).toEqual([]);
    const cell = (definition.cells as Record<string, unknown>[])[0];
    expect(cell.codeFile).toBeUndefined();
    expect(typeof cell.code).toBe("string");
    expect(cell.code as string).not.toMatch(/from\s+["']chalk["']/);
    // Default is bundled deps: only react (host-inlined) stays external, and
    // it is deliberately excluded from `deps` too — see buildCellFromSource.
    expect(cell.deps).toEqual({});
  });

  it("--no-bundle-deps (bundleDeps: false) leaves third-party deps external, matching direct `cell build`'s own default", async () => {
    const { code: _drop, ...rest } = VALID_CELL;
    const pkg = cellPkg({ ...rest, codeFile: "./chalk-cell.ts" });
    const { definition, errors } = await resolveCellCodeFiles(pkg, fixturesDir, {
      bundleDeps: false,
    });
    expect(errors).toEqual([]);
    const cell = (definition.cells as Record<string, unknown>[])[0];
    expect(cell.code as string).toMatch(/from\s+["']chalk["']/);
    expect(Object.keys(cell.deps as Record<string, string>).sort()).toEqual([
      "chalk",
      "react",
    ]);
  });

  it("reports a codeFile that cannot be found, without throwing", async () => {
    const { code: _drop, ...rest } = VALID_CELL;
    const pkg = cellPkg({ ...rest, codeFile: "./nope.ts" });
    const { errors } = await resolveCellCodeFiles(pkg, fixturesDir);
    expect(errors.some((e) => e.includes("not found"))).toBe(true);
  });

  it("is a no-op for a non-cell category", async () => {
    const pkg: StandalonePackageFile = {
      category: "view",
      slug: "probe-view",
      displayName: "Probe View",
      definition: { views: [{ slug: "probe-view", displayName: "Probe View", type: "list" }] },
    };
    const { errors } = await resolveCellCodeFiles(pkg, fixturesDir);
    expect(errors).toEqual([]);
  });
});
