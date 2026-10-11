/**
 * `synap login` with no pod saved leads with the Synap account sign-in (it
 * finds the person's pods); adding a pod by URL is the fallback, never the
 * first question (devbox report, 2026-10-11).
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { spawn } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";

const events: string[] = [];
let answers: Record<string, unknown> = {};
vi.mock("prompts", () => ({
  default: vi.fn(async (q: { name: string; message: string }) => {
    events.push(`prompt:${q.message}`);
    return { [q.name]: answers[q.name] };
  }),
}));
vi.mock("../src/commands/init.js", () => ({
  signInAndSavePod: vi.fn(async () => (events.push("signin"), null)),
}));

beforeEach(() => {
  events.length = 0;
  vi.spyOn(console, "log").mockImplementation(() => undefined);
});

describe("podsFirstLogin", () => {
  it("signs in first; only when no pod comes of it, offers the URL path", async () => {
    answers = { how: "signin", byUrl: true, inputName: undefined };
    const { podsFirstLogin } = await import("../src/commands/pods.js");
    await podsFirstLogin();
    expect(events).toEqual([
      "prompt:Connect your pod:",
      "signin",
      "prompt:Add a pod by URL instead?",
      "prompt:Profile name for this pod:",
    ]);
  });

  it("'Add a pod by URL instead' skips the sign-in", async () => {
    answers = { how: "url", inputName: undefined };
    const { podsFirstLogin } = await import("../src/commands/pods.js");
    await podsFirstLogin();
    expect(events).toEqual(["prompt:Connect your pod:", "prompt:Profile name for this pod:"]);
  });
});

describe("synap login, no pod saved (the real CLI)", () => {
  it("first question is the account sign-in, recommended; no pod URL asked", async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "synap-login-"));
    const ROOT = path.join(__dirname, "..");
    const out = await new Promise<string>((resolve) => {
      const child = spawn(process.execPath, ["--import", "tsx", path.join(ROOT, "src/index.ts"), "login"], {
        cwd: ROOT,
        env: { ...process.env, HOME: home, USERPROFILE: home, NO_COLOR: "1", SYNAP_POD_URL: "", SYNAP_HUB_API_KEY: "" },
        stdio: ["pipe", "pipe", "pipe"],
      });
      let buf = "";
      child.stdout.on("data", (d) => (buf += d));
      child.stderr.on("data", (d) => (buf += d));
      child.stdin.end(); // nobody answers
      child.on("close", () => resolve(buf));
    });
    fs.rmSync(home, { recursive: true, force: true });
    expect(out).toMatch(/Sign in to Synap \(recommended\)/);
    expect(out.indexOf("Sign in to Synap")).toBeLessThan(out.indexOf("Add a pod by URL instead"));
    expect(out).not.toMatch(/Profile name for this pod|Pod URL:/);
  }, 30_000);
});
