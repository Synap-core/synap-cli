/**
 * Background corpus import — the run must report FILE-level truth.
 *
 * Reproduced live: 3 markdown files through `POST /import/enqueue-corpus`.
 * The CLI printed `1 item · 1 proposed · 0 failed` while the resulting
 * import.graph proposal recorded `filesProcessed: 1, filesFailed: 2`. The pod
 * knew; the CLI could not see it, because the worker discarded its result and
 * the poll route returned only `{jobId,state,createdOn,completedOn}`.
 *
 * These tests pin the CLI half of the fix: given the job output the pod now
 * returns, a run that lost files must NOT read as clean, and a pod that reports
 * nothing must read as UNKNOWN — never as a pass.
 */

import { describe, it, expect } from "vitest";
import {
  readCorpusFileOutcome,
  corpusCompletionOutcome,
  corpusOutcomeLines,
  importExitCode,
  CORPUS_OUTCOME_UNAVAILABLE,
  type CorpusJobOutput,
} from "../src/commands/import.js";

const LOSSY: CorpusJobOutput = {
  proposalId: "prop-1",
  filesProcessed: 1,
  filesFailed: 2,
  qualityScore: 41,
  findings: [
    {
      id: "files-failed",
      severity: "warn",
      message: "2 file(s) failed deep structure (timeouts/empty)",
    },
  ],
};

const CLEAN: CorpusJobOutput = {
  proposalId: "prop-2",
  filesProcessed: 3,
  filesFailed: 0,
};

describe("readCorpusFileOutcome — absence is UNKNOWN, not zero", () => {
  it("reads the pod's counts when they are present", () => {
    expect(readCorpusFileOutcome(LOSSY)).toEqual({
      known: true,
      filesProcessed: 1,
      filesFailed: 2,
    });
  });

  it("treats a missing output (older pod) as unknown", () => {
    expect(readCorpusFileOutcome(null)).toEqual({ known: false });
    expect(readCorpusFileOutcome(undefined)).toEqual({ known: false });
  });

  it("treats an output WITHOUT filesFailed as unknown, not as 0 failed", () => {
    expect(readCorpusFileOutcome({ proposalId: "p" })).toEqual({ known: false });
  });
});

describe("corpusCompletionOutcome — a lossy run is not a clean run", () => {
  it("is degraded when any file failed", () => {
    const out = corpusCompletionOutcome(LOSSY);
    expect(out.status).toBe("degraded");
    expect(out.degradedReason).toBe("corpus_files_failed:2");
  });

  it("is proposed when every file was structured", () => {
    expect(corpusCompletionOutcome(CLEAN)).toEqual({ status: "proposed" });
  });

  it("stays proposed (with the unavailable message elsewhere) when unknown", () => {
    // The proposal genuinely exists, so the run is not a failure; the UNKNOWN is
    // communicated by CORPUS_OUTCOME_UNAVAILABLE, asserted below.
    expect(corpusCompletionOutcome(null)).toEqual({ status: "proposed" });
  });
});

describe("exit code — the run that lost files must exit non-zero", () => {
  // The whole point: `synap import` over 315 files must not exit 0 while an
  // unknown fraction of them is missing from the proposal.
  it("exits 1 for a corpus run whose files failed", () => {
    expect(importExitCode([corpusCompletionOutcome(LOSSY)])).toBe(1);
  });

  it("exits 0 for a corpus run where every file was structured", () => {
    expect(importExitCode([corpusCompletionOutcome(CLEAN)])).toBe(0);
  });
});

describe("corpusOutcomeLines — the human/report surface", () => {
  it("states processed and failed counts", () => {
    const lines = corpusOutcomeLines(LOSSY, 3);
    expect(lines[0]).toBe("files: 1 of 3 structured · 2 failed");
    expect(lines.join("\n")).toContain("produced NOTHING");
    // The proposal's own finding names the cause — surface it, don't restate it.
    expect(lines.join("\n")).toContain(
      "2 file(s) failed deep structure (timeouts/empty)"
    );
  });

  it("degrades honestly when the pod reported no outcome", () => {
    expect(corpusOutcomeLines(null)).toEqual([CORPUS_OUTCOME_UNAVAILABLE]);
    expect(CORPUS_OUTCOME_UNAVAILABLE).toContain(
      "file-level outcome unavailable from this pod"
    );
    // It must not read as a pass.
    expect(CORPUS_OUTCOME_UNAVAILABLE).toContain("NOT a confirmation");
  });

  it("says nothing alarming on a clean run", () => {
    const lines = corpusOutcomeLines(CLEAN, 3);
    expect(lines).toEqual(["files: 3 of 3 structured · 0 failed"]);
  });
});
