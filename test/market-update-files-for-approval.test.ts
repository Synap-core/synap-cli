/**
 * `synap market update --yes` with a computer's key: a workspace package
 * update the key may not apply on its own is FILED for the person's approval
 * (founder, 2026-11-02; synap-backend `proposeBeyondGrant`). The pod answers
 * `{status: "proposed", proposalIds}`; the CLI says it waits for
 * the person, gives the approval link, and counts it apart, never as failed.
 * An older pod still refuses with a 403: that stays a refusal with the
 * person's door (test/hub-error-limited-key-hint.test.ts).
 *
 * Driven through the REAL `applyUpdateThroughDoor` (the one update door,
 * `POST /package-updates/{slug}/apply`) and `hubPost` (a stubbed fetch is the
 * pod); what is asserted is the returned outcome and what the person reads.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { applyUpdateThroughDoor, approvalLink, summarizeApplyResults } from "../src/commands/market.js";
import type { HubConfig } from "../src/lib/hub-client.js";

const POD = "https://pod.antoinesrvt.synap.live";
const ADMIN = "https://pod-admin.antoinesrvt.synap.live";
const PROPOSAL = "0f6c8f8e-2f57-4b8e-9d2b-2f5f0d1f6a11";
const cfg: HubConfig = { podUrl: POD, apiKey: "computer-key", userId: "cli" };

const check = { slug: "brand-library", kind: "workspace" as const, latestVersion: "h-336546" };

function podAnswers(status: number, body: unknown): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(
      async () =>
        new Response(JSON.stringify(body), {
          status,
          headers: { "content-type": "application/json" },
        })
    )
  );
}

function capture(): string[] {
  const lines: string[] = [];
  for (const m of ["log", "error", "warn", "info"] as const)
    vi.spyOn(console, m).mockImplementation((...a: unknown[]) => void lines.push(a.map(String).join(" ")));
  return lines;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("an update the key may not apply is filed for the person's approval", () => {
  it("a proposed answer is waiting, with the pod-admin approval link — never failed", async () => {
    podAnswers(200, { status: "proposed", proposalIds: [PROPOSAL] });
    const out = capture();
    const r = await applyUpdateThroughDoor(check, cfg, { json: false }, 5_000);
    expect(r).toMatchObject({
      slug: "brand-library",
      status: "proposed",
      proposalId: PROPOSAL,
      reviewUrl: `${ADMIN}/proposal/${PROPOSAL}`,
    });
    expect(r.error).toBeUndefined();
    const said = out.join("\n");
    expect(said).toContain("filed for your approval");
    expect(said).toContain(`${ADMIN}/proposal/${PROPOSAL}`);
    expect(said).not.toMatch(/update failed/);
  });

  it("the summary counts it as waiting for approval, apart from failures", () => {
    const s = summarizeApplyResults([
      { slug: "brand-library", status: "proposed" },
      { slug: "operations", status: "proposed" },
      { slug: "crm", status: "unchanged" },
    ]);
    expect(s.proposed).toBe(2);
    expect(s.failed).toBe(0);
    expect(s.line).toContain("2 waiting for your approval");
    expect(s.line).not.toContain("failed");
    expect(s.line).toContain("→");
  });

  it("a grant refusal (403, no reasonCode) is still a refusal (failed), never counted as waiting", async () => {
    podAnswers(403, { error: `This key's grant does not allow "workspace.update".` });
    capture();
    const r = await applyUpdateThroughDoor(check, cfg, { json: false }, 5_000);
    expect(r.status).toBe("failed");
    expect(summarizeApplyResults([r]).proposed).toBe(0);
  });
});

describe("approvalLink", () => {
  it("is pod admin's proposal page when the pod-admin origin derives from the pod's", () => {
    expect(approvalLink(POD, PROPOSAL, `${POD}/open/${PROPOSAL}`)).toBe(`${ADMIN}/proposal/${PROPOSAL}`);
  });

  it("falls back to the pod's link, then to nothing, when no pod-admin origin derives", () => {
    // An unreadable pod URL derives no pod-admin origin.
    expect(approvalLink("not a url", PROPOSAL, `${POD}/open/${PROPOSAL}`)).toBe(`${POD}/open/${PROPOSAL}`);
    expect(approvalLink("not a url", PROPOSAL, undefined)).toBeUndefined();
    expect(approvalLink(POD, undefined, undefined)).toBeUndefined();
  });
});
