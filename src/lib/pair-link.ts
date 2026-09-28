/**
 * Phone pairing — the link `synap init` prints as a QR so Relay can reach this pod.
 *
 * Contract (Relay is the receiver; it owns the screen that consumes it):
 *
 *   synap://pair?v=1&pod=<url-encoded pod origin>[&email=<CP account>]
 *
 *   - `v`     grammar version. A receiver that sees an unknown `v` must refuse
 *             and say "update Relay", never guess.
 *   - `pod`   the pod's ORIGIN only (scheme + host + port, no path). https, or
 *             http for a LAN host only: a public host over plain http would
 *             send the phone's sign-in in the clear, so it is refused. Relay
 *             pre-fills its sign-in with this pod; it never trusts it for auth.
 *   - `email` OPTIONAL: the Synap account the CLI is signed in to. Relay
 *             pre-fills the sign-in email with it. Not a credential.
 *
 * `token` is RESERVED by Relay's parser (it ignores it) for a future
 * short-lived pairing token. No pod or CP door mints one yet, so the builder
 * takes none; add the parameter when that door exists.
 *
 * The scheme is `synap` (relay's app.json declares `["synap", "relay"]`), and a
 * single-segment host (`pair`) is what relay's `useDeepLinkHandler` reads as
 * `deepLinkPath === "pair"`.
 */

import QRCode from "qrcode";

export const PAIR_LINK_VERSION = "1";

export type PairLinkResult =
  | { ok: true; link: string }
  | { ok: false; reason: "invalid-url" | "loopback" | "insecure" };

/** Hosts a phone can never reach: the pod is only on this computer. */
function isLoopbackHost(h: string): boolean {
  return h === "localhost" || h.endsWith(".localhost") || h === "::1" || h === "0.0.0.0" || /^127\./.test(h);
}

/** A host only reachable on the local network, where plain http is tolerable. */
function isLanHost(h: string): boolean {
  if (h.endsWith(".local") || h.endsWith(".lan") || h.endsWith(".home.arpa")) return true;
  const m = /^(\d{1,3})\.(\d{1,3})\.\d{1,3}\.\d{1,3}$/.exec(h);
  if (m) {
    const a = Number(m[1]);
    const b = Number(m[2]);
    return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254);
  }
  // IPv6 unique-local (fc00::/7) and link-local (fe80::/10).
  return /^f[cd][0-9a-f]{2}:/.test(h) || /^fe[89ab][0-9a-f]:/.test(h);
}

export function buildPairLink(opts: { podUrl: string; email?: string }): PairLinkResult {
  let url: URL;
  try {
    url = new URL(opts.podUrl);
  } catch {
    return { ok: false, reason: "invalid-url" };
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return { ok: false, reason: "invalid-url" };
  const host = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (isLoopbackHost(host)) return { ok: false, reason: "loopback" };
  if (url.protocol === "http:" && !isLanHost(host)) return { ok: false, reason: "insecure" };

  const params = new URLSearchParams({ v: PAIR_LINK_VERSION, pod: url.origin });
  if (opts.email) params.set("email", opts.email);
  return { ok: true, link: `synap://pair?${params.toString()}` };
}

/** The link as a terminal QR code (half-block characters, fits ~30 rows). */
export async function renderTerminalQr(text: string): Promise<string> {
  return QRCode.toString(text, { type: "terminal", small: true });
}
