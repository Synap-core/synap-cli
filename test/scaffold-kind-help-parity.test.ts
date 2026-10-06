import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { SCAFFOLDABLE_KINDS } from "../src/lib/kind-package.js";

/**
 * `market scaffold --kind`'s HELP STRING must offer EXACTLY what the command
 * accepts — no more, no fewer.
 *
 * It once offered neither: the help advertised `skill`, which `marketScaffold`
 * refused outright (the CP package schema had no standalone slot to publish one
 * into) and silently omitted `workflow`, which `validateStandalonePackage` had
 * always accepted. So the documented four-command loop advertised a dead option
 * and hid a working one.
 *
 * `skill` joined the accepted list when the CP grew that slot and the pod grew
 * an applier — so the refusal is gone, and this file's assertion is now a
 * two-way parity instead of a one-way name check plus a "refusal is stated"
 * clause. The inversion is deliberate: an assertion that a refusal is PRESENT
 * would have to be deleted the moment the refusal became wrong, whereas "the
 * offered list equals the accepted list" stays true either way.
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

/** The comma-separated kinds the help OFFERS, after its "…template: " clause. */
function offeredKinds(help: string): string[] {
  const after = help.split("template:").at(-1) ?? "";
  return after
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

describe("market scaffold --kind help string", () => {
  it("reads the real file (guards against a vacuous pass)", () => {
    expect(INDEX.length).toBeGreaterThan(5000);
    expect(SCAFFOLDABLE_KINDS.length).toBeGreaterThan(1);
    // The parse itself must find something, or every assertion below is vacuous.
    expect(offeredKinds(kindHelp()).length).toBeGreaterThan(1);
  });

  it("offers EXACTLY the kinds scaffold accepts — no more, no fewer", () => {
    // Two-way: a kind the command refuses but the help offers fails here, and so
    // does a working kind the help hides (the `workflow` regression).
    expect(offeredKinds(kindHelp()).sort()).toEqual([...SCAFFOLDABLE_KINDS].sort());
  });

  it("no longer states a skill refusal — the special case is gone", () => {
    const help = kindHelp();
    expect(help, "the old refusal clause is stale").not.toContain(
      "is not scaffoldable",
    );
    expect(help).toContain("skill");
  });
});
