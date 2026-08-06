/**
 * `synap import` corpus door → FILE-LEVEL loss must be visible and non-zero.
 *
 * The pod structures each file of a corpus separately. A job whose pg-boss state
 * is "completed" can still have dropped files — the real run that motivated this
 * reported `0 failed · 1 proposed` to the user while the resulting proposal
 * recorded `filesProcessed: 1, filesFailed: 2`. Two of three files were gone and
 * nothing said so.
 *
 * The judgement lives in ONE place (`readCorpusFileOutcome` / `corpusOutcomeLines`)
 * precisely because a second copy is how "0 failed" survived on one path. What is
 * pinned here:
 *
 *   1. ABSENT output is UNKNOWN, never `filesFailed: 0` — a pod that predates the
 *      result-carrying worker must not read as "everything landed";
 *   2. a known loss produces a line that SAYS files are missing, not a count the
 *      reader has to interpret;
 *   3. loss maps to a non-zero exit code through the existing `degraded` outcome —
 *      a scripted backfill must not read loss as success.
 *
 * Pure-function level: no network, no pod, no timers.
 */

import { describe, it, expect } from "vitest";
import {
  readCorpusFileOutcome,
  corpusOutcomeLines,
  importExitCode,
  CORPUS_OUTCOME_UNAVAILABLE,
} from "../src/commands/import.js";

describe("corpus file-level outcome — absence is UNKNOWN, not success", () => {
  it("treats missing output as unknown", () => {
    expect(readCorpusFileOutcome(null)).toEqual({ known: false });
    expect(readCorpusFileOutcome(undefined)).toEqual({ known: false });
  });

  it("treats output WITHOUT filesFailed as unknown", () => {
    // An older pod returns a proposalId but no counts. That is not zero failures.
    expect(readCorpusFileOutcome({ proposalId: "p1" })).toEqual({ known: false });
  });

  it("never renders an unknown outcome as a clean count", () => {
    const lines = corpusOutcomeLines(null);
    expect(lines).toEqual([CORPUS_OUTCOME_UNAVAILABLE]);
    // The precise failure being prevented: printing a fabricated "0 failed".
    expect(lines.join(" ")).not.toMatch(/0 failed/);
    expect(lines.join(" ")).toMatch(/NOT a confirmation/i);
  });
});

describe("corpus file-level outcome — known loss is stated plainly", () => {
  const LOSS = { proposalId: "p1", filesProcessed: 1, filesFailed: 2 };

  it("reads the counts the pod reported", () => {
    expect(readCorpusFileOutcome(LOSS)).toEqual({
      known: true,
      filesProcessed: 1,
      filesFailed: 2,
    });
  });

  it("says files produced NOTHING and are absent from the proposal", () => {
    const text = corpusOutcomeLines(LOSS, 3).join("\n");
    expect(text).toContain("1 of 3 structured · 2 failed");
    expect(text).toMatch(/produced NOTHING/);
    expect(text).toMatch(/re-import/i);
  });

  it("stays quiet about loss when there was none", () => {
    const text = corpusOutcomeLines(
      { proposalId: "p1", filesProcessed: 3, filesFailed: 0 },
      3
    ).join("\n");
    expect(text).toContain("3 of 3 structured · 0 failed");
    expect(text).not.toMatch(/produced NOTHING/);
  });

  it("surfaces the pod's findings so the cause is actionable", () => {
    const text = corpusOutcomeLines(
      { ...LOSS, findings: [{ severity: "error", message: "file exceeds 8000-char cap" }] },
      3
    ).join("\n");
    expect(text).toContain("[ERROR] file exceeds 8000-char cap");
  });
});

describe("corpus file loss exits non-zero", () => {
  it("maps a lost-file run to a non-zero exit via `degraded`", () => {
    // This is the contract the run path relies on: it returns `degraded` when
    // filesFailed > 0 rather than inventing a second exit-code path.
    expect(importExitCode([{ status: "degraded" }])).toBe(1);
  });

  it("keeps a clean corpus run at zero", () => {
    expect(importExitCode([{ status: "proposed" }])).toBe(0);
  });

  it("keeps a still-running job at zero — queued is not degraded", () => {
    expect(importExitCode([{ status: "queued" }])).toBe(0);
  });
});
