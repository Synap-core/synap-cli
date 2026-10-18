/**
 * A stale CLI must be visible: `synap --version` and `synap doctor` name the
 * commit a build came from (2026-10-15: an Oct-11 test-branch build on the
 * devbox carried the same version number as main).
 */

import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { cliBuild, formatCliBuild } from "../src/lib/cli-build.js";

/** A package laid out like the published one: package.json + dist/lib + dist/build-info.json. */
function fakePackage(stamp?: Record<string, unknown>): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "synap-cli-build-"));
  fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ version: "9.9.9" }));
  fs.mkdirSync(path.join(root, "dist", "lib"), { recursive: true });
  if (stamp) fs.writeFileSync(path.join(root, "dist", "build-info.json"), JSON.stringify(stamp));
  return path.join(root, "dist", "lib");
}

describe("the CLI names its build", () => {
  it("a stamped build shows version, commit, branch and day — the version stays the first word", () => {
    const b = cliBuild(fakePackage({ sha: "a750d09", branch: "main", dirty: false, builtAt: "2026-10-15T11:00:00.000Z" }));
    expect(formatCliBuild(b)).toBe("9.9.9 (a750d09 main, built 2026-10-15)");
  });

  it("a build with uncommitted source says so", () => {
    const b = cliBuild(fakePackage({ sha: "0abc123", branch: "test/x", dirty: true, builtAt: "2026-10-11T08:00:00.000Z" }));
    expect(formatCliBuild(b)).toBe("9.9.9 (0abc123+changes test/x, built 2026-10-11)");
  });

  it("no stamp is said, not hidden", () => {
    expect(formatCliBuild(cliBuild(fakePackage()))).toBe(
      "9.9.9 (no build stamp: running from source or an unstamped build)"
    );
  });

  it("the build script writes the stamp the reader reads", () => {
    const script = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "scripts", "write-build-info.mjs");
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "synap-cli-stamp-"));
    fs.mkdirSync(path.join(root, "scripts"));
    fs.copyFileSync(script, path.join(root, "scripts", "write-build-info.mjs"));
    fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ version: "9.9.9" }));
    execFileSync("git", ["init", "-q"], { cwd: root });
    execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "x"], { cwd: root });
    const sha = execFileSync("git", ["rev-parse", "--short", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
    execFileSync(process.execPath, [path.join(root, "scripts", "write-build-info.mjs")]);
    const b = cliBuild(path.join(root, "dist", "lib"));
    expect(b).toMatchObject({ version: "9.9.9", sha, dirty: false });
    expect(b.builtAt).toMatch(/^\d{4}-\d\d-\d\dT/);
  });
});
