/**
 * Both failure branches inside `bundleWithEsbuild` — a missing/broken esbuild
 * install, and an esbuild build failure — must THROW `CellBundleError`, never
 * `process.exit(1)`. `cellBuild` (the direct `cell build` CLI entry point)
 * still exits 1 on any thrown error, so interactive behaviour is unchanged;
 * but `resolveCellCodeFiles` on the `market publish` path needs the error
 * RETURNED so it can build its `{ ok: false, stage: "build", errors }`
 * envelope (see `market-publish-build-error-envelope.test.ts` for that half).
 * If either branch still called `process.exit(1)`, this test's process would
 * die instead of the `expect(...).rejects` assertion ever running.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

describe("bundleWithEsbuild — esbuild load failure", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it("throws CellBundleError instead of exiting when esbuild fails to import", async () => {
    vi.doMock("esbuild", () => {
      throw new Error("Cannot find module 'esbuild'");
    });
    const { bundleWithEsbuild, CellBundleError } = await import("../src/commands/cell.js");

    await expect(bundleWithEsbuild("irrelevant-entry.ts")).rejects.toBeInstanceOf(
      CellBundleError,
    );
    await expect(bundleWithEsbuild("irrelevant-entry.ts")).rejects.toThrow(
      /Reinstall the CLI/,
    );

    vi.doUnmock("esbuild");
  });
});
