/**
 * `synap cell build --bundle-deps` on a cell that imports `@synap/view-sdk`.
 *
 * The frame host supplies `@synap/view-sdk` via the iframe import map
 * (`synap-app/packages/core/cell-runtime/src/frame-import-map.ts`,
 * `imports['@synap/view-sdk'] = blobs.viewSdk`) — the SAME contract that lets
 * react/react-dom stay external under `--bundle-deps`. Before this fix
 * `BUNDLE_DEPS_KEEP_EXTERNAL` only knew about react/react-dom, so esbuild
 * tried to resolve `@synap/view-sdk` from node_modules, failed (it is not an
 * installed package — it only exists at runtime, host-supplied), and the
 * build died. `market publish` now defaults `bundleDeps` to true for cells,
 * so this blocked publishing ANY cell that uses the view SDK.
 */
import { describe, it, expect } from "vitest";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { bundleWithEsbuild } from "../src/commands/cell.js";

const here = dirname(fileURLToPath(import.meta.url));
const fixture = (name: string) => resolve(here, "fixtures/cell-build", name);

describe("bundleWithEsbuild --bundle-deps keeps @synap/view-sdk external", () => {
  it("does not try to resolve @synap/view-sdk from node_modules", async () => {
    const { code, externals } = await bundleWithEsbuild(
      fixture("view-sdk-cell.ts"),
      { bundleDeps: true },
    );
    expect(externals).toContain("@synap/view-sdk");
    // chalk is still bundled (not host-provided); the import statement is gone.
    expect(code).not.toMatch(/from\s+["']chalk["']/);
    expect(code).toMatch(/from\s+["']@synap\/view-sdk["']/);
  });
});
