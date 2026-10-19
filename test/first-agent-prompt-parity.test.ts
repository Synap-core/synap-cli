import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { FIRST_AGENT_PROMPT, buildHandoff } from "../src/lib/init-handoff.js";

/**
 * `FIRST_AGENT_PROMPT` is a MIRROR: the one first prompt lives in synap-app
 * `onboarding-core/first-run.ts`, which this package cannot import. This reads
 * that source across the repo boundary and fails on any difference. It proves
 * sameness, not that the prompt is good. Skipped without the sibling repo.
 */
const SRC = join(
  process.cwd(),
  "../synap-app/packages/headless/src/onboarding-core/first-run.ts"
);

describe("FIRST_AGENT_PROMPT parity", () => {
  it.skipIf(!existsSync(SRC))("equals the synap-app source string", () => {
    const m = readFileSync(SRC, "utf8").match(
      /export const FIRST_AGENT_PROMPT\s*=\s*((?:"(?:[^"\\]|\\.)*"\s*\+?\s*)+);/
    );
    expect(m, "FIRST_AGENT_PROMPT not found in first-run.ts — renamed or moved?").not.toBeNull();
    const parts = [...m![1]!.matchAll(/"((?:[^"\\]|\\.)*)"/g)].map((x) => JSON.parse(`"${x[1]}"`));
    expect(FIRST_AGENT_PROMPT).toBe(parts.join(""));
  });

  it("init's hand-off prints exactly that prompt", () => {
    expect(buildHandoff(["Claude Code"]).prompt).toBe(FIRST_AGENT_PROMPT);
  });
});
