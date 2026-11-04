import { describe, expect, it } from "vitest";
import { formatDiff } from "./catalog.js";

type Row = Parameters<typeof formatDiff>[0][number];
const sp = (a?: string, b?: string) => ({
  before: a ? { version: a } : null,
  after: b ? { version: b } : null,
});
const row = (o: Partial<Row>) => ({ kind: "workspace", slug: "crm", warnings: [], columns: [], ...o }) as Row;

describe("catalog diff: one stamp rule, in people's words", () => {
  it("a changed row whose stamp moved says `published as`; unstamped is not `none`", () => {
    const out = formatDiff([
      row({ status: "changed", hashBefore: "a", hashAfter: "b", sourcePackage: sp("0.17.2", "0.17.4") }),
      row({ slug: "old", status: "changed", hashBefore: "a", hashAfter: "b", sourcePackage: sp(undefined, "0.17.4") }),
    ]);
    expect(out).toContain("~ published as: 0.17.2 → 0.17.4");
    expect(out).toContain("~ published as: unstamped → 0.17.4");
    expect(out).not.toMatch(/sourcePackage|none/);
  });

  it("an equal hash with a moved stamp says the stamp alone moved", () => {
    expect(
      formatDiff([row({ status: "changed", hashBefore: "h", hashAfter: "h", sourcePackage: sp("0.17.2", "0.17.4") })]),
    ).toContain("~ stamp only: 0.17.2 → 0.17.4 (content unchanged)");
  });

  it("a new or unchanged row prints no stamp line, whatever its stamps hold", () => {
    const out = formatDiff([
      row({ status: "new", hashAfter: "h", sourcePackage: sp(undefined, "0.17.4") }),
      row({ slug: "same", status: "unchanged", hashBefore: "h", hashAfter: "h", sourcePackage: sp("0.17.2", "0.17.4") }),
    ]);
    expect(out).not.toMatch(/published as|stamp only|sourcePackage/);
  });
});
