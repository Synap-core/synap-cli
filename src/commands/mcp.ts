/**
 * `synap mcp` — the MCP front door.
 *
 * The Synap pod exposes an MCP server at `${podUrl}/mcp` (Bearer-authed). This
 * command group is the turnkey funnel for pointing ANY MCP client at it:
 *
 *   synap mcp url      — print a ready-to-paste connection (URL + key + snippets)
 *                        for UI-only clients (ChatGPT, claude.ai connectors, …)
 *                        that can't be configured by writing a file.
 *   synap mcp verify   — health-check: is /mcp reachable and is the key valid?
 *   synap mcp connect  — alias of `synap connect` for file-configurable clients
 *                        (Claude Code, Cursor, Desktop, …) — writes the config.
 *
 * For file-configurable clients, prefer `synap mcp connect <client>` (it mints a
 * dedicated agent key + writes the client's config). `synap mcp url` is the
 * escape hatch for clients you must configure by hand in a UI.
 */

import chalk from "chalk";
import { resolveHubConfig, type HubConfig } from "../lib/hub-client.js";
import {
  buildMcpUrl,
  provisionAgentKey,
  enrollAgentIfNeeded,
} from "../lib/targets.js";
import { log } from "../utils/logger.js";

interface McpBaseOpts {
  podUrl?: string;
  apiKey?: string;
  workspace?: string;
  project?: string;
  json?: boolean;
}

/** Resolve the scoped MCP URL + the lenses from flags.
 *
 * Default is POD-WIDE: a workspace is a lens, not a container, so we do NOT
 * weld one into the connection. The agent connects pod-wide, orients, and
 * scopes consciously per tool-call (the URL param is only a fallback default
 * the pod injects when a call omits scope). Pin a workspace and/or a project
 * ONLY when explicitly asked (`--workspace` / `--project`) — e.g. an agent
 * dedicated to one client. Both are composable. */
function resolveMcpTarget(
  cfg: HubConfig,
  opts: McpBaseOpts
): { url: string; workspaceId?: string; projectId?: string } {
  const workspaceId = opts.workspace; // explicit pin only — no cfg fallback
  const projectId = opts.project; // explicit pin only
  return {
    url: buildMcpUrl(cfg.podUrl, workspaceId, projectId),
    workspaceId,
    projectId,
  };
}

/**
 * `synap mcp url` — print a ready-to-paste MCP connection for ANY client.
 *
 * Provisions a DEDICATED agent key (separate identity, revocable) rather than
 * echoing the human's full-scope key into an external UI. Prints the URL, the
 * key, and three paste-ready forms (Claude Code command, native mcpServers JSON,
 * and the mcp-remote stdio bridge for clients without native HTTP transport).
 */
