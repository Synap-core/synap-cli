/**
 * Typed capture (plan 527996fa, wave 0 item 0.9): `--type decision` files a
 * `decision` entity, and no typed capture writes the legacy `ek_type`.
 *
 * Rival rules this rules out: "a decision is a knowledge row tagged
 * ek_type=decision" (no decision reader sees it), and "ek_type is still the
 * discriminator" (the pod reads `knowledgeForm`; `ek_type` is kept only for
 * historic rows).
 */
import { describe, expect, it } from "vitest";
import { typedCaptureBody, type TypedCaptureInput } from "../src/commands/knowledge.js";

const NOW = new Date("2026-11-02T12:00:00.000Z");
const base: TypedCaptureInput = {
  type: "lesson",
  claim: "Pods reject a summary over 500 characters",
  why: "The seeded decision profile caps it",
  evidence: "ensure-system-profiles.ts",
  tags: ["pod", "schema"],
  title: "Summary cap",
  userId: "user-1",
  now: NOW,
};

describe("typed capture: a decision is a decision entity", () => {
  it("--type decision files the pod's decision kind, never knowledge", () => {
    const body = typedCaptureBody({ ...base, type: "decision", sessionId: "s-1", projectId: "p-1" });
    expect(body).toEqual({
      userId: "user-1",
      title: "Summary cap",
      sessionId: "s-1",
      projectId: "p-1",
      profileSlug: "decision",
      properties: {
        summary: "Pods reject a summary over 500 characters",
        decisionStatus: "accepted",
        decidedAt: "2026-11-02T12:00:00.000Z",
        rationale: "The seeded decision profile caps it\n\nEvidence: ensure-system-profiles.ts",
        tags: ["pod", "schema"],
      },
    });
  });

  it("a claim longer than the pod's summary keeps its whole text in the rationale", () => {
    const claim = "x".repeat(800);
    const body = typedCaptureBody({ ...base, type: "decision", claim, why: undefined, evidence: undefined });
    const props = body.properties as Record<string, string>;
    expect(props.summary).toHaveLength(500);
    expect(props.summary.endsWith("…")).toBe(true);
    expect(props.rationale).toBe(claim);
  });

  it("every other type files knowledge with knowledgeForm as its one discriminator", () => {
    for (const [type, form] of [
      ["gotcha", "caution"],
      ["lesson", "fact"],
      ["reference", "fact"],
    ] as const) {
      const body = typedCaptureBody({ ...base, type });
      expect(body.profileSlug).toBe("knowledge");
      expect(body.properties).toEqual({
        knowledgeForm: form,
        ek_claim: base.claim,
        ek_why: base.why,
        ek_evidence: base.evidence,
        ek_tags: base.tags,
      });
    }
  });

  it("no typed capture writes ek_type", () => {
    for (const type of ["gotcha", "lesson", "decision", "reference"]) {
      const body = typedCaptureBody({ ...base, type });
      expect(JSON.stringify(body)).not.toContain("ek_type");
    }
  });
});
