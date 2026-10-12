/**
 * `synap templates` shows a space whose update waits on the person's approval —
 * with the proposal ids — from the pod's LIVE `awaitingApproval` (Hub
 * `GET /workspaces`; the pod drops a proposal once it is approved or rejected).
 * Driven from the wire row through the real mapper and the real classifier.
 */
import { describe, it, expect } from "vitest";
import { mapWorkspaceAttachments } from "../src/lib/installed.js";
import { classifyTemplateRow } from "../src/commands/market.js";

const P = "a99e1d4e-0000-4000-8000-000000000001";
const wire = (awaitingApproval: unknown) => ({
  id: "ws-1",
  name: "CRM",
  workspaceSubtype: "crm",
  packageSlug: "crm",
  packageVersion: null,
  latestVersion: "h-2",
  drifted: true,
  awaitingApproval,
});
const row = (awaitingApproval: unknown) =>
  classifyTemplateRow(mapWorkspaceAttachments([wire(awaitingApproval)])[0]!, undefined, []);

describe("synap templates — a space waiting on approval", () => {
  it("names the proposals and points at them", () => {
    const r = row([P]);
    expect(r.group).toBe("attention");
    expect(r.awaitingNotice).toBe(
      `Waiting on your approval of 1 proposal (${P}), then run synap templates update crm`
    );
    expect(r.action).toBe(`synap open proposal ${P}`);
  });

  it("once decided (the pod sends []), it is plain unfinished drift — update, never reattach", () => {
    const r = row([]);
    expect(r.awaitingNotice).toBeNull();
    expect(r.status.kind).toBe("unfinished");
    expect(r.action).toBe("synap templates update crm");
  });

  it("an older pod that sends no field shows no notice", () => {
    expect(row(undefined).awaitingNotice).toBeNull();
  });
});
