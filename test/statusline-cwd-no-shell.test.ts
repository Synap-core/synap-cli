/**
 * F9 — `synap statusline` reads the git branch of Claude Code's cwd with no shell.
 *
 * The defect: `execSync(\`git -C ${JSON.stringify(cwd)} …\`)`. JSON quoting is
 * double quoting, and sh still expands `$(…)`, backticks and `$VAR` inside
 * double quotes, so a directory named `x$(…)` ran its command on every
 * statusline refresh. The fix hands the path to git as one argv word.
 */

import { describe, it, expect, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { gitBranchOf } from "../src/commands/statusline.js";

const made: string[] = [];
afterEach(() => {
  delete process.env.SYNAP_STATUSLINE_PROOF;
  for (const d of made.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

function tmp(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "synap-sl-"));
  made.push(d);
  return d;
}

describe("statusline git branch", () => {
  it("never runs a command substitution in the directory name", () => {
    const base = tmp();
    const proof = path.join(base, "INJECTED");
    // A directory name cannot hold "/", so the payload reads its target from the env.
    process.env.SYNAP_STATUSLINE_PROOF = proof;
    for (const name of ["x$(touch $SYNAP_STATUSLINE_PROOF)", "y`touch $SYNAP_STATUSLINE_PROOF`"]) {
      const dir = path.join(base, name);
      fs.mkdirSync(dir);
      expect(gitBranchOf(dir)).toBe(""); // not a repo
      expect(fs.existsSync(proof)).toBe(false);
    }
  });

  it("still reads the branch of a real repo whose path has shell characters", () => {
    const dir = path.join(tmp(), "repo $HOME `x`");
    fs.mkdirSync(dir);
    execFileSync("git", ["init", "-q", "-b", "lane-probe", dir]);
    expect(gitBranchOf(dir)).toBe("lane-probe");
  });

  it("the statusline module holds no shell-string git call", () => {
    const src = fs.readFileSync(path.resolve(__dirname, "../src/commands/statusline.ts"), "utf8");
    expect(src).toMatch(/execFileSync\("git"/); // non-vacuity: the call is still there
    expect(src).not.toMatch(/execSync\(/);
  });
});
