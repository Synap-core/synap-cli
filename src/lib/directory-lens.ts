/**
 * Per-DIRECTORY lens — the durable default scope for a working tree.
 *
 * RATIFIED MODEL: a directory's `.synap/lens.json` is where a lens normally
 * lives; the per-Claude-session lens (`session-lens.ts`) is an explicit
 * OVERRIDE on top of it.
 *
 * The session lens alone could not express "this repo is always Builder" — it
 * dies with the tab, so every new session started pod-wide (or, worse, on
 * whatever the global config happened to hold) and the operator re-pinned by
 * hand. A directory lens is discovered the way git discovers `.git`: walk UP
 * from the cwd until a `.synap/lens.json` turns up.
 *
 * Full precedence, highest first (assembled in `hub-client.ts`):
 *
 *   explicit flag  ›  session lens  ›  DIRECTORY LENS  ›  env var  ›  global config
 *
 * ── Pod qualification ────────────────────────────────────────────────────────
 * Workspace and project ids are POD-LOCAL: sending workspace W (pod A) to pod B
 * is the "Access denied to workspace" 403. A directory lens is exposed to that
 * hazard MORE than a session lens is, because it outlives many `synap pods use`
 * switches. It therefore carries the same `podUrl` stamp and is compared
 * through the SAME door — {@link lensMatchesPod} from `session-lens.ts`. There
 * is deliberately no second comparison implementation here; a duplicated
 * "is this the right pod" rule that drifts is the bug, not the fix.
 *
 * ── Write safety ─────────────────────────────────────────────────────────────
 * Writes never escape the user's own tree: the target is either an EXISTING
 * lens found on the upward walk (only when it sits at or below the home dir) or
 * the cwd itself. A lens is never created in an ancestor, never above the home
 * dir, and never at the filesystem root.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { lensMatchesPod, type SessionLens } from "./session-lens.js";

/** The directory name a lens lives in, and the file inside it. */
const LENS_DIR_NAME = ".synap";
const LENS_FILE_NAME = "lens.json";

/** A directory lens is the same shape as a session lens — same fields, different lifetime. */
export type DirectoryLens = SessionLens;

export interface FoundDirectoryLens {
  lens: DirectoryLens;
  /** Absolute path to the `.synap/lens.json` that supplied it — shown by `synap lens`. */
  file: string;
  /** The directory that owns it (the one containing `.synap/`). */
  dir: string;
}

function lensFileIn(dir: string): string {
  return path.join(dir, LENS_DIR_NAME, LENS_FILE_NAME);
}

/** Is `dir` the home dir or inside it? Used to bound where a lens may be WRITTEN. */
function isAtOrBelowHome(dir: string): boolean {
  const home = path.resolve(os.homedir());
  const target = path.resolve(dir);
  if (target === home) return true;
  return target.startsWith(home + path.sep);
}

/**
 * Every directory to consider, nearest first: the cwd, then each ancestor.
 * The walk STOPS after the home dir (a lens above `~` would apply to every
 * unrelated project on the machine) and at the filesystem root.
 */
export function lensSearchPath(startDir: string = process.cwd()): string[] {
  const home = path.resolve(os.homedir());
  const dirs: string[] = [];
  let dir = path.resolve(startDir);
  for (;;) {
    dirs.push(dir);
    if (dir === home) break;
    const parent = path.dirname(dir);
    if (parent === dir) break; // filesystem root
    dir = parent;
  }
  return dirs;
}

/** Read + parse one candidate, or null when absent/corrupt. A malformed lens must not crash the CLI. */
function readLensFile(dir: string): FoundDirectoryLens | null {
  const file = lensFileIn(dir);
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf-8")) as DirectoryLens;
    if (!parsed || typeof parsed !== "object") return null;
    return { lens: parsed, file, dir };
  } catch {
    return null;
  }
}

/**
 * The nearest directory lens at or above `startDir`, ignoring pod qualification.
 * Callers that are about to SEND ids must use {@link resolveDirectoryLensForPod}.
 */
export function findDirectoryLens(startDir?: string): FoundDirectoryLens | null {
  for (const dir of lensSearchPath(startDir)) {
    const found = readLensFile(dir);
    if (found) return found;
  }
  return null;
}

/**
 * The nearest directory lens, but ONLY if it belongs to `podUrl`.
 *
 * A lens stamped with a different pod returns null so the caller falls through
 * to the next rung (env var, then the pod-qualified global config) instead of
 * sending a foreign workspace id. Comparison is delegated to `lensMatchesPod`
 * — including its deliberate leniency for lenses written before the `podUrl`
 * stamp existed.
 */
export function resolveDirectoryLensForPod(
  podUrl: string | undefined,
  startDir?: string
): FoundDirectoryLens | null {
  const found = findDirectoryLens(startDir);
  if (!found) return null;
  return lensMatchesPod(found.lens, podUrl) ? found : null;
}

/**
 * Where would a write land? An existing lens on the upward walk wins (so
 * `synap use` from a subdirectory re-pins the repo's lens rather than seeding a
 * nested one), but only when that lens sits at or below the home dir. Otherwise
 * the cwd — a lens is never CREATED in an ancestor.
 */
export function directoryLensWriteTarget(startDir: string = process.cwd()): string {
  const found = findDirectoryLens(startDir);
  if (found && isAtOrBelowHome(found.dir)) return found.dir;
  return path.resolve(startDir);
}

/**
 * Merge-write the directory lens. Returns the file it wrote, so the caller can
 * TELL the user which path now owns their scope — a silently-resolved lens is
 * exactly what produced the 403 class this module exists to make legible.
 */
export function writeDirectoryLens(
  patch: Partial<DirectoryLens>,
  startDir?: string
): { lens: DirectoryLens; file: string; dir: string } {
  const dir = directoryLensWriteTarget(startDir);
  const prev = readLensFile(dir)?.lens ?? {};
  const next: DirectoryLens = { ...prev, ...patch, updatedAt: Date.now() };
  const file = lensFileIn(dir);
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.writeFileSync(file, JSON.stringify(next, null, 2) + "\n", { mode: 0o600 });
  return { lens: next, file, dir };
}

/**
 * Clear one field (or the whole lens) from the nearest directory lens.
 * Returns the file touched, or null when there was nothing to clear.
 */
export function clearDirectoryLensField(
  field?: keyof DirectoryLens,
  startDir?: string
): string | null {
  const found = findDirectoryLens(startDir);
  if (!found) return null;
  if (!field) {
    try {
      fs.unlinkSync(found.file);
    } catch {
      return null;
    }
    return found.file;
  }
  if (!(field in found.lens)) return null;
  const next = { ...found.lens };
  delete next[field];
  next.updatedAt = Date.now();
  try {
    fs.writeFileSync(found.file, JSON.stringify(next, null, 2) + "\n", { mode: 0o600 });
  } catch {
    return null;
  }
  return found.file;
}
