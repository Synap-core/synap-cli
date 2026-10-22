/**
 * `registerClaudeCodeMcp` against a mocked `claude` binary. Rows where a looser
 * registration disagrees: `-e` is variadic in Claude Code's CLI, so the server
 * name must precede it (else `use-bridge` removes the entry and the add dies
 * with "Invalid environment variable format"); and when the add fails, the
 * hand-registration hint must match the transport being registered, never leak
 * the key, and say the server may now be unregistered.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const exec = vi.hoisted(() => vi.fn());
vi.mock("node:child_process", async (orig) => ({
  ...(await orig<typeof import("node:child_process")>()),
  execFileSync: exec,
}));

import { registerClaudeCodeMcp } from "./targets.js";
import { log } from "../utils/logger.js";

const KEY = "synap_test_key_0123456789";
const URL = "https://pod.example.test/mcp";
let home: string;

function useTransport(transport: "http" | "bridge"): void {
  fs.mkdirSync(path.join(home, ".claude"), { recursive: true });
  fs.writeFileSync(
    path.join(home, ".claude", "settings.json"),
    JSON.stringify({ env: transport === "bridge" ? { SYNAP_MCP_TRANSPORT: "bridge" } : {} })
  );
}

function addCall(): string[] {
  const call = exec.mock.calls.find((c) => c[1][1] === "add");
  if (!call) throw new Error("no `claude mcp add` call");
  return call[1] as string[];
}

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "synap-reg-"));
  vi.spyOn(os, "homedir").mockReturnValue(home);
  vi.spyOn(log, "dim").mockImplementation(() => {});
  vi.spyOn(log, "success").mockImplementation(() => {});
  exec.mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(home, { recursive: true, force: true });
});

describe("registerClaudeCodeMcp", () => {
  it("bridge add puts the server name before the variadic -e", () => {
    useTransport("bridge");
    registerClaudeCodeMcp(URL, KEY, "synap-test");
    const args = addCall();
    expect(args.indexOf("synap-test")).toBeLessThan(args.indexOf("-e"));
    expect(args[args.indexOf("-e") + 1]).toBe(`SYNAP_MCP_API_KEY=${KEY}`);
    expect(args.indexOf("--")).toBeGreaterThan(args.indexOf("-e"));
  });

  it("a failed bridge add prints the stdio form, not http, and never the key", () => {
    useTransport("bridge");
    exec.mockImplementation((_bin: string, args: string[]) => {
      if (args[1] === "add") throw new Error("boom");
    });
    registerClaudeCodeMcp(URL, KEY, "synap-test");
    const printed = vi.mocked(log.dim).mock.calls.map((c) => String(c[0])).join("\n");
    expect(printed).toContain("claude mcp add --scope user synap-test -e SYNAP_MCP_API_KEY=");
    expect(printed).not.toContain("--transport http");
    expect(printed).toContain("UNREGISTERED");
    expect(printed).not.toContain(KEY);
  });

  it("a failed http add still prints the http form", () => {
    useTransport("http");
    exec.mockImplementation((_bin: string, args: string[]) => {
      if (args[1] === "add") throw new Error("boom");
    });
    registerClaudeCodeMcp(URL, KEY, "synap-test");
    const printed = vi.mocked(log.dim).mock.calls.map((c) => String(c[0])).join("\n");
    expect(printed).toContain("--transport http synap-test");
    expect(printed).not.toContain(KEY);
  });
});
