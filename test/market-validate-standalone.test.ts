import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * `market validate` must accept every file `market scaffold` can produce.
 *
 * Found by walking the documented four-command loop on 2026-09-05:
 *
 *   $ synap market scaffold probe-card-pack --kind cell
 *   ✓ Wrote probe-card-pack.cell.json
 *   $ synap market validate probe-card-pack.cell.json
 *   ✗ 3 validation errors: missing `meta`, missing `workspace`, `profiles` required
 *
 * Step 02 rejected step 01's own output — for EVERY non-workspace kind.
 * `marketPublish` already peeked with `isStandalonePackageFile` and branched to
 * the standalone validator; `marketValidate` went straight to the WORKSPACE
 * validator, which demands an envelope a standalone file does not have. Two
 * steps of one loop, two different notions of what a package is.
 *
 * Source scan: booting the command would need a CP session and a temp file, and
 * the invariant that actually matters is structural — both entry points must
 * consult the SAME discriminator.
 */
const SRC = join(process.cwd(), "src/commands/market-authoring.ts");

function bodyOf(src: string, fn: string): string {
  const start = src.indexOf(`export async function ${fn}`);
  if (start < 0) throw new Error(`${fn} not found — did it move or get renamed?`);
  // Open at the BODY brace, not the first `{` after the name — that one belongs
  // to the parameter type (`opts: { json?: boolean }`) and matching it yields a
  // ~79-char span that trivially passes every assertion below. Caught by this
  // file's own non-vacuous guard; keep that guard.
  let depth = 0;
  let paramsEnd = -1;
  for (let i = src.indexOf("(", start); i < src.length; i++) {
    if (src[i] === "(") depth++;
    else if (src[i] === ")") {
      depth--;
      if (depth === 0) {
        paramsEnd = i;
        break;
      }
    }
  }
  if (paramsEnd < 0) throw new Error(`could not find the parameter list of ${fn}`);
  const open = src.indexOf("{", paramsEnd);
  depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}") {
      depth--;
      if (depth === 0) return src.slice(start, i);
    }
  }
  throw new Error(`could not brace-match ${fn}`);
}

describe("market validate accepts standalone package files", () => {
  const src = readFileSync(SRC, "utf8");

  it("both entry points are present (guards against a vacuous pass)", () => {
    expect(bodyOf(src, "marketValidate").length).toBeGreaterThan(200);
    expect(bodyOf(src, "marketPublish").length).toBeGreaterThan(200);
  });

  it("marketValidate consults the standalone discriminator, as marketPublish does", () => {
    for (const fn of ["marketValidate", "marketPublish"]) {
      expect(
        bodyOf(src, fn).includes("isStandalonePackageFile("),
        `${fn} does not call isStandalonePackageFile. A cell/view/skill file has no ` +
          "meta/workspace envelope, so the workspace validator rejects it — which is " +
          "how `market validate` came to reject a file `market scaffold` had just written."
      ).toBe(true);
    }
  });

  it("marketValidate routes standalone files to the standalone validator", () => {
    expect(bodyOf(src, "marketValidate")).toContain("validateStandalonePackage(");
  });
});
