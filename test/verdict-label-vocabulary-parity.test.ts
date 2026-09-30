import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

/**
 * `synap session evidence` / `synap session evaluate` print a verdict word
 * for `pass` / `fail` / `unmeasured` (`session_evaluations.verdict`). SSOT is
 * `@synap-core/types/vocabulary`'s `STATUS_LABELS` — pinned there under a
 * comment naming "session evaluation verdicts" so `unmeasured` never reads as
 * a failure.
 *
 * This package cannot import the vocabulary package directly (drizzle-orm/
 * drizzle-zod/yjs transitive deps on a globally-installed binary — see the
 * doc comment on `SESSION_KIND_LABELS` in `sessions.ts`), so `VERDICT_LABELS`
 * is a local mirror. This tripwire reads the registry's OWN source across the
 * repo boundary so a drift fails the build instead of shipping silently.
 */
const REGISTRY = join(
  process.cwd(),
  "../synap-backend/packages/types/src/vocabulary/index.ts",
);
const SRC = join(process.cwd(), "src/commands/sessions.ts");

describe("CLI verdict labels match the vocabulary registry", () => {
  const hasRegistry = existsSync(REGISTRY);
  const cli = readFileSync(SRC, "utf8");

  it("the CLI table is readable and never derives a label from charAt(0)", () => {
    expect(cli).toContain("const VERDICT_LABELS");
    expect(cli).not.toMatch(/\.charAt\(0\)\.toUpperCase\(\)/);
  });

  it.runIf(hasRegistry)("every VERDICT_LABELS entry equals the registry's STATUS_LABELS entry", () => {
    const reg = readFileSync(REGISTRY, "utf8");
    expect(reg.length, "registry source unreadable — assertion would be vacuous").toBeGreaterThan(1000);

    const table = /const VERDICT_LABELS: Record<string, string> = \{([\s\S]*?)\n\};/.exec(cli)?.[1];
    expect(table, "VERDICT_LABELS table not found").toBeTruthy();

    const rows = [...table!.matchAll(/^\s*(\w+):\s*"([^"]+)"/gm)];
    expect(rows.length, "no rows parsed — the assertion would be vacuous").toBe(3);

    for (const [, verdict, label] of rows) {
      // pass/fail/unmeasured are unique keys in the registry file, so a
      // whole-file scan cannot cross into an unrelated STATUS_LABELS row.
      const re = new RegExp(`^\\s*${verdict}:\\s*"([^"]+)",?\\s*$`, "m");
      const registryLabel = re.exec(reg)?.[1];
      expect(registryLabel, `registry has no top-level "${verdict}:" row — nothing to compare against`).toBeTruthy();
      expect(
        label,
        `CLI prints "${label}" for ${verdict}; the registry says "${registryLabel}"`,
      ).toBe(registryLabel);
    }
  });
});
