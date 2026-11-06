/**
 * TRIPWIRE (per-file ratchet) — a failure never becomes empty in the CLI.
 *
 * The rule (`rules/start-here`, "An EMPTY result and a FAILED read are
 * different facts"; plan 87ebac54 §5, decisions F10-F12): a `.catch` or
 * `catch {}` whose only outcome is an empty value or nothing (silent OR
 * logged) turns a failed read into a calm, wrong answer on the terminal. The
 * detector is the ONE module `helpers/failure-empty-detector.mjs` (+ `.d.mts`),
 * a byte-for-byte copy of synap-app's
 * `packages/design-tokens/scripts/failure-empty-detector.mjs`. Edit it there,
 * copy it here; never edit this copy (the mirror test below fails on any
 * difference).
 *
 * Shape (the same as synap-app's `check:failure-empty`, browser's, relay's and
 * backend's tripwires): a JSON baseline of per-file ceilings
 * (`failure-empty.baseline.json`, keys relative to synap-cli, taken 2026-11-05
 * at main 43428df, no site cleaned up). A file rising above its ceiling, or a
 * new file with a site, is RED. A site that is right to end empty says why on
 * the line above: `// empty-ok: <reason>`; an empty reason is RED. To lock in
 * an improvement:
 * `FAILURE_EMPTY_UPDATE=1 npx vitest run test/failure-empty.tripwire.test.ts`
 * (lowers ceilings only; it never raises one or admits a new file).
 *
 * Root: `src/` (the detector's walker skips tests, fixtures, scripts,
 * declarations and build folders).
 *
 * Does NOT see: `?? []` on a read, a catch that SETS an empty value, a
 * non-empty default, a swallow behind a helper or a named handler other than
 * `noop`, whether a reason is true, or a file that swaps WHICH sites swallow
 * at a flat count.
 */
import { describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import {
  SELF_CHECK,
  countFailureEmpty,
  findFailureEmptySites,
  listSourceFiles,
  scanFailureEmpty,
} from "./helpers/failure-empty-detector.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(here, "..");
const ROOTS = [join(REPO, "src")];
const BASELINE = join(here, "failure-empty.baseline.json");
const MIRRORED = ["failure-empty-detector.mjs", "failure-empty-detector.d.mts"] as const;
const SOURCE_DIR = resolve(REPO, "..", "synap-app", "packages", "design-tokens", "scripts");

const keyOf = (abs: string) => relative(REPO, abs).split(sep).join("/");

type Baseline = { generated: string; files: Record<string, number> };

/**
 * ONE named real site the scan must keep seeing (stronger than "≥1 site
 * anywhere"): the hub client's JSON read answers `{}` when the pod's reply
 * does not parse (`res.json().catch(() => ({}))`). When it is fixed, pin
 * another real site.
 */
const KNOWN_POSITIVE = "src/lib/hub-client.ts";

/**
 * The baseline `FAILURE_EMPTY_UPDATE=1` writes: each ceiling drops to its
 * current count and NEVER rises; a file not in the baseline never enters.
 */
function lowerBaseline(
  current: Map<string, number>,
  base: Record<string, number>
): Record<string, number> {
  const next: Record<string, number> = {};
  for (const [k, ceiling] of Object.entries(base)) {
    const cur = current.get(join(REPO, k)) ?? 0;
    if (cur > 0) next[k] = Math.min(cur, ceiling);
  }
  return Object.fromEntries(Object.entries(next).sort(([a], [b]) => a.localeCompare(b)));
}

/** Files above their ceiling (a missing key is a ceiling of 0). */
function rises(current: Map<string, number>, base: Record<string, number>): string[] {
  const out: string[] = [];
  for (const [file, n] of current) {
    const k = keyOf(file);
    if (n > (base[k] ?? 0)) out.push(`${k}: baseline=${base[k] ?? 0} current=${n}`);
  }
  return out.sort();
}

describe("a failure never becomes empty (per-file ratchet over the CLI's src/)", () => {
  const files = listSourceFiles(ROOTS);
  const { counts, emptyReasons, total } = scanFailureEmpty(files);
  const baseline = JSON.parse(readFileSync(BASELINE, "utf8")) as Baseline;

  it("scans a plausible number of files and finds real sites (non-vacuity)", () => {
    // 2026-11-05 (main 43428df): 173 files, 153 sites in 59 files.
    expect(files.length).toBeGreaterThan(140);
    expect(files.map(keyOf)).toEqual(expect.arrayContaining(["src/index.ts", KNOWN_POSITIVE]));
    expect(total).toBeGreaterThan(100);
    expect(Object.keys(baseline.files).length).toBeGreaterThan(40);
  });

  it(`still sees the pinned real site in ${KNOWN_POSITIVE} (non-vacuity)`, () => {
    const abs = join(REPO, KNOWN_POSITIVE);
    expect(existsSync(abs), `pinned positive ${KNOWN_POSITIVE} is gone: pin another real site`).toBe(
      true
    );
    expect(counts.get(abs) ?? 0).toBeGreaterThan(0);
    const lines = readFileSync(abs, "utf8").split("\n");
    expect(
      findFailureEmptySites(abs, lines.join("\n")).sites.some(
        (s) =>
          !s.justified &&
          s.kind === "catch-call" &&
          /res\.json\(\)\.catch\(\(\) => \(\{\}\)\)/.test(lines[s.line - 1] ?? "")
      ),
      "the hub client's `res.json().catch(() => ({}))` is no longer counted"
    ).toBe(true);
  });

  for (const c of SELF_CHECK) {
    it(`self-check shape: ${c.shape}`, () => {
      expect(countFailureEmpty("self-check.tsx", c.src)).toBe(c.n);
    });
  }

  it("every `// empty-ok:` gives a reason", () => {
    expect(
      emptyReasons.map(keyOf),
      "Say why the empty outcome is right, or handle the failure"
    ).toEqual([]);
  });

  it("no file rose above its baseline ceiling", () => {
    if (process.env.FAILURE_EMPTY_UPDATE === "1") {
      writeFileSync(
        BASELINE,
        JSON.stringify(
          {
            generated: new Date().toISOString().slice(0, 10),
            files: lowerBaseline(counts, baseline.files),
          },
          null,
          2
        ) + "\n"
      );
    }
    expect(
      rises(counts, baseline.files),
      "This ratchet only tightens: handle the failure (say what failed and what to do), or justify the site with `// empty-ok: <reason>`. Never hand-raise the baseline"
    ).toEqual([]);
  });

  it("the update never raises a ceiling or admits a new file, and the rise stays red", () => {
    const [victim] = Object.entries(baseline.files).sort((a, b) => b[1] - a[1])[0]!;
    const victimCount = counts.get(join(REPO, victim)) ?? 0;
    expect(victimCount, "victim must carry >1 site for this test to mean anything").toBeGreaterThan(1);
    const base = { ...baseline.files, [victim]: 1 };
    const fresh = join(REPO, "src/new-file.ts");
    const current = new Map([...counts, [fresh, 2]]);
    const next = lowerBaseline(current, base);
    expect(next[victim]).toBe(1);
    expect(next).not.toHaveProperty("src/new-file.ts");
    expect(rises(current, next)).toEqual(
      ["src/new-file.ts: baseline=0 current=2", `${victim}: baseline=1 current=${victimCount}`].sort()
    );
  });

  it("a new swallow in a new file is red, and an empty reason is reported (the ratchet can fail)", () => {
    const dir = mkdtempSync(join(tmpdir(), "failure-empty-"));
    try {
      writeFileSync(join(dir, "regress.ts"), "export const r = () => hub.list().catch(() => []);\n");
      writeFileSync(
        join(dir, "noreason.ts"),
        "// empty-ok:\nexport const r = () => fetch(u).catch(() => []);\n"
      );
      const extra = scanFailureEmpty(listSourceFiles([dir]));
      const merged = new Map([...counts, ...extra.counts]);
      expect(rises(merged, baseline.files).join("\n")).toMatch(/regress\.ts: baseline=0 current=1/);
      expect(extra.emptyReasons.join("\n")).toMatch(/noreason\.ts:1$/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// The mirror: synap-app is private, so the CLI's CI (tests.yml) checks out
// only this repo and synap-backend; there the mirror is unmeasured and says
// so. In the monorepo (../synap-app beside synap-cli) it is measured.
const mirrorPresent = MIRRORED.every((name) => existsSync(join(SOURCE_DIR, name)));
if (!mirrorPresent)
  console.warn(
    `[failure-empty mirror] SKIP, unmeasured: no synap-app checkout with the detector at ${SOURCE_DIR}`
  );

describe.skipIf(!mirrorPresent)("failure-empty detector mirror", () => {
  for (const name of MIRRORED) {
    it(`${name} is byte-identical to synap-app's source`, () => {
      expect(
        readFileSync(join(here, "helpers", name)).equals(readFileSync(join(SOURCE_DIR, name))),
        `Edit synap-app's ${name} and copy it to synap-cli/test/helpers/, byte for byte`
      ).toBe(true);
    });
  }
});
