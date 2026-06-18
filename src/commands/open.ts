/**
 * synap open entity <id>
 * synap open view <id>
 * synap open proposal <id>
 * synap open cell <typeKey>
 * synap open document <id>
 * synap open <id>                            ← resolves type automatically
 *
 * Sends a synap:// deep link to the Electron browser app, which opens the
 * entity, view, proposal, cell, or document in the UI. The bare-ID form calls
 * GET /api/hub/resolve/:id to determine the type before dispatching.
 *
 * Works from any terminal — the OS routes the URL to the registered synap://
 * protocol handler. Requires the Synap desktop app to be running.
 */

import { execSync } from "child_process";
import { resolveHubConfig } from "../lib/hub-client.js";
import { log } from "../utils/logger.js";

export type OpenKind = "entity" | "view" | "cell" | "document" | "proposal";

export interface OpenOpts {
  kind: OpenKind;
  id: string;
}

export interface ResolveResult {
  type: "proposal" | "entity" | "view" | "document" | "unknown";
  id: string;
  displayName: string | null;
  workspaceId: string | null;
  profileSlug?: string | null;
}

function buildDeepLink(kind: OpenKind, id: string): string {
  return `synap://open/${kind}/${encodeURIComponent(id)}`;
}

function openUrl(url: string): void {
  const platform = process.platform;
  if (platform === "darwin") {
    execSync(`open "${url}"`);
  } else if (platform === "linux") {
    execSync(`xdg-open "${url}"`);
  } else if (platform === "win32") {
    execSync(`start "" "${url}"`);
  } else {
    throw new Error(`Unsupported platform: ${platform}`);
  }
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
  const url = buildDeepLink(opts.kind, opts.id);
  try {
    openUrl(url);
    log.success(`Opened ${opts.kind} in browser: ${opts.id.slice(0, 8)}…`);
    log.dim(`  (${url})`);
  } catch (e) {
    log.error(
      `Could not open browser: ${(e as Error).message}\n` +
        `  Make sure the Synap desktop app is running.`
    );
    process.exit(1);
  }
}

/**
 * Resolve a bare ID then open in browser.
 */
export async function resolveAndOpen(id: string): Promise<void> {
  try {
    const resolved = await resolveId(id);
    if (resolved.type === "unknown") {
      log.warn(`Unknown ID: "${id.slice(0, 8)}…". Nothing to open.`);
      return;
    }
    log.info(`Resolved: ${resolved.type} — ${resolved.displayName ?? id.slice(0, 8)}`);
    await openInBrowser({ kind: resolved.type as OpenKind, id });
  } catch (e) {
    log.error(
      `Could not resolve/open: ${(e as Error).message}\n` +
        `  Make sure the Synap desktop app is running and your pod is reachable.`
    );
    process.exit(1);
  }
}
