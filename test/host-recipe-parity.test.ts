/**
 * `renderRecipe` has ONE definition: `@synap-core/types/capability-manifest/
 * recipe.ts` (backend). Until a types release carries it, the runner ports it
 * (src/lib/host/recipe.ts); this test renders the same fixtures through BOTH
 * whenever the backend source is checked out beside this repo (CI checks out
 * Synap-core/backend as ../synap-backend) and requires the same argv, or the
 * same refusal, for each. HOST_RECIPE_SOURCE=<file> points it at another copy.
 *
 * What it proves is SAMENESS on these fixtures, not correctness: the fixtures
 * are chosen where a drift would show (a default, an embedded value, a whole
 * value with spaces, a list, a pinned bin, a script path, each refusal).
 */

import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { renderRecipe as ported, type Recipe } from "../src/lib/host/recipe.js";

const source =
  process.env.HOST_RECIPE_SOURCE ?? path.resolve(__dirname, "../../synap-backend/packages/types/src/capability-manifest/recipe.ts");
const present = fs.existsSync(source);
if (!present) console.warn(`host-recipe parity: ${source} is absent: skipped`);

const R: Recipe = {
  name: "fixture",
  description: "Every kind of placeholder.",
  params: {
    in: { type: "file", description: "in", required: true },
    clips: { type: "files", description: "clips", required: true },
    out: { type: "output", description: "out", required: true },
    x: { type: "number", description: "x", default: 0.5 },
    n: { type: "integer", description: "n", default: 2 },
    mode: { type: "enum", description: "mode", default: "fast", options: ["fast", "slow"] },
    color: { type: "color", description: "color", default: "1A2B3C" },
    at: { type: "time", description: "at", default: "1.5" },
    label: { type: "string", description: "label", default: "hi" },
  },
  steps: [
    { program: "ffmpeg", args: ["-i", "{in}", "-vf", "crop=iw*{x}:ih,fade=c={color}:st={at}", "-n", "{n}", "{clips}", "{out}"] },
    { program: "python", args: ["{script:a.py}", "{bin:ffmpeg}", "{mode}", "{label}", "{workdir}"] },
  ],
  scripts: [{ name: "a.py", sha256: "0".repeat(64), source: "x" }],
  gotchas: ["g"],
};
const RUN = { workdir: "/w", scripts: { "a.py": "/w/scripts/a.py" }, bins: { ffmpeg: "/opt/ffmpeg/bin/ffmpeg" } };
const OK = { in: "/w/in/a b.mp4", clips: ["/w/in/1.mp4", "/w/in/2.mp4"], out: "/w/out/o.mp4" };

const CASES: Array<[string, Record<string, unknown>, typeof RUN]> = [
  ["defaults", OK, RUN],
  ["every value given", { ...OK, x: 0.25, n: 3, mode: "slow", color: "#ffffff", at: "12.5", label: "a label with spaces" }, RUN],
  ["no pinned bins", OK, { ...RUN, bins: {} as typeof RUN.bins }],
  ["missing required", { clips: OK.clips, out: OK.out }, RUN],
  ["unknown param", { ...OK, gain: 3 }, RUN],
  ["wrong number", { ...OK, x: "half" }, RUN],
  ["integer not integer", { ...OK, n: 1.5 }, RUN],
  ["enum outside its options", { ...OK, mode: "turbo" }, RUN],
  ["bad colour", { ...OK, color: "red" }, RUN],
  ["bad time", { ...OK, at: "1 min" }, RUN],
  ["a valid time that cannot be spliced (its colon)", { ...OK, at: "00:01.5" }, RUN],
  ["empty list", { ...OK, clips: [] }, RUN],
  ["embedded value breaking the graph", { ...OK, x: "0,drawtext" }, RUN],
  ["embedded colour with a quote", { ...OK, color: "1A2B3C'" }, RUN],
  ["script not written", OK, { ...RUN, scripts: {} as typeof RUN.scripts }],
];

const outcome = (fn: () => unknown) => {
  try {
    return { ok: fn() };
  } catch (err) {
    return { error: (err as Error).message };
  }
};

describe.skipIf(!present)("renderRecipe port = @synap-core/types/capability-manifest renderRecipe", () => {
  it("the same argv, or the same refusal, for every fixture", async () => {
    const backend = (await import(source)) as { renderRecipe: typeof ported };
    let refusals = 0;
    for (const [label, values, run] of CASES) {
      const mine = outcome(() => ported(R, values, run));
      const theirs = outcome(() => backend.renderRecipe(R as never, values, run));
      expect(mine, label).toEqual(theirs);
      if ("error" in mine) refusals += 1;
    }
    // Non-vacuity: the table exercises both sides of the rule.
    expect(refusals).toBeGreaterThanOrEqual(8);
    expect(CASES.length - refusals).toBeGreaterThanOrEqual(3);
  });
});
