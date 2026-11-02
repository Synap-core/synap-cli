/**
 * Where the statusline keeps its caches and locks, and the ONE way it writes them.
 *
 * They used to live in `/tmp/synap-statusline-*`: created 0644 (the pod-wide
 * cache holds workspace names and a session goal, readable by every local
 * user) and written through `writeFileSync`, which follows a symlink another
 * user planted at that predictable name. They now live in `~/.synap/statusline/`
 * (the directory the transcript index already uses), directory 0700, file 0600,
 * opened with O_NOFOLLOW. A cache can be rebuilt, so nothing reads the old
 * `/tmp` files any more.
 */
import path from "node:path";
import { ensureSecretDir, writeSecretFileNoFollow } from "./atomic-file.js";
import { indexDir } from "./transcript-index.js";

/** A session id as a file-name part. */
export function convKey(claudeSessionId: string | undefined): string {
  return (claudeSessionId ?? "").replace(/[^A-Za-z0-9_-]/g, "") || "_nosession";
}

export const podCacheFile = (): string => path.join(indexDir(), "pod-cache.json");
export const podLockFile = (): string => path.join(indexDir(), "pod-refresh.lock");
export const convCachePath = (claudeSessionId: string | undefined): string =>
  path.join(indexDir(), `conv-${convKey(claudeSessionId)}.json`);
export const convLockPath = (claudeSessionId: string | undefined): string =>
  path.join(indexDir(), `conv-${convKey(claudeSessionId)}.lock`);

/**
 * Write `data` to `file` as 0600, refusing to follow a symlink at `file` (ELOOP).
 * The directory is created 0700 first. Throws on any failure: callers that
 * treat a cache write as best-effort already catch.
 */
export function writeStatuslineFile(file: string, data: string): void {
  ensureSecretDir(path.dirname(file));
  writeSecretFileNoFollow(file, data);
}
