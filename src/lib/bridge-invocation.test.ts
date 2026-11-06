/**
 * Which CLI the claude-code MCP bridge entry names (`resolveBridgeInvocation`).
 * On 2026-11-02 `~/.claude.json` named `node …/synap-cli/dist/index.js mcp
 * bridge`: the global `synap` was an `npm link` of a checkout, and the
 * registration wrote the link's RESOLVED target, so installing a release never
 * reached the bridge. These rows build each install shape on disk and pin what
 * gets registered: the bin npm installed, never what it resolves to.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { bridgeInvocationNote, resolveBridgeInvocation } from "./targets.js";

const NODE = "/usr/local/bin/node";
let tmp: string;

function file(p: string): string {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, "#!/usr/bin/env node\n");
  return p;
}

function link(target: string, at: string): string {
  fs.mkdirSync(path.dirname(at), { recursive: true });
  fs.symlinkSync(target, at);
  return at;
}

/** `npm i -g @synap-core/cli` under `<tmp>/prefix`: the package dir plus its bin link. */
function globalInstall(): { bin: string; entry: string } {
  const entry = file(path.join(tmp, "prefix", "lib", "node_modules", "@synap-core", "cli", "dist", "index.js"));
  const bin = link("../lib/node_modules/@synap-core/cli/dist/index.js", path.join(tmp, "prefix", "bin", "synap"));
  return { bin, entry };
}

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "synap-bridge-inv-"));
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe("resolveBridgeInvocation", () => {
  it("an npm install run from its bin registers the bin, not the resolved dist path", () => {
    const { bin } = globalInstall();
    const inv = resolveBridgeInvocation(bin, NODE);
    expect(inv.kind).toBe("installed");
    expect(inv.command).toEqual([NODE, bin]);
    expect(bridgeInvocationNote(inv)).toBeNull();
  });

  it("an npm install run through its package path still registers the bin next to it", () => {
    const { bin, entry } = globalInstall();
    const inv = resolveBridgeInvocation(entry, NODE);
    expect(inv.kind).toBe("installed");
    expect(inv.command).toEqual([NODE, bin]);
  });

  it("a global install that links a checkout registers the bin, and says it is a checkout", () => {
    const checkoutEntry = file(path.join(tmp, "checkout", "synap-cli", "dist", "index.js"));
    link(path.join(tmp, "checkout", "synap-cli"), path.join(tmp, "prefix", "lib", "node_modules", "@synap-core", "cli"));
    const bin = link("../lib/node_modules/@synap-core/cli/dist/index.js", path.join(tmp, "prefix", "bin", "synap"));
    const inv = resolveBridgeInvocation(bin, NODE);
    expect(inv.kind).toBe("linked");
    expect(inv.command).toEqual([NODE, bin]);
    const note = bridgeInvocationNote(inv) ?? "";
    expect(note).toContain(fs.realpathSync(checkoutEntry));
    expect(note).toContain("npm install -g @synap-core/cli@next");
  });

  it("a checkout build run directly is kept, and said", () => {
    const entry = file(path.join(tmp, "checkout", "synap-cli", "dist", "index.js"));
    const inv = resolveBridgeInvocation(entry, NODE);
    expect(inv.kind).toBe("checkout");
    expect(inv.command).toEqual([NODE, fs.realpathSync(entry)]);
    expect(bridgeInvocationNote(inv)).toContain("checkout build");
  });

  it("a throwaway npx copy falls back to the synap on PATH", () => {
    const entry = file(path.join(tmp, "_npx", "abc", "node_modules", "@synap-core", "cli", "dist", "index.js"));
    expect(resolveBridgeInvocation(entry, NODE)).toEqual({ kind: "npx", command: ["synap"] });
  });
});
