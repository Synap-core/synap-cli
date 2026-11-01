import { describe, it, expect } from "vitest";
import { osc8, safeText, scrubStrings } from "./term.js";

describe("safeText: what a pod string may put on the terminal", () => {
  it("drops ESC, BEL and the rest of C0, DEL and C1, so no sequence can start", () => {
    expect(safeText("a\x1b[31mb\x07c\x00d\x7fe\x9b2Jf\x9dg")).toBe("a[31mbcde2Jfg");
  });
  it("drops the bidi overrides and isolates", () => {
    expect(safeText("ab‮cd⁦ef⁩‏")).toBe("abcdef");
  });
  it("turns line breaks and tabs into one space, and keeps ordinary text whole", () => {
    expect(safeText("one\r\n\ttwo")).toBe("one two");
    expect(safeText("Café · ⏳ 3 — «ok» 日本")).toBe("Café · ⏳ 3 — «ok» 日本");
  });
});

describe("scrubStrings", () => {
  it("scrubs every string at any depth and keeps the shape and the other values", () => {
    expect(scrubStrings({ a: "x\x1b", b: [1, "y\x07", null, { c: "z\x9b" }], d: true })).toEqual({ a: "x", b: [1, "y", null, { c: "z" }], d: true });
  });
});

describe("osc8", () => {
  it("wraps a link, scrubbing both its URL and its text", () => {
    expect(osc8("https://a.test/\x1b\\x", "n\x1b]8;;https://evil\x1b\\")).toBe("\x1b]8;;https://a.test/\\x\x1b\\n]8;;https://evil\\\x1b]8;;\x1b\\");
  });
  it("is plain text with no URL", () => {
    expect(osc8("", "name\x07")).toBe("name");
    expect(osc8(null, "name")).toBe("name");
  });
});
