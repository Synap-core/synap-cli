import { describe, expect, it } from "vitest";
import { knowledgeTitleFromClaim } from "./knowledge-title.js";

describe("knowledgeTitleFromClaim", () => {
  it("keeps a short claim whole", () => {
    expect(knowledgeTitleFromClaim("Yjs was inert.")).toBe("Yjs was inert.");
  });
  it("takes the first sentence of a multi-sentence claim", () => {
    expect(
      knowledgeTitleFromClaim("Session start does not inherit the project lens. The workspace was inherited.")
    ).toBe("Session start does not inherit the project lens.");
  });
  it("clips a long first sentence at a word boundary with an ellipsis", () => {
    const t = knowledgeTitleFromClaim(
      "synap session start does NOT inherit the active PROJECT lens with synap lens showing Project d4b84ad8 from the config file and more"
    );
    expect(t.length).toBeLessThanOrEqual(81);
    expect(t.endsWith("…")).toBe(true);
    expect(t).not.toMatch(/\s…$/);
  });
  it("never returns an empty title", () => {
    expect(knowledgeTitleFromClaim("   ")).toBe("Untitled knowledge");
  });
});
