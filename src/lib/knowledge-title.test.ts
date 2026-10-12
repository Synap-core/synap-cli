import { describe, expect, it } from "vitest";
import { TITLE_HARD_MAX, chooseKnowledgeTitle } from "./knowledge-title.js";

describe("chooseKnowledgeTitle", () => {
  it("keeps a short claim whole", () => {
    expect(chooseKnowledgeTitle("Yjs was inert.")).toEqual({ ok: true, title: "Yjs was inert." });
  });

  it("takes the first sentence of a multi-sentence claim", () => {
    expect(
      chooseKnowledgeTitle("Session start does not inherit the project lens. The workspace was inherited.")
    ).toEqual({ ok: true, title: "Session start does not inherit the project lens." });
  });

  it("never cuts a long first sentence: it is sent whole for the pod to flag", () => {
    const claim =
      "synap session start does not inherit the active project lens even though synap lens shows the project from the config file and more";
    expect(claim.length).toBeGreaterThan(80);
    const out = chooseKnowledgeTitle(claim);
    expect(out).toEqual({ ok: true, title: claim });
  });

  it("refuses a first sentence over the hard cap and names --title", () => {
    const out = chooseKnowledgeTitle(`${"word ".repeat(50)}end.`);
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.reason).toMatch(/limit 200.*--title/);
  });

  it("lets an explicit --title win, collapsed to one line", () => {
    expect(chooseKnowledgeTitle("A long claim about grants.", "  Grants deny\n by default ")).toEqual({
      ok: true,
      title: "Grants deny by default",
    });
  });

  it("refuses an empty or over-cap --title, and an empty claim", () => {
    expect(chooseKnowledgeTitle("claim", "   ").ok).toBe(false);
    expect(chooseKnowledgeTitle("claim", "x".repeat(TITLE_HARD_MAX + 1)).ok).toBe(false);
    expect(chooseKnowledgeTitle("   ").ok).toBe(false);
  });
});
