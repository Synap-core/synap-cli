/**
 * Codex CLI reads `~/.codex/config.toml` (TOML), not config.yaml. This test
 * pins the [mcp_servers.<name>] shape writeCodexTomlMcpServer produces — the
 * stdio mcp-remote bridge (same auth semantics as Claude Desktop/Zed) — and
 * that re-running it merges in place without clobbering unrelated config.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { writeCodexTomlMcpServer } from "../src/lib/targets.js";

let dir: string;
let configPath: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "synap-codex-toml-"));
  configPath = path.join(dir, "config.toml");
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("writeCodexTomlMcpServer", () => {
  it("writes a [mcp_servers.<name>] stdio bridge entry to a fresh config.toml", () => {
    writeCodexTomlMcpServer(configPath, "synap", {
      mcpUrl: "https://pod.example.synap.live/mcp",
      bearer: "agent-key-123",
    });

    const content = fs.readFileSync(configPath, "utf-8");
    expect(content).toContain("[mcp_servers.synap]");
    expect(content).toContain(`command = "npx"`);
    expect(content).toContain(
      'args = ["-y", "mcp-remote", "https://pod.example.synap.live/mcp", "--header", "Authorization: Bearer agent-key-123"]'
    );
    // Never Codex's actual native transport keys, since we're not confident
    // of their exact shape — keep the stdio bridge, not a half-guessed `url`.
    expect(content).not.toMatch(/^url\s*=/m);
  });

  it("merges into an existing config.toml without clobbering other tables", () => {
    fs.writeFileSync(
      configPath,
      ['[mcp_servers.other-tool]', 'command = "other"', 'args = []', ''].join("\n")
    );

    writeCodexTomlMcpServer(configPath, "synap-team", {
      mcpUrl: "https://pod.team.synap.live/mcp",
      bearer: "team-key",
    });

    const content = fs.readFileSync(configPath, "utf-8");
    expect(content).toContain("[mcp_servers.other-tool]");
    expect(content).toContain("[mcp_servers.synap-team]");
    expect(content).toContain("team-key");
  });

  it("replaces its own section in place on a second call for the same server name", () => {
    writeCodexTomlMcpServer(configPath, "synap", {
      mcpUrl: "https://pod.example.synap.live/mcp",
      bearer: "old-key",
    });
    writeCodexTomlMcpServer(configPath, "synap", {
      mcpUrl: "https://pod.example.synap.live/mcp",
      bearer: "new-key",
    });

    const content = fs.readFileSync(configPath, "utf-8");
    const occurrences = content.match(/\[mcp_servers\.synap\]/g) ?? [];
    expect(occurrences).toHaveLength(1);
    expect(content).toContain("new-key");
    expect(content).not.toContain("old-key");
  });

  it("creates the parent directory when missing", () => {
    const nested = path.join(dir, "nested", "config.toml");
    writeCodexTomlMcpServer(nested, "synap", {
      mcpUrl: "https://pod.example.synap.live/mcp",
      bearer: "agent-key",
    });
    expect(fs.existsSync(nested)).toBe(true);
  });
});
