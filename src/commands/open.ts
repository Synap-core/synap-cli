/**
 * synap open entity <id>
 * synap open view <id>
 *
 * Sends a synap:// deep link to the Electron browser app, which opens the
 * entity or view in the UI. Works from any terminal — the OS routes the URL
 * to the registered synap:// protocol handler.
 *
 * Requires the Synap desktop app to be running.
 */

import { execSync } from "child_process";
import { log } from "../utils/logger.js";

export interface OpenOpts {
  kind: "entity" | "view" | "cell" | "document";
  id: string;
}

function buildDeepLink(kind: "entity" | "view" | "cell" | "document", id: string): string {
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

export async function openInBrowser(opts: OpenOpts): Promise<void> {
  try {
    const url = buildDeepLink(opts.kind, opts.id);
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
