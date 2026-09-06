/**
 * `synap proposals list --status` — the auto-approve RECEIPT lens.
 *
 * Ground truth: `ProposalStatus.AUTO_APPROVED = "auto_approved"` exists in
 * `synap-backend/packages/database/src/schema/proposals.ts:25`, commented
 * "Action was on the autoApproveFor whitelist — executed immediately, audited
 * here for traceability." So every auto-approved agent write ALREADY files a
 * proposal row. The user's "the agent did something on my pod and I have no way
 * to see it" was a missing FILTER: `listProposals` hardcoded
 * `status: "pending"` in its `hubGet` call and registered no `--status` flag.
 *
 * These tests pin the WIRE (what the command actually sent) rather than "the
 * option is registered", because a flag that never leaves the process is the
 * exact defect class this file exists to prevent.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// Imported dynamically (never at top level): `vi.mock` is hoisted above every
// static import, so a static `data-extra.js` import would evaluate the module —
// and its `hub-client.js` import — before the mock factory's closure variables
// exist. Same reason the sibling wire tests use `await import` throughout.
const load = () => import("../src/commands/data-extra.js");

const hubGet = vi.fn(async () => ({ proposals: [] }));

vi.mock("../src/lib/hub-client.js", () => ({
  hubGet,
  hubPatch: vi.fn(async () => ({})),
  hubPost: vi.fn(async () => ({})),
  resolveHubConfig: vi.fn(async () => ({
    podUrl: "http://127.0.0.1:1",
    apiKey: "test-key",
    workspaceId: "808939d1-86b3-4c52-a153-ae06ece2c54e",
  })),
  resolveUserId: vi.fn(async () => "user-1"),
  renderHubError: vi.fn(),
  resolveActiveSessionId: vi.fn(() => undefined),
  detachActiveSessionId: vi.fn(() => undefined),
  HubError: class HubError extends Error {},
}));

vi.mock("../src/lib/credential-class.js", () => ({
  classifyActiveCredential: vi.fn(async () => "unknown"),
}));

beforeEach(() => {
  hubGet.mockClear();
  hubGet.mockImplementation(async () => ({ proposals: [] }));
});

describe("--status vocabulary", () => {
  it("defaults to pending, so the bare command is unchanged", async () => {
    const { parseProposalStatus, DEFAULT_PROPOSAL_STATUS } = await load();
    expect(parseProposalStatus(undefined)).toBe("pending");
    expect(DEFAULT_PROPOSAL_STATUS).toBe("pending");
  });

  it("accepts auto_approved — the receipt lane that had no surface", async () => {
    const { parseProposalStatus } = await load();
    expect(parseProposalStatus("auto_approved")).toBe("auto_approved");
    // Hyphen spelling is what a human types after reading the rendered label.
    expect(parseProposalStatus("auto-approved")).toBe("auto_approved");
    expect(parseProposalStatus("AUTO_APPROVED")).toBe("auto_approved");
  });

  it("accepts every status the pod's own filter SSOT accepts", async () => {
    const { parseProposalStatus, PROPOSAL_STATUS_FILTERS } = await load();
    // Mirrors PROPOSAL_STATUS_FILTERS in
    // synap-backend/packages/api/src/routers/hub-protocol/proposals.ts.
    // A client narrower than the door it calls is its own bug class.
    // HAND-MAINTAINED MIRROR — nothing checks this list against the pod's
    // SSOT, so it passed green while the pod already accepted `expired`.
    // When the backend widens PROPOSAL_STATUS_FILTERS, this list and the
    // length below must move with it.
    for (const s of ["pending", "approved", "rejected", "auto_approved", "reverted", "approval_failed", "withdrawn", "expired", "all"]) {
      expect(parseProposalStatus(s)).toBe(s);
    }
    expect([...PROPOSAL_STATUS_FILTERS]).toHaveLength(9);
  });

  it("returns null for an unknown value instead of forwarding garbage", async () => {
    const { parseProposalStatus } = await load();
    expect(parseProposalStatus("approvedish")).toBeNull();
    expect(parseProposalStatus("validated")).toBeNull();
  });

  it("classifies only pending as actionable", async () => {
    const { isActionableStatus } = await load();
    expect(isActionableStatus("pending")).toBe(true);
    for (const s of ["approved", "auto_approved", "rejected", "all"] as const) {
      expect(isActionableStatus(s)).toBe(false);
    }
  });

  it("renders a display label with no underscores, and none for `all`", async () => {
    const { proposalStatusLabel } = await load();
    expect(proposalStatusLabel("auto_approved")).toBe("auto-approved");
    expect(proposalStatusLabel("all")).toBe("");
  });
});

describe("--status reaches the pod", () => {
  it("sends status=pending by default — the pre-existing behaviour, unchanged", async () => {
    const { listProposals } = await load();
    await listProposals({} as never);

    const [path, params] = hubGet.mock.calls[0] as unknown as [string, Record<string, unknown>];
    expect(path).toBe("/proposals");
    expect(params.status).toBe("pending");
  });

  it("forwards --status auto_approved as the status query param", async () => {
    const { listProposals } = await load();
    await listProposals({ status: "auto_approved" } as never);

    const [path, params] = hubGet.mock.calls[0] as unknown as [string, Record<string, unknown>];
    expect(path).toBe("/proposals");
    expect(params.status).toBe("auto_approved");
    // The receipt lens must not silently re-scope the inbox while it's at it.
    expect(params).not.toHaveProperty("workspaceId");
  });

  it("forwards --status all", async () => {
    const { listProposals } = await load();
    await listProposals({ status: "all" } as never);
    const [, params] = hubGet.mock.calls[0] as unknown as [string, Record<string, unknown>];
    expect(params.status).toBe("all");
  });

  it("never sends an unrecognised status to the pod", async () => {
    const { listProposals } = await load();
    const exit = vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);
    const err = vi.spyOn(console, "error").mockImplementation(() => {});

    await listProposals({ status: "bogus" } as never);

    expect(hubGet).not.toHaveBeenCalled();
    expect(exit).toHaveBeenCalledWith(1);
    exit.mockRestore();
    err.mockRestore();
  });
});

describe("--json echoes the filter", () => {
  it("includes the resolved status so an empty list is interpretable", async () => {
    const { listProposals } = await load();
    const out: string[] = [];
    const spy = vi.spyOn(console, "log").mockImplementation((s?: unknown) => {
      out.push(String(s));
    });

    await listProposals({ status: "auto_approved", json: true } as never);
    spy.mockRestore();

    const parsed = JSON.parse(out.join("\n")) as { status: string; proposals: unknown[] };
    // Without this, a consumer cannot tell "no auto-approved writes" from
    // "asked for a status this pod doesn't populate".
    expect(parsed.status).toBe("auto_approved");
    expect(parsed.proposals).toEqual([]);
  });
});
