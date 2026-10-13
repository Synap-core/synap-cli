/**
 * C1 / C3 / S3 / C2 — the doctor reads EVERY client's key file, says what it
 * could not read, sends a key only to the pod it belongs to, and `--fix`
 * reports every copy it could not rewrite.
 *
 * Seam under test: `TARGETS[*].keyStore` → `clientKeyFiles()` → the per-format
 * parsers → `checkKeyHealth` → `rewriteSurfaceKey`. Files are written where
 * `synap connect` writes them (the throwaway HOME, test/setup/temp-home.ts);
 * the pod is a stubbed fetch that records every bearer it is shown.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { TARGETS, clientKeyFiles } from "../src/lib/targets.js";
import { checkKeyHealth, fixKeyHealth, rewriteSurfaceKey, printKeyHealth } from "../src/lib/key-doctor.js";
import { tomlEntries, stripJsonc } from "../src/lib/key-locations.js";

const POD = "https://pod.example.test";
const MCP = `${POD}/mcp`;
const home = () => os.homedir();
const fileOf = (t: keyof typeof TARGETS) => {
  const ks = TARGETS[t].keyStore;
  if ("none" in ks) throw new Error(`${t} has no key file`);
  return ks.path()!;
};
const put = (file: string, text: string) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text, { mode: 0o600 });
};

let shown: string[];
let inFlight = 0;
let maxInFlight = 0;
/** Pod stub: `live` keys are active, everything else unknown. */
function pod(live: string[], opts: { statusFails?: boolean } = {}) {
  return vi.fn(async (url: string, init?: RequestInit) => {
    const bearer = String((init?.headers as Record<string, string>)?.Authorization ?? "").replace(/^Bearer /, "");
    shown.push(bearer);
    inFlight++;
    maxInFlight = Math.max(maxInFlight, inFlight);
    await new Promise((r) => setTimeout(r, 2));
    inFlight--;
    if (url.endsWith("/auth/key-state"))
      return new Response(JSON.stringify({ state: live.includes(bearer) ? "active" : "unknown", agentType: "codex" }), { status: 200 });
    if (url.endsWith("/auth/status"))
      return opts.statusFails ? new Response("{}", { status: 500 }) : new Response(JSON.stringify({ userId: "agent-1" }), { status: 200 });
    return new Response("nf", { status: 404 });
  });
}

beforeEach(() => {
  for (const d of fs.readdirSync(home())) fs.rmSync(path.join(home(), d), { recursive: true, force: true });
  shown = [];
  inFlight = 0;
  maxInFlight = 0;
});

const deps = (f: ReturnType<typeof pod>) => ({ home: home(), envKey: undefined, envPodUrl: undefined, fetch: f as never, labelOf: (s: string) => s, instanceIdFor: () => "m-x" });

