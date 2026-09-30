/**
 * `synap cell build --bundle-deps`.
 *
 * Default `cell build` externalizes EVERY bare import and hands the caller a
 * `deps` map that the runtime resolves via esm.sh at load time (see
 * `ViewFrame.tsx`). `--bundle-deps` inlines every third-party import into the
 * bundle at build time — only `react`/`react-dom` stay external, because
 * those are host-inlined separately (`frame-react-modules.ts`), never via
 * esm.sh. A cell built with `--bundle-deps` therefore ships with `deps = {}`,
 * which is what lets `ViewFrame.buildFrameCsp` drop esm.sh from the CSP
 * entirely (see the browser-side CSP test).
 *
 * Fixtures live under `test/fixtures/cell-build/` (not a tmpdir) so esbuild's
 * node_modules resolution walks up to this package's real `chalk` dependency
 * — a tmpdir outside the repo tree can't resolve it at all.
 */
import { describe, it, expect, vi } from "vitest";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { bundleWithEsbuild, cellBuild } from "../src/commands/cell.js";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";

const here = dirname(fileURLToPath(import.meta.url));
const fixture = (name: string) => resolve(here, "fixtures/cell-build", name);

describe("bundleWithEsbuild (default mode)", () => {
  it("externalizes every bare import, including third-party ones", async () => {
    const { code, externals } = await bundleWithEsbuild(fixture("chalk-cell.ts"));
    expect(externals.sort()).toEqual(["chalk", "react"]);
    // externalized imports stay as import statements — chalk's source is
    // never inlined.
    expect(code).not.toContain("function red(");
    expect(code).toMatch(/from\s+["']chalk["']/);
  });
});

describe("bundleWithEsbuild (--bundle-deps)", () => {
  it("externalizes only react/react-dom and inlines everything else", async () => {
    const { code, externals } = await bundleWithEsbuild(fixture("chalk-cell.ts"), {
      bundleDeps: true,
    });
    expect(externals).toEqual(["react"]);
    // chalk is now bundled — its import statement is gone from the output.
    expect(code).not.toMatch(/from\s+["']chalk["']/);
    expect(code).toMatch(/from\s+["']react["']/);
  });

  it("keeps react-dom (and its subpaths) external too, not just 'react'", async () => {
    const { code, externals } = await bundleWithEsbuild(
      fixture("react-dom-subpath.ts"),
      { bundleDeps: true },
    );
    expect(externals).toEqual(["react-dom"]);
    expect(code).not.toMatch(/from\s+["']chalk["']/);
    expect(code).toMatch(/from\s+["']react-dom\/client["']/);
  });
});

/**
 * THE WIRE, not the helper.
 *
 * The tests above assert what `bundleWithEsbuild` puts in `externals` — and
 * `react` is in there under `--bundle-deps` BY DESIGN (it stays external to
 * esbuild because the host inlines it). But `externals` is not the artifact the
 * runtime reads: `deps` is. `cellBuild` derives one from the other, and that
 * derivation is the seam the whole feature hangs on:
 *
 *   `ViewFrame.buildFrameCsp`'s `fullyBundled` branch keys off
 *   `Object.keys(deps).length === 0`.
 *
 * So if `cellBuild` copied `react` from `externals` into `deps`, every React
 * cell would ship `deps = { react: "…" }`, `fullyBundled` would be false, and
 * esm.sh would stay in the CSP — the flag would be inert on its main use case
 * while every externals-level test above stayed green. That is exactly what it
 * did before this test existed.
 */
describe("cell build --bundle-deps → the emitted deps map", () => {
  /** Run cellBuild with --json and parse the payload it prints. */
  async function emittedDeps(
    fixtureName: string,
    opts: { bundleDeps?: boolean }
  ): Promise<Record<string, string>> {
    const out = resolve(mkdtempSync(resolve(tmpdir(), "cellbuild-")), "out.js");
    const lines: string[] = [];
    const spy = vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => {
      lines.push(a.map(String).join(" "));
    });
    try {
      await cellBuild(fixture(fixtureName), { out, json: true, ...opts });
    } finally {
      spy.mockRestore();
    }
    // `log.dim` also writes to console.log, so slice out the JSON block:
    // --json prints a pretty-printed object starting at a line that is "{".
    const joined = lines.join("\n");
    const start = joined.indexOf("{");
    const end = joined.lastIndexOf("}");
    if (start === -1 || end === -1)
      throw new Error(`no JSON payload in cellBuild output:\n${joined}`);
    const payload = JSON.parse(joined.slice(start, end + 1)) as {
      deps: Record<string, string>;
    };
    return payload.deps;
  }

  it("omits react from deps under --bundle-deps, so deps is EMPTY", async () => {
    const deps = await emittedDeps("chalk-cell.ts", { bundleDeps: true });
    expect(deps).toEqual({});
    expect(Object.keys(deps)).toHaveLength(0);
  });

  it("omits react-dom (and subpaths) from deps under --bundle-deps", async () => {
    const deps = await emittedDeps("react-dom-subpath.ts", { bundleDeps: true });
    expect(deps).toEqual({});
  });

  it("default mode is UNCHANGED — react and chalk both stay in deps", async () => {
    const deps = await emittedDeps("chalk-cell.ts", {});
    expect(Object.keys(deps).sort()).toEqual(["chalk", "react"]);
  });
});
