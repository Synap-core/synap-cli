import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

/**
 * `synap market install --as <name>` (named instances) is RETIRED: two
 * workspaces may never come from the same template, and the pod answers
 * `instanceName` on /packages/apply with a 400. The flag must not come back.
 *
 * Scope: scans the `market install` option block in src/index.ts (from its
 * `.command("install <slug>")` to the next `.action(`). It does not cover the
 * unrelated `--as <status>` option elsewhere in the file.
 */
const src = readFileSync(new URL("../src/index.ts", import.meta.url), "utf8");

describe("market install --as is retired", () => {
  const start = src.indexOf('.command("install <slug>")');
  const block = src.slice(start, src.indexOf(".action(", start));

  it("sees the install option block (non-vacuity)", () => {
    expect(start).toBeGreaterThan(-1);
    expect(block).toContain('"--onto <workspaceId>"');
  });

  it("registers no --as option", () => {
    expect(block).not.toMatch(/"--as\b/);
  });

  it("market.ts no longer sends instanceName", () => {
    const market = readFileSync(new URL("../src/commands/market.ts", import.meta.url), "utf8");
    expect(market).not.toContain("instanceName");
  });
});
