import { describe, it, expect } from "vitest";
import { classifyRun } from "../src/commands/proposals-actions.js";

/**
 * A verb run's outcome must be read from what the producer actually emits.
 *
 * Found by dogfooding on 2026-09-05. Approving a `market.install` proposal on a
 * live pod printed:
 *
 *   ✗ Ran market.install — it failed:
 *       Unknown error
 *
 * while the proposal row held, and the pod confirmed:
 *
 *   runResult = { status: "installed",
 *                 result: { kind:"view", created:["Task Board","Priority Matrix",
 *                           "Task Calendar","All Tasks"], updated:[], failed:[] } }
 *
 * All four views existed. The install had WORKED. Cause: the CLI branched on
 * `runResult.success`, a field the executor never writes on this path — it
 * materializes `runOutcome.result` verbatim, and `market.install` returns
 * `{status, result}`. A missing `success` therefore read as failure.
 *
 * Exact mirror of the `status ?? "installed"` bug fixed the same day, where a
 * missing discriminator defaulted to SUCCESS. Same root: assuming a contract
 * the producer never promised. Hence `"unclear"` — the classifier refuses to
 * guess in either direction.
 */

describe("classifyRun — never guesses a verdict", () => {
  it("the real market.install payload that was misreported is a SUCCESS", () => {
    expect(
      classifyRun({
        status: "installed",
        result: {
          kind: "view",
          created: ["Task Board", "Priority Matrix", "Task Calendar", "All Tasks"],
          updated: [],
          failed: [],
        },
      })
    ).toBe("ok");
  });

  it("an explicit failure is still a failure", () => {
    expect(classifyRun({ success: false })).toBe("failed");
    expect(classifyRun({ error: "Capability is not approved" })).toBe("failed");
  });

  it("an explicit success is still a success", () => {
    expect(classifyRun({ success: true })).toBe("ok");
  });

  it("an explicit failure WINS over a success-looking status", () => {
    // Order matters: a run that errored must not be rescued by a stale status.
    expect(classifyRun({ status: "installed", error: "boom" })).toBe("failed");
    expect(classifyRun({ status: "installed", success: false })).toBe("failed");
  });

  it("an empty outcome is UNCLEAR — not success, and not failure", () => {
    // The whole point: absence of a marker is absence of information. Defaulting
    // it either way is what produced both of the day's reporting bugs.
    expect(classifyRun({})).toBe("unclear");
    expect(classifyRun({ executionTimeMs: 12 })).toBe("unclear");
  });
});
