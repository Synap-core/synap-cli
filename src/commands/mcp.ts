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
        "\nclaude.ai (web) uses OAuth via Synap Cloud MCP — run `synap mcp connect-claude` to print https://api.synap.live/mcp (no header field in that UI)."
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
