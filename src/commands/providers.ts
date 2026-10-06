/**
 * synap providers
 *
 * Discover and configure AI providers from the connected pod.
 *
 * synap providers list              — show available providers on the pod
 * synap providers pull [--target]   — write provider config to a local tool
 */

import chalk from "chalk";
import ora from "ora";
import prompts from "prompts";
import { log } from "../utils/logger.js";
import { getActivePodConfig } from "../lib/pod.js";
import type { ProviderInfo } from "../lib/targets.js";

export interface PodProvider extends ProviderInfo {
  baseUrl: string;
  enabled: boolean;
  priority: number;
  tags: string[];
}

/**
 * Fetch enabled providers (model IDs only, no keys) from the pod.
 * Used for display / listing.
 */
export async function fetchPodProviders(
  podUrl: string,
  apiKey: string
): Promise<PodProvider[]> {
  let res: Response;
  try {
    res = await fetch(
      `${podUrl.replace(/\/$/, "")}/api/hub/providers/models`,
      {
        headers: { Authorization: `Bearer ${apiKey}` },
        signal: AbortSignal.timeout(8000),
      }
    );
  } catch (err) {
    throw new Error(`Could not reach pod at ${podUrl}: ${(err as Error).message}`);
  }
  if (res.status === 401 || res.status === 403) {
    throw new Error(`Credentials rejected by pod (HTTP ${res.status}) — check your API key.`);
  }
  if (!res.ok) {
    throw new Error(`Pod returned HTTP ${res.status} for /api/hub/providers/models.`);
  }
  const data = (await res.json()) as { providers?: PodProvider[] };
  return data.providers ?? [];
}

/**
 * Fetch enabled providers WITH decrypted API keys from the pod vault.
 * The pod resolves: user-level override > workspace > pod-wide key.
 * Used by local tool installers (opencode, aider, etc.) that need real keys.
 */
export async function fetchPodCredentials(
  podUrl: string,
  apiKey: string,
  workspaceId?: string
): Promise<Array<PodProvider & { apiKey: string | null }>> {
  const base = podUrl.replace(/\/$/, "");
  const url = workspaceId
    ? `${base}/api/hub/providers/credentials?workspaceId=${encodeURIComponent(workspaceId)}`
    : `${base}/api/hub/providers/credentials`;
  let res: Response;
  try {
    res = await fetch(url, {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(8000),
    });
  } catch (err) {
    throw new Error(`Could not reach pod at ${podUrl}: ${(err as Error).message}`);
  }
  if (res.status === 401 || res.status === 403) {
    throw new Error(`Credentials rejected by pod (HTTP ${res.status}) — check your API key.`);
  }
  if (!res.ok) {
    throw new Error(`Pod returned HTTP ${res.status} for /api/hub/providers/credentials.`);
  }
  const data = (await res.json()) as {
    providers?: Array<PodProvider & { apiKey: string | null }>;
  };
  return data.providers ?? [];
}

// ─── Commands ────────────────────────────────────────────────────────────────

export async function providersList(opts: {
  json?: boolean;
  podUrl?: string;
  apiKey?: string;
}): Promise<void> {
  let podUrl = opts.podUrl;
  let apiKey = opts.apiKey;

  if (!podUrl || !apiKey) {
    const cfg = getActivePodConfig();
    podUrl = podUrl ?? cfg?.podUrl;
    apiKey = apiKey ?? cfg?.hubApiKey;
  }

  if (!podUrl || !apiKey) {
    log.error("Not connected to a pod. Run: synap init");
    process.exit(1);
  }

  const spinner = ora("Fetching providers from pod...").start();
  let providers: PodProvider[];
  try {
    providers = await fetchPodProviders(podUrl, apiKey);
    spinner.succeed(`Fetched ${providers.length} provider(s).`);
  } catch (err) {
    spinner.fail((err as Error).message);
    process.exit(1);
  }

  if (opts.json) {
    console.log(JSON.stringify(providers, null, 2));
    return;
  }

  if (providers.length === 0) {
    log.warn("No enabled providers found on this pod.");
    log.dim(`Add providers at: ${podUrl}/admin/intelligence → Providers`);
    log.dim("Then re-run: synap providers list");
    return;
  }

  log.heading(`AI Providers (${providers.length})`);
  for (const p of providers) {
    const modelCount = p.models.length;
    const badge = p.enabled ? chalk.green("●") : chalk.red("○");
    console.log(
      `  ${badge} ${chalk.bold(p.name.padEnd(20))} ${chalk.dim(p.providerId)}`
    );
    if (modelCount > 0) {
      const ids = p.models.slice(0, 3).map((m) => m.id);
      const extra = modelCount > 3 ? chalk.dim(` +${modelCount - 3} more`) : "";
      console.log(`       ${chalk.dim("models:")} ${ids.join(", ")}${extra}`);
    }
  }
  console.log();
  log.dim(`IS endpoint: ${podUrl}/v1  (OpenAI-compatible — use with any OpenAI-SDK client)`);
}

