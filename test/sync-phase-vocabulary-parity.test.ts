import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

/**
 * `synap cap sync-status`'s phase labels must say what
 * `@synap-core/types/vocabulary`'s `STATUS_LABELS` says for `SyncPhase`
 * values — falling back to `humanizeToken` for any phase the vocabulary
 * hasn't curated a word for (currently `not_connected`).
 *
 * This package cannot import the vocabulary package directly (see
 * `sync-status.ts`'s doc comment / `kind-heading-vocabulary-parity.test.ts` for
 * why), so `SYNC_PHASE_LABELS` is a local mirror — and a local label table is a
 * fork the moment it drifts. This tripwire reads BOTH registries' OWN source
 * across the repo boundary: the `SyncPhase` union (the phase SET) and
 * `STATUS_LABELS` (the words), so a drift in either fails the build instead
 * of shipping a silently wrong or missing phase.
 */
const REGISTRY = join(
  process.cwd(),
  "../synap-backend/packages/types/src/vocabulary/index.ts"
);
const SYNC_PHASE_SOURCE = join(
  process.cwd(),
  "../synap-backend/packages/api/src/services/event-sync/sync-kind-registry.ts"
);
const SRC = join(process.cwd(), "src/commands/sync-status.js").replace(/\.js$/, ".ts");

/** Mirrors `humanizeToken` (`vocabulary/index.ts`) for phases with no curated entry. */
function humanizeToken(token: string): string {
  const words = token.replace(/[_-]+/g, " ").trim().toLowerCase();
  return words ? words.charAt(0).toUpperCase() + words.slice(1) : token;
}

/**
 * Derives the phase SET from the `SyncPhase` union's own source instead of a
 * hand-listed array — a hand-listed array cannot see a phase added after it
 * was written (guards-and-tests.md: "derive the set, never hand-maintain it").
 */
function derivePhases(source: string): string[] {
  const block = /export type SyncPhase =([\s\S]*?);/.exec(source)?.[1];
  if (!block) return [];
  return [...block.matchAll(/"([a-z_]+)"/g)].map(([, v]) => v);
}

describe("CLI sync-status phase labels match the vocabulary registry", () => {
  const hasSyncPhaseSource = existsSync(SYNC_PHASE_SOURCE);
  const hasRegistry = existsSync(REGISTRY);
  const cli = readFileSync(SRC, "utf8");

  it("the CLI table is readable (guards against a vacuous pass)", () => {
    expect(cli.length, "file unreadable").toBeGreaterThan(500);
    expect(cli).toContain("const SYNC_PHASE_LABELS");
  });

  it.runIf(hasSyncPhaseSource)(
    "every phase in the SyncPhase union has a row in SYNC_PHASE_LABELS",
    () => {
      const src = readFileSync(SYNC_PHASE_SOURCE, "utf8");
      expect(
        src.length,
        "sync-kind-registry.ts unreadable — assertion would be vacuous"
      ).toBeGreaterThan(500);

      const phases = derivePhases(src);
      // Non-vacuity: the scan must actually find the union it hunts for.
      expect(phases.length, "found 0 phases — the scan is not seeing the union").toBeGreaterThanOrEqual(5);
      expect(phases).toContain("not_connected");

      const table = /const SYNC_PHASE_LABELS: Record<string, string> = \{([\s\S]*?)\n\};/.exec(
        cli
      )?.[1];
      expect(table, "SYNC_PHASE_LABELS table not found").toBeTruthy();
      const rows = new Map(
        [...table!.matchAll(/^\s*(\w+):\s*"([^"]+)"/gm)].map(([, k, v]) => [k, v])
      );

      for (const phase of phases) {
        expect(rows.get(phase), `SYNC_PHASE_LABELS is missing "${phase}"`).toBeTruthy();
      }
    }
  );

  it.runIf(hasSyncPhaseSource && hasRegistry)(
    "every phase label equals the registry's STATUS_LABELS entry (or its humanizeToken fallback)",
    () => {
      const reg = readFileSync(REGISTRY, "utf8");
      expect(
        reg.length,
        "registry source unreadable — assertion would be vacuous"
      ).toBeGreaterThan(1000);
      const syncSrc = readFileSync(SYNC_PHASE_SOURCE, "utf8");
      const phases = derivePhases(syncSrc);
      expect(phases.length).toBeGreaterThanOrEqual(5);

      const table = /const SYNC_PHASE_LABELS: Record<string, string> = \{([\s\S]*?)\n\};/.exec(
        cli
      )?.[1];
      expect(table, "SYNC_PHASE_LABELS table not found").toBeTruthy();
      const rows = new Map(
        [...table!.matchAll(/^\s*(\w+):\s*"([^"]+)"/gm)].map(([, k, v]) => [k, v])
      );
      expect(rows.size, "no rows parsed — the assertion would be vacuous").toBeGreaterThanOrEqual(
        phases.length
      );

      for (const phase of phases) {
        const cliLabel = rows.get(phase);
        expect(cliLabel, `CLI table has no row for "${phase}"`).toBeTruthy();

        const regMatch = new RegExp(`\\b${phase}:\\s*"([^"]+)"`).exec(reg);
        const expected = regMatch ? regMatch[1] : humanizeToken(phase);

        expect(
          cliLabel,
          `CLI prints "${cliLabel}" for ${phase}; the vocabulary would render "${expected}"`
        ).toBe(expected);
      }
    }
  );
});
