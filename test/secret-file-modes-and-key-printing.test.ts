/**
 * SEC-CLI — a key never reaches stdout / argv, and a credential file is 0600
 * even when it ALREADY existed with a looser mode.
 *
 * The defects: `writeFileSync(f, d, { mode: 0o600 })` only applies the mode on
 * CREATE (an existing 0644 file stays 0644, which is how ~/.synap/config.json.bak
 * and settings.json ended up group/world-readable); `mkdirSync(..., { mode })`
 * likewise leaves an existing 0755 directory; and `synap mcp url` printed
 * `claude mcp add --header "Authorization: Bearer <key>"` + mcp-remote args
 * carrying the key (terminal scrollback, shell history, `ps`).
 *
 * Not covered: `registerClaudeCodeMcp` still hands the key to `claude mcp add`
 * in argv (the claude CLI has no stdin/env form) — deferred, see the lane report.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { writeSecretFile, ensureSecretDir, copySecretBackup } from "../src/lib/atomic-file.js";
import { printMcpConnection, redactKey } from "../src/lib/mcp-snippets.js";

const KEY = "synap_test-secret-0123456789abcdef";
const mode = (p: string) => fs.statSync(p).mode & 0o777;
const synapDir = () => path.join(os.homedir(), ".synap");

beforeEach(() => {
  fs.rmSync(synapDir(), { recursive: true, force: true });
});

describe("secret file helpers tighten what already exists", () => {
  it("writeSecretFile: an existing 0644 file ends 0600", () => {
    fs.mkdirSync(synapDir(), { recursive: true });
    const f = path.join(synapDir(), "creds.json");
    fs.writeFileSync(f, "old", { mode: 0o644 });
    fs.chmodSync(f, 0o644);
    expect(mode(f)).toBe(0o644);
    writeSecretFile(f, "new", { mode: 0o600 });
    expect(mode(f)).toBe(0o600);
    expect(fs.readFileSync(f, "utf8")).toBe("new");
  });

  it("ensureSecretDir: an existing 0755 dir ends 0700, children included", () => {
    const d = path.join(synapDir(), "contexts");
    fs.mkdirSync(d, { recursive: true, mode: 0o755 });
    fs.chmodSync(synapDir(), 0o755);
    fs.chmodSync(d, 0o755);
    ensureSecretDir(d);
    ensureSecretDir(synapDir());
    expect(mode(d)).toBe(0o700);
    expect(mode(synapDir())).toBe(0o700);
  });

  it("copySecretBackup: a 0644 source yields a 0600 .bak", () => {
    fs.mkdirSync(synapDir(), { recursive: true });
    const src = path.join(synapDir(), "mcp.json");
    fs.writeFileSync(src, "{}");
    fs.chmodSync(src, 0o644);
    copySecretBackup(src, `${src}.bak`);
    expect(mode(`${src}.bak`)).toBe(0o600);
  });

  it("no src file writes a 0o600 credential with bare fs.writeFileSync (the create-only mode trap)", () => {
    // Scope: src/lib (the credential/config writers this lane owns). The
    // `commands/{app,bridge-setup,proton-setup,worker}.ts` writers are NOT
    // scanned — outside the lane, listed in the report for a follow-up.
    const root = path.resolve(__dirname, "../src/lib");
    const files: string[] = [];
    const walk = (d: string) => {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        const p = path.join(d, e.name);
        if (e.isDirectory()) walk(p);
        else if (p.endsWith(".ts") && !p.endsWith(".test.ts")) files.push(p);
      }
    };
    walk(root);
    expect(files.length).toBeGreaterThan(30); // non-vacuity: the scan sees the tree
    const offenders: string[] = [];
    let sawHelperUse = 0;
    for (const f of files) {
      const src = fs.readFileSync(f, "utf8");
      if (src.includes("writeSecretFile(")) sawHelperUse++;
      if (f.endsWith("atomic-file.ts")) continue;
      // call text from `fs.writeFileSync(` to the first `);` — enough to see its options
      for (const m of src.matchAll(/\bfs\.writeFileSync\([\s\S]*?\);/g)) {
        if (/mode:\s*0o[67]00/.test(m[0])) offenders.push(`${path.relative(root, f)}: ${m[0].slice(0, 60)}`);
      }
    }
    expect(sawHelperUse).toBeGreaterThanOrEqual(4); // non-vacuity: the door is actually used
    expect(offenders).toEqual([]);
  });
});

describe("printMcpConnection never prints or argv-embeds the key", () => {
  it("stdout has no key; files hold it at 0600; snippets reference env", () => {
    // pre-existing loose files/dirs must be tightened
    const keysDir = path.join(synapDir(), "mcp-keys");
    fs.mkdirSync(keysDir, { recursive: true, mode: 0o755 });
    fs.chmodSync(keysDir, 0o755);
    const pre = path.join(keysDir, "agent-1.env");
    fs.writeFileSync(pre, "x");
    fs.chmodSync(pre, 0o644);

    const out: string[] = [];
    const spy = vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => void out.push(a.join(" ")));
    try {
      printMcpConnection({ url: "https://pod.test/mcp", hubApiKey: KEY, agentUserId: "agent-1" });
    } finally {
      spy.mockRestore();
    }
    const screen = out.join("\n");
    expect(screen).not.toContain(KEY);
    expect(screen).not.toContain("0123456789abcdef");
    expect(screen).toContain(redactKey(KEY));
    expect(screen).toContain("${SYNAP_MCP_KEY}"); // Claude Code command references env
    expect(screen).toContain("${SYNAP_AUTH}"); // mcp-remote header references env

    const envFile = path.join(keysDir, "agent-1.env");
    const jsonFile = path.join(keysDir, "agent-1.json");
    expect(mode(envFile)).toBe(0o600);
    expect(mode(jsonFile)).toBe(0o600);
    expect(mode(keysDir)).toBe(0o700);
    expect(fs.readFileSync(envFile, "utf8")).toContain(KEY);
    const blocks = JSON.parse(fs.readFileSync(jsonFile, "utf8"));
    // mcp-remote: the key is in env, NOT in argv
    expect(blocks.mcpRemote.mcpServers.synap.args.join(" ")).not.toContain(KEY);
    expect(blocks.mcpRemote.mcpServers.synap.env.SYNAP_AUTH).toBe(`Bearer ${KEY}`);
  });

  it("redactKey keeps only the prefix and the last four", () => {
    expect(redactKey(KEY)).toBe("synap_…cdef");
  });
});
