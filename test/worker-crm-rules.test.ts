/**
 * The CRM worker's three rules, ported from `feat/worker-non-code-sessions`
 * (its task protocol, never merged) into the work-folder protocol, plus its
 * recorded `task` runs, which resume as work-folder runs in the folder they
 * ran in (founder, session 2df5c6fe, card crm-worker-cli: "Port first, then
 * move"). The rules came from the Month'Immo e2e of 27 Oct.
 */
import { describe, expect, it } from "vitest";
import { buildWorkFolderPrompt, upgradeLegacyRuns, type WorkerState } from "../src/commands/worker.js";

const sid = "8c34a72b-b1c1-4c37-9c1f-02920b69ccb2";
const p = buildWorkFolderPrompt({ sessionId: sid, goal: "Draft the first message", agentName: "crm", workDir: `/w/${sid}`, mcpServer: "synap-worker" });

describe("the work-folder prompt carries the CRM worker's rules", () => {
  it("reads a process's fields on the subject's roles, and the pod's research wins over a search", () => {
    expect(p).toContain("The fields a process reads often live on the subject's ROLES, not on the entity itself");
    expect(p).toContain("icpScore, buyingSignal, buyingSignalSource, qualificationNotes, nextAction are on its lead facet");
    expect(p).toContain("The pod's own research on the subject wins over a search of yours");
  });

  it("creates the records a process asks for with exact fields, never through free-text capture", () => {
    expect(p).toContain("Never synap_capture a record the process asks you to create or change");
    expect(p).toContain("the exact property keys the goal names (e.g. messageContent)");
  });

  it("creates in the session's space and keeps identity fields on their own entity", () => {
    expect(p).toContain("pass workspaceId = the session's workspaceId on every create");
    expect(p).toContain("never put a company's website, domain or email on a person");
  });
});

describe("runs recorded under the old task protocol", () => {
  const state = (): WorkerState => ({
    runs: {
      a: { sessionId: "a", status: "done", startedAt: "t", protocol: "task" as never },
      b: { sessionId: "b", status: "done", startedAt: "t", protocol: "task" as never, workDir: "/kept" },
      c: { sessionId: "c", status: "done", startedAt: "t", protocol: "code" },
      d: { sessionId: "d", status: "done", startedAt: "t" },
      e: { sessionId: "e", status: "done", startedAt: "t", protocol: "work-folder", workDir: "/w/e" },
    },
  });

  it("resume as work-folder runs in the folder they ran in (the worker's --cwd)", () => {
    const s = state();
    expect(upgradeLegacyRuns(s, "/home/x/wt/crm-worker")).toBe(2);
    expect(s.runs.a).toMatchObject({ protocol: "work-folder", workDir: "/home/x/wt/crm-worker" });
    expect(s.runs.b).toMatchObject({ protocol: "work-folder", workDir: "/kept" });
  });

  it("leave every other run as it was", () => {
    const s = state();
    upgradeLegacyRuns(s, "/cwd");
    expect(s.runs.c).toEqual(state().runs.c);
    expect(s.runs.d).toEqual(state().runs.d);
    expect(s.runs.e).toEqual(state().runs.e);
    expect(upgradeLegacyRuns(s, "/cwd")).toBe(0);
  });
});
