import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import {
  EXPORTER_EMITTED_KEYS,
  EXPORTER_UNEMITTED_KEYS,
  exporterDropWarnings,
} from "../src/lib/exporter-coverage.js";

/**
 * `lib/exporter-coverage.ts` is a hand-maintained claim about ANOTHER repo's
 * code — the exact shape (`hand-maintained-projection-is-the-root`) that
 * produced the defect it exists to warn about. So it is derived-and-pinned, not
 * trusted: this test reads the exporter's OWN source across the repo boundary
 * and fails if the two disagree in either direction.
 *
 *   • a key we call UNEMITTED that has gained an assignment → we now over-warn
 *     (an author is told a Card is dropped when it ships)
 *   • a key we call EMITTED that has lost one → we now under-warn, which is the
 *     original defect returning
 *
 * Note the exporter assigns SOME keys through a `(def as Record<string,
 * unknown>)` cast (`bentoViewBlocks` L231, `bentoViewName` L240,
 * `actionPlacements` L536). A type-driven read misses exactly those — a careful
 * hand-read of this file got two of them wrong in a report dated 2026-09-05 —
 * so the scan below matches BOTH assignment forms.
 *
 * Skipped (never failed vacuously) when the sibling checkout is absent, the
 * `it.runIf` shape `kind-heading-vocabulary-parity.test.ts` established.
 */
const EXPORTER = join(
  process.cwd(),
  "../synap-backend/packages/api/src/services/workspace-to-package-definition.ts",
);

/** Does the exporter assign `def.<key>` — plain, or through the Record cast? */
function assignsKey(src: string, key: string): boolean {
  const plain = new RegExp(`\\bdef\\.${key}\\s*=[^=]`);
  const cast = new RegExp(
    `\\(def as Record<string, unknown>\\)\\.${key}\\s*=[^=]`,
  );
  // `workspaceName` / `description` are set in the object literal that
  // INITIALISES `def` (`description` through a conditional spread), not by
  // assignment. That form is matched too — but only INSIDE that initialiser,
  // because `description:` occurs a dozen times elsewhere in this file (on
  // profiles, automations, playbooks…) and an unscoped match would report
  // every one of those as proof the top-level key is emitted.
  return plain.test(src) || cast.test(src) || defInitializer(src).includes(`${key}:`);
}

/** The `const def: PackageDefinition = { … };` literal, and nothing else. */
function defInitializer(src: string): string {
  const at = src.indexOf("const def: PackageDefinition = {");
  if (at < 0) return "";
  const end = src.indexOf("\n  };", at);
  return end < 0 ? "" : src.slice(at, end);
}

describe("exporter coverage claim matches the exporter's source", () => {
  const hasExporter = existsSync(EXPORTER);

  it("the local tables are non-vacuous", () => {
    expect(EXPORTER_UNEMITTED_KEYS.length).toBeGreaterThan(3);
    expect(EXPORTER_EMITTED_KEYS.length).toBeGreaterThan(10);
    // No key may appear in both tables — that would make the warning incoherent.
    const emitted = new Set(EXPORTER_EMITTED_KEYS);
    for (const k of EXPORTER_UNEMITTED_KEYS) {
      expect(emitted.has(k.key), `${k.key} is in BOTH tables`).toBe(false);
    }
  });

  it("every warning names its key and what is lost", () => {
    const warnings = exporterDropWarnings();
    expect(warnings.length).toBe(EXPORTER_UNEMITTED_KEYS.length);
    for (const k of EXPORTER_UNEMITTED_KEYS) {
      expect(warnings.some((w) => w.startsWith(`${k.key} —`))).toBe(true);
    }
    // Vocabulary: the product word is Card, never the machine token "cell".
    const cells = warnings.find((w) => w.startsWith("cells —"));
    expect(cells).toContain("Cards");
  });

  it.runIf(hasExporter)("no UNEMITTED key is actually assigned", () => {
    const src = readFileSync(EXPORTER, "utf8");
    expect(src.length, "exporter unreadable — assertion would be vacuous").toBeGreaterThan(5000);
    for (const { key } of EXPORTER_UNEMITTED_KEYS) {
      expect(
        assignsKey(src, key),
        `exporter now assigns def.${key} — exporter-coverage.ts over-warns; drop it from EXPORTER_UNEMITTED_KEYS`,
      ).toBe(false);
    }
  });

  it.runIf(hasExporter)("every EMITTED key is actually assigned", () => {
    const src = readFileSync(EXPORTER, "utf8");
    expect(src.length).toBeGreaterThan(5000);
    for (const key of EXPORTER_EMITTED_KEYS) {
      expect(
        assignsKey(src, key),
        `exporter no longer assigns def.${key} — it is now a SILENT drop; move it to EXPORTER_UNEMITTED_KEYS`,
      ).toBe(true);
    }
  });
});

/**
 * The warning must actually be WIRED, not merely available. A pure helper with
 * no call site is the "built but severed" shape this repo has catalogued
 * repeatedly — and it would be invisible to every test above, all of which
 * exercise the helper directly.
 *
 * Source-scanned rather than executed because the only caller is behind a live
 * pod fetch (`--from-workspace` → the pod's `to-template` door). Same technique
 * `market-validate-standalone.test.ts` uses for the same reason.
 */
describe("the drop-list is wired into `market publish --from-workspace`", () => {
  const SRC = readFileSync(
    join(process.cwd(), "src/commands/market-authoring.ts"),
    "utf8",
  );

  it("reads the real file (guards against a vacuous pass)", () => {
    expect(SRC.length).toBeGreaterThan(5000);
    expect(SRC).toContain("--from-workspace");
  });

  it("imports and calls exporterDropWarnings", () => {
    expect(SRC).toContain('from "../lib/exporter-coverage.js"');
    expect(SRC).toMatch(/dropWarnings\s*=\s*exporterDropWarnings\(\)/);
  });

  it("populates it ONLY on the --from-workspace branch", () => {
    // A hand-written file is not a projection: what the author wrote is what
    // gets published, so warning there would be a false alarm.
    const branch = SRC.slice(SRC.indexOf("if (opts.fromWorkspace) {"));
    const elseAt = branch.indexOf("\n  } else {");
    expect(elseAt).toBeGreaterThan(0);
    expect(branch.slice(0, elseAt)).toContain("exporterDropWarnings()");
  });

  it("surfaces the warning BEFORE the publish call, not after", () => {
    const warnAt = SRC.indexOf("Serialising a live workspace is a LOSSY projection");
    const publishAt = SRC.indexOf("await publishPackage(def, { isPublic })");
    expect(warnAt, "warning text not found").toBeGreaterThan(0);
    expect(publishAt).toBeGreaterThan(0);
    expect(warnAt, "the author is told what was dropped only AFTER it shipped")
      .toBeLessThan(publishAt);
  });

  it("carries the warnings in --json output too", () => {
    expect(SRC).toMatch(/warnings:\s*dropWarnings/);
  });
});
