/**
 * `synap mcp` — the MCP front door. Two lanes:
 *
 *   1. Web AI (Cloud MCP / OAuth) — control plane `${cp}/mcp` (managed:
 *      https://api.synap.live/mcp). claude.ai's connector UI is OAuth-only; use
 *      `synap mcp connect-claude` to print the URL (no key mint, no file write).
 *   2. IDE / file-configurable — pod `${podUrl}/mcp` (Bearer). Needs a pod +
 *      key. `synap mcp connect <client>` writes client config; `synap mcp url`
 *      prints URL + key for header-based UIs (ChatGPT, Raycast, …).
 *
 *   synap mcp url            — paste-ready pod MCP connection (URL + key)
 *   synap mcp verify         — health-check pod /mcp + key
 *   synap mcp connect        — write MCP config for IDE/desktop clients
 *   synap mcp connect-claude — print Cloud MCP OAuth URL for claude.ai (web)
 */

import chalk from "chalk";
import { resolveHubConfig, type HubConfig } from "../lib/hub-client.js";
import {
  buildMcpUrl,
  provisionAgentKey,
  enrollAgentIfNeeded,
} from "../lib/targets.js";
import { log } from "../utils/logger.js";
import { printMcpConnection, redactKey, writeMcpSnippetFiles, MCP_KEY_ENV } from "../lib/mcp-snippets.js";

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

    printMcpConnection({ url, hubApiKey, agentUserId, workspaceId, projectId });
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

/**
 * Derive the control-plane origin from a pod host, e.g.
 * `pod.antoinesrvt.synap.live` → `https://api.synap.live`.
 *
 * Pods are provisioned at `pod.<owner>.<root-domain>`; the control plane lives
 * at `api.<root-domain>` on the same root. Only strips when the host actually
 * starts with `pod.` — anything else (localhost, a custom domain, …) can't be
 * derived confidently, so the caller falls back to a placeholder + `--cp-url`.
 */
export function deriveCpOrigin(podUrl: string): { cpOrigin: string; derived: boolean } {
  try {
    const host = new URL(podUrl).hostname;
    const labels = host.split(".");
    if (labels[0] === "pod" && labels.length >= 3) {
      const rest = labels.slice(1); // drop "pod"
      // rest = [<owner>, ...root] when there's an owner segment, or just
      // [...root] when the pod is hosted directly under the root domain.
      const root = rest.length > 2 ? rest.slice(1).join(".") : rest.join(".");
      return { cpOrigin: `https://api.${root}`, derived: true };
    }
  } catch {
    // fall through to placeholder
  }
  return { cpOrigin: "https://api.<your-domain>", derived: false };
}

/**
 * `synap mcp connect-claude` — print the claude.ai (web) OAuth connection.
 *
 * claude.ai's "Add custom connector" UI is OAuth-only (Dynamic Client
 * Registration) — it has no field for a bearer header, so the file/header
 * based flows (`mcp connect`, `mcp url`) don't apply. The control plane's
 * `/mcp` endpoint speaks OAuth: paste a URL, approve in the browser. This
 * command does not mint keys or write client config — it only prints the URL.
 *
 * Stranger-safe: if no pod is configured, falls back to `--cp-url` or the
 * managed control plane `https://api.synap.live`.
 */
export async function mcpConnectClaudeWeb(
  opts: McpBaseOpts & { cpUrl?: string }
): Promise<void> {
  try {
    const MANAGED_CP = "https://api.synap.live";
    /** How we chose the CP origin — for --json + user-facing notes. */
    let source: "override" | "derived" | "managed-fallback" = "managed-fallback";
    let cpOrigin = MANAGED_CP;

    if (opts.cpUrl) {
      cpOrigin = opts.cpUrl.replace(/\/$/, "");
      source = "override";
    } else {
      try {
        const cfg = await resolveHubConfig(opts);
        const fromPod = deriveCpOrigin(cfg.podUrl);
        if (fromPod.derived) {
          cpOrigin = fromPod.cpOrigin;
          source = "derived";
        } else {
          // Non-pod.* host — can't derive confidently; managed + tip to --cp-url.
          cpOrigin = MANAGED_CP;
          source = "managed-fallback";
        }
      } catch {
        // No pod config — stranger path: print managed Cloud MCP (no key mint).
        cpOrigin = MANAGED_CP;
        source = "managed-fallback";
      }
    }

    const finalCpOrigin = cpOrigin.replace(/\/$/, "");
    const url = `${finalCpOrigin}/mcp`;

    const steps = [
      "Open claude.ai → Settings → Connectors → Add custom connector",
      "Name: Synap",
      `URL: ${url}`,
      "Leave Advanced settings (OAuth Client ID/Secret) blank",
      "Click Add → you'll be redirected to sign in to Synap Cloud and approve → done",
      'Then ask Claude to "list my Synap pods" (list_pods) and connect one (connect_pod)',
    ];

    if (opts.json) {
      console.log(
        JSON.stringify(
          { url, cpOrigin: finalCpOrigin, derived: source, steps },
          null,
          2
        )
      );
      return;
    }

    log.heading("\nConnect claude.ai (web) to Synap");
    if (source === "managed-fallback" && !opts.cpUrl) {
      console.log(
        chalk.dim(
          "  Using managed Cloud MCP (https://api.synap.live). Pass --cp-url for a self-hosted control plane. No key minted."
        )
      );
    }
    console.log(`  ${chalk.dim("URL")}   ${url}`);
    console.log();
    steps.forEach((step, i) => console.log(`  ${chalk.bold(`${i + 1}.`)} ${step}`));
    console.log();
    console.log(
      chalk.dim(
        "Cloud MCP does not store your data. After OAuth, list_pods then connect_pod (you still need a pod for useful work)."
      )
    );
  } catch (e) {
    log.error(`Could not build the claude.ai connection: ${(e as Error).message}`);
    process.exit(1);
  }
}

