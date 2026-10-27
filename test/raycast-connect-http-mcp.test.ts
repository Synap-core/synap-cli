/**
 * `synap connect raycast` (decision B1, 2026-10-21): Raycast AI uses the pod's
 * own MCP server over HTTP, the extension keeps only its native commands.
 *
 * Driven through the real installer door (`installForTarget`) down to the real
 * key mint (`provisionAgentKey` → `POST /api/hub/setup/agent`); only the pod
 * (`fetch`) is faked, in a throwaway HOME (test/setup).
 *
 * Rows that rule out a wrong rule:
 *   - the mint asks for the `entry` tool surface (rules out a key that lists
 *     every tool in Raycast AI — the 9-tool starter set is the decision);
 *   - the printout names the HTTP URL and the OAuth sign-in, and points at the
 *     0600 file for the fallback header — never the key itself (rules out the
 *     old mcp-remote/stdio block and a key on screen);
 *   - the commands' key is stored for the extension (rules out dropping the
 *     native commands' credential with the AI tools).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const POD = "https://pod.raycast.example.test";
const KEY = "synap_hub_raycast-test-key-0123456789";

let mintBodies: Array<Record<string, unknown>> = [];
let lines: string[] = [];

const { installForTarget } = await import("../src/lib/targets.js");
const { getSurfaceAgentKey } = await import("../src/lib/pod.js");

beforeEach(() => {
  fs.rmSync(path.join(os.homedir(), ".synap"), { recursive: true, force: true });
  mintBodies = [];
  lines = [];
  const capture = (...a: unknown[]) => void lines.push(a.map(String).join(" "));
  vi.spyOn(console, "log").mockImplementation(capture);
  vi.spyOn(console, "error").mockImplementation(capture);
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      const u = new URL(String(url));
      if (u.origin !== POD) throw new TypeError(`unexpected call ${url}`);
      const json = (body: unknown) =>
        new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
      if (u.pathname === "/api/hub/setup/agent") {
        mintBodies.push(JSON.parse(String(init?.body ?? "{}")));
        return json({ hubApiKey: KEY, agentUserId: "agent-raycast" });
      }
      if (u.pathname === "/api/hub/workspaces/enroll-agent") return json({ enrolled: [] });
      if (u.pathname === "/api/hub/auth/key-state") return json({ state: "active" });
      throw new TypeError(`unexpected call ${url}`);
    })
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("synap connect raycast → the pod's HTTP MCP server", () => {
  it("mints the commands' key on the entry tool surface and stores it for the extension", async () => {
    const ok = await installForTarget("raycast", { podUrl: POD, apiKey: "human-key" }, { verify: false });
    expect(ok).toBe(true);
    expect(mintBodies).toHaveLength(1);
    expect(mintBodies[0]).toMatchObject({ agentType: "raycast", toolProfile: "entry" });
    expect(getSurfaceAgentKey("raycast", POD)?.hubApiKey).toBe(KEY);
  });

  it("prints the Install MCP Server form (HTTP + OAuth), never the key", async () => {
    await installForTarget("raycast", { podUrl: POD, apiKey: "human-key" }, { verify: false });
    const out = lines.join("\n");
    expect(out).toContain("Install MCP Server");
    expect(out).toContain(`URL: ${POD}/mcp`);
    expect(out).toMatch(/Transport: HTTP/);
    expect(out).toMatch(/OAuth → Dynamic → Sign In/);
    expect(out).not.toContain("mcp-remote");
    expect(out).not.toContain(KEY);

    // The fallback header's full value is in a 0600 file the printout names.
    const file = out.match(/full value: (\S+), 0600/)?.[1];
    expect(file, "the printout names the key file").toBeTruthy();
    expect(fs.readFileSync(file!, "utf8")).toContain(`Bearer ${KEY}`);
    expect(fs.statSync(file!).mode & 0o777).toBe(0o600);
  });
});
