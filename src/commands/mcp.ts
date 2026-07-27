/**
 * `synap mcp` — the MCP front door.
 *
 * The Synap pod exposes an MCP server at `${podUrl}/mcp` (Bearer-authed). This
 * command group is the turnkey funnel for pointing ANY MCP client at it:
 *
 *   synap mcp url      — print a ready-to-paste connection (URL + key + snippets)
 *                        for UI-only clients that accept a custom header (e.g.
 *                        Raycast) and for clients that need the raw values to
 *                        wire up by hand. claude.ai's connector UI does NOT
 *                        currently accept a bearer token here — see the note
 *                        printed by this command.
 *   synap mcp verify   — health-check: is /mcp reachable and is the key valid?
 *   synap mcp connect  — alias of `synap connect` for file-configurable clients
 *                        (Claude Code, Cursor, Desktop, …) — writes the config.
 *   synap mcp connect-claude — print the claude.ai (web) OAuth connection
 *                        steps. claude.ai's connector UI is OAuth-only (no
 *                        header field), so this prints paste-ready values
 *                        instead of writing a file — claude.ai + the control
 *                        plane drive the actual OAuth handshake.
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
        "\nclaude.ai (web/desktop/mobile connectors) can't take a custom header yet — its connector UI has no field for one. OAuth support is planned; until then, use Claude Code, Cursor, or another file-configurable client above."
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

/**
 * Derive the control-plane origin from a pod host, e.g.
 * `pod.antoinesrvt.synap.live` → `https://api.synap.live`.
 *
 * Pods are provisioned at `pod.<owner>.<root-domain>`; the control plane lives
 * at `api.<root-domain>` on the same root. Only strips when the host actually
 * starts with `pod.` — anything else (localhost, a custom domain, …) can't be
 * derived confidently, so the caller falls back to a placeholder + `--cp-url`.
 */
function deriveCpOrigin(podUrl: string): { cpOrigin: string; derived: boolean } {
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
 * `/mcp` endpoint now speaks OAuth, so connecting is: paste a URL, approve in
 * the browser. This command can't drive that click-through itself — claude.ai
 * and the control plane own the OAuth handshake — it only prints the exact
 * values so there's no guesswork.
 */
export async function mcpConnectClaudeWeb(
  opts: McpBaseOpts & { cpUrl?: string }
): Promise<void> {
  try {
    const cfg = await resolveHubConfig(opts);
    const { cpOrigin, derived } = deriveCpOrigin(cfg.podUrl);
    const finalCpOrigin = (opts.cpUrl ?? cpOrigin).replace(/\/$/, "");
    const url = `${finalCpOrigin}/mcp`;
    const wasDerived = opts.cpUrl ? "override" : derived;

    const steps = [
      "Open claude.ai → Settings → Connectors → Add custom connector",
      "Name: Synap",
      `URL: ${url}`,
      "Leave Advanced settings (OAuth Client ID/Secret) blank",
      "Click Add → you'll be redirected to sign in to Synap Cloud and approve → done",
      'Then ask Claude to "list my Synap pods" to confirm',
    ];

    if (opts.json) {
      console.log(
        JSON.stringify({ url, cpOrigin: finalCpOrigin, derived: wasDerived, steps }, null, 2)
      );
      return;
    }

    log.heading("\nConnect claude.ai (web) to Synap");
    if (!derived && !opts.cpUrl) {
      log.warn(
        "Could not derive the control-plane URL from your pod host — pass --cp-url <url> (e.g. https://api.yourdomain.com)."
      );
    }
    console.log(`  ${chalk.dim("URL")}   ${url}`);
    console.log();
    steps.forEach((step, i) => console.log(`  ${chalk.bold(`${i + 1}.`)} ${step}`));
    console.log();
    console.log(
      chalk.dim(
        "This connects via the Synap control plane. A direct pod connection (no control plane) is coming."
      )
    );
  } catch (e) {
    log.error(`Could not build the claude.ai connection: ${(e as Error).message}`);
    process.exit(1);
  }
}
