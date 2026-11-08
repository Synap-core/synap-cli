/**
 * Logs: kept on the computer, sent ONLY when a person asked for them (the
 * heartbeat answers `logsRequested`), always masked, always capped.
 *
 * Masking removes every value the runner knows to be secret (an env value
 * whose name reads like a credential, the computer's own key) and anything
 * shaped like a credential (bearer tokens, Synap keys, JWTs, `password=…`).
 * The pod masks again on its side (`redactSecrets`); the runner does not rely
 * on it.
 */

import { capLogEnd, HOST_LOG_CAP, type HostLog } from "./wire.js";

/** Lines of `compose logs` read per service when a log is asked for. */
export const LOG_TAIL_LINES = 400;

const SECRET_NAME_RE = /(TOKEN|SECRET|PASSWORD|PASSWD|PASS|KEY|CREDENTIAL|AUTH|COOKIE|SESSION)/i;
const SHAPES: Array<[RegExp, string]> = [
  [/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi, "$1 ***"],
  [/\bsynap_[A-Za-z0-9_-]{12,}/g, "synap_***"],
  [/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, "***.jwt.***"],
  [/\b(sk|pk|rk)-[A-Za-z0-9_-]{16,}/g, "$1-***"],
  [/\b(password|passwd|secret|token|api[_-]?key)(\s*[=:]\s*)("[^"]*"|'[^']*'|\S+)/gi, "$1$2***"],
];

/** The env values of a manifest that must never appear in a log. */
export function secretValues(env: Record<string, string>): string[] {
  return Object.entries(env)
    .filter(([k, v]) => SECRET_NAME_RE.test(k) && v.length >= 4)
    .map(([, v]) => v);
}

export function maskSecrets(text: string, secrets: readonly string[] = []): string {
  let out = text;
  // Longest first, so a secret that contains another is masked whole.
  for (const s of [...new Set(secrets)].filter((s) => s.length >= 4).sort((a, b) => b.length - a.length)) {
    out = out.split(s).join("***");
  }
  for (const [re, sub] of SHAPES) out = out.replace(re, sub);
  return out;
}

/** A masked log as the wire carries it: the head and tail, each at most HOST_LOG_CAP bytes. */
export function toHostLog(text: string, secrets: readonly string[] = [], cap = HOST_LOG_CAP): HostLog {
  const masked = maskSecrets(text, secrets);
  const totalBytes = Buffer.byteLength(masked, "utf8");
  if (totalBytes <= cap) return { head: masked, tail: "", totalBytes, truncated: false };
  const head = capLogEnd(masked, "head", cap);
  const rest = masked.slice(head.length);
  const tail = capLogEnd(rest, "tail", cap);
  return {
    head,
    tail,
    totalBytes,
    truncated: Buffer.byteLength(head, "utf8") + Buffer.byteLength(tail, "utf8") < totalBytes,
  };
}
