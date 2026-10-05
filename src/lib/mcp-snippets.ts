/**
 * The ONE paste-ready printout of a pod MCP connection: URL, key, and the
 * client-specific forms (Claude Code command, native mcpServers JSON, the
 * mcp-remote stdio bridge, header-based UIs). `synap mcp url` and a custom
 * agent from `synap agents add` both print through here, so the two can never
 * hand a user different instructions for the same connection.
 */

import chalk from "chalk";
import { log } from "../utils/logger.js";

export interface McpConnectionPrintout {
  url: string;
  hubApiKey: string;
  agentUserId: string;
  workspaceId?: string;
  projectId?: string;
}

export function printMcpConnection(c: McpConnectionPrintout): void {
  const { url, hubApiKey, agentUserId, workspaceId, projectId } = c;
  const mcpServers = {
    mcpServers: {
      synap: { url, headers: { Authorization: `Bearer ${hubApiKey}` } },
    },
  };
  const mcpRemote = {
    mcpServers: {
      synap: {
        command: "npx",
        args: ["mcp-remote", url, "--header", `Authorization: Bearer ${hubApiKey}`],
      },
    },
  };

  log.heading("\nSynap MCP connection");
  console.log(`  ${chalk.dim("URL")}      ${url}`);
  console.log(`  ${chalk.dim("Header")}   Authorization: Bearer ${hubApiKey}`);
  console.log(
    `  ${chalk.dim("Agent")}    ${agentUserId}${workspaceId ? chalk.dim(` · workspace ${workspaceId}`) : chalk.dim(" · pod-wide")}${projectId ? chalk.dim(` · project ${projectId}`) : ""}`
  );

  console.log(chalk.bold("\nClaude Code"));
  console.log(
    chalk.cyan(
      `  claude mcp add --transport http synap ${url} \\\n    --header "Authorization: Bearer ${hubApiKey}" --scope user`
    )
  );

  console.log(chalk.bold("\nCursor / VS Code / native-HTTP clients (mcp.json)"));
  console.log(chalk.dim(JSON.stringify(mcpServers, null, 2)));

  console.log(chalk.bold("\nClaude Desktop / stdio-only clients (mcp-remote bridge)"));
  console.log(chalk.dim(JSON.stringify(mcpRemote, null, 2)));

  console.log(
    chalk.bold("\nUI clients that accept an API key / custom header (ChatGPT, Raycast, …)")
  );
  console.log(`  Paste the URL above and add the Authorization header.`);
  console.log(
    chalk.dim(
      "  Raycast: run “Install MCP Server” → transport HTTP → paste the URL + a “Authorization: Bearer …” header."
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
