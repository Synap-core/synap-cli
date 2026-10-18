/**
 * Which CLI is running: its version AND the commit it was built from.
 *
 * The version alone could not tell an Oct-11 test-branch build from current
 * main (2026-10-15 devbox incident: same version, old code, wrong success
 * line). `build` stamps `dist/build-info.json` (`scripts/write-build-info.mjs`);
 * running from source (`tsx`) there is no stamp, and that is said, not hidden.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export interface CliBuild {
  version: string;
  sha?: string;
  branch?: string;
  /** Built with uncommitted changes under src/. */
  dirty?: boolean;
  builtAt?: string;
}

// dist/lib/cli-build.js → dist/build-info.json, package.json at the package
// root; the same two hops from src/lib when running from source.
const here = path.dirname(fileURLToPath(import.meta.url));

function readJson<T>(file: string): T | null {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")) as T;
  } catch {
    return null;
  }
}

export function cliBuild(dir = here): CliBuild {
  const pkg = readJson<{ version?: string }>(path.join(dir, "..", "..", "package.json"));
  const stamp = readJson<Omit<CliBuild, "version">>(path.join(dir, "..", "build-info.json"));
  return { version: pkg?.version ?? "unknown", ...(stamp ?? {}) };
}

/** "1.12.0 (a750d09 main, built 2026-10-15)" — the version stays the first word. */
export function formatCliBuild(b: CliBuild): string {
  if (!b.builtAt) return `${b.version} (no build stamp: running from source or an unstamped build)`;
  const day = b.builtAt.slice(0, 10);
  if (!b.sha) return `${b.version} (built ${day}, commit unknown)`;
  return `${b.version} (${b.sha}${b.dirty ? "+changes" : ""}${b.branch ? ` ${b.branch}` : ""}, built ${day})`;
}
