/**
 * `synap cell define --content-kind` / `--view-types` parsing + door parity.
 *
 * A cell defined with neither field installs cleanly and is then permanently
 * UNPICKABLE — `view_renderer_view_types` stays null (so it can never be chosen
 * as a view renderer, browser `useRegisterFrameCells`) and `content_kind` takes
 * the column default `widget` (so it is never offered for an entity-detail /
 * -card / -profile / collection slot). No error is raised anywhere, which is
 * why the CLI validates `--content-kind` locally: an unknown value would be
 * stripped silently by the define door's zod and produce exactly that outcome.
 *
 * `CONTENT_KINDS` is a hand-maintained copy of the `ContentKind` union in the
 * backend schema, so the last test pins it against that source.
 */
import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import {
  CONTENT_KINDS,
  parseContentKind,
  parseViewTypes,
} from "../src/commands/cell.js";

describe("parseContentKind", () => {
  it("accepts every value in the union", () => {
    for (const kind of CONTENT_KINDS) {
      expect(parseContentKind(kind)).toBe(kind);
    }
  });

  it("tolerates surrounding whitespace", () => {
    expect(parseContentKind("  collection ")).toBe("collection");
  });

  it("rejects anything outside the union rather than passing it through", () => {
    // The old `role` vocabulary that ContentKind REPLACED — a plausible typo
    // that must not reach the door, where zod would drop it without a word.
    expect(parseContentKind("detail")).toBeNull();
    expect(parseContentKind("Collection")).toBeNull();
    expect(parseContentKind("")).toBeNull();
  });
});

describe("parseViewTypes", () => {
  it("returns undefined when the flag is absent (omit-is-silence)", () => {
    // Omitting the field on an upsert leaves the stored affinity untouched.
    expect(parseViewTypes(undefined)).toBeUndefined();
  });

  it("splits, trims and dedupes a comma list", () => {
    expect(parseViewTypes(" table, kanban ,table,list")).toEqual([
      "table",
      "kanban",
      "list",
    ]);
  });

  it("turns an empty string into the explicit clear signal", () => {
    expect(parseViewTypes("")).toEqual([]);
    expect(parseViewTypes(" , ")).toEqual([]);
  });
});

const WIDGET_DEFINITIONS_SCHEMA = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../synap-backend/packages/database/src/schema/widget-definitions.ts"
);

describe("door parity: CONTENT_KINDS vs the ContentKind union", () => {
  it.skipIf(!existsSync(WIDGET_DEFINITIONS_SCHEMA))(
    "matches the backend schema's ContentKind union exactly",
    () => {
      const src = readFileSync(WIDGET_DEFINITIONS_SCHEMA, "utf-8");
      // Read the runtime CONST, not the type alias. The pod derived the union
      // FROM this array (`export type ContentKind = (typeof CONTENT_KINDS)[number]`)
      // precisely so the two can never disagree — which means the literals no
      // longer live in the type declaration at all, and a scanner pointed at
      // the alias finds zero of them. That is what happened: this test went RED
      // on its own non-vacuity guard rather than passing green over nothing,
      // which is the behaviour we want from a source scan whose target moved.
      const decl = /export const CONTENT_KINDS\s*=([\s\S]*?)\]\s*as const;/.exec(src);
      expect(
        decl,
        "CONTENT_KINDS const not found — did it move, get renamed, or stop being an `as const` array?"
      ).toBeTruthy();

      const podKinds = [...decl![1].matchAll(/"([a-z-]+)"/g)].map((m) => m[1]);
      expect(podKinds.length).toBeGreaterThan(0);
      expect([...podKinds].sort()).toEqual([...CONTENT_KINDS].sort());
    }
  );
});
