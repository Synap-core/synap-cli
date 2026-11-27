/**
 * The skill snapshots tracked in this repo (`skills/<pkg>/SKILL.md`, a mirror
 * of synap-backend's generated SKILL.md; `npm run sync-skills` refreshes the
 * whole folder before a publish) never teach a retired door (surfaces review,
 * 27 Nov 2026, architecture S8):
 *
 *   - `synap_list_widgets` is the old name of `synap_list_cells` (backend#1310);
 *   - `POST /api/hub/cell-instances/html` "embed it by instanceId" is the old
 *     shape of an HTML page: since backend#1357 a page is written once with
 *     `synap_create_document` type html and a cell only places it.
 *
 * Scanned set derived from disk: every tracked `skills/** /SKILL.md` present.
 * Does NOT check that a snapshot equals backend's source (the sibling is not
 * in CI), only that it does not name these retired doors.
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const SKILLS = join(dirname(fileURLToPath(import.meta.url)), "..", "skills");
const RETIRED = [/\bsynap_list_widgets\b/, /cell-instances\/html`?\)? and embed it by `?instanceId/];

const files = existsSync(SKILLS)
  ? readdirSync(SKILLS, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => join(SKILLS, e.name, "SKILL.md"))
      .filter((f) => existsSync(f))
  : [];

describe("tracked skill snapshots teach no retired door", () => {
  it("finds the tracked snapshots (non-vacuous)", () => {
    expect(files.length).toBeGreaterThanOrEqual(2);
    expect(files.some((f) => readFileSync(f, "utf8").includes("synap_list_cells"))).toBe(true);
  });

  it("no snapshot names synap_list_widgets or the cell-instances/html embed shape", () => {
    const hits: string[] = [];
    for (const f of files) {
      const text = readFileSync(f, "utf8").replace(/\s+/g, " ");
      for (const re of RETIRED) if (re.test(text)) hits.push(`${f.slice(SKILLS.length + 1)}: ${re}`);
    }
    expect(hits).toEqual([]);
  });

  it("self-check: the patterns catch the old texts and spare the new ones", () => {
    const old = "(`POST /api/hub/cell-instances/html`) and embed it by `instanceId`.";
    expect(RETIRED.some((re) => re.test(old))).toBe(true);
    expect(RETIRED.some((re) => re.test("the space's cells (synap_list_widgets)"))).toBe(true);
    expect(RETIRED.some((re) => re.test("the space's cells (synap_list_cells)"))).toBe(false);
  });
});
