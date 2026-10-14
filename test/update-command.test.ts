/**
 * `synap update` stays a command for people who never had OpenClaw: it prints
 * how to update the CLI. The real CLI in a child process.
 */

import { describe, it, expect } from "vitest";
import { spawnSync } from "child_process";
import path from "path";

const ROOT = path.join(__dirname, "..");
const CLI = path.join(ROOT, "src/index.ts");

describe("synap update", () => {
  it("prints how to update the CLI and exits 0", () => {
    const r = spawnSync(process.execPath, ["--import", "tsx", CLI, "update"], {
      cwd: ROOT,
      encoding: "utf-8",
      env: { ...process.env, NO_COLOR: "1" },
    });
    const out = r.stdout + r.stderr;
    expect(r.status).toBe(0);
    expect(out).toContain("npm update -g @synap-core/cli");
    expect(out).toContain("npx @synap-core/cli@latest");
  }, 30_000);
});