export async function providersPull(opts: {
  target?: string;
  podUrl?: string;
  apiKey?: string;
}): Promise<void> {
  let podUrl = opts.podUrl;
  let apiKey = opts.apiKey;

  if (!podUrl || !apiKey) {
    const cfg = getActivePodConfig();
    podUrl = podUrl ?? cfg?.podUrl;
    apiKey = apiKey ?? cfg?.hubApiKey;
  }

  if (!podUrl || !apiKey) {
    log.error("Not connected to a pod. Run: synap init");
    process.exit(1);
  }

  const VALID_TARGETS = ["opencode", "aider", "show"] as const;
  type PullTarget = (typeof VALID_TARGETS)[number];

  let target = opts.target as PullTarget | undefined;

  if (target && !VALID_TARGETS.includes(target as PullTarget)) {
    log.error(`Unknown target: ${chalk.bold(target)}`);
    log.dim(`Valid targets: ${VALID_TARGETS.join(", ")}`);
    process.exit(1);
  }

  if (!target) {
    const { picked } = await prompts({
      type: "select",
      name: "picked",
      message: "Configure provider for which tool?",
      choices: [
        { title: "opencode", description: "Write ~/.config/opencode/opencode.json", value: "opencode" },
        { title: "aider",    description: "Write ~/.aider.conf.yml", value: "aider" },
        { title: "Show IS endpoint  (manual setup)", description: "Print base URL + key for any OpenAI-compatible client", value: "show" },
      ],
    });
    target = picked as PullTarget | undefined;
    if (!target) return; // user cancelled (Ctrl-C)
  }

  let ok = true;

  if (target === "opencode") {
    const { installOpencode } = await import("../lib/targets.js");
    ok = await installOpencode({ podUrl, apiKey });
  } else if (target === "aider") {
    const { installAider } = await import("../lib/targets.js");
    ok = await installAider({ podUrl, apiKey });
  } else {
    // "show" — print the IS endpoint for manual configuration
    log.heading("Intelligence Service endpoint");
    log.info(`Base URL: ${chalk.cyan(podUrl + "/v1")}`);
    log.info(`API Key:  ${chalk.dim(apiKey)}`);
    log.blank();
    log.dim("This is an OpenAI-compatible endpoint. Use it as your AI provider base URL.");
    log.dim("The API key is your Hub Protocol key — it authenticates and scopes requests.");
  }

  if (!ok) {
    process.exit(1);
  }
}

/**
 * Store a per-user API key override for a provider.
 *
 * synap providers set-key <providerId> [--workspace <id>]
 */
