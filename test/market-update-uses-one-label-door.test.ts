import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, resolve, join, relative } from "path";
import { stripComments } from "./helpers/strip-comments.mjs";
import { TEMPLATE_STEP_LABELS } from "../src/lib/template-steps.js";

/**
 * Template-step words have ONE door in this package: `src/lib/template-steps.ts`
 * (the mirror of `@synap-core/types/vocabulary` `TEMPLATE_STEP_LABELS`, pinned
 * by `template-step-vocabulary-parity.test.ts`). No other source file may spell
 * a step label as a string of its own — that is how the CLI came to say
 * "completed with failures" where every other surface said "Not finished".
 *
 * History: this file first pinned only `marketUpdate`, which printed a SECOND,
 * hand-rolled status label instead of calling `installedStatusLabel` (a green
 * "up to date" nothing had verified; a content change read as a version bump).
 * It scanned for the literal `chalk.green("up to date")`; once the step words
 * moved behind the door that literal existed nowhere, and the scan passed while
 * looking at nothing. It now scans every source file for every label.
 *
 * What it scans: every `src/**\/*.ts` (derived — a new file joins by existing),
 * comments stripped by the shared string-aware scanner, then every '…', "…"
 * and `…` literal on one line. A literal is a step label when, after dropping
 * leading/trailing whitespace, glyphs, punctuation (but not `-`/`_`, which make a
 * machine token like "not-finished") and `${…}` holes, it equals
 * a label (case-insensitive). The labels come from the door itself, so a new
 * step joins the scan by existing.
 *
 * What it does NOT see (measured by the self-checks below): a label inside a
 * longer sentence ("X is already up to date.") — sentences are product copy,
 * not vocabulary (.claude/rules/vocabulary.md); a label split across a
 * concatenation (`"up to " + "date"`); a literal spanning lines.
 */

const here = dirname(fileURLToPath(import.meta.url));
const SRC_DIR = resolve(here, "../src");
const DOOR = "lib/template-steps.ts";

/**
 * Same words, different domain value — classified, with the reason. Each entry
 * must still match (a stale exemption fails below), so the list cannot rot.
 */
const OTHER_DOMAIN: Record<string, string> = {
  "lib/key-approval.ts": "agent-KEY approval spinner (a key waits on the person), not a template step",
  "lib/batch-approval.ts": "batch KEY approval spinner, not a template step",
  "commands/app.ts": "app-key connect spinner, not a template step",
};

const LABELS = Object.values(TEMPLATE_STEP_LABELS).map((l) => l.toLowerCase());

/** The words a literal reduces to once holes, glyphs and punctuation are gone. */
function core(literal: string): string {
  return literal
    .replace(/\$\{[^}]*\}/g, " ")
    // `-` and `_` are kept: "not-finished" is a machine token, not a label.
    .replace(/[^\p{L}\p{N}'\-_ ]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

/** Every one-line string literal in comment-stripped source. */
function literals(code: string): string[] {
  return [...code.matchAll(/"((?:[^"\\\n]|\\.)*)"|'((?:[^'\\\n]|\\.)*)'|`((?:[^`\\\n]|\\.)*)`/g)].map(
    (m) => m[1] ?? m[2] ?? m[3] ?? ""
  );
}

function stepLabelsIn(code: string): string[] {
  return literals(code).filter((l) => LABELS.includes(core(l)));
}

function sourceFiles(dir: string): string[] {
  return (readdirSync(dir, { recursive: true }) as string[])
    .filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts") && !f.endsWith(".d.ts"))
    .map((f) => join(dir, f));
}

/**
 * Extract a top-level function body. Anchors on the closing `}` at column 0,
 * which the repo's formatting guarantees for a top-level declaration.
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

describe("template-step words come only from the one door", () => {
  const files = sourceFiles(SRC_DIR);
  const scanned = files.map((f) => ({
    rel: relative(SRC_DIR, f).split("\\").join("/"),
    code: stripComments(readFileSync(f, "utf8"), "ts"),
  }));

  it("self-check: the matcher sees a label cell and ignores a sentence", () => {
    expect(stepLabelsIn('return chalk.yellow("update available  ") + x;')).toEqual(["update available  "]);
    expect(stepLabelsIn("console.log(chalk.dim(`  Up to date`));")).toHaveLength(1);
    expect(stepLabelsIn("parts.push(`${n} not finished`);")).toHaveLength(1);
    expect(stepLabelsIn("x(chalk.yellow('⚠ ') + ' · not finished')")).toHaveLength(1);
    expect(stepLabelsIn('log.info(`• ${name} is already up to date.`);')).toEqual([]);
    expect(stepLabelsIn('const s = "content changed";')).toEqual([]);
    expect(stepLabelsIn('case "not-finished":')).toEqual([]);
  });

  it("the scan is not vacuous: it reads the whole tree and sees the door's own labels", () => {
    expect(files.length, "src glob matched too few files").toBeGreaterThan(80);
    const total = scanned.reduce((n, f) => n + literals(f.code).length, 0);
    expect(total, "too few string literals — the stripper or the regex went blind").toBeGreaterThan(5000);
    expect(LABELS.length).toBeGreaterThanOrEqual(4);
    const door = scanned.find((f) => f.rel === DOOR);
    expect(door, `${DOOR} not scanned`).toBeTruthy();
    // Every label is spelled exactly once — in the door.
    expect(stepLabelsIn(door!.code).map(core).sort()).toEqual([...LABELS].sort());
  });

  it("no other source file spells a step label", () => {
    const offenders: string[] = [];
    for (const f of scanned) {
      if (f.rel === DOOR || f.rel in OTHER_DOMAIN) continue;
      for (const l of stepLabelsIn(f.code)) offenders.push(`${f.rel}: "${l}"`);
    }
    expect(offenders, "spell it through src/lib/template-steps.ts").toEqual([]);
  });

  it("every other-domain exemption still matches (a stale exemption is removed)", () => {
    for (const rel of Object.keys(OTHER_DOMAIN)) {
      const f = scanned.find((s) => s.rel === rel);
      expect(f, `${rel} no longer exists`).toBeTruthy();
      expect(stepLabelsIn(f!.code).length, `${rel} no longer spells a label — drop it`).toBeGreaterThan(0);
    }
  });
});

describe("market update renders status through the ONE label door", () => {
  const body = functionBody(stripComments(readFileSync(resolve(SRC_DIR, "commands/market.ts"), "utf8"), "ts"), "marketUpdate");

  it("marketUpdate calls installedStatusLabel", () => {
    expect(body).toContain("installedStatusLabel(");
  });

  it("the extractor really located a body (guards against a silent empty match)", () => {
    expect(body.length).toBeGreaterThan(500);
    expect(body).toContain("buildMarketCatalog");
  });
});
