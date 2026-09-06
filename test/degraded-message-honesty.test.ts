import { describe, it, expect } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

import {
  describeDegradedReason,
  degradedMessage,
} from "../src/lib/capture-structure.js";

/**
 * THE INCIDENT (live dogfood, deployed pod): `synap import /tmp/zzimg.png` on a
 * pod with no vision provider printed
 *
 *   "AI structuring unavailable (is_empty_result) — nothing was created.
 *    Retry when it's back."
 *
 * Three separate lies in one line: nothing was "unavailable", `is_empty_result`
 * is a raw machine token shown to a human, and there is nothing to come "back"
 * — an unconfigured vision provider is a permanent configuration state, so the
 * user was told to retry forever.
 */

/** The eleven honest reasons the Intelligence Service emits. */
const IS_REASONS = [
  "pdf_scanned_needs_ocr",
  "pdf_missing_binary",
  "vision_provider_not_configured",
  "image_missing_binary",
  "transcription_provider_not_configured",
  "audio_missing_binary",
  "docx_missing_binary",
  "docx_empty",
  "html_empty",
  "unsupported_type",
] as const;

const POD_REASONS = ["is_auth_error", "is_invalid_response", "is_empty_result"] as const;

const ALL_REASONS = [...IS_REASONS, ...POD_REASONS];

/** Reasons that describe a state which will NOT change on its own. */
const PERMANENT_STATES = [
  "vision_provider_not_configured",
  "transcription_provider_not_configured",
  "pdf_scanned_needs_ocr",
  "unsupported_type",
  "docx_empty",
  "html_empty",
] as const;

describe("degraded copy: never leak a token, never lie about retrying", () => {
  it.each(ALL_REASONS)("never prints the raw token %s at the user", (reason) => {
    const msg = degradedMessage({ degraded: true, degradedReason: reason });
    expect(msg).not.toContain(reason);
    // Nor any other snake_case machine token.
    expect(msg).not.toMatch(/\b[a-z]+(?:_[a-z]+){2,}\b/);
  });

  it.each(ALL_REASONS)("says WHAT happened and WHAT TO DO for %s", (reason) => {
    const { title, detail } = describeDegradedReason(reason);
    expect(title.length).toBeGreaterThan(10);
    expect(detail.length).toBeGreaterThan(20);
    // "what to do" = an imperative or a named surface, not a shrug.
    expect(detail).toMatch(
      /Configure|Check|Re-run|OCR|Keep|Save|Run |synap |Settings/
    );
  });

  it.each(PERMANENT_STATES)(
    "does NOT tell the user to retry %s — that state never changes",
    (reason) => {
      const msg = degradedMessage({ degraded: true, degradedReason: reason });
      expect(msg).not.toMatch(/retry|try again|when it'?s back|come back/i);
    }
  );

  it("still offers a retry for a genuinely transient pod failure", () => {
    // `is_invalid_response` IS an outage — retrying is the right advice there,
    // and flattening every reason into "don't retry" would be the mirror error.
    const msg = degradedMessage({
      degraded: true,
      degradedReason: "is_invalid_response",
    });
    expect(msg).toMatch(/back/i);
  });

  it("always states that nothing was created (the CLI materializes no fallback)", () => {
    for (const reason of [...ALL_REASONS, undefined]) {
      expect(
        degradedMessage({ degraded: true, degradedReason: reason })
      ).toContain("nothing was created");
    }
  });

  it("humanizes an unknown future reason instead of leaking or crashing", () => {
    const msg = degradedMessage({
      degraded: true,
      degradedReason: "ocr_budget_exhausted",
    });
    expect(msg).not.toContain("ocr_budget_exhausted");
    expect(msg).not.toContain("undefined");
    expect(msg.length).toBeGreaterThan(20);
  });

  it("handles a missing reason without inventing a cause", () => {
    const msg = degradedMessage({ degraded: true });
    expect(msg).not.toContain("undefined");
    expect(msg).toContain("nothing was created");
  });
});

/**
 * CROSS-REPO PARITY — the CLI copy must not drift from the app's one-door.
 *
 * `@synap-core/capture-pipeline`'s `describeDegradedReason` is the canonical
 * table, but the CLI is a separate pnpm workspace and cannot import from
 * `synap-app` without a package.json change. So the `title` half is copied
 * verbatim and pinned here by reading the sibling repo's source directly.
 *
 * The `detail` half is intentionally NOT compared: the app's details end in
 * "saved as a note in the meantime" and the CLI creates nothing at all.
 *
 * Skips (does not fail) when the sibling repo is absent — the CLI is published
 * standalone and this must not turn into a red gate in a CLI-only checkout.
 */
const APP_TYPES = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../synap-app/packages/core/capture-pipeline/src/types.ts"
);

describe.skipIf(!existsSync(APP_TYPES))(
  "parity with @synap-core/capture-pipeline describeDegradedReason",
  () => {
    const source = readFileSync(APP_TYPES, "utf8");

    /** Titles keyed by reason, parsed out of the app's own switch statement. */
    const appTitles = (): Record<string, string> => {
      const fn = source.slice(
        source.indexOf("export function describeDegradedReason")
      );
      // Start at the SWITCH, not the function header: the header's own return
      // type annotation (`): {\n title: string;\n detail: string;\n}`) closes
      // with a column-0 brace and truncated the body to 121 chars.
      const body = fn.slice(fn.indexOf("switch (reason)"));
      const out: Record<string, string> = {};
      // `case "x":` … possibly several … then `title: "…"`.
      const blocks = body.split(/\n\s*case /).slice(1);
      for (const block of blocks) {
        const reasons = [
          block.match(/^"([a-z_]+)"/)?.[1],
          ...Array.from(block.matchAll(/^\s*"([a-z_]+)":$/gm)).map((m) => m[1]),
        ].filter((r): r is string => Boolean(r));
        const title = block.match(/title:\s*"([^"]+)"/)?.[1];
        if (!title) continue;
        for (const r of reasons) out[r] = title;
      }
      return out;
    };

    const titles = appTitles();

    it("parsed the app's table (guards against a silently empty comparison)", () => {
      // A parity test that compares nothing passes forever. Pin the count.
      expect(Object.keys(titles).length).toBeGreaterThanOrEqual(
        IS_REASONS.length
      );
      expect(titles.vision_provider_not_configured).toBeTruthy();
    });

    it.each(ALL_REASONS)("uses the app's exact title for %s", (reason) => {
      if (!titles[reason]) return; // reason the app hasn't been taught
      expect(describeDegradedReason(reason).title).toBe(titles[reason]);
    });

    it("knows every reason the app knows", () => {
      const unknown = Object.keys(titles).filter(
        (r) => describeDegradedReason(r).title !== titles[r]
      );
      expect(unknown).toEqual([]);
    });
  }
);
