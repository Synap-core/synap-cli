/**
 * Every place on this computer that holds a Synap key for one pod.
 *
 * A key is not "configured" in one place. `synap connect claude-code` alone
 * writes three copies (the CLI config, Claude Code's env, Claude Code's MCP
 * registry); every other client `synap connect` supports keeps its own copy in
 * its own file and format (Cursor, Codex, Windsurf, Zed, Goose, VS Code…); a
 * shell rc may export another, and the ambient `SYNAP_HUB_API_KEY` silently
 * beats the CLI profile. When the copies disagree, the one that wins is the one
 * nobody looked at — so the doctor reads all of them, and says which FILE each
 * one lives in.
 *
 * Two honesty rules:
 *  - A file it cannot read or parse is reported `unchecked` ("not checked:
 *    Zed — settings.json is not valid JSON"), never silently skipped — an
 *    unread file is not a file with no key in it.
 *  - `podKnown`: a key is sent to this pod (`/auth/key-state`) only when
 *    something ties it to THIS pod — a profile / agent key recorded for this
 *    pod URL, a client entry whose MCP URL is this pod, a shell rc / process env
 *    that also names this pod. A key with no recorded pod (an old `agentKeys`
 *    entry, a bare `export SYNAP_HUB_API_KEY`) may be another pod's secret, so it
 *    is listed but never sent.
 *
 * Read-only. The client files to read come in as `clients` (derived from
 * `TARGETS` by the caller); everything else is derived from `home`, so tests
 * run on a temp HOME and never see the person's real files.
 */

import fs from "node:fs";
import path from "node:path";
import YAML from "yaml";

export type KeyRole = "person" | "agent";

export type KeyLocationKind =
  | "profile"
  | "agent-key-by-pod"
  | "agent-key"
  | "pending"
  | "claude-settings-env"
  | "claude-mcp-header"
  /** An MCP entry in another client's own config file (Cursor, Codex, Zed…). */
  | "client-config"
  | "shell-rc"
  | "process-env";

/** How a client's config file stores its MCP servers (one parser each). */
export type KeyFileFormat = "claude-code" | "json" | "jsonc" | "toml" | "yaml-goose";

/** One client config file to read, for one agent surface. */
export interface ClientKeyFile {
  surface: string;
  /** The tool's name, for "not checked: <tool>". */
  tool: string;
  file: string;
  format: KeyFileFormat;
}

export interface KeyLocation {
  kind: KeyLocationKind;
  /** Human, ready to print: file + field. */
  label: string;
  /** The file it lives in (absent for the process environment). */
  file?: string;
  role: KeyRole;
  /** Agent surface the key belongs to (claude-code, codex, …). */
  surface?: string;
  key: string;
  /** Stored agent id, when the location records one. */
  agentUserId?: string;
  /** The doctor may rewrite this copy itself (shell rc files it never edits). */
  rewritable: boolean;
  /** Profile name, MCP server name, or line number — whatever names it inside the file. */
  ref?: string;
  /**
   * Something ties this copy to THIS pod. Default true; false = the key may be
   * another pod's, so it is never sent to this one (see the module doc).
   */
  podKnown?: boolean;
}

/** A place the doctor looked at and could NOT read — reported, never silently ✓. */
export interface UncheckedLocation {
  /** The tool or store: "Zed", "~/.synap/config.json". */
  tool: string;
  file: string;
  reason: string;
}

export interface KeyInventory {
  locations: KeyLocation[];
  unchecked: UncheckedLocation[];
}

const norm = (u: string) => u.replace(/\/+$/, "");

type Read<T> = { ok: true; value: T | null } | { ok: false; reason: string };

/** File text, `null` ONLY when it does not exist; any other failure is a reason. */
function readText(file: string): Read<string> {
  try {
    return { ok: true, value: fs.readFileSync(file, "utf8") };
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") return { ok: true, value: null };
    return { ok: false, reason: `could not be read (${code ?? (err as Error).message})` };
  }
}

