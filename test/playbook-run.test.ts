/**
 * `synap playbook run` — name resolution, typed params, and the honesty of the
 * outcome: a proposal is success (exit 0, review link), blocked/skipped and
 * every refusal are non-zero with nothing wrongly sent.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const hubPost = vi.fn();
const hubGet = vi.fn();
const renderHubError = vi.fn();

vi.mock("../src/lib/hub-client.js", () => ({
  hubPost,
  hubGet,
  renderHubError,
  resolveHubConfig: vi.fn(async () => ({ podUrl: "http://127.0.0.1:1", apiKey: "k" })),
}));

const PB = "11111111-1111-4111-8111-111111111111";
const PB2 = "22222222-2222-4222-8222-222222222222";
const SUBJ = "33333333-3333-4333-8333-333333333333";

let out: string[];
let exit: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  hubPost.mockReset();
  hubGet.mockReset();
  renderHubError.mockReset();
  out = [];
  const capture = (...a: unknown[]) => void out.push(a.map(String).join(" "));
  vi.spyOn(console, "log").mockImplementation(capture);
  vi.spyOn(console, "error").mockImplementation(capture);
  exit = vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);
});
afterEach(() => vi.restoreAllMocks());
const printed = () => out.join("\n");

const d2i = {
  id: PB,
  name: "Design to implementation",
  workspaceId: "ws-1",
  params: [
    { name: "design", type: "entity", required: true },
    { name: "budget", type: "number" },
    { name: "tier", type: "choice", options: ["a", "b"] },
    { name: "notes", type: "text" },
  ],
};

async function run(ref: string, opts: Record<string, unknown> = {}) {
  const { runPlaybook } = await import("../src/commands/playbook.js");
  await runPlaybook(ref, opts as never);
}

describe("synap playbook run", () => {
  it("resolves a name, types params, and sends them to the run door", async () => {
    hubGet.mockResolvedValueOnce({ playbooks: [d2i, { id: PB2, name: "Other" }], nextCursor: null });
    hubPost.mockResolvedValueOnce({ status: "running", session: { id: "s-1" } });
    await run("design to implementation", {
      subject: SUBJ,
      param: [`design=${SUBJ}`, "budget=1000", "notes=123"],
    });
    const [path, body] = hubPost.mock.calls[0] as [string, Record<string, unknown>];
    expect(path).toBe(`/playbooks/${PB}/run`);
    expect(body).toEqual({ subjectId: SUBJ, params: { design: SUBJ, budget: 1000, notes: "123" } });
    expect(printed()).toContain("Started");
    expect(exit).not.toHaveBeenCalled();
  });

  it("treats proposed as success: review link, no non-zero exit", async () => {
    hubGet.mockResolvedValueOnce({ playbooks: [d2i], nextCursor: null });
    hubPost.mockResolvedValueOnce({ status: "proposed", proposalId: "prop-9", reviewUrl: "https://pod/open/prop-9" });
    await run(d2i.name, { param: [`design=${SUBJ}`] });
    expect(printed()).toContain("queued for your review");
    expect(printed()).toContain("https://pod/open/prop-9");
    expect(printed()).toContain("synap open proposal prop-9");
    expect(exit).not.toHaveBeenCalled();
  });

  it("refuses an ambiguous name listing candidates, sending nothing", async () => {
    hubGet.mockResolvedValueOnce({ playbooks: [d2i, { ...d2i, id: PB2, workspaceId: "ws-2" }], nextCursor: null });
    await run(d2i.name);
    expect(hubPost).not.toHaveBeenCalled();
    expect(printed()).toContain(PB);
    expect(printed()).toContain(PB2);
    expect(exit).toHaveBeenCalledWith(1);
  });

  it("refuses an unknown name, sending nothing", async () => {
    hubGet.mockResolvedValueOnce({ playbooks: [d2i], nextCursor: null });
    await run("nope");
    expect(hubPost).not.toHaveBeenCalled();
    expect(printed()).toContain('No active playbook named "nope"');
    expect(exit).toHaveBeenCalledWith(1);
  });

  it("follows the list cursor before deciding a name is unknown", async () => {
    hubGet
      .mockResolvedValueOnce({ playbooks: [], nextCursor: "c2" })
      .mockResolvedValueOnce({ playbooks: [d2i], nextCursor: null });
    hubPost.mockResolvedValueOnce({ status: "running", session: { id: "s" } });
    await run(d2i.name);
    expect(hubGet).toHaveBeenCalledTimes(2);
    expect(hubPost).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["undeclared", ["bogus=1"], "declares no param"],
    ["bad number", ["budget=abc"], "is a number"],
    ["bad entity", ["design=not-a-uuid"], "is an entity"],
    ["bad choice", ["tier=z"], "must be one of"],
    ["not key=value", ["oops"], "not key=value"],
  ])("refuses a %s param before sending", async (_n, param, msg) => {
    hubGet.mockResolvedValueOnce({ playbooks: [d2i], nextCursor: null });
    await run(d2i.name, { param });
    expect(hubPost).not.toHaveBeenCalled();
    expect(printed()).toContain(msg);
    expect(exit).toHaveBeenCalledWith(1);
  });

  it("warns that a missing required param will be asked, and still runs", async () => {
    hubGet.mockResolvedValueOnce({ playbooks: [d2i], nextCursor: null });
    hubPost.mockResolvedValueOnce({ status: "running", session: { id: "s" } });
    await run(d2i.name);
    expect(printed()).toContain("Required param(s) not given: design");
    expect(hubPost).toHaveBeenCalledTimes(1);
  });

  it("an id skips the list and reads the playbook for its params", async () => {
    hubGet.mockResolvedValueOnce(d2i);
    hubPost.mockResolvedValueOnce({ status: "running", session: { id: "s" } });
    await run(PB, { param: ["budget=5"] });
    expect(hubGet.mock.calls[0]![0]).toBe(`/playbooks/${PB}`);
    expect((hubPost.mock.calls[0] as unknown[])[1]).toEqual({ params: { budget: 5 } });
  });

  it("blocked (nothing ran) exits non-zero with the pod's message", async () => {
    hubGet.mockResolvedValueOnce({ playbooks: [d2i], nextCursor: null });
    hubPost.mockResolvedValueOnce({ status: "blocked", message: "Nothing ran: skills not enabled" });
    await run(d2i.name);
    expect(printed()).toContain("Nothing ran: skills not enabled");
    expect(exit).toHaveBeenCalledWith(1);
  });

  it("a failed run call goes through renderHubError and exits non-zero (never swallowed)", async () => {
    hubGet.mockResolvedValueOnce({ playbooks: [d2i], nextCursor: null });
    const err = new Error("Forbidden (HTTP 403)");
    hubPost.mockRejectedValueOnce(err);
    await run(d2i.name);
    expect(renderHubError).toHaveBeenCalledWith(err);
    expect(exit).toHaveBeenCalledWith(1);
  });

  it("a failed list read is not folded into 'unknown playbook'", async () => {
    const err = new Error("boom (HTTP 500)");
    hubGet.mockRejectedValueOnce(err);
    await run(d2i.name);
    expect(renderHubError).toHaveBeenCalledWith(err);
    expect(printed()).not.toContain("No active playbook");
    expect(exit).toHaveBeenCalledWith(1);
  });

  it("refuses a non-uuid --subject before any call", async () => {
    await run(d2i.name, { subject: "abc" });
    expect(hubGet).not.toHaveBeenCalled();
    expect(exit).toHaveBeenCalledWith(1);
  });
});
