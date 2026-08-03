import { describe, it, expect } from "vitest";
import { importExitCode, degradedOutcome, type ItemOutcome } from "../src/commands/import.js";

const o = (status: ItemOutcome["status"]): { status: ItemOutcome["status"] } => ({ status });

describe("importExitCode", () => {
  it("exits 0 when everything succeeded", () => {
    expect(importExitCode([o("stored"), o("stored"), o("proposed")])).toBe(0);
  });

  it("exits 0 for a clean dry-run", () => {
    expect(importExitCode([o("dry-run"), o("dry-run")])).toBe(0);
  });

  it("exits 0 for skipped / empty — the run was honest, nothing was lost", () => {
    expect(importExitCode([o("skipped"), o("empty")])).toBe(0);
  });

  // The bug: a file that produced ZERO entities used to exit 0, so a 257-file
  // backfill could lose most of its input and still report success.
  it("exits 1 when ANY item degraded", () => {
    expect(importExitCode([o("stored"), o("degraded")])).toBe(1);
  });

  it("exits 1 on a degraded-only run", () => {
    expect(importExitCode([o("degraded")])).toBe(1);
  });

  it("still exits 1 when any item failed", () => {
    expect(importExitCode([o("stored"), o("failed")])).toBe(1);
  });

  it("exits 0 on an empty outcome list", () => {
    expect(importExitCode([])).toBe(0);
  });
});

describe("degradedOutcome carries degradedReason into --json", () => {
  // A door asymmetry: the human path prints the reason via degradedMessage(),
  // while the --json payload dropped it at this exact seam. A scripted import
  // saw {"status":"degraded"} and could not tell an auth error from an empty
  // result.
  it("threads the server's degradedReason onto the outcome", () => {
    const outcome = degradedOutcome(
      "note.md",
      { degraded: true, degradedReason: "is_invalid_response" },
      "ws-1",
      null
    );
    expect(outcome.degradedReason).toBe("is_invalid_response");
    // Round-trip: this object IS the per-item --json payload.
    expect(JSON.parse(JSON.stringify(outcome))).toEqual({
      label: "note.md",
      status: "degraded",
      workspaceId: "ws-1",
      projectId: null,
      degradedReason: "is_invalid_response",
    });
  });

  it("preserves every reason the API type declares", () => {
    for (const reason of ["is_auth_error", "is_invalid_response", "is_empty_result"]) {
      expect(
        degradedOutcome("f.md", { degraded: true, degradedReason: reason }, null, null).degradedReason
      ).toBe(reason);
    }
  });

  it("omits the key entirely when the server sent no reason (no invented cause)", () => {
    const outcome: ItemOutcome = degradedOutcome("note.md", { degraded: true }, "ws-1", null);
    expect("degradedReason" in outcome).toBe(false);
  });
});