/**
 * `synap mcp ui-setup <client>` — print the exact form fields to fill in a
 * client's MCP/Connector UI. Supports ChatGPT (API key), Codex, Cursor,
 * VS Code, Claude Desktop, and generic clients.
 */
export async function mcpUiSetup(
  client: string,
  opts: { name?: string; workspace?: string; project?: string; json?: boolean; podUrl?: string; apiKey?: string }
): Promise<void> {
  try {
    const hubCfg = await resolveHubConfig({ podUrl: opts.podUrl, apiKey: opts.apiKey });
    const { url, workspaceId, projectId } = resolveMcpTarget(hubCfg, { workspace: opts.workspace, project: opts.project });

    const { hubApiKey, agentUserId } = await provisionAgentKey(
      hubCfg.podUrl,
      hubCfg.apiKey,
      "generic",
      { requireApproval: false }
    );

    const normalizedClient = client.toLowerCase().replace(/-/g, "");
    let output = "";
    // The key never reaches stdout or argv: fields show it redacted; the full
    // material is written 0600 and clients reference it through an env var.
    const keyShown = redactKey(hubApiKey);
    const snippetFiles = writeMcpSnippetFiles(url, hubApiKey, agentUserId);

    const clientConfigs: Record<string, { name: string; format: "http" | "stdio" | "file"; fields: Record<string, string>; notes: string[] }> = {
      chatgpt: {
        name: "ChatGPT (API key)",
        format: "http",
        fields: {
          "Connector Name": "Synap",
          "URL": url,
          "Auth Type": "API Key",
          "API Key": `${keyShown} (full key: ${snippetFiles.envFile})`,
        },
        notes: [
          "ChatGPT → Settings → Connectors → Add custom connector",
          "Paste the URL and API Key exactly as shown above",
          `If your build shows a Header field instead: Authorization: Bearer <key> (full key in ${snippetFiles.envFile}, 0600)`,
        ],
      },
      chatgptoauth: {
        name: "ChatGPT (OAuth via Control Plane)",
        format: "http",
        fields: {
          "Connector Name": "Synap (Control Plane)",
          "URL": "https://api.synap.live/mcp",
          "Auth Type": "OAuth",
          "API Key": "(leave blank — OAuth flow)",
        },
        notes: [
          "ChatGPT → Settings → Connectors → Add custom connector",
          "Use the Control Plane OAuth URL (multi-pod support)",
          "After connecting, ask ChatGPT: 'list my Synap pods' then 'connect pod <name>'",
        ],
      },
      codex: {
        name: "OpenAI Codex (config.toml)",
        format: "file",
        fields: {
          "Config file": "~/.codex/config.toml",
          "Section to add": `[mcp_servers.synap]`,
          "url": url,
          "http_headers": `{ Authorization = "Bearer ${keyShown}" }`,
          "startup_timeout_sec": "30",
          "enabled": "true",
        },
        notes: [
          `Open ~/.codex/config.toml and add the [mcp_servers.synap] section (replace ${keyShown} with the full key from ${snippetFiles.envFile}, 0600)`,
          "Restart Codex CLI to pick up the new MCP server",
          "The synap tool set will appear in agent mode",
        ],
      },
      cursor: {
        name: "Cursor (mcp.json)",
        format: "http",
        fields: {
          "Config file": "~/.cursor/mcp.json",
          "mcpServers.synap.url": url,
          "mcpServers.synap.headers.Authorization": `Bearer \${env:${MCP_KEY_ENV}}`,
        },
        notes: [
          "Cursor reads native HTTP MCP format from ~/.cursor/mcp.json",
          "Restart Cursor. The synap tool set will appear in agent mode.",
        ],
      },
      vscode: {
        name: "VS Code (Kilo Code / Cline / Continue / Copilot)",
        format: "http",
        fields: {
          "Config file": "~/Library/Application Support/Code/User/mcp.json (macOS)",
          "servers.synap.type": "http",
          "servers.synap.url": url,
          "servers.synap.headers.Authorization": `Bearer \${env:${MCP_KEY_ENV}}`,
        },
        notes: [
          "VS Code 1.99+ uses 'servers' format (not mcpServers)",
          "Picked up automatically by Kilo Code, Cline, Continue, and GitHub Copilot",
          "Reload VS Code (or open the MCP panel) to activate",
        ],
      },
      "claude-desktop": {
        name: "Claude Desktop (stdio bridge)",
        format: "stdio",
        fields: {
          "Config file": "~/Library/Application Support/Claude/claude_desktop_config.json (macOS)",
          "mcpServers.synap.command": "npx",
          "mcpServers.synap.args": `-y mcp-remote ${url} --header "Authorization:\${SYNAP_AUTH}"`,
          "mcpServers.synap.env.SYNAP_AUTH": `Bearer ${keyShown} (real value: "mcpRemote" block in ${snippetFiles.jsonFile})`,
        },
        notes: [
          "Claude Desktop only supports stdio MCP — uses mcp-remote bridge",
          "Fully quit Claude Desktop (Cmd+Q), then relaunch",
          "Look for the MCP tools icon under the input box — 'synap' should appear",
        ],
      },
      "claude-code": {
        name: "Claude Code (native HTTP MCP)",
        format: "http",
        fields: {
          "Command": `source ${snippetFiles.envFile} && claude mcp add --transport http synap-${new URL(hubCfg.podUrl).hostname.split(".")[1] || "pod"} ${url} --header 'Authorization: Bearer \${${MCP_KEY_ENV}}' --scope user`,
        },
        notes: [
          `The key stays out of the command: it is read from $${MCP_KEY_ENV} when Claude Code starts — launch it from a shell that sourced ${snippetFiles.envFile}`,
          "Relaunch Claude Code to load the tools",
        ],
      },
      generic: {
        name: "Generic MCP Client (HTTP)",
        format: "http",
        fields: {
          "URL": url,
          "Headers": `Authorization: Bearer ${keyShown}`,
        },
        notes: [
          "Paste URL and add Authorization header in your client's MCP config",
          "Supports any MCP-compatible client with HTTP transport",
        ],
      },
    };

    const clientConfig = clientConfigs[normalizedClient] || clientConfigs.generic;

    if (opts.json) {
      console.log(JSON.stringify({ client: clientConfig.name, format: clientConfig.format, fields: clientConfig.fields, notes: clientConfig.notes }, null, 2));
      return;
    }

    log.heading(`MCP UI Setup — ${clientConfig.name}`);
    log.blank();
    log.info("Form fields to fill in your client's MCP/Connector settings:");
    log.blank();
    for (const [key, value] of Object.entries(clientConfig.fields)) {
      console.log(`  ${chalk.bold(key)}: ${chalk.cyan(value)}`);
    }
    log.blank();
    log.info("Notes:");
    for (const note of clientConfig.notes) {
      console.log(`  • ${note}`);
    }
    log.blank();
    log.dim("Agent key provisioned for this session. Re-run with --name to target another pod.");

  } catch (e) {
    log.error(`Could not build UI setup: ${(e as Error).message}`);
    process.exit(1);
  }
}

