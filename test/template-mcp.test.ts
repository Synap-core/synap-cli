/**
 * `synap agents add <slug>` for a catalog agent template that says where its
 * program reads MCP servers (`spec.mcp`, Hermes first): the pod's server is
 * written there, the rest of the file kept, owner-only, and nothing outside
 * the person's home is ever written.
 */

import { beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parse as parseYaml } from "yaml";
import { mcpConfigPath, parseMcpSpec, writeTemplateMcp, type AgentMcpSpec } from "../src/lib/template-mcp.js";
import { readAgentTemplateWake } from "../src/lib/agent-template.js";
import { writeTemplateMcpFor } from "../src/lib/agent-door.js";

let home: string;
const HERMES: AgentMcpSpec = { config: "~/.hermes/config.yaml", format: "yaml", key: "mcp_servers", entry: "url-headers" };
const server = () => ({ home, serverName: "synap-me", url: "https://pod.me.synap.live/mcp", apiKey: "sk-agent-1" });

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "template-mcp-"));
});

describe("writeTemplateMcp", () => {
  it("adds the server under the template's key, keeps the rest of a YAML config and its comments, 0600", () => {
    const file = path.join(home, ".hermes", "config.yaml");
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, "# my settings\nmodel: hermes-4\nmcp_servers:\n  github:\n    command: gh-mcp\n", { mode: 0o644 });

    expect(writeTemplateMcp(HERMES, server())).toEqual({ file, change: "added" });
    const text = fs.readFileSync(file, "utf8");
    expect(text).toContain("# my settings");
    expect(parseYaml(text)).toEqual({
      model: "hermes-4",
      mcp_servers: {
        github: { command: "gh-mcp" },
        "synap-me": { url: "https://pod.me.synap.live/mcp", headers: { Authorization: "Bearer sk-agent-1" } },
      },
    });
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);

    // Again: nothing to change. A new key: updated in place.
    expect(writeTemplateMcp(HERMES, server()).change).toBe("unchanged");
    expect(writeTemplateMcp(HERMES, { ...server(), apiKey: "sk-agent-2" }).change).toBe("updated");
    expect(parseYaml(fs.readFileSync(file, "utf8")).mcp_servers["synap-me"].headers.Authorization).toBe("Bearer sk-agent-2");
  });

  it("creates the file when there is none, and writes JSON under a dot path", () => {
    expect(writeTemplateMcp(HERMES, server()).change).toBe("added");
    const json: AgentMcpSpec = { config: "~/.x/settings.json", format: "json", key: "mcp.servers", entry: "url-headers" };
    const { file } = writeTemplateMcp(json, server());
    expect(JSON.parse(fs.readFileSync(file, "utf8"))).toEqual({
      mcp: { servers: { "synap-me": { url: "https://pod.me.synap.live/mcp", headers: { Authorization: "Bearer sk-agent-1" } } } },
    });
  });

  it("never writes outside home, and refuses a config it cannot read", () => {
    expect(() => mcpConfigPath({ ...HERMES, config: "~/../etc/passwd" }, home)).toThrow(/not under your home/);
    const file = path.join(home, ".hermes", "config.yaml");
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, "a: [unclosed\n");
    expect(() => writeTemplateMcp(HERMES, server())).toThrow(/not valid YAML/);
    expect(fs.readFileSync(file, "utf8")).toBe("a: [unclosed\n");
  });
});

describe("spec.mcp on a template", () => {
  it("is read strictly: none is null, a malformed one throws", () => {
    expect(parseMcpSpec("x", undefined)).toBeNull();
    expect(parseMcpSpec("x", { config: "~/.x/c.yaml", format: "yaml", key: "mcp_servers" })).toEqual({
      config: "~/.x/c.yaml",
      format: "yaml",
      key: "mcp_servers",
      entry: "url-headers",
    });
    expect(() => parseMcpSpec("x", { config: "/etc/c.yaml", format: "yaml", key: "k" })).toThrow(/under ~\//);
    expect(() => parseMcpSpec("x", { config: "~/c.toml", format: "toml", key: "k" })).toThrow(/format/);
    expect(() => parseMcpSpec("x", { config: "~/c.yaml", format: "yaml", key: "a b" })).toThrow(/dot path/);
  });

  it("rides the template read beside its wake", () => {
    const root = path.join(home, "catalog");
    fs.mkdirSync(path.join(root, "agents"), { recursive: true });
    fs.writeFileSync(
      path.join(root, "agents", "hermes.agent.yaml"),
      `apiVersion: synap/v1
kind: agent
meta: { slug: hermes, name: Hermes }
spec:
  harness: hermes
  worker: true
  wake: { program: hermes, args: ["chat", "-q", "{prompt}"] }
  mcp: { config: "~/.hermes/config.yaml", format: yaml, key: mcp_servers }
`
    );
    expect(readAgentTemplateWake("hermes", root)?.mcp).toEqual(HERMES);
  });

  it("agents add writes it only for a type whose catalog template declares one (the installed catalog)", () => {
    // claude-code's template declares no spec.mcp (its config is written by its own installer): nothing to do.
    expect(writeTemplateMcpFor("claude-code", "https://pod.me.synap.live", {}, "k", home)).toBeNull();
    // A type the catalog does not name: nothing to do.
    expect(writeTemplateMcpFor("acme-bot", "https://pod.me.synap.live", {}, "k", home)).toBeNull();
  });
});
