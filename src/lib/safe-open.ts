/**
 * The ONE way the CLI opens a URL in the person's browser.
 *
 * Every opener used to build a shell string — open "<url>", start "" "<url>"
 * — escaping (at best) only `"`. A URL that came from a pod or a connector
 * (`$(…)`, backticks, `&`) then ran as a command on this computer. Here the URL
 * is never seen by a shell: it is one argv element handed to `open` /
 * `xdg-open` / `rundll32 url.dll,FileProtocolHandler`, and only http(s) URLs
 * are opened at all.
 *
 * `openPodPage` adds the second rule for pages a pod tells us to open (key
 * approvals): the URL must be on THAT pod's origin or its pod-admin origin. A
 * pod-supplied link to anywhere else is printed, never opened.
 */

import { execFile } from "node:child_process";
import { log } from "../utils/logger.js";

export type Launch = (cmd: string, args: string[]) => void;

/** Default launcher: argv only, no shell, detached best-effort. */
const defaultLaunch: Launch = (cmd, args) => {
  try {
    const child = execFile(cmd, args, { windowsHide: true }, () => {
      /* best-effort: the caller already printed the URL */
    });
    child.unref?.();
  } catch {
    /* spawn failure (no `open` on PATH): the URL was printed */
  }
};

/** Parse `url` and return it only if it is an absolute http(s) URL. */
export function httpUrlOrNull(url: string): URL | null {
  try {
    const u = new URL(url);
    return u.protocol === "https:" || u.protocol === "http:" ? u : null;
  } catch {
    return null;
  }
}

/** The argv that opens `url` on `platform` — never a shell string. `null` = no opener here. */
export function openerArgv(url: string, platform: NodeJS.Platform = process.platform): { cmd: string; args: string[] } | null {
  if (platform === "darwin") return { cmd: "open", args: [url] };
  if (platform === "win32") return { cmd: "rundll32", args: ["url.dll,FileProtocolHandler", url] };
  if (platform === "linux" || platform === "freebsd" || platform === "openbsd") return { cmd: "xdg-open", args: [url] };
  return null;
}

/**
 * Open an http(s) URL in the default browser. Returns false (and opens
 * nothing) for any other scheme, an unparsable URL, or a Linux box with no
 * display. Never throws.
 */
export function openExternalUrl(
  url: string,
  deps: { launch?: Launch; platform?: NodeJS.Platform; env?: NodeJS.ProcessEnv } = {}
): boolean {
  const u = httpUrlOrNull(url);
  if (!u) return false;
  const platform = deps.platform ?? process.platform;
  const env = deps.env ?? process.env;
  // Linux with no display: xdg-open fails, or starts a text browser that takes
  // over the terminal. Don't try.
  if (platform === "linux" && !env.DISPLAY && !env.WAYLAND_DISPLAY) return false;
  const argv = openerArgv(u.href, platform);
  if (!argv) return false;
  (deps.launch ?? defaultLaunch)(argv.cmd, argv.args);
  return true;
}

/**
 * The pod-admin origin for a pod origin — mirror of the pod's
 * `toPodAdminOrigin` (synap-backend `utils/pod-admin-origin.ts`), which builds
 * every approval URL: `pod.<root>` / `<sub>.<root>` → `pod-admin.<root>`,
 * localhost → the local pod-admin dev server.
 */
export function podAdminOrigin(podOrigin: string): string | null {
  const u = httpUrlOrNull(podOrigin);
  if (!u) return null;
  const host = u.host;
  if (host.startsWith("localhost") || host.startsWith("127.0.0.1")) return "http://localhost:4040";
  const bare = host.replace(/:\d+$/, "");
  const root = bare.startsWith("pod.") ? bare.slice(4) : bare.includes(".") ? bare.slice(bare.indexOf(".") + 1) : bare;
  return `${u.protocol}//pod-admin.${root}`;
}

/** The origins a page from `podUrl` may live on: the pod itself and its pod-admin app. */
export function podPageOrigins(podUrl: string): string[] {
  const u = httpUrlOrNull(podUrl);
  if (!u) return [];
  const admin = podAdminOrigin(u.origin);
  return admin ? [u.origin, admin] : [u.origin];
}

/** Why `url` may not be opened as a page of `podUrl`, or null when it may. */
export function podPageRefusal(url: string, podUrl: string): string | null {
  const u = httpUrlOrNull(url);
  if (!u) return "it is not an http(s) link";
  const allowed = podPageOrigins(podUrl);
  if (!allowed.includes(u.origin)) return `it is on ${u.origin}, not on your pod (${allowed.join(" or ") || podUrl})`;
  return null;
}

/**
 * Open a page the POD handed us (an approval link) — only when it is on that
 * pod's origin or its pod-admin origin. A refused link is printed with why, so
 * the person can still judge it; it is never opened.
 */
export function openPodPage(url: string, podUrl: string, open: (url: string) => void = (u) => void openExternalUrl(u)): boolean {
  const refusal = podPageRefusal(url, podUrl);
  if (refusal) {
    log.warn(`Not opening that link: ${refusal}.`);
    return false;
  }
  open(url);
  return true;
}
