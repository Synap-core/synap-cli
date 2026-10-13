/**
 * The ONE paste-ready printout of a pod MCP connection: URL, key, and the
 * client-specific forms (Claude Code command, native mcpServers JSON, the
 * mcp-remote stdio bridge, header-based UIs). `synap mcp url` and a custom
 * agent from `synap agents add` both print through here, so the two can never
 * hand a user different instructions for the same connection.
 */

import os from "node:os";
import path from "node:path";
import chalk from "chalk";
import { log } from "../utils/logger.js";
import { ensureSecretDir, writeSecretFile } from "./atomic-file.js";

/** Name of the env var every printed snippet references instead of the key. */
export const MCP_KEY_ENV = "SYNAP_MCP_KEY";

/** `synap_abcd1234wxyz` → `synap_…wxyz`. Never enough to use, enough to recognise. */
export function redactKey(key: string): string {
  const prefix = key.startsWith("synap_") ? "synap_" : "";
  return `${prefix}…${key.slice(-4)}`;
}

export interface McpSnippetFiles {
  /** `export SYNAP_MCP_KEY=…` — `source` it before launching the client. */
  envFile: string;
  /** Ready-to-merge client config blocks carrying the REAL key. */
  jsonFile: string;
}

/**
 * The key must reach a client config without crossing argv, stdout or shell
 * history. So the CLI writes the full material to 0600 files under `~/.synap`
 * and prints only redacted forms + these paths.
 */
export function writeMcpSnippetFiles(
  url: string,
  hubApiKey: string,
  agentUserId: string
): McpSnippetFiles {
  const dir = path.join(os.homedir(), ".synap", "mcp-keys");
  ensureSecretDir(path.join(os.homedir(), ".synap"));
  ensureSecretDir(dir);
  const id = (agentUserId || "agent").replace(/[^A-Za-z0-9_-]/g, "_");
  const envFile = path.join(dir, `${id}.env`);
  const jsonFile = path.join(dir, `${id}.json`);
  writeSecretFile(envFile, `export ${MCP_KEY_ENV}='${hubApiKey}'\n`);
  writeSecretFile(
    jsonFile,
    JSON.stringify(mcpClientBlocks(url, hubApiKey), null, 2) + "\n"
  );
  return { envFile, jsonFile };
}

/** Native-HTTP and mcp-remote blocks. `key` is real (file) or redacted (screen). */
export function mcpClientBlocks(url: string, key: string) {
  return {
    mcpServers: {
      synap: { url, headers: { Authorization: `Bearer ${key}` } },
    },
    // mcp-remote: the header VALUE comes from env, so the key is not in argv
    // (and a space inside an argument is a known mcp-remote/Windows trap).
    mcpRemote: {
      mcpServers: {
        synap: {
          command: "npx",
          args: ["-y", "mcp-remote", url, "--header", "Authorization:${SYNAP_AUTH}"],
          env: { SYNAP_AUTH: `Bearer ${key}` },
        },
      },
    },
  };
}

export interface McpConnectionPrintout {
  url: string;
  hubApiKey: string;
  agentUserId: string;
  workspaceId?: string;
  projectId?: string;
}

export function printMcpConnection(c: McpConnectionPrintout): void {
  const { url, hubApiKey, agentUserId, workspaceId, projectId } = c;
  const red = redactKey(hubApiKey);
  const files = writeMcpSnippetFiles(url, hubApiKey, agentUserId);
  const blocks = mcpClientBlocks(url, red);
  const mcpServers = { mcpServers: blocks.mcpServers };
  const mcpRemote = blocks.mcpRemote;

  log.heading("\nSynap MCP connection");
  console.log(`  ${chalk.dim("URL")}      ${url}`);
  console.log(`  ${chalk.dim("Header")}   Authorization: Bearer ${red}`);
  console.log(
    `  ${chalk.dim("Key")}      saved to ${files.envFile} and ${files.jsonFile} (0600) — the full key is never printed here`
  );
  console.log(
    `  ${chalk.dim("Agent")}    ${agentUserId}${workspaceId ? chalk.dim(` · workspace ${workspaceId}`) : chalk.dim(" · pod-wide")}${projectId ? chalk.dim(` · project ${projectId}`) : ""}`
  );

  console.log(chalk.bold("\nClaude Code"));
  console.log(
    chalk.cyan(
      `  source ${files.envFile}\n  claude mcp add --transport http synap ${url} \\\n    --header 'Authorization: Bearer \${${MCP_KEY_ENV}}' --scope user`
    )
  );

  console.log(chalk.bold("\nCursor / VS Code / native-HTTP clients (mcp.json)"));
  console.log(chalk.dim(`  (redacted — merge the block from ${files.jsonFile})`));
  console.log(chalk.dim(JSON.stringify(mcpServers, null, 2)));

  console.log(chalk.bold("\nClaude Desktop / stdio-only clients (mcp-remote bridge)"));
  console.log(chalk.dim(`  (redacted — merge the "mcpRemote" block from ${files.jsonFile})`));
  console.log(chalk.dim(JSON.stringify(mcpRemote, null, 2)));

  console.log(
    chalk.bold("\nUI clients that accept an API key / custom header (ChatGPT, Raycast, …)")
  );
  console.log(`  Paste the URL above and add the Authorization header.`);
  console.log(
    chalk.dim(
      "  Raycast: run “Install MCP Server” → transport HTTP → paste the URL + a “Authorization: Bearer <key from the file above>” header."
    )
  );
  console.log(
    chalk.dim(
      "  ChatGPT: Settings → enable Developer mode → add a connector → paste the URL and choose API-key auth."
    )
  );
  console.log(
    chalk.yellow(
      "\nclaude.ai (web) uses OAuth via Synap Cloud MCP — run `synap mcp connect-claude` to print https://api.synap.live/mcp (no header field in that UI)."
    )
  );
  console.log(
    chalk.dim(
      "\nTip: for a known client, `synap agents add <client>` writes the config for you."
    )
  );
}
