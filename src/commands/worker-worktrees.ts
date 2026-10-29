/**
 * One tree folder per code run, so two runs at once never share a checkout
 * (finding f94c0287: both worked in the one clone under `--cwd`).
 *
 * The worker's `--cwd` is usually a folder OF repos, not a repo, so the worker
 * cannot create the worktree itself: it gives the run an empty folder
 * (`<state>/trees/<short id>`) as its cwd, the prompt tells the run to make its
 * worktrees there (`git -C <cwd>/<repo> worktree add <folder>/<repo> …`), and
 * when the run ends the worker sweeps the folder: a worktree with no
 * uncommitted change and no commit that is not on a remote is removed; any
 * other is KEPT, and named in the run's result.
 */

import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

export interface GitResult {
  code: number;
  stdout: string;
}
export type GitFn = (cwd: string, args: string[]) => Promise<GitResult>;

export const defaultGit: GitFn = (cwd, args) =>
  new Promise((resolve) => {
    execFile("git", args, { cwd, timeout: 60_000, maxBuffer: 16 * 1024 * 1024 }, (err, stdout) => {
      const code = err ? (typeof (err as { code?: unknown }).code === "number" ? (err as { code: number }).code : 1) : 0;
      resolve({ code, stdout: String(stdout ?? "") });
    });
  });

export function treeFolderFor(treesRoot: string, sessionId: string): string {
  return path.join(treesRoot, sessionId.slice(0, 8));
}

/** The run's own folder under the trees root; created owner-only. */
export function ensureTreeFolder(folder: string): void {
  fs.mkdirSync(folder, { recursive: true, mode: 0o700 });
}

export interface SweepResult {
  removed: string[];
  /** Worktrees left in place, each with why. */
  kept: { dir: string; why: string }[];
}

/**
 * Removes the run's clean worktrees. A failed check is a reason to KEEP, never
 * "clean": an unreadable status must not delete work.
 */
export async function sweepTreeFolder(folder: string, git: GitFn = defaultGit): Promise<SweepResult> {
  const out: SweepResult = { removed: [], kept: [] };
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(folder, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    const dir = path.join(folder, e.name);
    if (!e.isDirectory()) continue;
    if (!fs.existsSync(path.join(dir, ".git"))) {
      out.kept.push({ dir, why: "not a git worktree" });
      continue;
    }
    const status = await git(dir, ["status", "--porcelain"]);
    if (status.code !== 0) {
      out.kept.push({ dir, why: "git status failed" });
      continue;
    }
    if (status.stdout.trim()) {
      out.kept.push({ dir, why: "uncommitted changes" });
      continue;
    }
    // Commits reachable from HEAD that no remote-tracking ref has: unpushed work.
    const unpushed = await git(dir, ["rev-list", "--count", "HEAD", "--not", "--remotes"]);
    if (unpushed.code !== 0 || Number(unpushed.stdout.trim()) !== 0) {
      out.kept.push({ dir, why: unpushed.code !== 0 ? "git rev-list failed" : "unpushed commits" });
      continue;
    }
    const common = await git(dir, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
    if (common.code !== 0) {
      out.kept.push({ dir, why: "git-common-dir failed" });
      continue;
    }
    // Run from the main repo: git refuses to remove the worktree it is run in.
    const removed = await git(path.dirname(common.stdout.trim()), ["worktree", "remove", dir]);
    if (removed.code !== 0) out.kept.push({ dir, why: "git worktree remove refused" });
    else out.removed.push(dir);
  }
  if (!out.kept.length) {
    try {
      fs.rmdirSync(folder);
    } catch {
      /* not empty: something else is in it, leave it */
    }
  }
  return out;
}
