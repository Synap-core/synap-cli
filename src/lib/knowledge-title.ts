/**
 * Choose a knowledge entity's TITLE.
 *
 * The title is a short NAME; the claim lives in `ek_claim`. An explicit
 * `--title` wins. Without one, the claim's first sentence is used WHOLE —
 * never clipped. This helper used to cut it at ~80 characters + "…", which
 * left 134 knowledge titles reading as cut on the founder's pod (title audit,
 * 2026-10-12). The pod now reports a title that is too long in the write
 * receipt (`titleLint`), so the writer rewrites it instead of the CLI hiding
 * the problem.
 *
 * Over the pod's hard cap the write would be refused, so it is refused here
 * first, with the flag that fixes it.
 */

/** Mirrors `TITLE_HARD_MAX` (`@synap-core/types/titles`); the pod refuses longer. */
export const TITLE_HARD_MAX = 200;

export type KnowledgeTitleResult =
  | { ok: true; title: string }
  | { ok: false; reason: string };

function oneLine(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

export function chooseKnowledgeTitle(
  claim: string,
  explicitTitle?: string
): KnowledgeTitleResult {
  if (explicitTitle !== undefined) {
    const title = oneLine(explicitTitle);
    if (!title) return { ok: false, reason: "--title is empty." };
    if (title.length > TITLE_HARD_MAX) {
      return {
        ok: false,
        reason: `--title is ${title.length} characters; the limit is ${TITLE_HARD_MAX} (aim for 80 or less).`,
      };
    }
    return { ok: true, title };
  }
  const flat = oneLine(claim);
  if (!flat) return { ok: false, reason: "--claim is empty." };
  // First sentence: stop at the first terminal punctuation followed by space/end.
  const sentence = flat.match(/^(.+?[.!?])(?:\s|$)/)?.[1] ?? flat;
  if (sentence.length > TITLE_HARD_MAX) {
    return {
      ok: false,
      reason: `The claim's first sentence is ${sentence.length} characters, too long for a title (limit ${TITLE_HARD_MAX}). Pass --title "<a short name, 80 characters or less>".`,
    };
  }
  return { ok: true, title: sentence };
}