/** Strip // and /* *\/ comments and trailing commas OUTSIDE strings (JSONC). */
export function stripJsonc(text: string): string {
  let out = "";
  let i = 0;
  let inStr = false;
  while (i < text.length) {
    const c = text[i]!;
    if (inStr) {
      out += c;
      if (c === "\\") {
        out += text[i + 1] ?? "";
        i += 2;
        continue;
      }
      if (c === '"') inStr = false;
      i++;
      continue;
    }
    if (c === '"') {
      inStr = true;
      out += c;
      i++;
    } else if (c === "/" && text[i + 1] === "/") {
      while (i < text.length && text[i] !== "\n") i++;
    } else if (c === "/" && text[i + 1] === "*") {
      const end = text.indexOf("*/", i + 2);
      i = end < 0 ? text.length : end + 2;
    } else {
      out += c;
      i++;
    }
  }
  return out.replace(/,(\s*[}\]])/g, "$1");
}

function readJsonObject(file: string, jsonc = false): Read<Record<string, unknown>> {
  const t = readText(file);
  if (!t.ok || t.value === null) return t as Read<Record<string, unknown>>;
  try {
    const v = JSON.parse(jsonc ? stripJsonc(t.value) : t.value) as unknown;
    if (!v || typeof v !== "object" || Array.isArray(v)) return { ok: false, reason: "is not a JSON object" };
    return { ok: true, value: v as Record<string, unknown> };
  } catch (err) {
    return { ok: false, reason: `is not valid JSON (${(err as Error).message})` };
  }
}

/** `~/…` for display. */
export function tildify(file: string, home: string): string {
  return file.startsWith(home + path.sep) ? `~${file.slice(home.length)}` : file;
}

export const SHELL_RC_FILES = [".zshrc", ".zprofile", ".zshenv", ".bashrc", ".bash_profile", ".profile", ".config/fish/config.fish"];

const assignment = (name: string) => [
  new RegExp(`^(?:export\\s+)?${name}=["']?([^"'\\s]+)["']?`),
  new RegExp(`^set\\s+-[gx]+\\s+${name}\\s+["']?([^"'\\s]+)["']?`),
];

/**
 * `SYNAP_HUB_API_KEY=…` assignments in shell rc files (export / set -x /
 * plain), each with the `SYNAP_POD_URL` the same file sets, if any.
 */
export function shellRcAssignments(home: string): Array<{ file: string; line: number; key: string; podUrl?: string }> {
  const out: Array<{ file: string; line: number; key: string; podUrl?: string }> = [];
  for (const rel of SHELL_RC_FILES) {
    const file = path.join(home, rel);
    let text: string;
    try {
      text = fs.readFileSync(file, "utf8");
    } catch {
      continue;
    }
    let podUrl: string | undefined;
    const keys: Array<{ line: number; key: string }> = [];
    text.split("\n").forEach((raw, i) => {
      const line = raw.trim();
      if (line.startsWith("#")) return;
      const k = assignment("SYNAP_HUB_API_KEY").map((r) => line.match(r)).find(Boolean);
      if (k?.[1] && !k[1].startsWith("$")) keys.push({ line: i + 1, key: k[1] });
      const p = assignment("SYNAP_POD_URL").map((r) => line.match(r)).find(Boolean);
      if (p?.[1] && !p[1].startsWith("$")) podUrl = p[1];
    });
    for (const k of keys) out.push({ file, ...k, ...(podUrl ? { podUrl } : {}) });
  }
  return out;
}

// ─── Client config parsers (one per format) ────────────────────────────────

/** One MCP entry found in a client file: its name, MCP URL and Bearer key. */
interface McpEntry {
  name: string;
  url?: string;
  key?: string;
}

