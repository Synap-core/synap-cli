/**
 * The CLI words a token through `@synap-core/types/vocabulary`'s
 * `humanizeToken` / `resolveStatusLabel`, never a local copy. Four copies once
 * lived here, each differing from the door (camelCase, dotted tails, cased
 * words such as "API") — the browser's no-local-humanize ratchet, same shape.
 *
 * Derived, not hand-listed: every `.ts` under `src/` is scanned, and a sample
 * of KNOWN positives proves the detector sees a declaration (a ratchet that
 * cannot fail is not a guard).
 */
import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const SRC = join(process.cwd(), "src");

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    return statSync(p).isDirectory() ? walk(p) : p.endsWith(".ts") ? [p] : [];
  });
}

/** A declaration (function, const arrow, method) of a `humanize*` helper. */
const LOCAL_HUMANIZE = /(?:function\s+|(?:const|let|var)\s+)humanize\w*\s*(?:[=(<:])/g;

function localHumanizers(source: string): string[] {
  return [...source.matchAll(LOCAL_HUMANIZE)].map((m) => m[0].trim());
}

describe("no local humanize* in the CLI", () => {
  it("the detector sees a declaration (non-vacuity)", () => {
    expect(localHumanizers("function humanizeToken(t: string) {}")).toHaveLength(1);
    expect(localHumanizers("const humanizeKindToken = (k: string) => k;")).toHaveLength(1);
    expect(localHumanizers('import { humanizeToken } from "x"; humanizeToken(a);')).toHaveLength(0);
  });

  it("scans the real tree", () => {
    expect(walk(SRC).length).toBeGreaterThan(50);
  });

  it("no source file declares its own humanize* — import the door's", () => {
    const offenders = walk(SRC)
      .map((f) => [f, localHumanizers(readFileSync(f, "utf8"))] as const)
      .filter(([, hits]) => hits.length > 0)
      .map(([f, hits]) => `${f.slice(SRC.length + 1)}: ${hits.join(", ")}`);
    expect(offenders).toEqual([]);
  });
});
