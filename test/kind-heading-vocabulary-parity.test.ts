import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

/**
 * The CLI's `market --list` headings must say what the product's vocabulary
 * SSOT says.
 *
 * `@synap-core/types/vocabulary` is the one door for domain nouns, but this
 * package cannot import it (the CLI links only `@synap-core/workspace-
 * templates`). So `KIND_HEADINGS` is a local table — and a local label table is
 * a fork the moment it drifts. This tripwire is what stops it drifting, by
 * reading the registry's OWN source across the repo boundary.
 *
 * It exists because the headings were built with
 * `t.charAt(0).toUpperCase() + t.slice(1)` — the exact construction
 * `.claude/rules/vocabulary.md` forbids — which printed "Cell" where the
 * registry says **Card**, and "Workflow" where it says Automation.
 */
const REGISTRY = join(
  process.cwd(),
  "../synap-backend/packages/types/src/vocabulary/object-kinds.ts",
);
const SRC = join(process.cwd(), "src/commands/market.ts");

/** `cell: { label: "Card", labelPlural: "Cards" }` → ["Card", "Cards"] */
function registryLabels(src: string, kind: string): { label: string; plural: string } | null {
  const at = src.search(new RegExp(`^\\s{2}${kind}:\\s*\\{`, "m"));
  if (at < 0) return null;
  const block = src.slice(at, at + 600);
  const label = /label:\s*"([^"]+)"/.exec(block)?.[1];
  const plural = /labelPlural:\s*"([^"]+)"/.exec(block)?.[1];
  return label && plural ? { label, plural } : null;
}

describe("CLI kind headings match the vocabulary registry", () => {
  const hasRegistry = existsSync(REGISTRY);
  const cli = readFileSync(SRC, "utf8");

  /**
   * Comments are stripped BEFORE scanning for the forbidden construction —
   * otherwise this test fails on the docblock that explains the fix, which is
   * exactly what happened when it was first written. Block and line comments go
   * in ONE combined alternation: stripping them in sequence has silently eaten
   * real code in this codebase before, at an apostrophe inside a string.
   */
  const codeOnly = cli.replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, "");

  it("the CLI table is readable (guards against a vacuous pass)", () => {
    expect(codeOnly.length, "stripper ate the file").toBeGreaterThan(5000);
    expect(codeOnly).toContain("const KIND_HEADINGS");
    expect(
      codeOnly,
      "the forbidden `charAt(0).toUpperCase()` construction is back on a kind token",
    ).not.toMatch(/\bt\.charAt\(0\)\.toUpperCase\(\) \+ t\.slice\(1\)/);
  });

  it.runIf(hasRegistry)("every heading equals the registry's labelPlural", () => {
    const reg = readFileSync(REGISTRY, "utf8");
    expect(reg.length, "registry source unreadable — assertion would be vacuous").toBeGreaterThan(1000);

    // CP publish vocabulary → pod runtime vocabulary for the one renamed kind.
    const CP_TO_POD: Record<string, string> = { workflow: "automation" };
    const table = /const KIND_HEADINGS: Record<string, string> = \{([\s\S]*?)\n\};/.exec(cli)?.[1];
    expect(table, "KIND_HEADINGS table not found").toBeTruthy();

    const rows = [...table!.matchAll(/^\s*(\w+):\s*"([^"]+)"/gm)];
    expect(rows.length, "no rows parsed — the assertion would be vacuous").toBeGreaterThan(3);

    for (const [, cpKind, heading] of rows) {
      const podKind = CP_TO_POD[cpKind] ?? cpKind;
      const labels = registryLabels(reg, podKind);
      if (!labels) continue; // kind the registry does not model; nothing to fork from
      expect(
        heading,
        `CLI prints "${heading}" for ${cpKind}; the registry says "${labels.plural}"`,
      ).toBe(labels.plural);
    }
  });
});
