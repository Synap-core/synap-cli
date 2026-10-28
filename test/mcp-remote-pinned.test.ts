/**
 * F2 — every stdio-bridge entry Synap writes runs ONE exact mcp-remote version,
 * and the agent key is in env, never in argv.
 *
 * The defect: Zed ran `npx -y mcp-remote@latest` and Claude Desktop (connect,
 * `synap pods use`) a bare `npx -y mcp-remote`, with the agent key in its env
 * (or, from `pods use`, in its argv). `npx -y` executes whatever npm serves
 * at each client launch: one bad publish of a third-party package = every
 * user's key and machine. The package changed maintainer in 2026-08.
 */

import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { MCP_REMOTE_PACKAGE, mcpRemoteArgs, mcpClientBlocks } from "../src/lib/mcp-snippets.js";

const SRC = path.resolve(__dirname, "../src");

function walk(d: string, out: string[] = []): string[] {
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (p.endsWith(".ts") && !p.endsWith(".test.ts")) out.push(p);
  }
  return out;
}

describe("mcp-remote is pinned", () => {
  it("the one spec is an exact version", () => {
    expect(MCP_REMOTE_PACKAGE).toMatch(/^mcp-remote@\d+\.\d+\.\d+$/);
  });

  it("the args carry the pinned spec and read the header value from env", () => {
    const args = mcpRemoteArgs("https://pod.x.synap.live/mcp");
    expect(args).toEqual(["-y", MCP_REMOTE_PACKAGE, "https://pod.x.synap.live/mcp", "--header", "Authorization:${SYNAP_AUTH}"]);
    const block = mcpClientBlocks("https://pod.x.synap.live/mcp", "k-secret").mcpRemote.mcpServers.synap;
    expect(block.args).toContain(MCP_REMOTE_PACKAGE);
    expect(block.args.join(" ")).not.toContain("k-secret");
    expect(block.env.SYNAP_AUTH).toBe("Bearer k-secret");
  });

  it("no source file names mcp-remote as an npx argument except through the constant", () => {
    const files = walk(SRC);
    expect(files.length).toBeGreaterThan(60); // non-vacuity: the scan sees the tree
    const offenders: string[] = [];
    for (const f of files) {
      const lines = fs.readFileSync(f, "utf8").split("\n");
      lines.forEach((line, i) => {
        if (/^\s*(\/\/|\*|\/\*)/.test(line)) return; // comments
        // A quoted "mcp-remote…" / `mcp-remote…` token is an argument; prose in comments and log text is not.
        if (/["'`]mcp-remote(@[^"'`]*)?["'`]/.test(line) && !line.includes("MCP_REMOTE_PACKAGE =")) {
          offenders.push(`${path.relative(SRC, f)}:${i + 1}: ${line.trim()}`);
        }
        if (/-y mcp-remote[ @]/.test(line)) offenders.push(`${path.relative(SRC, f)}:${i + 1}: ${line.trim()}`);
      });
    }
    expect(offenders).toEqual([]);
  });

  it("no source file puts a Bearer key into mcp-remote argv", () => {
    const offenders = walk(SRC).filter((f) => /args:\s*\[[^\]]*mcp-remote[^\]]*Bearer \$\{/.test(fs.readFileSync(f, "utf8")));
    expect(offenders).toEqual([]);
  });
});
