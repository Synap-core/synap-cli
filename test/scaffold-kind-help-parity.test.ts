import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { SCAFFOLDABLE_KINDS } from "../src/lib/kind-package.js";

/**
 * `market scaffold --kind`'s HELP STRING must offer exactly what the command
 * accepts.
 *
 * It did not: the help said "cell, view, or skill" while `marketScaffold`
 * refuses `skill` outright (the CP package schema has no standalone slot for
 * one) and silently omitted `workflow`, which `validateStandalonePackage` has
 * always accepted. So the documented four-command loop advertised a dead option
 * and hid a working one — the same class as the scaffold→validate break found on
 * 2026-09-05.
 *
 * The list cannot simply be imported into `src/index.ts`: index.ts keeps its
 * eager module graph to commander + one lib, and `kind-package.ts` pulls `yaml`.
 * So this tripwire is what binds the two.
 */
const INDEX = readFileSync(join(process.cwd(), "src/index.ts"), "utf8");

/** The `--kind <kind>` option description as registered on `market scaffold`. */
function kindHelp(): string {
  const at = INDEX.indexOf('.command("scaffold <slug>")');
  expect(at, "market scaffold command not found in src/index.ts").toBeGreaterThan(0);
  const block = INDEX.slice(at, at + 1500);
  const help = /\.option\(\s*"--kind <kind>",\s*\n?\s*"([^"]+)"/.exec(block)?.[1];
  expect(help, "--kind option description not found").toBeTruthy();
  return help!;
}

describe("market scaffold --kind help string", () => {
  it("reads the real file (guards against a vacuous pass)", () => {
    expect(INDEX.length).toBeGreaterThan(5000);
    expect(SCAFFOLDABLE_KINDS.length).toBeGreaterThan(1);
  });

  it("names every kind scaffold accepts", () => {
    const help = kindHelp();
    for (const kind of SCAFFOLDABLE_KINDS) {
      expect(help, `help string does not offer --kind ${kind}`).toContain(kind);
    }
  });

  it("does not offer a kind scaffold refuses", () => {
    const help = kindHelp();
    // `skill` may APPEAR — but only in the clause that says it is refused,
    // never in the offered list. Split on that clause and check the offer half.
    const offered = help.split("(")[0];
    expect(
      offered,
      "the offered list names a kind `marketScaffold` rejects",
    ).not.toMatch(/\bskill\b/);
    expect(help, "the refusal must still be stated, not silently dropped").toContain(
      "skill is not scaffoldable",
    );
  });
});
