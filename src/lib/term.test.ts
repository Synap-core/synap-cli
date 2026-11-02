import fs from "node:fs";
import { describe, it, expect } from "vitest";
import { osc8, safeText, scrubStrings } from "./term.js";

describe("safeText: what a pod string may put on the terminal", () => {
  it("drops ESC, BEL and the rest of C0, DEL and C1, so no sequence can start", () => {
    expect(safeText("a\x1b[31mb\x07c\x00d\x7fe\x9b2Jf\x9dg")).toBe("a[31mbcde2Jfg");
  });
  it("drops the bidi overrides and isolates", () => {
    expect(safeText("ab\u202ecd\u2066ef\u2069\u200f")).toBe("abcdef");
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

describe("the bidi scrubber's source", () => {
  // Trojan Source: a raw bidi control inside a source file reorders what a reviewer reads.
  const BIDI = [0x200e, 0x200f, 0x202a, 0x202b, 0x202c, 0x202d, 0x202e, 0x2066, 0x2067, 0x2068, 0x2069];

  it("holds no raw bidi control character in term.ts or in this test", () => {
    for (const f of ["./term.ts", "./term.test.ts"]) {
      const src = fs.readFileSync(new URL(f, import.meta.url), "utf-8");
      const raw = [...src].filter((c) => BIDI.includes(c.codePointAt(0)!));
      expect(raw, f).toEqual([]);
    }
  });

  it("still removes each one", () => {
    for (const cp of BIDI) expect(safeText(`a${String.fromCodePoint(cp)}b`)).toBe("ab");
  });
});