export async function mcpUrl(
  opts: McpBaseOpts & { client?: string }
): Promise<void> {
  try {
    const cfg = await resolveHubConfig(opts);
    const { url, workspaceId, projectId } = resolveMcpTarget(cfg, opts);

    // A dedicated agent key — never paste the human's full-scope key into an
    // external product. requireApproval:false because the user is explicitly
    // running this command with an already-authed key.
    // The pod only mints keys for known surface agent types; an arbitrary
    // client name (e.g. "chatgpt") maps to the "generic" surface. The --client
    // value stays a display label only.
    const SURFACE_TYPES = [
      "claude-code",
      "claude-desktop",
      "cursor",
      "raycast",
      "codex",
      "openwebui",
      "generic",
    ];
    const agentType =
      opts.client && SURFACE_TYPES.includes(opts.client)
        ? opts.client
        : "generic";
    const { hubApiKey, agentUserId } = await provisionAgentKey(
      cfg.podUrl,
      cfg.apiKey,
      agentType,
      { requireApproval: false }
    );

    // Enroll the fresh agent into the user's workspace(s). Without this the
    // agent authenticates but sees ZERO workspaces — every ask/capture then
    // fails with "Access denied to workspace". `connect` already does this via
    // prepareMcpSurface; `mcp url` must too or its key is inert. Best-effort:
    // a missing enrollment shouldn't block printing the connection.
    await enrollAgentIfNeeded(cfg.podUrl, cfg.apiKey, agentUserId, workspaceId, {
      quiet: opts.json === true, // keep --json stdout pure JSON
    }).catch(() => {});

    if (opts.json) {
      console.log(
        JSON.stringify(
          {
            url,
            apiKey: hubApiKey,
            agentUserId,
            workspaceId: workspaceId ?? null,
            projectId: projectId ?? null,
          },
          null,
          2
        )
      );
      return;
    }

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

    console.log(chalk.bold("\nUI clients (ChatGPT connectors, claude.ai, Raycast, …)"));
    console.log(`  Paste the URL above and add the Authorization header.`);
    console.log(
      chalk.dim(
        "  Raycast: run “Install MCP Server” → transport HTTP → paste the URL + a “Authorization: Bearer …” header."
      )
    );
    console.log(
      chalk.dim(
        "\nTip: for file-configurable clients, `synap mcp connect <client>` writes the config for you."
      )
    );
  } catch (e) {
    log.error(`Could not build MCP connection: ${(e as Error).message}`);
    process.exit(1);
  }
}

/**
 * `synap mcp verify` — health-check the MCP endpoint + the active key.
 * Confirms /mcp is reachable (manifest) and the key authenticates, so the user
 * knows the connection works before wiring a client to it.
 */
export async function mcpVerify(opts: McpBaseOpts): Promise<void> {
  try {
    const cfg = await resolveHubConfig(opts);
    const { url, workspaceId } = resolveMcpTarget(cfg, opts);
    const podBase = cfg.podUrl.replace(/\/$/, "");

    // 1. Manifest reachability (no auth needed — the legacy GET manifest).
    // 30s timeout: pods can be slow (~8s observed); a tight bound false-fails.
    let reachable = false;
    let toolCount: number | undefined;
    try {
      const res = await fetch(`${podBase}/mcp`, {
        headers: { Accept: "application/json" },
        signal: AbortSignal.timeout(30000),
      });
      reachable = res.ok;
      if (res.ok) {
        const body = (await res.json()) as { toolCount?: number };
        toolCount = body.toolCount;
      }
    } catch {
      reachable = false;
    }

    // 2. Key validity (authed call).
    let keyValid = false;
    try {
      const res = await fetch(`${podBase}/api/hub/auth/status`, {
        headers: { Authorization: `Bearer ${cfg.apiKey}` },
        signal: AbortSignal.timeout(30000),
      });
      keyValid = res.ok;
    } catch {
      keyValid = false;
    }

    if (opts.json) {
      console.log(
        JSON.stringify({ url, reachable, toolCount, keyValid }, null, 2)
      );
      return;
    }

    log.heading("\nSynap MCP — verify");
    console.log(`  ${chalk.dim("URL")}        ${url}`);
    console.log(
      `  ${chalk.dim("Endpoint")}   ${reachable ? chalk.green("reachable") : chalk.red("unreachable")}${toolCount != null ? chalk.dim(` · ${toolCount} tools`) : ""}`
    );
    console.log(
      `  ${chalk.dim("API key")}    ${keyValid ? chalk.green("valid") : chalk.red("invalid / expired")}`
    );
    if (workspaceId)
      console.log(`  ${chalk.dim("Workspace")}  ${workspaceId}`);

    if (reachable && keyValid) {
      log.success("\nMCP is ready — point any client at the URL above.");
    } else {
      log.error(
        "\nMCP not ready. Check the pod is deployed and your key has mcp scope (`synap mcp url` mints a fresh one)."
      );
      process.exit(1);
    }
  } catch (e) {
    log.error(`Verify failed: ${(e as Error).message}`);
    process.exit(1);
  }
}
