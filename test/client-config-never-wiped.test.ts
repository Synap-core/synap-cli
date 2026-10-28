/**
 * F1 — `synap connect` never replaces a client's own config with `{}`.
 *
 * The defect: every client writer read its config with `try { JSON.parse }
 * catch { start fresh }` and then wrote the result back. Zed lost its whole
 * settings.json on every SECOND `synap connect zed`: the regex comment strip
 * also ate the `//` inside the `https://…/mcp` URL Synap itself had written,
 * the parse failed, and the file became one Synap entry. VS Code mcp.json
 * (comments, trailing commas) and Claude Code settings.json had the same path.
 *
 * Now: one strings-aware JSONC reader that THROWS on a file it cannot parse,
 * and one writer that copies the previous file to `<file>.synap.bak` first.
 */

import { describe, it, expect } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  stripJsonc,
  readClientConfig,
  writeClientConfig,
  clientConfigBackupPath,
  ConfigUnreadableError,
} from "../src/lib/atomic-file.js";
import { writeMcpServerEntry, setClaudeCodeMcpTransport } from "../src/lib/targets.js";

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "client-cfg-"));

/** What `synap connect zed` writes, plus the person's own settings around it. */
const ZED_AFTER_FIRST_CONNECT = `{
  // my theme
  "theme": "One Dark",
  "lsp": { "rust-analyzer": { "initialization_options": { "check": { "command": "clippy" } } } },
  "context_servers": {
    "synap-x": {
      "source": "custom",
      "command": {
        "path": "npx",
        "args": ["-y", "mcp-remote@0.1.38", "https://pod.x.synap.live/mcp", "--header", "Authorization:\${SYNAP_AUTH}"],
        "env": { "SYNAP_AUTH": "Bearer k" },
      },
      "settings": {},
    },
  },
}
`;

describe("stripJsonc keeps strings intact", () => {
  it("a URL's // survives, comments and trailing commas go", () => {
    expect(JSON.parse(stripJsonc(`{"u": "https://a//b", /* c */ "v": [1, 2,], // t\n}`))).toEqual({
      u: "https://a//b",
      v: [1, 2],
    });
  });

  it("a ',}' and a '/*' inside a string are kept", () => {
    expect(JSON.parse(stripJsonc(`{"a": "x,}", "b": "/* not a comment */", "c": "q\\"//"}`))).toEqual({
      a: "x,}",
      b: "/* not a comment */",
      c: 'q"//',
    });
  });

  it("the Zed file Synap itself writes parses on the NEXT run (the every-second-run wipe)", () => {
    const v = JSON.parse(stripJsonc(ZED_AFTER_FIRST_CONNECT)) as Record<string, any>;
    expect(v.theme).toBe("One Dark");
    expect(v.context_servers["synap-x"].command.args[2]).toBe("https://pod.x.synap.live/mcp");
  });
});

describe("readClientConfig / writeClientConfig", () => {
  it("a missing file reads as {} (the only case that may)", () => {
    expect(readClientConfig(path.join(tmp(), "absent.json"))).toEqual({});
  });

  it("an unparsable file THROWS and stays byte-identical", () => {
    const f = path.join(tmp(), "settings.json");
    const broken = '{ "theme": "One Dark", "lsp": { oops } }';
    fs.writeFileSync(f, broken);
    expect(() => readClientConfig(f)).toThrow(ConfigUnreadableError);
    expect(() => readClientConfig(f)).toThrow(/never replaces a config it cannot read/);
    expect(fs.readFileSync(f, "utf8")).toBe(broken);
  });

  it("a re-run over Zed settings keeps the person's theme and LSP, and backs the old file up", () => {
    const f = path.join(tmp(), "settings.json");
    fs.writeFileSync(f, ZED_AFTER_FIRST_CONNECT);
    for (let run = 0; run < 3; run++) {
      const s = readClientConfig<Record<string, any>>(f);
      s.context_servers["synap-x"].command.env.SYNAP_AUTH = `Bearer k${run}`;
      writeClientConfig(f, s);
    }
    const after = JSON.parse(fs.readFileSync(f, "utf8")) as Record<string, any>;
    expect(after.theme).toBe("One Dark");
    expect(after.lsp["rust-analyzer"].initialization_options.check.command).toBe("clippy");
    expect(after.context_servers["synap-x"].command.env.SYNAP_AUTH).toBe("Bearer k2");
    expect(fs.existsSync(clientConfigBackupPath(f))).toBe(true);
    expect(fs.statSync(f).mode & 0o777).toBe(0o600);
  });
});

describe("the writers refuse instead of wiping", () => {
  it("writeMcpServerEntry (Claude Desktop, Cursor, Windsurf): unparsable → throws, file untouched, no backup-and-start-fresh", () => {
    const dir = tmp();
    const f = path.join(dir, "claude_desktop_config.json");
    const broken = '{ "mcpServers": { "other": { "command": "x" } }, "globalShortcut": "Cmd+K" ';
    fs.writeFileSync(f, broken);
    expect(() => writeMcpServerEntry(f, "synap-x", { url: "https://pod.x.synap.live/mcp" })).toThrow(ConfigUnreadableError);
    expect(fs.readFileSync(f, "utf8")).toBe(broken);
    expect(fs.readdirSync(dir)).toEqual(["claude_desktop_config.json"]);
  });

  it("writeMcpServerEntry: a JSONC file with a trailing comma keeps the other servers", () => {
    const f = path.join(tmp(), "mcp.json");
    fs.writeFileSync(f, '{ "mcpServers": { "other": { "url": "https://other.example/mcp" }, }, // mine\n "theme": 1, }');
    writeMcpServerEntry(f, "synap-x", { url: "https://pod.x.synap.live/mcp" });
    const after = JSON.parse(fs.readFileSync(f, "utf8")) as Record<string, any>;
    expect(after.mcpServers.other.url).toBe("https://other.example/mcp");
    expect(after.mcpServers["synap-x"].url).toBe("https://pod.x.synap.live/mcp");
    expect(after.theme).toBe(1);
  });

  it("`synap mcp bridge` over an unparsable ~/.claude/settings.json: throws, file untouched", () => {
    const f = path.join(os.homedir(), ".claude", "settings.json");
    fs.mkdirSync(path.dirname(f), { recursive: true });
    const broken = '{ "hooks": { "Stop": [] }, "permissions": { "allow": ["Bash(ls)"], }, ';
    fs.writeFileSync(f, broken);
    expect(() => setClaudeCodeMcpTransport("bridge")).toThrow(ConfigUnreadableError);
    expect(fs.readFileSync(f, "utf8")).toBe(broken);
  });
});

describe("tripwire: no parse-or-start-fresh read left in the client writers", () => {
  it("targets.ts parses JSON only through readClientConfig (one read-only probe excepted)", () => {
    const src = fs.readFileSync(path.resolve(__dirname, "../src/lib/targets.ts"), "utf8");
    // A regex comment strip is what ate the URL's `//`.
    expect(src).not.toMatch(/\.replace\(\/\\\/\\\/\[\^\\n\]\*\/g/);
    const parses = src.match(/JSON\.parse\(/g) ?? [];
    // The one left is `claudeCodeMcpTransport`, which only reads (never writes).
    expect(parses.length).toBe(1);
    expect(src).toMatch(/export function claudeCodeMcpTransport[\s\S]{0,200}JSON\.parse\(/);
    expect(src.match(/readClientConfig\(|readClientConfig</g)?.length ?? 0).toBeGreaterThanOrEqual(7);
  });
});
