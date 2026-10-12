import { describe, expect, it } from "vitest";
import { titleFromTranscript } from "./superwhisper-import.js";

describe("titleFromTranscript", () => {
  it("uses a short first sentence whole", () => {
    expect(titleFromTranscript("Call the bank about the loan. Then the rest.")).toBe(
      "Call the bank about the loan."
    );
  });

  it("never cuts a long transcript — it names the note by its date", () => {
    const long =
      "Okay so I was thinking about how the capture flow should work when you come back from a meeting and want to dump everything at once";
    const t = titleFromTranscript(long, "2026-10-12 14:32");
    expect(t).toBe("Voice note — 2026-10-12 14:32");
    expect(t).not.toMatch(/…$/);
  });

  it("falls back to the recording id with no date, and on a too-short line", () => {
    expect(titleFromTranscript("Hm.", undefined, "rec42")).toBe("Voice note rec42");
    expect(titleFromTranscript("", "2026-10-12")).toBe("Voice note — 2026-10-12");
  });
});
