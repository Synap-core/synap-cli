/**
 * `synap proposals await <id>` — the blocking half of the dev loop.
 *
 * What these tests pin:
 *   • the three outcomes (approved / rejected / timeout) and their exit codes,
 *   • that the status vocabulary is the pod's own (`PROPOSAL_STATUSES`,
 *     `STATUS_ATTENTION`, imported) and stays exhaustively classified — the CLI
 *     was once narrower than the door it calls on `expired`, and a hand-mirrored
 *     enum is how that happened,
 *   • that `approval_failed` ("approved, but the write threw", attention
 *     `decide`) keeps the wait going instead of reporting a rejection,
 *   • that an unknown status is NOT reported as a decision the pod never made.
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import {
  awaitProposal,
  classifyProposalStatus,
  approvalFailedLine,
  exitCodeForOutcome,
  parseDuration,
  statusOf,
  PROPOSAL_ROW_STATUSES,
} from "../src/commands/proposals-await.js";
import {
  PROPOSAL_STATUSES,
  STATUS_ATTENTION,
} from "@synap-core/types/proposals/attention";
import type { HubConfig } from "../src/lib/hub-client.js";

const CFG: HubConfig = {
  podUrl: "https://pod.example.test",
  apiKey: "test-key",
  userId: "user-1",
};

/** Queue of statuses; each fetch consumes one, the last repeats forever. */
function mockStatuses(statuses: string[]): void {
  let i = 0;
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => {
      const status = statuses[Math.min(i, statuses.length - 1)];
      i++;
      return new Response(JSON.stringify({ id: "p1", status }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    })
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("status vocabulary — derived, never hand-mirrored", () => {
  it("row statuses are the pod's PROPOSAL_STATUSES, imported", () => {
    expect([...PROPOSAL_ROW_STATUSES]).toEqual([...PROPOSAL_STATUSES]);
    expect(PROPOSAL_ROW_STATUSES).not.toContain("all");
  });

  it("every status the pod can hold is classified — none falls through", () => {
    expect(PROPOSAL_STATUSES.length).toBeGreaterThan(5);
    for (const status of PROPOSAL_STATUSES) {
      expect(classifyProposalStatus(status), status).not.toBe("unknown");
    }
  });

  it("the bucket follows STATUS_ATTENTION: decide waits, notice/history end", () => {
    for (const status of PROPOSAL_STATUSES) {
      const outcome = classifyProposalStatus(status);
      if (STATUS_ATTENTION[status] === "decide") {
        expect(outcome, status).toBe("pending");
      } else {
        expect(["approved", "rejected"], status).toContain(outcome);
      }
    }
  });

  it("`approval_failed` is a verdict still owed — it waits, it is not a rejection", () => {
    expect(classifyProposalStatus("approval_failed")).toBe("pending");
    expect(exitCodeForOutcome(classifyProposalStatus("approval_failed"))).toBe(2);
  });

  it("`expired` is terminal-not-approved — the status the CLI once could not see", () => {
    expect(classifyProposalStatus("expired")).toBe("rejected");
    expect(exitCodeForOutcome(classifyProposalStatus("expired"))).toBe(1);
  });

  it("auto_approved is a YES — it already executed", () => {
    expect(classifyProposalStatus("auto_approved")).toBe("approved");
  });

  it("an unrecognised status is `unknown`, never a fabricated decision", () => {
    expect(classifyProposalStatus("in_review")).toBe("unknown");
    expect(classifyProposalStatus(undefined)).toBe("unknown");
    expect(exitCodeForOutcome("unknown")).toBe(2);
  });
});

describe("parseDuration", () => {
  it("parses units", () => {
    expect(parseDuration("30m", 1)).toBe(1_800_000);
    expect(parseDuration("10s", 1)).toBe(10_000);
    expect(parseDuration("2h", 1)).toBe(7_200_000);
    expect(parseDuration("500ms", 1)).toBe(500);
  });
  it("a bare number is seconds", () => {
    expect(parseDuration("45", 1)).toBe(45_000);
  });
  it("falls back when absent, null when unparseable", () => {
    expect(parseDuration(undefined, 999)).toBe(999);
    expect(parseDuration("soon", 999)).toBeNull();
    expect(parseDuration("0s", 999)).toBeNull();
  });
});

describe("statusOf", () => {
  it("reads a bare row and an enveloped one", () => {
    expect(statusOf({ status: "pending" })).toBe("pending");
    expect(statusOf({ proposal: { status: "approved" } })).toBe("approved");
    expect(statusOf(null)).toBeUndefined();
  });
});

describe("awaitProposal", () => {
  it("returns approved without waiting when the proposal is already decided", async () => {
    mockStatuses(["approved"]);
    const res = await awaitProposal("p1", CFG, { timeoutMs: 5_000, intervalMs: 5_000 });
    expect(res.outcome).toBe("approved");
    expect(res.status).toBe("approved");
    expect(exitCodeForOutcome(res.outcome)).toBe(0);
    // One immediate check only — it never entered the poll loop.
    expect(vi.mocked(fetch)).toHaveBeenCalledTimes(1);
  });

  it("polls a pending proposal until it is approved", async () => {
    mockStatuses(["pending", "pending", "approved"]);
    const res = await awaitProposal("p1", CFG, { timeoutMs: 2_000, intervalMs: 5 });
    expect(res.outcome).toBe("approved");
    expect(exitCodeForOutcome(res.outcome)).toBe(0);
    expect(vi.mocked(fetch).mock.calls.length).toBeGreaterThan(1);
  });

  it("polls a pending proposal until it is rejected — exit 1, not an exception", async () => {
    mockStatuses(["pending", "rejected"]);
    const res = await awaitProposal("p1", CFG, { timeoutMs: 2_000, intervalMs: 5 });
    expect(res.outcome).toBe("rejected");
    expect(res.status).toBe("rejected");
    expect(exitCodeForOutcome(res.outcome)).toBe(1);
  });

  it("keeps waiting on approval_failed, says so ONCE, and ends when the person acts", async () => {
    mockStatuses(["approval_failed", "approval_failed", "approved"]);
    const onApprovalFailed = vi.fn();
    const res = await awaitProposal("p1", CFG, {
      timeoutMs: 5_000,
      intervalMs: 5,
      onApprovalFailed,
    });
    expect(res.outcome).toBe("approved");
    expect(onApprovalFailed).toHaveBeenCalledTimes(1);
  });

  it("times out with exit 2 (never exit 1) when approval_failed is never acted on", async () => {
    mockStatuses(["approval_failed"]);
    const res = await awaitProposal("p1", CFG, { timeoutMs: 60, intervalMs: 10 });
    expect(res.outcome).toBe("pending");
    expect(res.status).toBe("approval_failed");
    expect(exitCodeForOutcome(res.outcome)).toBe(2);
  });

  it("the wait line names the failed write and where to retry or dismiss it", () => {
    expect(approvalFailedLine("https://pod/x")).toBe(
      "Approved, but the write failed: retry or dismiss it at https://pod/x"
    );
  });

  it("times out with exit 2 while the proposal is still pending", async () => {
    mockStatuses(["pending"]);
    const res = await awaitProposal("p1", CFG, { timeoutMs: 60, intervalMs: 10 });
    expect(res.outcome).toBe("pending");
    expect(res.status).toBe("pending");
    expect(exitCodeForOutcome(res.outcome)).toBe(2);
  });
});
