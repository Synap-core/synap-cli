import { describe, it, expect } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import * as words from "../src/lib/goal-words.js";

/**
 * The goal words `synap track` prints equal the vocabulary door's.
 *
 * `@synap-core/types/vocabulary` is the one door, but the CLI cannot import
 * it, so `src/lib/goal-words.ts` copies each table. This holds every copy
 * EQUAL to the vocabulary's own source in the sibling `synap-backend` — keys
 * and words — so a status, verdict or word changed on the pod fails here.
 *
 * WHAT IT CANNOT SEE: a sibling that predates the goal vocabulary (backend
 * `main` before the goals merge: no `TRACK_STATUS_LABELS`) skips the suite,
 * stated rather than passed; so does an absent sibling. It reads object
 * literals of `key: "Word"` lines only — a table rewritten into another shape
 * fails the "found" assertion rather than passing silently.
 */
const VOCAB = join(process.cwd(), "../synap-backend/packages/types/src/vocabulary");
const INDEX = join(VOCAB, "index.ts");
const PARTICIPANTS = join(VOCAB, "track-participant-words.ts");
const present =
  existsSync(INDEX) && readFileSync(INDEX, "utf8").includes("export const TRACK_STATUS_LABELS");

/** `export const NAME … = { a: "A", b_c: "B c", } …` → { a: "A", b_c: "B c" } (null when absent). */
function readTable(file: string, name: string): Record<string, string> | null {
  const src = readFileSync(file, "utf8");
  const at = src.search(new RegExp(`export const ${name}\\b[^=]*=\\s*\\{`));
  if (at < 0) return null;
  const body = src.slice(src.indexOf("{", at) + 1, src.indexOf("}", at));
  const out: Record<string, string> = {};
  for (const m of body.matchAll(/^\s*([A-Za-z_][A-Za-z0-9_]*):\s*"([^"]*)",?\s*(?:\/\/.*)?$/gm)) {
    out[m[1]!] = m[2]!;
  }
  return out;
}

const TABLES: Array<[string, string, keyof typeof words]> = [
  [INDEX, "TRACK_STATUS_LABELS", "TRACK_STATUS_LABELS"],
  [INDEX, "TRACK_VERDICT_LABELS", "TRACK_VERDICT_LABELS"],
  [INDEX, "TRACK_WORK_KIND_LABELS", "TRACK_WORK_KIND_LABELS"],
  [INDEX, "TRACK_UNCERTAINTY_LABELS", "TRACK_UNCERTAINTY_LABELS"],
  [INDEX, "GOAL_CRITERION_MARK_LABELS", "GOAL_CRITERION_MARK_LABELS"],
  [INDEX, "WAITING_ON_REASON_LABELS", "WAITING_ON_REASON_LABELS"],
  [INDEX, "GOAL_FIELD_LABELS", "GOAL_FIELD_LABELS"],
  [PARTICIPANTS, "TRACK_PARTICIPANT_ROLE_LABELS", "TRACK_PARTICIPANT_ROLE_LABELS"],
  [PARTICIPANTS, "TRACK_COMMITMENT_STATE_LABELS", "TRACK_COMMITMENT_STATE_LABELS"],
];

describe.skipIf(!present)("CLI goal words equal the vocabulary door", () => {
  it("the reader still sees a literal sample (non-vacuity)", () => {
    expect(readTable(INDEX, "TRACK_STATUS_LABELS")).toMatchObject({ completed: "Closed" });
  });

  for (const [file, name, local] of TABLES) {
    it(name, () => {
      const theirs = readTable(file, name);
      expect(theirs, `${name} not found`).not.toBeNull();
      expect(Object.keys(theirs!).length).toBeGreaterThan(2);
      expect({ ...(words[local] as Record<string, string>) }).toEqual(theirs);
    });
  }
});

describe("an unknown token humanizes, never leaks", () => {
  it("goalWord falls back to words", () => {
    expect(words.goalWord(words.TRACK_STATUS_LABELS, "on_hold")).toBe("On hold");
    expect(words.goalWord(words.TRACK_STATUS_LABELS, null)).toBe("");
  });
});