/**
 * `synap mcp bridge` — the stdio MCP server Claude Code spawns when it is
 * connected through the bridge (`synap mcp use-bridge`). Forwards every
 * message to the pod's /mcp and names the Claude Code conversation it runs in,
 * so the work it does can be reopened there. See lib/mcp-bridge.ts.
 *
 * stdout IS the protocol — nothing but JSON-RPC may be written to it.
 */
export async function mcpBridge(opts: { url?: string }): Promise<void> {
  const { runMcpBridge } = await import("../lib/mcp-bridge.js");
  const { conversationHeaders } = await import("../lib/conversation-headers.js");
  const fromEnv = process.env.SYNAP_MCP_API_KEY || process.env.SYNAP_HUB_API_KEY;
  const cfg = fromEnv && opts.url ? null : await resolveHubConfig();
  const apiKey = fromEnv || cfg?.apiKey;
  const url = opts.url || (cfg ? buildMcpUrl(cfg.podUrl) : undefined);
  if (!apiKey || !url) {
    process.stderr.write("[synap mcp bridge] no pod key or URL — run `synap init`\n");
    process.exit(1);
  }
  // The spawn-time id (a stdio server's env), never a lens fallback.
  await runMcpBridge({
    url,
    apiKey,
    headers: conversationHeaders(process.env.CLAUDE_CODE_SESSION_ID),
  });
}

/**
 * `synap mcp use-bridge [--off]` — switch Claude Code's MCP connection to the
 * stdio bridge (or back to direct http), re-using the key `synap init` stored.
 */
export async function mcpUseBridge(opts: { off?: boolean }): Promise<void> {
  const { setClaudeCodeMcpTransport } = await import("../lib/targets.js");
  const name = setClaudeCodeMcpTransport(opts.off ? "http" : "bridge");
  if (!name) {
    log.error("Claude Code is not connected to a pod yet — run `synap init` first.");
    process.exitCode = 1;
    return;
  }
  log.dim(
    opts.off
      ? "Claude Code talks to the pod directly again; conversations are no longer named on MCP calls."
      : "Each Claude Code conversation is now named on its MCP calls, so its work can be reopened with `claude --resume <id>`."
  );
}
