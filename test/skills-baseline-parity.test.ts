import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { describe, it, expect } from "vitest";

/**
 * PARITY GUARD: the CLI's `skills/` copy === the backend source of truth.
 *
 * `skills/` is a COPY of `synap-backend/skills/` made by `scripts/sync-skills.sh`
 * (run on `prepublishOnly`). Nothing failed when the copy went stale, and it
 * did: on 2026-10-05 the CLI's focus-sessions.md, linking.md, reflexes.md and a
 * dozen more differed from the backend, and `from-intent.md` / `concepts.md`
 * were missing — so `synap` read from this checkout taught agents an older
 * contract than the pod speaks. The IS mirror has the same guard
 * (`baseline-drift.test.ts`); this is the CLI's.
 *
 * The scanned set is DERIVED: every file the backend ships for each skill the
 * CLI carries (a directory under `skills/` that the backend also has). A file
 * missing from the copy, or differing, fails — fix with `npm run sync-skills`.
 *
 * Skips when the sibling `synap-backend` checkout or the local `skills/` copy
 * is absent (a fresh clone: `skills/` is gitignored and built at publish).
 */

const CLI_ROOT = resolve(__dirname, "..");
const COPY = join(CLI_ROOT, "skills");
const SOURCE = resolve(CLI_ROOT, "..", "synap-backend", "skills");
const comparable = existsSync(SOURCE) && existsSync(COPY);

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) return files(p);
    return [p];
  });
}

describe.skipIf(!comparable)("CLI skills copy matches synap-backend/skills", () => {
  const skills = comparable
    ? readdirSync(COPY).filter(
        (d) =>
          statSync(join(COPY, d)).isDirectory() &&
          existsSync(join(SOURCE, d)) &&
          statSync(join(SOURCE, d)).isDirectory()
      )
    : [];

  it("finds the skills it guards (non-vacuity)", () => {
    expect(skills).toContain("synap");
    expect(skills.length).toBeGreaterThanOrEqual(3);
  });

  it("every backend file of each carried skill is copied byte-for-byte", () => {
    const drift: string[] = [];
    let compared = 0;
    for (const skill of skills) {
      for (const src of files(join(SOURCE, skill))) {
        const rel = relative(SOURCE, src);
        const dst = join(COPY, rel);
        compared += 1;
        if (!existsSync(dst)) drift.push(`missing ${rel}`);
        else if (!readFileSync(dst).equals(readFileSync(src)))
          drift.push(`differs ${rel}`);
      }
    }
    expect(compared).toBeGreaterThan(40);
    expect(drift, "run `npm run sync-skills`").toEqual([]);
  });
});