describe("C1: every client file TARGETS says holds a key is read", () => {
  it("finds the key in each format: JSON (Cursor, Windsurf, VS Code, Claude Desktop args), JSONC (Zed), TOML (Codex, Grok), YAML (Goose)", async () => {
    put(fileOf("cursor"), JSON.stringify({ mcpServers: { "synap-example": { url: MCP, headers: { Authorization: "Bearer k-cursor" } } } }));
    put(fileOf("windsurf"), JSON.stringify({ mcpServers: { s: { url: `${MCP}?workspaceId=w`, headers: { Authorization: "Bearer k-windsurf" } } } }));
    put(fileOf("vscode"), JSON.stringify({ servers: { s: { type: "http", url: MCP, headers: { Authorization: "Bearer k-vscode" } } } }));
    put(fileOf("claude-desktop"), JSON.stringify({ mcpServers: { s: { command: "npx", args: ["-y", "mcp-remote", MCP, "--header", "Authorization: Bearer k-desktop"] } } }));
    put(fileOf("zed"), `{\n  // my settings — https://zed.dev\n  "context_servers": { "s": { "command": { "path": "npx", "args": ["mcp-remote@latest", "${MCP}", "--header", "Authorization: Bearer k-zed"] } }, },\n}\n`);
    put(fileOf("codex"), `model = "o3"\n\n[mcp_servers.synap]\nurl = "${MCP}"\nhttp_headers = { Authorization = "Bearer k-codex" }\n`);
    put(fileOf("grok"), `[mcp_servers.synap-example]\nurl = "${MCP}"\nheaders = { Authorization = "Bearer k-grok" }\n`);
    put(fileOf("goose"), `extensions:\n  synap:\n    name: synap\n    uri: "${MCP}"\n    headers:\n      Authorization: "Bearer k-goose"\n`);
    // Another pod's entry in the same file is NOT this pod's copy.
    put(fileOf("opencode"), JSON.stringify({ mcp: { other: { type: "remote", url: "https://pod.other.test/mcp", headers: { Authorization: "Bearer k-other" } } } }));

    const f = pod([]);
    const r = await checkKeyHealth(POD, deps(f));
    const bySurface = Object.fromEntries(r.locations.filter((l) => l.kind === "client-config").map((l) => [l.surface, l.key]));
    expect(bySurface).toEqual({
      cursor: "k-cursor",
      windsurf: "k-windsurf",
      vscode: "k-vscode",
      "claude-desktop": "k-desktop",
      zed: "k-zed",
      codex: "k-codex",
      grok: "k-grok",
      goose: "k-goose",
    });
    expect(shown).not.toContain("k-other");
    expect(r.unchecked).toEqual([]);
  });

  it("SEC-CLI: finds the key when mcp-remote carries it in env (not argv) — Claude Desktop, Raycast-style, Zed command.env", async () => {
    const args = ["-y", "mcp-remote", MCP, "--header", "Authorization:${SYNAP_AUTH}"];
    put(fileOf("claude-desktop"), JSON.stringify({ mcpServers: { s: { command: "npx", args, env: { SYNAP_AUTH: "Bearer k-desktop-env" } } } }));
    put(fileOf("zed"), JSON.stringify({ context_servers: { s: { command: { path: "npx", args, env: { SYNAP_AUTH: "Bearer k-zed-env" } } } } }));
    const r = await checkKeyHealth(POD, deps(pod([])));
    const bySurface = Object.fromEntries(r.locations.filter((l) => l.kind === "client-config").map((l) => [l.surface, l.key]));
    expect(bySurface).toEqual({ "claude-desktop": "k-desktop-env", zed: "k-zed-env" });
  });

  it("keyStore is DERIVED into the doctor's read set — every target with a key file is read", () => {
    const files = clientKeyFiles();
    const withFile = Object.values(TARGETS).filter((t) => !("none" in t.keyStore) && t.keyStore.path());
    expect(files.map((f) => f.surface).sort()).toEqual(withFile.map((t) => t.name).sort());
    expect(files.length).toBeGreaterThanOrEqual(9); // non-vacuity
  });

  it("parsers: TOML tables and JSONC comments that contain // inside strings", () => {
    expect(tomlEntries(`[mcp_servers.a]\nurl = "https://x/mcp"\nheaders = { Authorization = "Bearer z" }\n[other]\nurl = "y"`)).toEqual([{ name: "[mcp_servers.a]", url: "https://x/mcp", key: "z" }]);
    expect(JSON.parse(stripJsonc(`{"u": "https://a//b", /* c */ "v": 1, // t\n}`))).toEqual({ u: "https://a//b", v: 1 });
  });
});

describe("C3: a file that cannot be parsed is 'not checked', never ✓", () => {
  it("corrupt Cursor mcp.json and ~/.claude.json are reported by tool, not skipped", async () => {
    put(fileOf("cursor"), "{ not json");
    put(path.join(home(), ".claude.json"), "{");
    const r = await checkKeyHealth(POD, deps(pod([])));
    expect(r.unchecked!.map((u) => u.tool).sort()).toEqual(["Claude Code", "Cursor"]);
    const out: string[] = [];
    vi.spyOn(console, "log").mockImplementation((m: string) => void out.push(String(m)));
    printKeyHealth(r);
    vi.restoreAllMocks();
    expect(out.join("\n")).toMatch(/not checked: Cursor/);
  });
});

