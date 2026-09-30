import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Regression: the Codex MCP block shipped `headers = { ... }`, which Codex does
 * not recognise. Its TOML schema (extracted from the Codex binary's
 * `RawMcpServerConfig`) is `http_headers`; `headers` parses fine and is then
 * silently ignored, so the pod receives no Authorization header and 401s while
 * `codex mcp list` still reports the server as "enabled".
 *
 * The failure was invisible for a long time because:
 *   - the field is not rejected (Codex reports `Auth: Unknown`, not a parse error)
 *   - `bearer_token_env_var` is a NAME lookup — a token pasted there also "parses"
 *   - the pod endpoint itself is healthy, so the wrongness is purely local
 *
 * This is a source-level guard: it pins the field name we EMIT, which is the
 * only place the bug can re-enter. It does NOT assert that Codex accepts it —
 * only the real `codex mcp list` proves that (see the fix commit).
 */
const readSrc = (rel: string) =>
  readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf-8");

describe("Codex MCP TOML uses Codex's real auth field", () => {
  const targets = readSrc("../src/lib/targets.ts");

  it("installCodex writes http_headers, not headers", () => {
    const block = targets.slice(targets.indexOf("async function installCodex"));
    expect(block).toContain(
      '`http_headers = { Authorization = "Bearer ${effectiveApiKey}" }`',
    );
    // The un-prefixed name is the whole bug: it parses and is then ignored.
    expect(block).not.toContain('`headers = { Authorization');
  });

  it("does not write `type = \"http\"` — Codex derives transport from `url`", () => {
    const block = targets.slice(targets.indexOf("async function installCodex"));
    expect(block).not.toContain("type = \"http\"");
  });

  it("the mcp command's printed guidance matches the writer", () => {
    const mcpCmd = readSrc("../src/commands/mcp.ts");
    const codex = mcpCmd.slice(mcpCmd.indexOf("codex: {"));
    expect(codex).toContain('"http_headers": `{ Authorization = "Bearer ${hubApiKey}" }`');
    // Two doors printing different fields is how the original went unnoticed.
    expect(codex).not.toContain('"headers": `{ Authorization = "Bearer');
  });

  it("never routes a token through bearer_token_env_var (that field is a NAME)", () => {
    // Codex resolves this as an env-var NAME at runtime. A pasted token is a
    // lookup that always misses, so the request goes out unauthenticated.
    expect(targets).not.toContain("bearer_token_env_var");
    expect(readSrc("../src/commands/mcp.ts")).not.toContain("bearer_token_env_var");
  });
});
