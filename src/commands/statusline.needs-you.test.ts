import { describe, it, expect } from "vitest";
import { parseNeedsYouCount } from "./statusline.js";

describe("parseNeedsYouCount", () => {
  it("ok: the rule's headline number, with its floor flag", () => {
    expect(parseNeedsYouCount({ count: { needsYou: 3, truncated: true }, rows: {} })).toEqual({ count: 3, truncated: true });
  });
  it("empty: a measured zero is 0, not unknown", () => {
    expect(parseNeedsYouCount({ count: { needsYou: 0, truncated: false } })).toEqual({ count: 0, truncated: false });
  });
  it("failed: a malformed body is null (unknown), never 0", () => {
    expect(parseNeedsYouCount(null)).toBeNull();
    expect(parseNeedsYouCount({})).toBeNull();
    expect(parseNeedsYouCount({ count: { needsYou: "3" } })).toBeNull();
    expect(parseNeedsYouCount({ proposals: [] })).toBeNull();
  });
});
