/**
 * A bundle failure on the `market publish` path must reach the caller as a
 * structured `{ ok: false, stage: "build", errors }` envelope, not kill the
 * process.
 *
 * `resolveCellCodeFiles` (`lib/kind-package.ts`) already wraps
 * `buildCellFromSource` in try/catch and pushes `(e as Error).message` into
 * its `errors` array — but before this fix `bundleWithEsbuild` called
 * `process.exit(1)` directly on BOTH a missing esbuild install and an
 * esbuild build error, so that catch was unreachable: the process died
 * first, and `marketPublishStandalone`'s carefully-built `--json` envelope
 * (`market-authoring.ts`) never ran. This test proves the catch is now
 * reachable by feeding `resolveCellCodeFiles` a `codeFile` with a real
 * syntax error and asserting it RETURNS an error instead of exiting.
 */
import { describe, it, expect } from "vitest";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import {
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

describe("resolveCellCodeFiles surfaces a bundle failure as a returned error", () => {
  it("returns an errors[] entry instead of exiting the process", async () => {
    const pkg = cellPkg({
      key: "probe-cell",
      name: "Probe Cell",
      codeFile: "./syntax-error-cell.ts",
      contentKind: "widget",
      viewTypes: ["list"],
    });

    const { errors } = await resolveCellCodeFiles(pkg, fixturesDir, {
      bundleDeps: true,
    });

    expect(errors.length).toBeGreaterThan(0);
    expect(errors[0]).toContain("syntax-error-cell.ts");
    expect(errors[0]).toContain("failed to bundle");
  });
});
