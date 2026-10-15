import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import {
  ASKED_BY_AN_AGENT,
  NEEDS_YOUR_OK,
  STEP_FOR_STATE,
  TEMPLATE_STEP_LABELS,
} from "../src/lib/template-steps.js";

/**
 * The CLI's template-step words and its state → step rule are MIRRORS: the
 * product's one table is `TEMPLATE_STEP_LABELS` in `@synap-core/types/vocabulary`
 * and its one rule is `STEP_FOR_STATE` in `@synap-core/web/marketplace`, and
 * this package can import neither. This reads both sources across the repo
 * boundary, derives the row set from THEM (a step added there joins the check
 * by existing), and fails on any difference in either direction.
 *
 * What it does NOT prove: that the rule is right. Two copies of a wrong rule
 * agree (a convergence guard proves sameness only). It is skipped in a
 * checkout without the sibling repos, as the kind-heading parity test is.
 */
const VOCAB = join(process.cwd(), "../synap-backend/packages/types/src/vocabulary/index.ts");
const CLASSIFIER = join(
  process.cwd(),
  "../synap-app/packages/web/src/marketplace/utils/template-step.ts"
);

/** `name ... = { a: "x", "b-c": null, }` → { a: "x", "b-c": null }. Values: string literal or null. */
function objectRows(src: string, name: string): Record<string, string | null> {
  const at = src.search(new RegExp(`const ${name}\\b[^=]*=\\s*\\{`));
  expect(at, `${name} not found — renamed or moved?`).toBeGreaterThanOrEqual(0);
  const open = src.indexOf("{", at);
  const close = src.indexOf("}", open);
  const body = src.slice(open + 1, close);
  const rows: Record<string, string | null> = {};
  for (const m of body.matchAll(/^\s*(?:"([^"]+)"|([\w-]+)):\s*(?:"([^"]*)"|(null))\s*,?\s*$/gm)) {
    rows[m[1] ?? m[2]!] = m[4] ? null : m[3]!;
  }
  return rows;
}

describe("template-step words mirror the vocabulary", () => {
  it.runIf(existsSync(VOCAB))("TEMPLATE_STEP_LABELS equals the vocabulary's, row for row", () => {
    const src = readFileSync(VOCAB, "utf8");
    const theirs = objectRows(src, "TEMPLATE_STEP_LABELS");
    expect(Object.keys(theirs).length, "parsed no rows — the comparison would be vacuous").toBeGreaterThanOrEqual(4);
    expect({ ...TEMPLATE_STEP_LABELS }).toEqual(theirs);
  });

  it.runIf(existsSync(VOCAB))("the CLI-only words are not vocabulary yet (move them into the mirror when they are)", () => {
    const labels = Object.values(objectRows(readFileSync(VOCAB, "utf8"), "TEMPLATE_STEP_LABELS"));
    expect(labels.length).toBeGreaterThanOrEqual(4);
    expect(labels).not.toContain(NEEDS_YOUR_OK);
    expect(labels).not.toContain(ASKED_BY_AN_AGENT);
  });

  it.runIf(existsSync(CLASSIFIER))("STEP_FOR_STATE equals the shared classifier's, row for row", () => {
    const theirs = objectRows(readFileSync(CLASSIFIER, "utf8"), "STEP_FOR_STATE");
    expect(Object.keys(theirs).length, "parsed no rows — the comparison would be vacuous").toBeGreaterThanOrEqual(6);
    expect({ ...STEP_FOR_STATE }).toEqual(theirs);
  });
});
