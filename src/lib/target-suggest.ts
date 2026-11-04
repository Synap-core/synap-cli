/**
 * The known client names closest to a name the person typed, and the words
 * that say so. Read by every command that takes a client name (`synap
 * connect`, `synap mcp url`), so an unknown name is answered the same way.
 */
import { TARGETS, type TargetName } from "./targets.js";

/** Lowercase, letters and digits only: `Generic.` and `claude_code` meet `generic` and `claude-code`. */
function squash(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function editDistance(a: string, b: string): number {
  const row = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    let diag = row[0];
    row[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const up = row[j];
      row[j] = Math.min(row[j] + 1, row[j - 1] + 1, diag + (a[i - 1] === b[j - 1] ? 0 : 1));
      diag = up;
    }
  }
  return row[b.length];
}

/**
 * The known clients closest to `name`, best first, at most 3: the same name
 * up to case and punctuation, then the names it starts, then those a few
 * typos away (at most 2, or a third of the name for a long one).
 */
export function suggestTargets(name: string): TargetName[] {
  const want = squash(name);
  if (!want) return [];
  const names = Object.keys(TARGETS) as TargetName[];
  const exact = names.filter((n) => squash(n) === want);
  if (exact.length) return exact;
  const scored: Array<{ n: TargetName; d: number }> = [];
  const limit = Math.max(2, Math.floor(want.length / 3));
  for (const n of names) {
    const s = squash(n);
    if (want.length >= 3 && s.startsWith(want)) scored.push({ n, d: 0 });
    else {
      const d = editDistance(want, s);
      if (d <= limit) scored.push({ n, d });
    }
  }
  return scored
    .sort((a, b) => a.d - b.d || a.n.localeCompare(b.n))
    .slice(0, 3)
    .map((x) => x.n);
}

/** What `synap connect <unknown>` prints: the closest clients, and the way to a tool. */
export function unknownClientMessage(
  name: string,
  suggestions: readonly string[],
  { toolHint = true }: { toolHint?: boolean } = {}
): string[] {
  const lines = [`Unknown client \`${name}\`.`];
  if (suggestions.length) lines.push(`Did you mean: ${suggestions.map((s) => `\`${s}\``).join(", ")}?`);
  if (toolHint) lines.push(`To connect a tool or account: synap connect --tool ${name}`);
  lines.push("All clients: synap connect --list");
  return lines;
}
