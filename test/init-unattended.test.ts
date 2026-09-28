/**
 * `synap init` without a person at the keyboard: CI flags, exit codes, the
 * `--json` summary, and the closing line when no agent got connected. Driven
 * end to end: the real CLI in a child process, against a fake pod on
 * loopback, with a throwaway HOME.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawn } from "child_process";
import http from "http";
import fs from "fs";
import os from "os";
import path from "path";
import type { AddressInfo } from "net";

const ROOT = path.join(__dirname, "..");
const CLI = path.join(ROOT, "src/index.ts");

let server: http.Server;
let podUrl: string;
let home: string;
const hits: string[] = [];

beforeAll(async () => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "synap-init-"));
  server = http.createServer((req, res) => {
    hits.push(`${req.method} ${req.url}`);
    if (req.url === "/health") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ status: "ok" }));
      return;
    }
    // Every agent-key mint fails: nothing can be connected.
    res.writeHead(500, { "Content-Type": "text/plain" });
    res.end("mint broken");
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  podUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(() => {
  server.close();
  fs.rmSync(home, { recursive: true, force: true });
});

function runInit(args: string[]): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ["--import", "tsx", CLI, "init", ...args], {
      cwd: ROOT,
      env: { ...process.env, HOME: home, USERPROFILE: home, NO_COLOR: "1", SYNAP_POD_URL: "" },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.stdin.end();
    child.on("error", (err) => resolve({ code: -1, stdout, stderr: String(err) }));
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

describe("synap init, unattended", () => {
  it("without a terminal and without --pod-url/--agents: exit 2 and says which flags", async () => {
    const r = await runInit(["--json"]);
    expect(r.code).toBe(2);
    expect(JSON.parse(r.stdout)).toEqual({
      exitCode: 2,
      error: "Not a terminal. Pass --pod-url and --agents claude-code,codex",
    });
  }, 30_000);

  it("an unknown agent is a usage error", async () => {
    const r = await runInit(["--pod-url", podUrl, "--agents", "codex,emacs", "--json"]);
    expect(r.code).toBe(2);
    expect(JSON.parse(r.stdout).error).toMatch(/Unknown agent: emacs/);
  }, 30_000);

  it("an unreachable pod exits 3", async () => {
    const r = await runInit(["--pod-url", "http://127.0.0.1:1", "--agents", "codex", "--json"]);
    expect(r.code).toBe(3);
    expect(JSON.parse(r.stdout)).toMatchObject({ exitCode: 3 });
  }, 30_000);

  it("no key and nobody to sign in: exit 5, never a prompt", async () => {
    const r = await runInit(["--pod-url", podUrl, "--agents", "codex", "--json"]);
    expect(r.code).toBe(5);
    expect(JSON.parse(r.stdout).error).toMatch(/--api-key/);
  }, 30_000);

  it("no agent connected: exit 6, the JSON says why, and the closing line points at connect instead of example prompts", async () => {
    const r = await runInit(["--pod-url", podUrl, "--api-key", "human-key", "--agents", "codex", "--json"]);
    expect(r.code).toBe(6);
    expect(JSON.parse(r.stdout)).toEqual({
      podUrl,
      connected: [],
      notApproved: ["codex"],
      failed: [],
      pairLink: null,
      exitCode: 6,
    });
    // Human lines went to stderr, so stdout stayed one JSON document.
    expect(r.stderr).toContain("Codex wasn't approved. Retry: synap connect --target=codex");
    expect(r.stderr).toContain("No agent connected yet. When you're ready: synap connect --target=claude-code");
    expect(r.stderr).not.toContain("Try it now");
    expect(r.stderr).toContain("Pair later, once the pod has a public URL");
    expect(hits).toContain("POST /api/hub/setup/agent");
  }, 30_000);
});
