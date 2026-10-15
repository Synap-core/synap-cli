/**
 * `synap templates` draws the pod's step fields (Hub `GET /workspaces`, lane
 * be-health of FIX-WAVE-2): `state`, `pendingDataChanges`, `updateProposal`,
 * `stepWarnings` — and an older pod that sends none of them reads as before.
 * Driven from the wire row through the real mapper, the real classifier and
 * the real renderer, with the printed lines as the assertion.
 *
 * Also: one name for the unfinished state in the batch summary, and the 409
 * "a person must agree" hint naming `synap whoami`.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("../src/utils/logger.js", () => {
  const rec = () => () => undefined;
  return {
    log: {
      success: rec(),
      warn: rec(),
      info: rec(),
      hint: rec(),
      error: rec(),
      blank: rec(),
      dim: rec(),
      heading: rec(),
    },
    banner: () => undefined,
  };
});

import { mapWorkspaceAttachments } from "../src/lib/installed.js";
import { classifyTemplateRow, renderTemplateRow, summarizeApplyResults, classifyApplyResponse } from "../src/commands/market.js";
import { consentRefusalLines, type DataChange } from "../src/lib/template-lifecycle.js";

const plain = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "");
const P1 = "a99e1d4e-0000-4000-8000-000000000001";
const P2 = "a99e1d4e-0000-4000-8000-000000000002";
const AGENT_P = "2465f34e-0000-4000-8000-000000000003";
const HELD =
  "Not finished: this update of builder changes existing data, and waits for you to agree to it. Run `synap templates update builder` to review the changes.";

const wire = (over: Record<string, unknown>) => ({
  id: "ws-1",
  name: "Builder",
  workspaceSubtype: "dev",
  packageSlug: "builder",
  packageVersion: "h-1",
  latestVersion: "h-2",
  drifted: true,
  ...over,
});
const rowOf = (over: Record<string, unknown>) =>
  classifyTemplateRow(mapWorkspaceAttachments([wire(over) as never])[0]!, undefined, []);

let out: string[] = [];
const spy = vi.spyOn(console, "log");
beforeEach(() => {
  out = [];
  spy.mockImplementation((...a: unknown[]) => void out.push(plain(a.map(String).join(" "))));
});
afterEach(() => spy.mockReset());
const printed = (over: Record<string, unknown>) => {
  renderTemplateRow(rowOf(over));
  return out.join("\n");
};

describe("synap templates — the step the pod reports", () => {
  it("a stamped space whose last update FAILED reads 'not finished' with ⚠, never ⏳", () => {
    const s = "Not finished: the last update of builder stopped. Run `synap templates update builder` to resume.";
    const text = printed({ state: "failed", applyWarning: s, awaitingApproval: [] });
    expect(text).toContain("⚠ builder · not finished");
    expect(text).toContain(`⚠ ${s}`);
    expect(text).not.toContain("⏳");
    expect(text).not.toContain("update available");
  });

  it("waiting on live proposals is the one ⏳ step", () => {
    const text = printed({ state: "awaiting-approval", awaitingApproval: [P1], applyWarning: "Waiting on your approval." });
    expect(text).toContain("⏳ builder · waiting for approval");
    expect(text).toContain("⏳ Waiting on your approval.");
    expect(text).toContain(`synap open proposal ${P1}`);
  });

  it("an older pod (no state) waiting on a proposal keeps ⏳ on the pod's sentence", () => {
    const text = printed({ packageVersion: null, awaitingApproval: [P1], applyWarning: "Waiting on your approval." });
    expect(text).toContain("⏳ Waiting on your approval.");
  });

  it("several pending proposals still get a door: the review queue", () => {
    const r = rowOf({ state: "awaiting-approval", awaitingApproval: [P1, P2], applyWarning: "Waiting." });
    expect(r.action).toBe("synap proposals");
  });

  it("data changes held: 'Needs your OK', the pod's sentences, the consent command once", () => {
    const text = printed({
      state: "active",
      applyWarning: HELD,
      awaitingApproval: [],
      pendingDataChanges: {
        count: 2,
        sentences: ["Stories move from planned to backlog.", "Bugs gain a severity."],
        unreadable: false,
        needsPodAdmin: false,
      },
      stepWarnings: ["Could not check which of this update's data changes already ran."],
    });
    expect(text).toContain("⚠ Needs your OK: 2 data changes to existing records");
    expect(text).toContain("• Stories move from planned to backlog.");
    expect(text).toContain("• Bugs gain a severity.");
    expect(text).toContain("Could not check which of this update's data changes already ran.");
    expect(text).not.toContain("Only a pod owner or admin");
    // The held sentence says what the block says: printed once, not twice.
    expect(text).not.toContain(HELD);
    expect(text.match(/synap templates update builder/g)?.length).toBe(1);
  });

  it("a reader who cannot agree is told who can", () => {
    const text = printed({
      state: "active",
      pendingDataChanges: { count: 1, sentences: ["Stories move."], unreadable: false, needsPodAdmin: true },
    });
    expect(text).toContain("Only a pod owner or admin can agree to them.");
  });

  it("an agent's update proposal: 'Asked by an agent' and its door, printed once", () => {
    const text = printed({ state: "active", updateProposal: { id: AGENT_P } });
    expect(text).toContain(`→ Asked by an agent · synap open proposal ${AGENT_P}`);
    expect(text.match(new RegExp(`synap open proposal ${AGENT_P}`, "g"))?.length).toBe(1);
    expect(rowOf({ updateProposal: { id: AGENT_P } }).action).toBe(`synap open proposal ${AGENT_P}`);
  });

  it("an older pod that sends none of the new fields draws what it drew before", () => {
    // Unstamped + drifted: the row the CLI already drew as "not finished".
    const r = rowOf({ packageVersion: null });
    expect(r.dataChanges).toBeNull();
    expect(r.updateProposalId).toBeNull();
    expect(r.step).toBeNull();
    expect(r.action).toBe("synap templates update builder");
    const text = printed({ packageVersion: null });
    expect(text).toContain("⚠ builder · not finished");
    expect(text).not.toMatch(/Needs your OK|Asked by an agent|⏳/);
  });

  it("a malformed pendingDataChanges is unknown, never 'nothing held' and never a crash", () => {
    const [ws] = mapWorkspaceAttachments([wire({ pendingDataChanges: "yes" }) as never]);
    expect(ws!.pendingDataChanges).toBeUndefined();
    const [none] = mapWorkspaceAttachments([wire({ pendingDataChanges: null }) as never]);
    expect(none!.pendingDataChanges).toBeNull();
  });
});

describe("one name for the unfinished state", () => {
  it("the batch summary says 'not finished', never 'completed with failures'", () => {
    const s = summarizeApplyResults([
      { slug: "crm", status: "not-finished" },
      { slug: "dev", status: "updated-with-failures" },
    ]);
    expect(plain(s.line)).toContain("2 not finished");
    expect(plain(s.line)).not.toContain("completed with failures");
  });

  it("an old pod's awaiting fallback names the one proposal, or the queue", () => {
    const entry = { slug: "crm", name: "CRM" } as Parameters<typeof classifyApplyResponse>[0];
    const one = classifyApplyResponse(entry, { templateApply: { state: "awaiting-approval", proposals: [P1] } }, { wasUnstamped: false });
    expect(one.warnings[0]).toContain(`synap open proposal ${P1}`);
    const two = classifyApplyResponse(entry, { templateApply: { state: "awaiting-approval", proposals: [P1, P2] } }, { wasUnstamped: false });
    expect(two.warnings[0]).toContain("(synap proposals)");
  });
});

describe("409: only a person can agree", () => {
  const owed: DataChange[] = [{ opKey: "w12", description: "Stories move.", affected: 2, destructive: false }];

  it("an agent-key refusal tells the person how to check their key", () => {
    const said = consentRefusalLines("Builder", "builder", owed, true);
    expect(said.hints.join("\n")).toContain("synap templates update builder --accept-data-changes w12");
    expect(said.hints.join("\n")).toContain("`synap whoami` must say Is agent: no");
  });

  it("a person who has not agreed is not sent to whoami", () => {
    const said = consentRefusalLines("Builder", "builder", owed, false);
    expect(said.hints.join("\n")).not.toContain("whoami");
  });
});
