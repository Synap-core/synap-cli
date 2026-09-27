/**
 * Phone pairing — the link `synap init` prints as a QR so Relay can reach this pod.
 *
 * Contract (Relay is the receiver; it owns the screen that consumes it):
 *
 *   synap://pair?v=1&pod=<url-encoded pod origin>[&token=<opaque, single-use>]
 *
 *   - `v`     grammar version. A receiver that sees an unknown `v` must refuse
 *             and say "update Relay", never guess.
 *   - `pod`   the pod's public origin (https, or http for a LAN host). Relay
 *             pre-fills its sign-in with this pod; it never trusts it for auth.
 *   - `token` OPTIONAL and absent today: no pod or CP door mints a short-lived,
 *             single-use pairing token yet. When one exists, the CLI passes it
 *             here and Relay redeems it instead of asking for a password. Until
 *             then the phone signs in normally, with the pod already chosen.
 *
 * The scheme is `synap` (relay's app.json declares `["synap", "relay"]`), and a
 * single-segment host (`pair`) is what relay's `useDeepLinkHandler` reads as
 * `deepLinkPath === "pair"`.
 */

import QRCode from "qrcode";

export const PAIR_LINK_VERSION = "1";

export type PairLinkResult =
  | { ok: true; link: string }
  | { ok: false; reason: "invalid-url" | "loopback" };

/** Hosts a phone can never reach: the pod is only on this computer. */
function isLoopbackHost(hostname: string): boolean {
  const h = hostname.replace(/^\[|\]$/g, "").toLowerCase();
  return h === "localhost" || h.endsWith(".localhost") || h === "::1" || h === "0.0.0.0" || /^127\./.test(h);
}

export function buildPairLink(opts: { podUrl: string; token?: string }): PairLinkResult {
  let url: URL;
  try {
    url = new URL(opts.podUrl);
  } catch {
    return { ok: false, reason: "invalid-url" };
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return { ok: false, reason: "invalid-url" };
  if (isLoopbackHost(url.hostname)) return { ok: false, reason: "loopback" };

  const pod = `${url.origin}${url.pathname.replace(/\/+$/, "")}`;
  const params = new URLSearchParams({ v: PAIR_LINK_VERSION, pod });
  if (opts.token) params.set("token", opts.token);
  return { ok: true, link: `synap://pair?${params.toString()}` };
}

/** The link as a terminal QR code (half-block characters, fits ~30 rows). */
export async function renderTerminalQr(text: string): Promise<string> {
  return QRCode.toString(text, { type: "terminal", small: true });
}
