import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * A governed `synap market install` comes back as a PROPOSAL, not an install.
 *
 * Found by dogfooding a live pod on 2026-09-05:
 *
 *   $ synap market install task-views-pack --json
 *   { "outcome": "installed",
 *     "result": { "proposed": true, "proposalId": "…", "ackState": "proposed" } }
 *
 * and the human path printed a green "✓ Installed" for a write that had not
 * happened. Cause: `String(outcome.status ?? "installed")`. The envelope's
 * discriminator is `kind` (`execute-capability.ts` returns
 * `{kind:"proposed", proposalId, reviewUrl, ackState:"proposed"}`), and some
 * hops flatten it to `{proposed:true, …}` — in neither shape is `status` set,
 * so the `??` defaulted a queued proposal to success.
 *
 * Same class as the `changeType ?? "update"` bug that once titled every
 * capability run "Update Capability": a DEFAULTED DISCRIMINATOR turns "I don't
 * know" into a confident claim.
 *
 * This is a source scan because the alternative is booting the whole command.
 * It asserts the two things that actually matter and would each have caught the
 * live bug: no `status ?? "installed"` default anywhere, and every honest
 * proposed-marker consulted.
 */

const SRC = join(process.cwd(), "src/commands/market.ts");

function stripCommentsAndStrings(src: string): string {
  // Comments first, then ALL THREE quote styles in ONE left-to-right pass.
  //
  // Stripping them in sequence is wrong and silently ate this test's own
  // subject: the single-quote pass ran first and treated the apostrophe in a
  // DOUBLE-quoted `"…didn't…"` as an opening quote, swallowing everything up to
  // the next apostrophe — including the `outcome.kind` it was asserting on. The
  // test then failed against correct code. One alternation cannot do that,
  // because whichever quote opens first consumes its own literal.
  return src
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/(^|[^:])\/\/[^\n]*/g, "$1 ")
    .replace(
      /`(?:\\[\s\S]|[^\\`])*`|'(?:\\.|[^\\'])*'|"(?:\\.|[^\\"])*"/g,
      '""',
    );
}

describe("market install must never default an unknown outcome to installed", () => {
  const raw = readFileSync(SRC, "utf8");
  const code = stripCommentsAndStrings(raw);

  it("the source is readable and non-trivial (guards against a vacuous pass)", () => {
    // Without this, a broken path or an over-eager stripper would compare
    // nothing to nothing and stay green forever — the failure mode that nearly
    // shipped on two sibling tripwires in the same wave.
    expect(code.length).toBeGreaterThan(1000);
    expect(code).toContain("outcome");
  });

  it('never writes `outcome.status ?? "installed"`', () => {
    // Literals became "" under the stripper, so match the shape, not the word.
    expect(
      /outcome\.status\s*\?\?\s*""/.test(code),
      'market.ts defaults a missing `status` to "installed". A governed install ' +
        "returns a PROPOSAL with no `status`, so this prints a success for a " +
        "write that never happened. Read `kind` / `ackState` / `proposed` instead."
    ).toBe(false);
  });

  it("consults every honest proposed-marker, not just one", () => {
    for (const marker of ["kind", "ackState", "proposed"]) {
      expect(
        code.includes(`outcome.${marker}`),
        `market.ts never reads \`outcome.${marker}\`. The proposed envelope has ` +
          "appeared in more than one shape (`{kind:'proposed'}` from " +
          "execute-capability, `{proposed:true}` after flattening); checking only " +
          "one of them is how the live false-success happened."
      ).toBe(true);
    }
  });
});
