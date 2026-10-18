#!/usr/bin/env node
/**
 * Stamp the build: `dist/build-info.json` = which commit this `dist` was
 * compiled from. Run by `build`, read by `src/lib/cli-build.ts`, shown by
 * `synap --version` and `synap doctor`.
 *
 * Why: on 2026-10-15 the devbox ran an Oct-11 build from a test branch, and
 * nothing it printed could tell it apart from current main — the version
 * number was the same. A version names a release; only the commit names a
 * build. Outside a git checkout (or without git) the stamp is the date alone.
 */

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const git = (...args) => {
  try {
    return execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return undefined;
  }
};

const sha = git("rev-parse", "--short", "HEAD");
const info = { builtAt: new Date().toISOString() };
if (sha) {
  info.sha = sha;
  const branch = git("rev-parse", "--abbrev-ref", "HEAD");
  if (branch && branch !== "HEAD") info.branch = branch;
  // Uncommitted changes under src/ mean the build is not exactly `sha`.
  info.dirty = (git("status", "--porcelain", "--", "src") ?? "") !== "";
}

fs.mkdirSync(path.join(root, "dist"), { recursive: true });
fs.writeFileSync(path.join(root, "dist", "build-info.json"), JSON.stringify(info, null, 2) + "\n");
