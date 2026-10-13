/**
 * Config writes that cannot half-happen, and config reads that cannot mistake
 * a broken file for an empty one.
 *
 * `~/.synap/config.json` holds every pod profile and every agent key. Two
 * defects could wipe it:
 *  1. `fs.writeFileSync` truncates first, then writes — a crash, a full disk or
 *     a concurrent reader between the two sees (or keeps) an empty/partial file.
 *  2. A parse failure was read as `{}` ("start fresh"), and the next write then
 *     persisted that `{}` merged with one field — every other profile gone.
 *
 * So: write a temp file in the same directory, fsync it, rename it over the
 * target (atomic on POSIX), keeping the target's mode (0600 for ~/.synap). And
 * a file that exists but does not parse THROWS — it is never an empty config.
 */

import fs from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";

/** The file exists but is not valid JSON — never to be treated as empty. */
export class ConfigUnreadableError extends Error {
  constructor(
    readonly file: string,
    readonly cause: unknown
  ) {
    super(
      `${file} exists but could not be read as JSON (${cause instanceof Error ? cause.message : String(cause)}). ` +
        `Nothing was written. Fix the file, or move it aside and run \`synap init\` again.`
    );
    this.name = "ConfigUnreadableError";
  }
}

/** Parsed JSON object, or `null` ONLY when the file does not exist. Throws on anything else. */
export function readJsonStrict<T = Record<string, unknown>>(file: string): T | null {
  let raw: string;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw new ConfigUnreadableError(file, err);
  }
  try {
    const v = JSON.parse(raw) as unknown;
    if (!v || typeof v !== "object" || Array.isArray(v)) throw new Error("not a JSON object");
    return v as T;
  } catch (err) {
    throw new ConfigUnreadableError(file, err);
  }
}

/**
 * Write `data` to `file` atomically: temp file in the same directory → fsync →
 * rename. The mode is `opts.mode`, else the existing file's mode, else 0600.
 */
export function writeFileAtomic(file: string, data: string, opts: { mode?: number } = {}): void {
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  let mode = opts.mode;
  if (mode === undefined) {
    try {
      mode = fs.statSync(file).mode & 0o777;
    } catch {
      mode = 0o600;
    }
  }
  const tmp = path.join(dir, `.${path.basename(file)}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`);
  const fd = fs.openSync(tmp, "wx", mode);
  try {
    fs.writeFileSync(fd, data);
    fs.fsyncSync(fd);
  } catch (err) {
    fs.closeSync(fd);
    fs.rmSync(tmp, { force: true });
    throw err;
  }
  fs.closeSync(fd);
  // openSync's mode is filtered by the umask; set it exactly.
  fs.chmodSync(tmp, mode);
  try {
    fs.renameSync(tmp, file);
  } catch (err) {
    fs.rmSync(tmp, { force: true });
    throw err;
  }
  // Persist the rename itself (best-effort: not every platform can fsync a dir).
  try {
    const dfd = fs.openSync(dir, "r");
    try {
      fs.fsyncSync(dfd);
    } finally {
      fs.closeSync(dfd);
    }
  } catch {
    /* Windows / unsupported */
  }
}

/**
 * The ONE door for a file that holds a credential and is written in place.
 *
 * `fs.writeFileSync(f, d, { mode: 0o600 })` applies the mode only when it
 * CREATES the file — an existing 0644 file keeps 0644. So write, then chmod.
 * Accepts the same `{ mode }` options object so call sites swap in by name.
 */
export function writeSecretFile(file: string, data: string, opts: { mode?: number } = {}): void {
  const mode = opts.mode ?? 0o600;
  fs.writeFileSync(file, data, { mode });
  fs.chmodSync(file, mode);
}

/** Copy a file that may hold credentials (a `.bak`) and force it to 0600. */
export function copySecretBackup(src: string, dst: string): void {
  fs.copyFileSync(src, dst);
  fs.chmodSync(dst, 0o600);
}

/**
 * Create `dir` (and parents) as 0700 and tighten it if it already existed.
 * Only for directories Synap owns (`~/.synap`, `~/.synap/contexts`) — never a
 * client's own config directory.
 */
export function ensureSecretDir(dir: string): void {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.chmodSync(dir, 0o700);
}