export async function providersSetKey(opts: {
  providerId: string;
  workspaceId?: string;
  apiKey?: string;
  podUrl?: string;
  hubApiKey?: string;
}): Promise<void> {
  let podUrl = opts.podUrl;
  let hubApiKey = opts.hubApiKey;

  if (!podUrl || !hubApiKey) {
    const cfg = getActivePodConfig();
    podUrl = podUrl ?? cfg?.podUrl;
    hubApiKey = hubApiKey ?? cfg?.hubApiKey;
  }

  if (!podUrl || !hubApiKey) {
    log.error("Not connected to a pod. Run: synap init");
    process.exit(1);
  }

  // Prompt for API key if not provided
  let apiKey = opts.apiKey;
  if (!apiKey) {
    apiKey = await prompts({
      type: "password",
      name: "apiKey",
      message: `Enter API key for provider "${opts.providerId}":`,
      validate: (value) => value.length > 0 ? true : "API key is required",
    }).then((r) => r.apiKey);
    if (!apiKey) return; // cancelled
  }

  const base = podUrl.replace(/\/$/, "");
  const url = opts.workspaceId
    ? `${base}/api/hub/ai-providers/credentials?workspaceId=${encodeURIComponent(opts.workspaceId)}`
    : `${base}/api/hub/ai-providers/credentials`;

  const spinner = ora("Storing provider credential...").start();
  try {
    const res = await fetch(url, {
      method: "PATCH",
      headers: {
        Authorization: `Bearer ${hubApiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        providerId: opts.providerId,
        apiKey,
        enabled: true,
        priority: 5,
      }),
    });

    if (res.status === 401 || res.status === 403) {
      throw new Error("Credentials rejected by pod — check your API key.");
    }
    if (!res.ok) {
      const err = await res.text();
      throw new Error(`Pod returned HTTP ${res.status}: ${err}`);
    }

    spinner.succeed(
      `Stored key for "${opts.providerId}"${opts.workspaceId ? ` (workspace: ${opts.workspaceId})` : ""}`
    );
    log.blank();
    log.dim("Your key will be used when making requests through the pod's Intelligence Service.");
  } catch (err) {
    spinner.fail((err as Error).message);
    process.exit(1);
  }
}

/**
 * List user/workspace-level key overrides.
 *
 * synap providers list-keys [--workspace <id>]
 */
export async function providersListKeys(opts: {
  workspaceId?: string;
  podUrl?: string;
  hubApiKey?: string;
}): Promise<void> {
  let podUrl = opts.podUrl;
  let hubApiKey = opts.hubApiKey;

  if (!podUrl || !hubApiKey) {
    const cfg = getActivePodConfig();
    podUrl = podUrl ?? cfg?.podUrl;
    hubApiKey = hubApiKey ?? cfg?.hubApiKey;
  }

  if (!podUrl || !hubApiKey) {
    log.error("Not connected to a pod. Run: synap init");
    process.exit(1);
  }

  const base = podUrl.replace(/\/$/, "");
  const url = opts.workspaceId
    ? `${base}/api/hub/ai-providers/credentials?workspaceId=${encodeURIComponent(opts.workspaceId)}`
    : `${base}/api/hub/ai-providers/credentials`;

  const spinner = ora("Fetching credentials...").start();
  try {
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${hubApiKey}` },
    });

    if (res.status === 401 || res.status === 403) {
      throw new Error("Credentials rejected by pod — check your API key.");
    }
    if (!res.ok) {
      const err = await res.text();
      throw new Error(`Pod returned HTTP ${res.status}: ${err}`);
    }

    const data = (await res.json()) as {
      providers: Array<{ providerId: string; apiKey: string | null; source: string }>;
    };

    spinner.succeed(`Found ${data.providers.length} provider(s).`);
    console.log();

    if (data.providers.length === 0) {
      log.warn("No providers configured on this pod.");
      return;
    }

    for (const p of data.providers) {
      const hasKey = !!p.apiKey;
      const maskKey = p.apiKey ? `${p.apiKey.slice(0, 8)}...${p.apiKey.slice(-4)}` : "none";
      const sourceBadge = p.source === "user"
        ? chalk.green("★")
        : p.source === "workspace"
          ? chalk.yellow("◆")
          : chalk.dim("●");

      console.log(
        `  ${sourceBadge} ${chalk.bold(p.providerId.padEnd(20))} ${chalk.cyan(maskKey)}`
      );
    }

    console.log();
    log.dim("Tip: Use 'synap providers set-key <providerId>' to store your own API key.");
  } catch (err) {
    spinner.fail((err as Error).message);
    process.exit(1);
  }
}
