/**
 * Where an agent TEMPLATE's program reads its MCP servers (`spec.mcp`), and
 * the one writer that puts the pod's server there, so `synap agents add
 * <slug>` leaves the program connected with no hand edit (Hermes first).
 *
 * The template says it as data, never as a command:
 *
 *   spec:
 *     mcp:
 *       config: "~/.hermes/config.yaml"   # under the person's home, always
 *       format: yaml                      # yaml | json
 *       key: mcp_servers                  # the map the server goes under (dot path)
 *       entry: url-headers                # { url, headers: { Authorization: "Bearer <key>" } }
 *
 * The file holds the agent's key afterwards, so it is written 0600, atomically,
 * and the rest of it is kept (YAML comments included).
 */

import fs from "node:fs";
import path from "node:path";
import { parseDocument } from "yaml";
import { writeFileAtomic } from "./atomic-file.js";

export const MCP_CONFIG_FORMATS = ["yaml", "json"] as const;
export const MCP_ENTRY_SHAPES = ["url-headers"] as const;

export interface AgentMcpSpec {
  /** `~/…`: a file under the person's home. */
  config: string;
  format: (typeof MCP_CONFIG_FORMATS)[number];
  /** Dot path of the map the server goes under (`mcp_servers`, `mcp.servers`). */
  key: string;
  entry: (typeof MCP_ENTRY_SHAPES)[number];
}

/**
 * `spec.mcp` read strictly: `null` when the template declares none; a block
 * that is not one THROWS (a template that says where its config lives but
 * cannot be read is not "no config").
 */
export function parseMcpSpec(slug: string, raw: unknown): AgentMcpSpec | null {
  if (raw == null) return null;
  const m = raw as Partial<Record<keyof AgentMcpSpec, unknown>>;
  const bad = (why: string) => new Error(`The agent template "${slug}" declares an MCP config Synap cannot use: ${why}.`);
  if (typeof m.config !== "string" || !m.config.startsWith("~/")) throw bad("`config` must be a path under ~/");
  if (!MCP_CONFIG_FORMATS.includes(m.format as AgentMcpSpec["format"])) throw bad(`\`format\` must be ${MCP_CONFIG_FORMATS.join(" or ")}`);
  if (typeof m.key !== "string" || !/^[A-Za-z0-9_-]+(\.[A-Za-z0-9_-]+)*$/.test(m.key)) throw bad("`key` must be a dot path");
  const entry = m.entry ?? "url-headers";
  if (!MCP_ENTRY_SHAPES.includes(entry as AgentMcpSpec["entry"])) throw bad(`\`entry\` must be ${MCP_ENTRY_SHAPES.join(" or ")}`);
  return { config: m.config, format: m.format as AgentMcpSpec["format"], key: m.key, entry: entry as AgentMcpSpec["entry"] };
}

/** The config file, resolved under `home`. A path that leaves home THROWS. */
export function mcpConfigPath(spec: AgentMcpSpec, home: string): string {
  const file = path.resolve(home, spec.config.slice(2));
  if (!file.startsWith(path.resolve(home) + path.sep)) {
    throw new Error(`The MCP config "${spec.config}" is not under your home folder: refused.`);
  }
  return file;
}

export type McpWriteChange = "added" | "updated" | "unchanged";

/**
 * Put the pod's MCP server (`serverName`) in the program's own config, the
 * rest of the file kept. Returns the file and what changed.
 */
export function writeTemplateMcp(
  spec: AgentMcpSpec,
  server: { home: string; serverName: string; url: string; apiKey: string }
): { file: string; change: McpWriteChange } {
  const file = mcpConfigPath(spec, server.home);
  const entry = { url: server.url, headers: { Authorization: `Bearer ${server.apiKey}` } };
  const keyPath = [...spec.key.split("."), server.serverName];
  let before: string | null = null;
  try {
    before = fs.readFileSync(file, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }

  let after: string;
  let existed: boolean;
  if (spec.format === "yaml") {
    const doc = parseDocument(before ?? "");
    if (doc.errors.length) throw new Error(`${file} is not valid YAML (${doc.errors[0].message}): fix it, then run this again.`);
    existed = doc.hasIn(keyPath);
    doc.setIn(keyPath, doc.createNode(entry));
    after = doc.toString();
  } else {
    let obj: Record<string, unknown>;
    try {
      obj = before?.trim() ? (JSON.parse(before) as Record<string, unknown>) : {};
    } catch (err) {
      throw new Error(`${file} is not valid JSON (${(err as Error).message}): fix it, then run this again.`);
    }
    let node: Record<string, unknown> = obj;
    for (const k of keyPath.slice(0, -1)) {
      const next = node[k];
      if (next == null) node[k] = {};
      else if (typeof next !== "object" || Array.isArray(next)) throw new Error(`${file}: "${k}" is not a map, so the server cannot go under it.`);
      node = node[k] as Record<string, unknown>;
    }
    existed = keyPath[keyPath.length - 1] in node;
    node[keyPath[keyPath.length - 1]] = entry;
    after = `${JSON.stringify(obj, null, 2)}\n`;
  }
  if (before === after) return { file, change: "unchanged" };
  // It holds the agent's key now: owner-only, atomically, whatever mode it had.
  writeFileAtomic(file, after, { mode: 0o600 });
  return { file, change: existed ? "updated" : "added" };
}
