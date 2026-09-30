import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, resolve } from "path";

/**
 * `market update`'s preview printed a SECOND, hand-rolled status label instead
 * of calling `installedStatusLabel`. The copy diverged in two ways that both
 * LIED to the user:
 *
 *   1. no cache-cold branch — a pod with no catalog version to compare against
 *      got a green "up to date" that nothing had actually verified;
 *   2. no hash-version branch — a content change read as a version bump.
 *
 * `cache-cold-honesty.test.ts` covered the resolver but NOT the seam: deleting
 * the fix left every one of those tests green, because none of them asserted
 * that `marketUpdate` reaches the door at all. This pins the seam.
 *
 * Source-scan rather than behavioural because `marketUpdate` opens the network
 * on its first two statements (`buildMarketCatalog`, `fetchInstalledInventory-
 * Strict`); mocking that would test the mock. Comments are stripped in ONE pass
 * BEFORE scanning — a previous tripwire in this repo matched the forbidden
 * construction quoted inside its own docblock and failed against correct source.
 */

const here = dirname(fileURLToPath(import.meta.url));
const SRC = resolve(here, "../src/commands/market.ts");

/**
 * Strip comments with a STRING-AWARE scanner. A naive line-comment regex eats
 * the double slash inside every "https://…" literal, truncating real code and
 * unbalancing the braces — exactly how the first version of this test failed
 * against correct source.
 */
function stripComments(s: string): string {
  let out = "";
  let i = 0;
  while (i < s.length) {
    const ch = s[i];
    const next = s[i + 1];
    if (ch === '"' || ch === "'" || ch === "`") {
      const quote = ch;
      out += ch;
      i++;
      while (i < s.length) {
        if (s[i] === "\\") {
          out += s[i] + (s[i + 1] ?? "");
          i += 2;
          continue;
        }
        out += s[i];
        if (s[i] === quote) {
          i++;
          break;
        }
        i++;
      }
      continue;
    }
    if (ch === "/" && next === "*") {
      const end = s.indexOf("*/", i + 2);
      i = end === -1 ? s.length : end + 2;
      continue;
    }
    if (ch === "/" && next === "/") {
      const end = s.indexOf("\n", i);
      i = end === -1 ? s.length : end;
      continue;
    }
    out += ch;
    i++;
  }
  return out;
}

/**
 * Extract a top-level function body. Anchors on the closing `}` at column 0,
 * which the repo's formatting guarantees for a top-level declaration — more
 * robust than counting braces through regex literals and template expressions.
 */
function functionBody(source: string, name: string): string {
  const lines = source.split("\n");
  const start = lines.findIndex((l) => l.startsWith(`export async function ${name}(`));
  if (start === -1) throw new Error(`${name} not found — did it get renamed?`);
  for (let i = start + 1; i < lines.length; i++) {
    if (lines[i] === "}") return lines.slice(start, i + 1).join("\n");
  }
  throw new Error(`no column-0 close brace found for ${name}`);
}

describe("market update renders status through the ONE label door", () => {
  const body = functionBody(stripComments(readFileSync(SRC, "utf8")), "marketUpdate");

  it("marketUpdate calls installedStatusLabel", () => {
    expect(body).toContain("installedStatusLabel(");
  });

  it("marketUpdate builds no second 'up to date' label of its own", () => {
    // The green literal may exist ONLY inside the resolver, never at a call site.
    expect(body).not.toMatch(/chalk\.green\(\s*["'`]up to date/);
  });

  it("marketUpdate builds no second 'update available' label of its own", () => {
    expect(body).not.toMatch(/chalk\.yellow\(\s*[`"']update available/);
  });

  it("the extractor really located a body (guards against a silent empty match)", () => {
    expect(body.length).toBeGreaterThan(500);
    expect(body).toContain("buildMarketCatalog");
  });
});
