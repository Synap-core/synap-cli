import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

/**
 * `resolveSessionTitle` in `src/commands/sessions.ts` mirrors the platform's
 * ONE title resolver (`synap-backend/packages/types/src/focus-sessions/
 * title.ts`) — this package cannot import that file (see the doc comment on
 * `SESSION_KIND_LABELS` in `sessions.ts`).
 *
 * A COPIED algorithm pinned by hand-written expectations only catches drift by
 * luck: the fixtures shared with the registry's `title.test.ts` all sit on the
 * same side of the clip rule's one real decision — `lastSpace >= max / 2`,
 * back off to a word boundary, else cut mid-word. So this file does two things
 * the fixtures alone cannot:
 *   - it reads the REGISTRY's own source across the repo boundary and fails if
 *     the two clip bodies have diverged (the `verdict-label-vocabulary-parity`
 *     shape);
 *   - it carries the pair of inputs on WHICH the rules disagree — a late space
 *     that is backed off to, and an early one that is not.
 */
import { resolveSessionTitle } from "../src/commands/sessions.js";

const REGISTRY = join(
  process.cwd(),
  "../synap-backend/packages/types/src/focus-sessions/title.ts",
);
const CLI_SRC = join(process.cwd(), "src/commands/sessions.ts");

/** A function body, comments and whitespace normalized away. */
function body(src: string, name: string): string | null {
  const start = src.indexOf(`function ${name}(`);
  if (start < 0) return null;
  const open = src.indexOf("{", start);
  let depth = 0;
  for (let i = open; i < src.length; i += 1) {
    if (src[i] === "{") depth += 1;
    else if (src[i] === "}") {
      depth -= 1;
      if (depth === 0) {
        return src
          .slice(open + 1, i)
          .replace(/\/\/[^\n]*/g, " ")
          .replace(/\s+/g, " ")
          .trim();
      }
    }
  }
  return null;
}

describe("CLI resolveSessionTitle parity with the registry's own fixtures", () => {
  it("prefers the title over the goal", () => {
    expect(resolveSessionTitle({ title: "Billing launch", goal: "Ship billing" })).toBe(
      "Billing launch",
    );
  });

  it("trims and one-lines the title", () => {
    expect(resolveSessionTitle({ title: "  Billing\n launch ", goal: "x" })).toBe(
      "Billing launch",
    );
  });

  it("falls back to the goal's first non-empty line when the title is blank", () => {
    expect(
      resolveSessionTitle({
        title: "   ",
        goal: "\n  Ship billing  \nThen invoice everyone",
      }),
    ).toBe("Ship billing");
    expect(resolveSessionTitle({ title: null, goal: "Ship billing" })).toBe("Ship billing");
    expect(resolveSessionTitle({ goal: "Ship billing" })).toBe("Ship billing");
  });

  it("clips a paragraph goal at a word boundary with an ellipsis", () => {
    const goal =
      "Research the best web scraping approaches for social media platforms, then compare vendors and write a recommendation memo";
    const out = resolveSessionTitle({ goal });
    expect(out.length).toBeLessThanOrEqual(80);
    expect(out.endsWith("…")).toBe(true);
    const body = out.slice(0, -1);
    expect(goal.startsWith(body)).toBe(true);
    expect(goal[body.length]).toMatch(/[\s,]/);
  });

  it("does not clip the user's own title", () => {
    const title = "A".repeat(150);
    expect(resolveSessionTitle({ title, goal: "x" })).toBe(title);
  });

  it("honours a custom maxLength and cuts a single long word mid-word", () => {
    expect(resolveSessionTitle({ goal: "Supercalifragilistic" }, { maxLength: 8 })).toBe(
      "Superca…",
    );
  });

  // ── The clip rule's one decision: `lastSpace >= floor(max / 2)` ──────────
  // These two rule OUT "always back off to the last space" and "always cut at
  // the budget": each is right on one row and wrong on the other.
  it("backs off to a word boundary when the space keeps most of the budget", () => {
    // cut = "Ship the billing la", lastSpace 16 >= floor(20/2) ⇒ back off.
    expect(
      resolveSessionTitle({ goal: "Ship the billing launch now" }, { maxLength: 20 }),
    ).toBe("Ship the billing…");
  });

  it("cuts mid-word when backing off would throw away most of the budget", () => {
    // cut = "Hi Supercalifragili", lastSpace 2 < floor(20/2) ⇒ keep the cut.
    expect(
      resolveSessionTitle(
        { goal: "Hi Supercalifragilisticexpialidocious" },
        { maxLength: 20 },
      ),
    ).toBe("Hi Supercalifragili…");
  });

  it("returns an empty string only when both are empty", () => {
    expect(resolveSessionTitle({ title: "", goal: "" })).toBe("");
    expect(resolveSessionTitle({})).toBe("");
  });
});

describe("the CLI's clip rule has not drifted from the registry's", () => {
  const hasRegistry = existsSync(REGISTRY);

  it.runIf(hasRegistry)("clipAtWordBoundary is byte-for-byte the registry's clip", () => {
    const registryClip = body(readFileSync(REGISTRY, "utf8"), "clip");
    const cliClip = body(readFileSync(CLI_SRC, "utf8"), "clipAtWordBoundary");
    // Non-vacuity: both bodies parsed, and both still contain the decision.
    expect(registryClip, "registry `clip` not found").toBeTruthy();
    expect(cliClip, "CLI `clipAtWordBoundary` not found").toBeTruthy();
    expect(registryClip).toContain("Math.floor(max / 2)");
    expect(cliClip).toEqual(registryClip);
  });
});