const BEARER = /(?:^|Authorization:\s*)Bearer\s+([^\s"']+)/i;

/** An entry of any JSON client shape: `{url|uri|serverUrl, headers}`, mcp-remote `args`, Zed `command.args`. */
function jsonEntry(name: string, e: unknown): McpEntry {
  if (!e || typeof e !== "object") return { name };
  const o = e as Record<string, any>;
  const strings: string[] = [];
  for (const k of ["url", "uri", "serverUrl"]) if (typeof o[k] === "string") strings.push(o[k]);
  for (const args of [o.args, o.command?.args]) if (Array.isArray(args)) strings.push(...args.filter((a: unknown): a is string => typeof a === "string"));
  const headers = { ...(o.headers ?? {}), ...(o.http_headers ?? {}), ...(o.requestInit?.headers ?? {}) } as Record<string, unknown>;
  const url = strings.find((s) => /^https?:\/\//i.test(s));
  let key: string | undefined;
  for (const [h, v] of Object.entries(headers)) if (/^authorization$/i.test(h) && typeof v === "string") key ??= v.match(BEARER)?.[1];
  for (const s of strings) key ??= /Authorization:/i.test(s) ? s.match(BEARER)?.[1] : undefined;
  // mcp-remote keeps the header VALUE in env (`Authorization:${SYNAP_AUTH}` +
  // `env.SYNAP_AUTH = "Bearer <key>"`) so the key is never in argv — read it there too.
  for (const env of [o.env, o.command?.env])
    if (env && typeof env === "object")
      for (const v of Object.values(env as Record<string, unknown>)) if (typeof v === "string") key ??= v.match(BEARER)?.[1];
  return { name, url, key };
}

const JSON_CONTAINERS = ["mcpServers", "servers", "mcp", "context_servers"];

function jsonEntries(obj: Record<string, unknown>): McpEntry[] {
  const out: McpEntry[] = [];
  for (const c of JSON_CONTAINERS) {
    const box = obj[c];
    if (box && typeof box === "object" && !Array.isArray(box))
      for (const [name, e] of Object.entries(box as Record<string, unknown>)) out.push({ ...jsonEntry(name, e), name: `${c}.${name}` });
  }
  return out;
}

/** `[mcp_servers.<name>]` tables (Codex, Grok): `url = "…"` + a `Bearer …` header line. */
export function tomlEntries(text: string): McpEntry[] {
  const out: McpEntry[] = [];
  const parts = text.split(/^\s*\[([^\]\n]+)\]\s*$/m);
  for (let i = 1; i < parts.length; i += 2) {
    const header = parts[i]!.trim();
    if (!header.startsWith("mcp_servers.")) continue;
    const body = parts[i + 1] ?? "";
    out.push({
      name: `[${header}]`,
      url: body.match(/^\s*url\s*=\s*"([^"]+)"/m)?.[1],
      key: body.match(/Authorization\s*=\s*"Bearer\s+([^"\s]+)"/i)?.[1],
    });
  }
  return out;
}

/** Goose `extensions:` (YAML): `uri` + `headers.Authorization`. */
function gooseEntries(doc: unknown): McpEntry[] {
  const ext = (doc as Record<string, any> | null)?.extensions;
  if (!ext || typeof ext !== "object") return [];
  return Object.entries(ext as Record<string, unknown>).map(([name, e]) => ({ ...jsonEntry(name, e), name: `extensions.${name}` }));
}

/** The entries of one client file, or why it could not be read. */
function readClientEntries(c: ClientKeyFile): Read<McpEntry[]> {
  if (c.format === "json" || c.format === "jsonc") {
    const r = readJsonObject(c.file, c.format === "jsonc");
    return r.ok ? { ok: true, value: r.value ? jsonEntries(r.value) : null } : r;
  }
  const t = readText(c.file);
  if (!t.ok || t.value === null) return t as Read<McpEntry[]>;
  if (c.format === "toml") return { ok: true, value: tomlEntries(t.value) };
  try {
    return { ok: true, value: gooseEntries(YAML.parse(t.value)) };
  } catch (err) {
    return { ok: false, reason: `is not valid YAML (${(err as Error).message.split("\n")[0]})` };
  }
}

