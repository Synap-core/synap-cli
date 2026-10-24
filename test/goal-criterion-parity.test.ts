import { describe, it, expect } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  CRITERION_EVALUATOR,
  CRITERION_KEY_MAX,
  CRITERION_KINDS,
  parseCriterion,
} from "../src/commands/tracks.js";

/**
 * `--criterion "[kind:] statement"` → a goal criterion the POD accepts.
 *
 * The CLI cannot import `@synap-core/types`, so its kinds and their stored
 * evaluators are a local table. This holds it to the pod's own source:
 *   · the kinds ARE the pod's `CRITERION_CHECK_MEANINGS`, in order;
 *   · each kind's evaluator is one `CHECK_MEANING_EVALUATORS` allows for it;
 *   · the key fits the pod's criterion key length (`sessionCriterionSchema`);
 *   · a measured criterion names its `evidenceKey` (the pod refuses an
 *     evidence check without one) — behavioural, no sibling needed.
 *
 * WHAT IT CANNOT SEE: a sibling that predates the goal build (no
 * `units/goal.ts`) skips the source checks, stated rather than passed.
 */
const BACKEND = join(process.cwd(), "../synap-backend/packages");
const GOAL_TS = join(BACKEND, "types/src/units/goal.ts");
const SCHEMA_TS = join(BACKEND, "api/src/schemas/session-criteria.ts");
const present = existsSync(GOAL_TS) && existsSync(SCHEMA_TS);

function readMeanings(src: string): string[] {
  const m = /export const CRITERION_CHECK_MEANINGS = \[([^\]]*)\]/.exec(src);
  return m ? [...m[1]!.matchAll(/"([^"]+)"/g)].map((x) => x[1]!) : [];
}

function readEvaluators(src: string): Record<string, string[]> {
  const at = src.indexOf("export const CHECK_MEANING_EVALUATORS");
  const body = at < 0 ? "" : src.slice(src.indexOf("{", at) + 1, src.indexOf("} as const", at));
  const out: Record<string, string[]> = {};
  for (const m of body.matchAll(/^\s*([a-z_]+):\s*\[([^\]]*)\]/gm)) {
    out[m[1]!] = [...m[2]!.matchAll(/"([^"]+)"/g)].map((x) => x[1]!);
  }
  return out;
}

describe.skipIf(!present)("CLI criterion translation follows the pod", () => {
  const goal = present ? readFileSync(GOAL_TS, "utf8") : "";

  it("the kinds are the pod's check meanings, in order", () => {
    const theirs = readMeanings(goal);
    expect(theirs.length).toBeGreaterThan(3); // non-vacuity
    expect([...CRITERION_KINDS]).toEqual(theirs);
  });

  it("each kind's evaluator is one the pod allows for that meaning", () => {
    const allowed = readEvaluators(goal);
    expect(Object.keys(allowed).length).toBe(CRITERION_KINDS.length);
    for (const kind of CRITERION_KINDS) {
      expect(allowed[kind], kind).toContain(CRITERION_EVALUATOR[kind]);
    }
  });

  it("the key length is the pod's", () => {
    const schema = readFileSync(SCHEMA_TS, "utf8");
    const m = /key: z\s*\.string\(\)\s*\.min\(1\)\s*\.max\((\d+)\)/.exec(schema);
    expect(m, "criterion key schema not found").not.toBeNull();
    expect(CRITERION_KEY_MAX).toBe(Number(m![1]));
  });
});

describe("the criteria a person types are ones the pod accepts", () => {
  it("a measured criterion names the key its evidence is posted under", () => {
    const c = parseCriterion("measured: Forty qualified leads a month", new Set()) as {
      key: string;
      check: { kind: string; evidenceKey?: string };
    };
    expect(c.check).toEqual({ kind: "evidence", evidenceKey: c.key });
  });

  it("a long statement's key fits the pod's length, de-duplicated", () => {
    const long = "x".repeat(200);
    const taken = new Set<string>();
    const a = parseCriterion(long, taken) as { key: string };
    const b = parseCriterion(long, taken) as { key: string };
    expect(a.key.length).toBeLessThanOrEqual(CRITERION_KEY_MAX);
    expect(b.key.length).toBeLessThanOrEqual(CRITERION_KEY_MAX);
    expect(b.key).not.toBe(a.key);
  });
});
