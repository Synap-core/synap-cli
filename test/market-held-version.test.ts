/**
 * The pod holds a template's version until every layer landed (synap-backend
 * `finishTemplateApply`, `templateApply` on the `/packages/apply` response).
 * The CLI must print the pod's sentence for it (one wording, served by the pod), must not read the held version as an
 * old pod that cannot stamp, and must list the space as "not finished" (with
 * the one command that finishes it) rather than "version unknown".
 */
import { describe, it, expect } from "vitest";
import {
  classifyApplyResult,
  heldVersionLine,
  installedStatusLabel,
  type UpdateCheck,
} from "../src/commands/market.js";

const ENTRY = { slug: "crm", name: "CRM" } as Parameters<typeof classifyApplyResult>[0];
// eslint-disable-next-line no-control-regex
const plain = (s: string) => s.replace(/\u001b\[[0-9;]*m/g, "");

describe("held template version", () => {
  it("prints the POD's sentence verbatim — the CLI never words it", () => {
    const sentence =
      "Waiting on your approval of 1 proposal (p-1), then run `synap templates update crm`.";
    expect(
      heldVersionLine({
        templateApply: { state: "awaiting-approval", proposals: ["p-1"] },
        templateApplyWarning: sentence,
      })
    ).toBe(sentence);
    // The record alone (an older pod that sends no sentence) is not re-worded.
    expect(heldVersionLine({ templateApply: { state: "partial" } })).toBeNull();
    expect(heldVersionLine({})).toBeNull();
  });

  it("a version the pod HELD is not a stamp contradiction", () => {
    const ws = { status: "created", workspaceId: "w", outcome: "created" as const };
    const ctx = { remoteVersionSent: "h-1", wasUnstamped: false, stampVerified: false };
    expect(classifyApplyResult(ENTRY, ws, undefined, undefined, ctx).status).toBe(
      "stamp-contradiction"
    );
    expect(
      classifyApplyResult(ENTRY, ws, undefined, undefined, { ...ctx, stampHeld: true }).status
    ).toBe("installed");
  });

  it("an unstamped space the pod reads drifted is 'not finished', not 'version unknown'", () => {
    const c = {
      slug: "crm",
      installedVersion: "",
      updateAvailable: true,
      noVersionInfo: true,
    } as UpdateCheck;
    expect(plain(installedStatusLabel(c, false, true))).toBe(
      "not finished — run synap templates update crm"
    );
    expect(plain(installedStatusLabel({ ...c, updateAvailable: false }, false, true))).toContain(
      "version unknown"
    );
  });
});
