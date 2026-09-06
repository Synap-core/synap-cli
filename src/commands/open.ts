/**
 * synap open entity <id>
 * synap open view <id>
 * synap open proposal <id>
 * synap open cell <typeKey>
 * synap open document <id>
 * synap open <id>                            ← resolves type automatically
 *
 * Sends a synap:// deep link to the Electron browser app. The OS routes the
 * URL to the registered handler. On macOS we target the installed Synap.app
 * by bundle id / path so leftover electron-vite (`com.github.electron`)
 * cannot steal the click.
 */

import { execFileSync, execSync } from "child_process";
import { existsSync } from "fs";
import { homedir } from "os";
import { join } from "path";
import { openAppUrl } from "@synap/hub-rest-client";
import { resolveHubConfig } from "../lib/hub-client.js";
import { log } from "../utils/logger.js";

/**
 * Object kind, as a free string. The browser's `object-nav.ts` is the ONE
 * route table for what's openable (21 kinds and growing) — the CLI does not
 * duplicate it. An unroutable kind still opens the app; `objectNavTarget`
 * decides there and returns `null` silently, so this command always prints
 * the emitted link so the user can see what was sent.
 */
export type OpenKind = string;

export interface OpenOpts {
  kind: OpenKind;
  id: string;
  /** Address parameters the kind needs to be resolvable (a run's flowType). */
  params?: Record<string, string>;
}

export interface ResolveResult {
  /**
   * A browser-routable label, or "unknown". FREE STRING on purpose: the pod's
   * `/resolve/:id` projects onto `object-nav.ts`'s route table (~21 kinds) and
   * pins that with a tripwire. A hand-written union here was a second, smaller
   * table — it listed four kinds, so every capability-substrate object the pod
   * could resolve was still unopenable on this side.
   */
  type: string;
  /** The id to OPEN — not always the id queried (a correlationId resolves to
   *  the proposal/skill row it belongs to, and THAT is what opens). */
  id: string;
  displayName: string | null;
  workspaceId: string | null;
  profileSlug?: string | null;
  /** False when the thing resolved but has no browser surface at all. */
  openable?: boolean;
  /** Address params the deep link must carry (only runs use one today). */
  params?: Record<string, string>;
}

/** Lock-step with browser/electron-builder.yml `appId`. */
export const DESKTOP_BUNDLE_ID = "live.synap.browser";

export function desktopAppPaths(home = homedir()): string[] {
  return [
    "/Applications/Synap.app",
    join(home, "Applications", "Synap.app"),
  ];
}

export function buildDeepLink(
  kind: OpenKind,
  id: string,
  params?: Record<string, string>,
): string {
  return openAppUrl(kind, id, params);
}

/**
 * Ordered `open` argv lists for macOS. Prefer the installed .app so we do
 * not depend on Launch Services still pointing at electron-vite.
 */
export function darwinOpenArgvCandidates(
  url: string,
  exists: (path: string) => boolean = existsSync,
): string[][] {
  const candidates: string[][] = [];
  const installed = desktopAppPaths().find(exists);
  if (installed) candidates.push(["-a", installed, url]);
  candidates.push(["-b", DESKTOP_BUNDLE_ID, url]);
  candidates.push([url]);
  return candidates;
}

export function openUrl(url: string): void {
  const platform = process.platform;
  if (platform === "darwin") {
    let lastErr: unknown;
    for (const args of darwinOpenArgvCandidates(url)) {
      try {
        execFileSync("open", args, { stdio: "pipe" });
        return;
      } catch (e) {
        lastErr = e;
      }
    }
    throw lastErr instanceof Error ? lastErr : new Error("open failed");
  }
  if (platform === "linux") {
    execFileSync("xdg-open", [url], { stdio: "pipe" });
    return;
  }
  if (platform === "win32") {
    execSync(`start "" "${url}"`);
    return;
  }
  throw new Error(`Unsupported platform: ${platform}`);
}

/**
 * Resolve a bare ID by calling the pod's /resolve endpoint.
 */
async function resolveId(id: string): Promise<ResolveResult> {
  const config = await resolveHubConfig();
  const url = `${config.podUrl}/api/hub/resolve/${encodeURIComponent(id)}`;
  const res = await fetch(url, {
    headers: {
      Authorization: `Bearer ${config.apiKey}`,
    },
  });
  if (!res.ok) {
    throw new Error(`Resolve failed: ${res.status} ${res.statusText}`);
  }
  return res.json();
}

export async function openInBrowser(opts: OpenOpts): Promise<void> {
  const url = buildDeepLink(opts.kind, opts.id, opts.params);
  try {
    openUrl(url);
    log.success(`Opened ${opts.kind} in the Synap app: ${opts.id.slice(0, 8)}…`);
    log.dim(`  (${url})`);
  } catch (e) {
    log.error(
      `Could not open the Synap desktop app: ${(e as Error).message}\n` +
        `  Install Synap.app (or run the desktop app once) so it can claim synap://.`,
    );
    process.exit(1);
  }
}

/**
 * Resolve a bare ID then open in the desktop app.
 */
export async function resolveAndOpen(id: string): Promise<void> {
  if (id.startsWith("generated:")) {
    await openInBrowser({ kind: "cell", id });
    return;
  }
  try {
    const resolved = await resolveId(id);
    if (resolved.type === "unknown") {
      log.warn(`Unknown ID: "${id.slice(0, 8)}…". Nothing to open.`);
      return;
    }
    log.info(
      `Resolved: ${resolved.type} — ${resolved.displayName ?? id.slice(0, 8)}`,
    );
    // RESOLVED BUT NOT OPENABLE. Some things the pod can identify have no
    // browser surface at all (an external send is a correlationId-keyed audit
    // event: no row, no page). Say what it is and stop — minting
    // `synap://open/<kind>/<id>` for a kind the route table has no arm for
    // opens the app onto nothing, which is worse than an honest refusal.
    if (resolved.openable === false) {
      log.warn(
        `A ${resolved.type} has no page in the Synap app — nothing to open.\n` +
          `  Inspect it instead: synap diagnose ${id}`,
      );
      return;
    }
    // `resolved.id`, not `id`: a correlationId handed back by a capability run
    // resolves to the proposal (or skill) row it belongs to, and that ROW id is
    // what the deep link must carry. For every direct row-id hit they are equal.
    await openInBrowser({
      kind: resolved.type as OpenKind,
      id: resolved.id ?? id,
      ...(resolved.params ? { params: resolved.params } : {}),
    });
  } catch (e) {
    log.error(
      `Could not resolve/open: ${(e as Error).message}\n` +
        `  Make sure the Synap desktop app is installed and your pod is reachable.`,
    );
    process.exit(1);
  }
}