describe("S3: a key is sent only to the pod it belongs to", () => {
  it("a bare shell-rc export and a pod-less legacy agentKeys entry are never sent; one pinned to this pod is", async () => {
    put(path.join(home(), ".zshrc"), "export SYNAP_HUB_API_KEY=k-rc-unknown\n");
    put(path.join(home(), ".bashrc"), `export SYNAP_POD_URL=${POD}\nexport SYNAP_HUB_API_KEY=k-rc-this-pod\n`);
    put(path.join(home(), ".profile"), `export SYNAP_POD_URL=https://pod.other.test\nexport SYNAP_HUB_API_KEY=k-rc-other-pod\n`);
    put(path.join(home(), ".synap", "config.json"), JSON.stringify({ agentKeys: { discord: { hubApiKey: "k-legacy-nopod" } } }));
    const r = await checkKeyHealth(POD, deps(pod([])));
    expect(shown).toContain("k-rc-this-pod");
    expect(shown).not.toContain("k-rc-unknown");
    expect(shown).not.toContain("k-legacy-nopod");
    expect(shown).not.toContain("k-rc-other-pod");
    expect(r.notSent!.map((l) => l.key).sort()).toEqual(["k-legacy-nopod", "k-rc-unknown"]);
  });

  it("asks about keys ONE at a time (unknown keys cost the pod a bcrypt scan each)", async () => {
    put(path.join(home(), ".synap", "config.json"), JSON.stringify({ agentKeysByPod: Object.fromEntries(["a", "b", "c", "d"].map((s) => [s, { [POD]: { hubApiKey: `k-${s}` } }])) }));
    await checkKeyHealth(POD, deps(pod([])));
    expect(shown.length).toBe(4);
    expect(maxInFlight).toBe(1);
  });
});

describe("C2: --fix reports every copy it could not rewrite", () => {
  it("rewrites the stale copy in a JSONC file with its comments kept", async () => {
    put(path.join(home(), ".synap", "config.json"), JSON.stringify({ agentKeysByPod: { zed: { [POD]: { hubApiKey: "k-live", agentUserId: "agent-1" } } } }));
    const zed = fileOf("zed");
    put(zed, `{\n  // keep me\n  "context_servers": { "s": { "command": { "args": ["${MCP}", "--header", "Authorization: Bearer k-stale"] } } }\n}\n`);
    const f = pod(["k-live"]);
    const r = await checkKeyHealth(POD, deps(f));
    const res = await rewriteSurfaceKey(r, "zed", "k-live", "agent-1", { fetch: f as never, home: home() });
    expect(res.failed).toEqual([]);
    const after = fs.readFileSync(zed, "utf8");
    expect(after).toContain("// keep me");
    expect(after).toContain("Bearer k-live");
    expect(after).not.toContain("k-stale");
  });

  it("a copy that changed under it is a FAILED rewrite, and the fix is not ✓", async () => {
    put(path.join(home(), ".synap", "config.json"), JSON.stringify({ agentKeysByPod: { cursor: { [POD]: { hubApiKey: "k-live", agentUserId: "agent-1" } } } }));
    put(fileOf("cursor"), JSON.stringify({ mcpServers: { s: { url: MCP, headers: { Authorization: "Bearer k-stale" } } } }));
    const f = pod(["k-live"]);
    const r = await checkKeyHealth(POD, deps(f));
    put(fileOf("cursor"), JSON.stringify({ mcpServers: {} })); // edited by the person meanwhile
    const outcomes = await fixKeyHealth(r, { fetch: f as never, verify: async () => ({ ok: true }) });
    expect(outcomes).toHaveLength(1);
    expect(outcomes[0]!.ok).toBe(false);
    expect(outcomes[0]!.message).toMatch(/NOT to: .*mcp\.json/);
  });

  it("a key whose agent the pod will not name is not saved with a blank agent id", async () => {
    put(path.join(home(), ".synap", "config.json"), JSON.stringify({ agentKeysByPod: { codex: { [POD]: { hubApiKey: "k-live" } } } }));
    const f = pod(["k-live"], { statusFails: true });
    const r = await checkKeyHealth(POD, deps(f));
    await expect(rewriteSurfaceKey(r, "codex", "k-live", undefined, { fetch: f as never, home: home() })).rejects.toThrow(/whose key this is/);
    const cfg = JSON.parse(fs.readFileSync(path.join(home(), ".synap", "config.json"), "utf8"));
    expect(cfg.agentKeys).toBeUndefined();
  });
});