// ─── Collect ───────────────────────────────────────────────────────────────

export interface CollectInput {
  home: string;
  podUrl: string;
  /** `process.env.SYNAP_HUB_API_KEY` as this process sees it. */
  envKey?: string;
  envPodUrl?: string;
  /** Client config files to read (derived from `TARGETS` — `clientKeyFiles()`). */
  clients?: ClientKeyFile[];
}

export function collectKeyInventory(input: CollectInput): KeyInventory {
  const { home } = input;
  const pod = norm(input.podUrl);
  const out: KeyLocation[] = [];
  const unchecked: UncheckedLocation[] = [];
  const configFile = path.join(home, ".synap", "config.json");
  const cfgLabel = tildify(configFile, home);
  const cfgRead = readJsonObject(configFile);
  if (!cfgRead.ok) unchecked.push({ tool: "Synap CLI", file: cfgLabel, reason: cfgRead.reason });
  const cfg = (cfgRead.ok ? cfgRead.value : null) ?? {};
  const onPod = (u?: string) => !!u && norm(u) === pod;
  const isPodMcp = (u?: string) => !!u && (norm(u) === `${pod}/mcp` || norm(u).startsWith(`${pod}/mcp?`) || norm(u).startsWith(`${pod}/mcp/`));

  // 1. Pod profiles (the person's / this computer's own key) for this pod.
  const pods = (cfg.pods ?? {}) as Record<string, { podUrl?: string; hubApiKey?: string }>;
  for (const [name, p] of Object.entries(pods)) {
    if (onPod(p?.podUrl) && p.hubApiKey)
      out.push({ kind: "profile", label: `${cfgLabel} → pods.${name}`, file: configFile, role: "person", key: p.hubApiKey, rewritable: false, ref: name, podKnown: true });
  }

  // 2. Agent keys per surface: by pod (truth), legacy last-write, pending requests.
  type Stored = { hubApiKey?: string; agentUserId?: string; podUrl?: string };
  const byPod = (cfg.agentKeysByPod ?? {}) as Record<string, Record<string, Stored>>;
  for (const [surface, map] of Object.entries(byPod)) {
    const hit = map?.[pod] ?? Object.entries(map ?? {}).find(([u]) => norm(u) === pod)?.[1];
    if (hit?.hubApiKey)
      out.push({ kind: "agent-key-by-pod", label: `${cfgLabel} → agentKeysByPod.${surface}`, file: configFile, role: "agent", surface, key: hit.hubApiKey, agentUserId: hit.agentUserId, rewritable: true, podKnown: true });
  }
  const legacy = (cfg.agentKeys ?? {}) as Record<string, Stored>;
  for (const [surface, k] of Object.entries(legacy)) {
    if (!k?.hubApiKey) continue;
    if (k.podUrl && !onPod(k.podUrl)) continue;
    // No recorded pod: it may be another pod's key — listed, never sent.
    out.push({ kind: "agent-key", label: `${cfgLabel} → agentKeys.${surface}`, file: configFile, role: "agent", surface, key: k.hubApiKey, agentUserId: k.agentUserId, rewritable: true, podKnown: !!k.podUrl });
  }
  const pending = (cfg.pendingAgentKeys ?? {}) as Record<string, Record<string, Stored>>;
  for (const [surface, map] of Object.entries(pending)) {
    const hit = map?.[pod];
    if (hit?.hubApiKey)
      out.push({ kind: "pending", label: `${cfgLabel} → pendingAgentKeys.${surface}`, file: configFile, role: "agent", surface, key: hit.hubApiKey, agentUserId: hit.agentUserId, rewritable: true, podKnown: true });
  }

  // 3. Each client's own config file — one parser per format.
  for (const c of input.clients ?? []) {
    const shown = tildify(c.file, home);
    if (c.format === "claude-code") {
      // Claude Code: its env block (the ambient SYNAP_HUB_API_KEY inside every
      // Claude session) and its MCP registry headers in ~/.claude.json.
      const settings = readJsonObject(c.file);
      if (!settings.ok) unchecked.push({ tool: c.tool, file: shown, reason: settings.reason });
      const env = ((settings.ok && settings.value?.env) || {}) as Record<string, string>;
      if (env.SYNAP_HUB_API_KEY && (!env.SYNAP_POD_URL || onPod(env.SYNAP_POD_URL)))
        out.push({ kind: "claude-settings-env", label: `${shown} → env.SYNAP_HUB_API_KEY`, file: c.file, role: "agent", surface: c.surface, key: env.SYNAP_HUB_API_KEY, rewritable: true, podKnown: onPod(env.SYNAP_POD_URL) });
      const claudeJsonFile = path.join(home, ".claude.json");
      const claudeJson = readJsonObject(claudeJsonFile);
      if (!claudeJson.ok) unchecked.push({ tool: c.tool, file: tildify(claudeJsonFile, home), reason: claudeJson.reason });
      const servers = ((claudeJson.ok && claudeJson.value?.mcpServers) || {}) as Record<string, unknown>;
      for (const [name, s] of Object.entries(servers)) {
        const e = jsonEntry(name, s);
        if (isPodMcp(e.url) && e.key)
          out.push({ kind: "claude-mcp-header", label: `${tildify(claudeJsonFile, home)} → mcpServers.${name}`, file: claudeJsonFile, role: "agent", surface: c.surface, key: e.key, rewritable: true, ref: name, podKnown: true });
      }
      continue;
    }
    const r = readClientEntries(c);
    if (!r.ok) {
      unchecked.push({ tool: c.tool, file: shown, reason: r.reason });
      continue;
    }
    for (const e of r.value ?? []) {
      if (!isPodMcp(e.url) || !e.key) continue;
      out.push({ kind: "client-config", label: `${shown} → ${e.name}`, file: c.file, role: "agent", surface: c.surface, key: e.key, rewritable: true, ref: e.name, podKnown: true });
    }
  }

  // 4. Shell rc exports, and the process environment itself. A file that pins
  //    ANOTHER pod is that pod's business; one that pins none is unknown.
  for (const a of shellRcAssignments(home)) {
    if (a.podUrl && !onPod(a.podUrl)) continue;
    out.push({ kind: "shell-rc", label: `${tildify(a.file, home)}:${a.line}`, file: a.file, role: "agent", key: a.key, rewritable: false, ref: String(a.line), podKnown: onPod(a.podUrl) });
  }
  if (input.envKey && (!input.envPodUrl || onPod(input.envPodUrl)))
    out.push({ kind: "process-env", label: "SYNAP_HUB_API_KEY (this shell)", role: "agent", key: input.envKey, rewritable: false, podKnown: onPod(input.envPodUrl) });

  return { locations: out, unchecked };
}

/** The locations only (see {@link collectKeyInventory}). */
export function collectKeyLocations(input: CollectInput): KeyLocation[] {
  return collectKeyInventory(input).locations;
}

/**
 * The keys this pod may be asked about: those with at least one copy tied to
 * this pod. Every other key stays on this computer.
 */
export function keysToProbe(locations: KeyLocation[]): string[] {
  return [...new Set(locations.filter((l) => l.podKnown !== false).map((l) => l.key))];
}

/**
 * Which file(s) put the process env key there — the settings env Claude Code
 * injects, or a shell rc. Empty = set by something the doctor cannot see.
 */
export function envKeySetBy(locations: KeyLocation[], envKey: string): KeyLocation[] {
  return locations.filter((l) => (l.kind === "claude-settings-env" || l.kind === "shell-rc") && l.key === envKey);
}
