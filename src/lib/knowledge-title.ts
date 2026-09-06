/**
 * Derive a knowledge entity's TITLE from its claim.
 *
 * The title is a label; the claim lives in `ek_claim`, whose profile field is
 * literally labelled "Summary". Copying the whole claim into the title made
 * every knowledge card read its body twice (the room dogfood of 2026-09-04).
 * A title is the first sentence, clipped at a word boundary, never mid-word.
 */
const TITLE_MAX = 80;

export function knowledgeTitleFromClaim(claim: string): string {
  const oneLine = claim.replace(/\s+/g, " ").trim();
  if (!oneLine) return "Untitled knowledge";
  // First sentence: stop at the first terminal punctuation followed by space/end.
  const sentence = oneLine.match(/^(.+?[.!?])(?:\s|$)/)?.[1] ?? oneLine;
  if (sentence.length <= TITLE_MAX) return sentence;
  const clipped = sentence.slice(0, TITLE_MAX);
  const atWord = clipped.lastIndexOf(" ");
  return `${(atWord > TITLE_MAX / 2 ? clipped.slice(0, atWord) : clipped).replace(/[\s,;:]+$/, "")}…`;
}
