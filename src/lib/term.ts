/**
 * The status line's terminal vocabulary: the ANSI colours, the OSC 8 link,
 * and the one scrub every pod string goes through before it is printed.
 *
 * One home, so `statusline.ts`, `bridge-status.ts` and `now-line.ts` draw with
 * the same codes and none of them prints a pod string raw.
 */

export const GREEN = "\x1b[32m";
export const RED = "\x1b[31m";
export const CYAN = "\x1b[36m";
export const AMBER = "\x1b[33m";
export const MAGENTA = "\x1b[35m";
export const BOLD_GREEN = "\x1b[01;32m";
export const BOLD_YELLOW = "\x1b[01;33m";
export const BOLD_RED = "\x1b[01;31m";
export const BOLD_BLUE = "\x1b[01;34m";
export const DIM = "\x1b[2m";
export const RESET = "\x1b[0m";

/**
 * C0 (ESC, BEL, BS, …), DEL, C1 (CSI, OSC, ST as single bytes), and the bidi
 * overrides and isolates. A pod string holding any of them could recolour the
 * line, open an OSC 8 link of its own, set the window title or reorder what
 * the person reads. Line breaks and tabs become one space.
 */
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u200e\u200f\u202a-\u202e\u2066-\u2069]/g;
const BREAKS = /[\t\n\r]+/g;

/** A string from the pod (or any file) as the terminal may show it: no control characters. */
export function safeText(s: string): string {
  return s.replace(BREAKS, " ").replace(CONTROL, "");
}

/** Every string inside a parsed JSON value, scrubbed with {@link safeText}; the shape is kept. */
export function scrubStrings<T>(value: T): T {
  if (typeof value === "string") return safeText(value) as T;
  if (Array.isArray(value)) return value.map(scrubStrings) as T;
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = scrubStrings(v);
    return out as T;
  }
  return value;
}

/** An OSC 8 hyperlink; plain text when there is no URL. Both parts are scrubbed. */
export function osc8(url: string | null | undefined, text: string): string {
  const safe = safeText(text);
  const href = url ? safeText(url) : "";
  return href ? `\x1b]8;;${href}\x1b\\${safe}\x1b]8;;\x1b\\` : safe;
}
