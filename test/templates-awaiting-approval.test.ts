/**
 * `synap templates` shows WHY a space's last update did not finish under the
 * space — the pod's ONE sentence (Hub `GET /workspaces` `applyWarning`,
 * synap-backend `templateApplyWarning`), printed verbatim, plus the proposals
 * it waits on, which the pod reads LIVE (a decided proposal is gone). Driven
 * from the wire row through the real mapper and the real classifier.
 */
import { describe, it, expect } from "vitest";
import { mapWorkspaceAttachments } from "../src/lib/installed.js";
import { classifyTemplateRow } from "../src/commands/market.js";

const P = "a99e1d4e-0000-4000-8000-000000000001";
const SENTENCE = `Waiting on your approval of 1 proposal (${P}), then run \`synap templates update crm\`.`;
const wire = (awaitingApproval: unknown, applyWarning: unknown) => ({
  id: "ws-1",
  name: "CRM",
  workspaceSubtype: "crm",
  packageSlug: "crm",
  packageVersion: null,
  latestVersion: "h-2",
  drifted: true,
  awaitingApproval,
  applyWarning,
});
const row = (awaitingApproval: unknown, applyWarning: unknown) =>
  classifyTemplateRow(
    mapWorkspaceAttachments([wire(awaitingApproval, applyWarning)])[0]!,
    undefined,
    []
  );

describe("synap templates — why a space is not finished", () => {
  it("shows the pod's sentence under the space and points at the proposal", () => {
    const r = row([P], SENTENCE);
    expect(r.group).toBe("attention");
    expect(r.applyNotice).toBe(SENTENCE);
    expect(r.action).toBe(`synap open proposal ${P}`);
  });

  it("partial / not run: the pod's sentence, the update as the next step", () => {
    const s = "Not finished: part of crm did not apply. Run `synap templates update crm` to retry.";
    const r = row([], s);
    expect(r.applyNotice).toBe(s);
    expect(r.status.kind).toBe("unfinished");
    expect(r.action).toBe("synap templates update crm");
  });

  it("once decided the pod sends no sentence: plain unfinished drift, never 'reattach'", () => {
    const r = row([], null);
    expect(r.applyNotice).toBeNull();
    expect(r.action).toBe("synap templates update crm");
  });

  it("an older pod that sends neither field shows no notice", () => {
    expect(row(undefined, undefined).applyNotice).toBeNull();
  });
});
