/**
 * Find a thing by the name a person typed: the ONE matcher every
 * "No <thing> named …" refusal goes through before it refuses.
 *
 * Why: `synap cap add cal.com` answered "No capability named "cal.com"" while
 * `synap cap list` showed "Cal.com Scheduling" two lines up (founder dogfood,
 * 2026-11-16, finding 1773922e). An exact match is still the only thing that
 * runs without asking; anything else becomes a suggestion the person confirms.
 *
 * Pure (no I/O, no prompts): the caller decides what to do with a near match.
 */

export interface NameFields {
  /** Names a person would type: the display name, the key or slug. */
  names: string[];
  /** Weaker text a word can be found in: a description, verb ids. */
  words?: string[];
}

export type NameMatch<T> =
  | { kind: "exact"; item: T }
  | { kind: "near"; candidates: T[] }
  | { kind: "none" };

/** Lower case, accents dropped, only letters and digits: "Cal.com" → "calcom". */
export function normalizeName(s: string): string {
  return s
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "");
}

/** Words of a text, normalized; tokens shorter than 2 characters dropped. */
export function nameTokens(s: string): string[] {
  return s
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length >= 2);
}

/** Edit distance where swapping two neighbouring letters is one edit ("strpie" → "stripe"). */
function editDistance(a: string, b: string): number {
  if (a === b) return 0;
  let before: number[] = [];
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) {
      let d = Math.min(
        prev[j]! + 1,
        cur[j - 1]! + 1,
        prev[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1)
      );
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1])
        d = Math.min(d, before[j - 2]! + 1);
      cur[j] = d;
    }
    before = prev;
    prev = cur;
  }
  return prev[b.length]!;
}

/** 0..1, 1 = identical. */
function similarity(a: string, b: string): number {
  const longest = Math.max(a.length, b.length);
  return longest === 0 ? 1 : 1 - editDistance(a, b) / longest;
}

/** Below this a candidate is noise, not a suggestion. */
export const MIN_SCORE = 40;

/** How close `query` is to one name (0 = unrelated, 100 = same once normalized). */
export function scoreName(query: string, name: string): number {
  const q = normalizeName(query);
  const n = normalizeName(name);
  if (!q || !n) return 0;
  if (q === n) return 100;
  if (n.startsWith(q) && q.length >= 2) return 85;
  const nameWords = nameTokens(name);
  const queryWords = nameTokens(query);
  // "cal.com" → ["cal","com"]: every typed word starts a word of the name.
  if (
    queryWords.length > 0 &&
    queryWords.every((w) => nameWords.some((t) => t.startsWith(w)))
  )
    return 80;
  if (q.length >= 3 && n.includes(q)) return 65;
  // A typo of the whole name, or of one of its words ("strpie" → "Stripe").
  const best = Math.max(
    similarity(q, n),
    ...nameWords.map((t) => similarity(q, t))
  );
  return best >= 0.7 ? Math.round(70 * best) : 0;
}

/** How well the query's words show up in the weaker text (a description). */
function scoreWords(query: string, words: string[]): number {
  const queryWords = nameTokens(query).filter((w) => w.length >= 3);
  if (queryWords.length === 0) return 0;
  const textWords = new Set(words.flatMap(nameTokens));
  const found = queryWords.filter((w) =>
    [...textWords].some((t) => t.startsWith(w))
  ).length;
  return found === queryWords.length ? 50 : 0;
}

/**
 * Exact (case-insensitive, then normalized when it names ONE thing) runs;
 * anything else is `near` (best first, at most `limit`) or `none`.
 */
export function matchByName<T>(
  items: readonly T[],
  query: string,
  fieldsOf: (item: T) => NameFields,
  limit = 5
): NameMatch<T> {
  const raw = query.trim().toLowerCase();
  if (!raw) return { kind: "none" };
  const exact = items.find((it) =>
    fieldsOf(it).names.some((n) => n.trim().toLowerCase() === raw)
  );
  if (exact !== undefined) return { kind: "exact", item: exact };

  const scored = items
    .map((item) => {
      const f = fieldsOf(item);
      const score = Math.max(
        0,
        ...f.names.map((n) => scoreName(query, n)),
        scoreWords(query, f.words ?? [])
      );
      return { item, score };
    })
    .filter((s) => s.score >= MIN_SCORE)
    .sort((a, b) => b.score - a.score);

  const sameOnceNormalized = scored.filter((s) => s.score === 100);
  if (sameOnceNormalized.length === 1)
    return { kind: "exact", item: sameOnceNormalized[0]!.item };
  if (scored.length === 0) return { kind: "none" };
  return { kind: "near", candidates: scored.slice(0, limit).map((s) => s.item) };
}
