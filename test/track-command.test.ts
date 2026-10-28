/**
 * `synap track` + `synap session start --track` — the bytes sent to the Hub
 * `/tracks` routes and the honesty of what is printed: a proposal prints as
 * QUEUED (never "started"), and the pod's domain advisories (`domainsNote`,
 * `domainNote`) reach the terminal.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const hubPost = vi.fn();
const hubGet = vi.fn();
const hubPatch = vi.fn();
const attachActiveSessionId = vi.fn(() => "session-lens");

vi.mock("../src/lib/hub-client.js", () => ({
  hubPost,
  hubGet,
  hubPatch,
  attachActiveSessionId,
  resolveHubConfig: vi.fn(async () => ({
    podUrl: "http://127.0.0.1:1",
    apiKey: "agent-key",
    workspaceId: "ws-lens",
    projectId: "proj-lens",
  })),
  renderHubError: vi.fn(),
  HubError: class HubError extends Error {},
}));

let out: string[];
beforeEach(() => {
  hubPost.mockReset();
  hubGet.mockReset();
  hubPatch.mockReset();
  attachActiveSessionId.mockClear();
  out = [];
  const capture = (...a: unknown[]) => void out.push(a.map(String).join(" "));
  vi.spyOn(console, "log").mockImplementation(capture);
  vi.spyOn(console, "error").mockImplementation(capture);
});
afterEach(() => vi.restoreAllMocks());

// Colour codes stripped: the words are what is asserted, whatever chalk's level.
// eslint-disable-next-line no-control-regex
const printed = () => out.join("\n").replace(/\x1b\[[0-9;]*m/g, "");

describe("synap track start", () => {
  it("prints a proposal as queued with its review link, and the domain note", async () => {
    hubPost.mockResolvedValueOnce({
      status: "proposed",
      proposalId: "prop-1",
      reviewUrl: "https://pod/open/prop-1",
      missingDomains: ["market"],
      domainsNote: 'No workspace is installed for this stage domain: "market".',
    });
    const { startTrack } = await import("../src/commands/tracks.js");
    await startTrack({ playbook: "pb-1", param: ["budget=1000", "market=null"] });

    const [path, body] = hubPost.mock.calls[0] as [string, Record<string, unknown>];
    expect(path).toBe("/tracks");
    expect(body).toEqual({
      projectId: "proj-lens",
      playbookId: "pb-1",
      params: { budget: 1000, market: null },
    });
    expect(printed()).toContain("queued for your review");
    expect(printed()).toContain("https://pod/open/prop-1");
    expect(printed()).toContain('stage domain: "market"');
    expect(printed()).not.toContain("Track started");
  });
});

describe("synap track start — a lasting track needs no method (W1)", () => {
  it("sends a named start with NO playbookId, and points at the session door", async () => {
    hubPost.mockResolvedValueOnce({
      status: "started",
      track: { id: "t-9", name: "Grow the newsletter" },
    });
    const { startTrack } = await import("../src/commands/tracks.js");
    await startTrack({ name: "Grow the newsletter", direction: "Forwarded weekly" });
    const [path, body] = hubPost.mock.calls[0] as [string, Record<string, unknown>];
    expect(path).toBe("/tracks");
    expect(body).toEqual({
      projectId: "proj-lens",
      name: "Grow the newsletter",
      direction: "Forwarded weekly",
    });
    expect(printed()).toContain("Track started");
    expect(printed()).toContain("synap session start --track t-9");
  });

  it("refuses a start with neither a name nor a playbook, sending nothing", async () => {
    const exit = vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);
    const { startTrack } = await import("../src/commands/tracks.js");
    await startTrack({});
    expect(exit).toHaveBeenCalledWith(1);
    expect(hubPost).not.toHaveBeenCalled();
  });
});

describe("synap track start-step", () => {
  it("resolves the current step, then prints the pod's domain fallback", async () => {
    hubGet.mockResolvedValueOnce({ id: "t-1", name: "BM", currentStage: "scan", status: "active" });
    hubPost.mockResolvedValueOnce({
      status: "created",
      stageKey: "scan",
      session: { id: "sess-1" },
      domainFallback: { wanted: "market", reason: "no_workspace" },
      domainNote: "…started in the project's home workspace instead.",
    });
    const { startStep } = await import("../src/commands/tracks.js");
    await startStep("t-1", {});

    expect(hubPost.mock.calls[0][0]).toBe("/tracks/t-1/stages/scan/sessions");
    expect(printed()).toContain("home workspace instead");
    expect(printed()).toContain("sess-1");
  });
});

describe("synap track advance", () => {
  it("prints the step's offer as NOT started", async () => {
    hubPost.mockResolvedValueOnce({
      status: "advanced",
      paused: false,
      offer: { name: "Build", goal: "Build the MVP" },
    });
    const { advanceTrack } = await import("../src/commands/tracks.js");
    await advanceTrack("t-1", "build", {});
    expect(hubPost.mock.calls[0]).toEqual(["/tracks/t-1/advance", { toStage: "build" }, expect.anything()]);
    expect(printed()).toContain("Offered (not started): Build");
  });
});

describe("synap session start --track", () => {
  it("sends trackId and NOT the ambient project/workspace lens", async () => {
    hubGet.mockResolvedValueOnce({ id: "user-1" });
    hubPost.mockResolvedValueOnce({ id: "sess-1", goal: "g" });
    const { startSession } = await import("../src/commands/sessions.js");
    await startSession({ goal: "g", track: "t-1", json: true });

    const [, body] = hubPost.mock.calls[0] as [string, Record<string, unknown>];
    expect(body.trackId).toBe("t-1");
    expect(body).not.toHaveProperty("projectId");
    expect(body).not.toHaveProperty("workspaceId");
  });

  it("prints a proposed start as queued and attaches nothing", async () => {
    hubGet.mockResolvedValueOnce({ id: "user-1" });
    hubPost.mockResolvedValueOnce({
      status: "proposed",
      proposalId: "prop-9",
      reviewUrl: "https://pod/open/prop-9",
      session: null,
    });
    const { startSession } = await import("../src/commands/sessions.js");
    await startSession({ goal: "g", track: "t-1" });

    expect(printed()).toContain("queued for your review");
    expect(printed()).not.toContain("Session started");
    expect(attachActiveSessionId).not.toHaveBeenCalled();
  });
});

describe("synap track status / reopen", () => {
  it("sends the verdict and its reason on a close", async () => {
    hubPatch.mockResolvedValueOnce({ status: "proposed", proposalId: "prop-2" });
    const { setTrackStatus } = await import("../src/commands/tracks.js");
    await setTrackStatus("t-1", "archived", {
      verdict: "replaced",
      verdictReason: "the launch track took over",
      reason: "duplicate",
    });
    const [path, body] = hubPatch.mock.calls[0] as [string, Record<string, unknown>];
    expect(path).toBe("/tracks/t-1");
    expect(body).toEqual({
      status: "archived",
      verdict: "replaced",
      verdictReason: "the launch track took over",
      reasoning: "duplicate",
    });
    expect(printed()).toContain("queued for your review");
  });

  it("sends no verdict when none is given", async () => {
    hubPatch.mockResolvedValueOnce({ status: "updated", track: { id: "t-1" } });
    const { setTrackStatus } = await import("../src/commands/tracks.js");
    await setTrackStatus("t-1", "paused", {});
    expect(hubPatch.mock.calls[0]![1]).toEqual({ status: "paused" });
  });

  it("--expected sends the status the caller read as expectedStatus (D1)", async () => {
    hubPatch.mockResolvedValueOnce({ status: "updated", track: { id: "t-1" } });
    const { setTrackStatus } = await import("../src/commands/tracks.js");
    await setTrackStatus("t-1", "paused", { expected: "active" });
    expect(hubPatch.mock.calls[0]![1]).toEqual({
      status: "paused",
      expectedStatus: "active",
    });
  });

  it("reopen POSTs /tracks/:id/reopen and prints a proposal as queued", async () => {
    hubPost.mockResolvedValueOnce({
      status: "proposed",
      proposalId: "prop-3",
      reviewUrl: "https://pod/open/prop-3",
    });
    const { reopenTrack } = await import("../src/commands/tracks.js");
    await reopenTrack("t-1", { name: "Grow v2", reason: "it matters again" });
    const [path, body] = hubPost.mock.calls[0] as [string, Record<string, unknown>];
    expect(path).toBe("/tracks/t-1/reopen");
    expect(body).toEqual({ name: "Grow v2", reasoning: "it matters again" });
    expect(printed()).toContain("queued for your review");
    expect(printed()).not.toContain("reopened as a new version");
  });

  it("reopen prints the new version when the pod made it", async () => {
    hubPost.mockResolvedValueOnce({
      status: "started",
      track: { id: "t-2", name: "Grow", status: "active", currentStage: null },
    });
    const { reopenTrack } = await import("../src/commands/tracks.js");
    await reopenTrack("t-1", {});
    expect(hubPost.mock.calls[0]![1]).toEqual({});
    expect(printed()).toContain("reopened as a new version");
    expect(printed()).toContain("t-2");
  });
});

describe("synap track list — pod-wide (W5)", () => {
  it("--everywhere lists every goal, paged, and prints the next-page cursor", async () => {
    hubGet.mockResolvedValueOnce({
      items: [{ id: "t-1", name: "Grow", status: "active", currentStage: null }],
      nextCursor: "c2",
    });
    const { listTracks } = await import("../src/commands/tracks.js");
    await listTracks({ everywhere: true, limit: "20" });
    const [path, params] = hubGet.mock.calls[0] as [string, Record<string, unknown>];
    expect(path).toBe("/tracks");
    expect(params.projectId).toBeUndefined();
    expect(params.limit).toBe("20");
    expect(printed()).toContain("Grow");
    expect(printed()).toContain("synap track list --cursor c2");
  });

  it("a project in scope still lists that project's goals only", async () => {
    hubGet.mockResolvedValueOnce({ items: [] });
    const { listTracks } = await import("../src/commands/tracks.js");
    await listTracks({});
    expect((hubGet.mock.calls[0] as [string, Record<string, unknown>])[1].projectId).toBe("proj-lens");
    expect(printed()).toContain("This project has no goal yet.");
  });
});

describe("synap track start / update — what the goal holds (W2, W4)", () => {
  it("builds criteria from --criterion lines: kind prefix, slug keys, unique, method for learning", async () => {
    const { parseCriterion, goalContentBody } = await import("../src/commands/tracks.js");
    const taken = new Set<string>();
    expect(parseCriterion("measured: Ten readers pay", taken)).toEqual({
      key: "ten-readers-pay",
      statement: "Ten readers pay",
      // The pod refuses an evidence check with no key to post evidence under.
      check: { kind: "evidence", evidenceKey: "ten-readers-pay" },
      checkKind: "measured",
    });
    expect(parseCriterion("Ten readers pay", taken)).toMatchObject({
      key: "ten-readers-pay-2",
      check: { kind: "human" },
      checkKind: "judged",
    });
    expect(parseCriterion("learning: We know why churn happens", taken)).toMatchObject({
      checkKind: "learning",
      about: "method",
    });
    // a colon that does not follow a known kind stays in the statement
    expect(parseCriterion("Ship it: v1", new Set())).toMatchObject({ statement: "Ship it: v1" });
    expect(goalContentBody({ loop: "2" }).loop).toEqual({ on: true, perWeek: 2 });
    expect(goalContentBody({ loop: "off" }).loop).toBeNull();
    expect(() => goalContentBody({ loop: "sometimes" })).toThrow(/--loop/);
  });

  it("start sends the goal content typed on the line", async () => {
    hubPost.mockResolvedValueOnce({ status: "started", track: { id: "t-9", name: "Grow" } });
    const { startTrack } = await import("../src/commands/tracks.js");
    await startTrack({
      name: "Grow",
      endState: "Ten paying readers",
      criterion: ["measured: Ten readers pay", "judged: The tone feels right"],
      dropCondition: ["Under 50 readers after a year"],
      kind: "flow",
      uncertainty: "complex",
      loop: "on",
    });
    const [, body] = hubPost.mock.calls[0] as [string, Record<string, unknown>];
    expect(body).toMatchObject({
      endState: "Ten paying readers",
      dropConditions: ["Under 50 readers after a year"],
      workKind: "flow",
      uncertainty: "complex",
      loop: { on: true },
    });
    expect((body.criteria as Array<{ key: string }>).map((c) => c.key)).toEqual([
      "ten-readers-pay",
      "the-tone-feels-right",
    ]);
  });

  it("update PATCHes /tracks/:id/direction, prints a proposal as queued, and refuses an empty patch", async () => {
    hubPatch.mockResolvedValueOnce({ status: "proposed", proposalId: "prop-8" });
    const { updateTrack } = await import("../src/commands/tracks.js");
    await updateTrack("t-1", { kpiCurrent: "42", endState: "Done looks like this" });
    expect(hubPatch.mock.calls[0][0]).toBe("/tracks/t-1/direction");
    expect(hubPatch.mock.calls[0][1]).toEqual({
      endState: "Done looks like this",
      kpi: { current: 42 },
    });
    expect(printed()).toContain("queued for your review");

    hubPatch.mockClear();
    const exit = vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);
    await updateTrack("t-1", {});
    expect(hubPatch).not.toHaveBeenCalled();
    expect(exit).toHaveBeenCalledWith(1);
  });
});

describe("synap track show — the goal's derived reads (W2, W3, W5b)", () => {
  it("prints end state, criteria with marks, in review, waiting on and participants by name", async () => {
    hubGet.mockResolvedValueOnce({
      id: "t-1",
      name: "Grow",
      status: "active",
      currentStage: null,
      endState: "Ten paying readers",
      workKind: "flow",
      criteria: [{ key: "ten", statement: "Ten readers pay", mark: "claimed" }],
      inReview: true,
      waitingOn: [{ reason: "judge", count: 1 }],
      participants: [
        { role: "owner", displayName: "Ada", principalId: "u-1" },
        { role: "delegate", displayName: null, principalId: "a-1", commitment: "Draft", commitmentState: "accepted" },
      ],
    });
    const { showTrack } = await import("../src/commands/tracks.js");
    await showTrack("t-1", {});
    const text = printed();
    for (const piece of [
      "Ten paying readers",
      "Ten readers pay",
      "claimed",
      "In review",
      "Waiting on judge",
      "Owner: Ada",
      "name unknown",
      "Draft [Accepted]",
      "What done looks like: Ten paying readers",
      "Active",
      "Flow",
    ]) {
      expect(text).toContain(piece);
    }
    expect(text).not.toContain("a-1");
  });

  it("a closed goal reads in words — never `completed`, `not_met` or `reported_impossible`", async () => {
    hubGet.mockResolvedValueOnce({
      id: "t-2",
      name: "Launch",
      status: "completed",
      verdict: "not_met",
      currentStage: null,
      workKind: "operation",
      uncertainty: "complicated",
      criteria: [{ key: "up", statement: "Site is up", mark: "not_started" }],
      waitingOn: [{ reason: "another_work", count: 2 }],
      participants: [
        { role: "delegate", displayName: "Bo", principalId: "u-2", commitment: "Ship", commitmentState: "reported_impossible" },
      ],
    });
    const { showTrack } = await import("../src/commands/tracks.js");
    await showTrack("t-2", {});
    const text = printed();
    for (const piece of [
      "Closed — Not met",
      "Operation · Complicated",
      "(up, not started)",
      "Waiting on other work (2)",
      "Delegate: Bo — Ship [Reported impossible]",
    ]) {
      expect(text).toContain(piece);
    }
    for (const token of ["completed", "not_met", "not_started", "another_work", "reported_impossible"]) {
      expect(text, token).not.toContain(token);
    }
  });
});

describe("synap track accept / synap goal convert", () => {
  it("accept POSTs the judge's decision to the criterion's acceptance door", async () => {
    hubPost.mockResolvedValueOnce({ status: "updated", track: {} });
    const { acceptCriterion } = await import("../src/commands/tracks.js");
    await acceptCriterion("t-1", "ten", "changes_asked", { note: "add the date" });
    expect(hubPost.mock.calls[0]).toEqual([
      "/tracks/t-1/criteria/ten/acceptance",
      { decision: "changes_asked", note: "add the date" },
      expect.anything(),
    ]);
  });

  it("convert POSTs /tracks/convert and says what did not carry over", async () => {
    hubPost.mockResolvedValueOnce({
      status: "started",
      track: { id: "g-1", name: "Q3 revenue" },
      entityId: "e-1",
      notCarried: ["progress"],
    });
    const { convertToGoal } = await import("../src/commands/tracks.js");
    await convertToGoal("e-1", { name: "Q3 revenue" });
    expect(hubPost.mock.calls[0]).toEqual([
      "/tracks/convert",
      { entityId: "e-1", name: "Q3 revenue" },
      expect.anything(),
    ]);
    expect(printed()).toContain("Now a goal");
    expect(printed()).toContain("Not carried over: progress");
  });
});
