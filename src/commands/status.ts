/**
 * synap status
 *
 * API-only status: hits the pod's `/health` endpoint and related remote
 * status endpoints. Never shells out to Docker; never SSHes. The bash
 * `./synap health` on the pod host is the canonical local health check —
 * this npm CLI is the remote / laptop-side view.
 *
 * Sources (all HTTP):
 *   - Pod `/health` (basic reachability + version)
 *   - Pod `/api/provision/status` (Intelligence Service state)
 *   - CP `/openclaw/status/:podId` for managed pods (via stored creds)
 *
 * Explicitly NOT sources anymore:
 *   - `docker ps` / `docker inspect` / `docker logs` (was getOpenClawDockerStatus)
 *   - `docker exec openclaw openclaw skills list` (was isSynapSkillInstalledInDocker)
 * For those, the user runs `./synap health` on the pod host.
 */

import chalk from "chalk";
import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import { log, banner } from "../utils/logger.js";
import { checkPodHealth, getActivePodConfig, listPodProfiles, getAgentWorkspaceRouting } from "../lib/pod.js";
import { resolveHubConfig, hubGet, HubError, renderHubError } from "../lib/hub-client.js";
import {
  isLoggedIn,
  getStoredToken,
  isTokenLocallyExpired,
} from "../lib/auth.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

function getCliVersion(): string {
  try {
    const pkg = JSON.parse(
      readFileSync(join(__dirname, "..", "..", "package.json"), "utf-8")
    ) as { version?: string };
    return pkg.version ?? "0.1.0";
  } catch {
    return "0.1.0";
  }
}

interface ReleaseStatus {
  status?: string;
  version?: string | null;
  migrations?: {
    lastApplied: string | null;
    lastAppliedAt: string | null;
    count: number;
    note?: string;
  };
  schemaCoherence?: {
    ok: boolean | null;
    drift: Array<{ table: string; column: string; addedBy: string }>;
    checked?: number;
    note?: string;
  };
  buildStamp?: string | null;
}

/**
 * Fetch the pod's deploy-verification detail (version + migration + schema
 * coherence). Degrades to null on any error — an older pod without the route,
 * or an unreachable pod, simply omits the extra detail from `synap status`.
 */
async function fetchReleaseStatus(
  podUrl: string
): Promise<ReleaseStatus | null> {
  try {
    const res = await fetch(`${podUrl}/status/release`, {
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) return null;
    return (await res.json()) as ReleaseStatus;
  } catch {
    return null;
  }
}

function timeAgo(isoDate: string): string {
  const diff = Date.now() - new Date(isoDate).getTime();
  const minutes = Math.floor(diff / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? "" : "s"} ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? "" : "s"} ago`;
  const days = Math.floor(hours / 24);
  return `${days} day${days === 1 ? "" : "s"} ago`;
}

export async function status(opts: { json?: boolean } = {}): Promise<void> {
  // ── JSON mode: raw dump, no banner/pretty output ─────────────────────────
  // Focused on the "is the latest actually deployed?" question — pod health +
  // release/migration/coherence detail as one machine-readable object.
  if (opts.json) {
    const cfg = getActivePodConfig();
    const url = cfg?.podUrl ?? process.env.SYNAP_POD_URL ?? null;
    const health = url ? await checkPodHealth(url) : null;
    const release = url ? await fetchReleaseStatus(url) : null;
    process.stdout.write(
      JSON.stringify({ podUrl: url, health, release }, null, 2) + "\n"
    );
    return;
  }

  banner();

  // CLI version + update hint
  const cliVersion = getCliVersion();
  log.info(`CLI v${cliVersion}   ${chalk.dim("Update: npm update -g @synap-core/cli")}`);
  log.dim("Remote / API-only view. For local docker health, run ./synap health on the pod host.");

  const creds = getStoredToken();

  // ── Account ────────────────────────────────────────────────────────────
  // This is the synap.live CONTROL-PLANE account (~/.synap/credentials.json) —
  // a different identity axis from the pod API key (~/.synap/config.json). A
  // self-hosted pod added via `synap pods add` never has one, and works fine
  // without it. Never render the two axes as one, and never gate Next Steps on
  // this one — that's what made a healthy pod report "Not logged in".
  log.heading("Account");
  let cpLinked = false;
  if (creds) {
    log.success(`Logged in as ${chalk.bold(creds.email)} ${chalk.dim("(synap.live)")}`);
    log.dim(`User ID: ${creds.userId}`);

    if (isTokenLocallyExpired(creds)) {
      // Local expiry passed — confirm with CP before declaring dead.
      const authStatus = await isLoggedIn();
      if (authStatus.valid) {
        cpLinked = true;
        log.dim(`Token refreshed (valid until ${new Date(creds.expiresAt).toLocaleDateString()})`);
      } else {
        log.warn("Session expired — run: synap login");
        log.dim("On a server without a browser? Use: synap login --token <token>");
      }
    } else {
      // Token is locally fresh — validate in background but don't block on failure.
      cpLinked = true;
      const authStatus = await isLoggedIn().catch(() => ({ valid: false as const }));
      if (authStatus.valid) {
        log.dim(`Token valid until ${new Date(creds.expiresAt).toLocaleDateString()}`);
      } else {
        log.dim("Token fresh (CP unreachable — cached credentials in use)");
      }
    }
  } else {
    log.dim("Account (synap.live): not linked — optional for self-hosted pods.");
    log.dim("Needed only for managed pods, provisioning and the marketplace. Link with: synap login");
  }

  // ── Pod ────────────────────────────────────────────────────────────────
  const localConfig = getActivePodConfig();
  const podUrl = localConfig?.podUrl ?? process.env.SYNAP_POD_URL;
  const allProfiles = listPodProfiles();

  log.heading("Synap Pod");
  let podHealthy = false;
  if (!podUrl) {
    log.dim("Not connected. Run: synap init");
  } else {
    const pod = await checkPodHealth(podUrl);
    podHealthy = pod.healthy;
    if (allProfiles.length > 1) {
      const active = allProfiles.find((p) => p.active);
      log.info(`Active profile: ${chalk.bold(active?.name ?? "default")}  ${chalk.dim("(synap pods list to see all)")}`);
    }
    log.info(`URL: ${podUrl}`);
    log.info(
      `Health: ${pod.healthy ? chalk.green("healthy") : chalk.red("unreachable")}`
    );
    if (pod.version) log.info(`Version: ${pod.version}`);
    if (localConfig?.workspaceId) log.dim(`Workspace: ${localConfig.workspaceId}`);

    // ── Release / deploy verification ──────────────────────────────────────
    // Answers "is the latest actually deployed, and did the migration apply?"
    // from the pod's own runtime state. Older pods without the route just skip.
    if (pod.healthy) {
      const release = await fetchReleaseStatus(podUrl);
      if (release) {
        if (release.version) {
          log.info(`API build: ${chalk.bold(release.version)} ${chalk.dim("(@synap/api)")}`);
        }
        if (release.buildStamp) {
          log.dim(`Build stamp: ${release.buildStamp}`);
        }

        const mig = release.migrations;
        if (mig?.note) {
          log.dim(`Migrations: ${mig.note}`);
        } else if (mig) {
          const when = mig.lastAppliedAt ? ` ${chalk.dim(`(${timeAgo(mig.lastAppliedAt)})`)}` : "";
          log.info(
            `Last migration: ${chalk.bold(mig.lastApplied ?? "none")}  ${chalk.dim(`[${mig.count} applied]`)}${when}`
          );
        }

        const sc = release.schemaCoherence;
        if (sc?.note) {
          log.dim(`Schema: ${sc.note}`);
        } else if (sc) {
          if (sc.ok === true) {
            log.info(`Schema: ${chalk.green("OK")}${sc.checked ? chalk.dim(` (${sc.checked} columns checked)`) : ""}`);
          } else if (sc.ok === false) {
            log.warn(
              `Schema: ${chalk.red(`DRIFT — ${sc.drift.length} missing column${sc.drift.length === 1 ? "" : "s"}`)}`
            );
            for (const d of sc.drift.slice(0, 10)) {
              log.dim(`  • ${d.table}.${d.column}  ← ${d.addedBy}`);
            }
            if (sc.drift.length > 10) log.dim(`  … and ${sc.drift.length - 10} more`);
          } else {
            log.dim("Schema: unknown");
          }
        }
      }
    }
  }

  // ── Workspace Config ───────────────────────────────────────────────────
  log.heading("Workspace Config");
  if (localConfig) {
    log.info(`Workspace ID: ${localConfig.workspaceId}`);
    log.info(`Agent User:   ${localConfig.agentUserId}`);
    log.info(`Saved:        ${timeAgo(localConfig.savedAt)}`);
  } else {
    log.dim("No local config — run: synap init");
  }

  // ── API Key ────────────────────────────────────────────────────────────
  // Probe the Hub API to verify the stored key is still valid. A 401 here
  // means the key was rotated or revoked — surface the exact reconnect command
  // so the user doesn't have to diagnose it themselves.
  log.heading("API Key");
  // null = not checked (no pod / unreachable), true/false = probe result.
  // This is the axis Next Steps cares about — not the synap.live account.
  let keyValid: boolean | null = null;
  if (!localConfig) {
    log.dim("No pod configured.");
  } else if (!podHealthy) {
    log.dim("Pod unreachable — cannot verify key.");
  } else {
    try {
      const cfg = await resolveHubConfig();
      await hubGet("/users/me", {}, cfg);
      keyValid = true;
      log.success("Valid");
      log.dim(`Key saved: ${timeAgo(localConfig.savedAt)}`);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      // A non-HubError (transport, DNS) can still be an auth failure worded by
      // another layer — keep the text check as the fallback arm.
      const is401 =
        err instanceof HubError
          ? err.status === 401
          : msg.toLowerCase().includes("unauthorized");
      if (is401) {
        keyValid = false;
        const activeName = allProfiles.find((p) => p.active)?.name ?? "default";
        log.warn(chalk.red("Invalid or expired — credentials must be refreshed."));
        log.info(`Run: ${chalk.cyan(`synap login --reconnect ${activeName}`)}`);
      } else {
        // Verification itself failed — key state stays unknown, not invalid.
        renderHubError(err);
      }
    }
  }

  // ── Intelligence Service (via pod's own endpoint) ──────────────────────
  log.heading("Intelligence Service");
  if (!podUrl) {
    log.dim("No pod connected");
  } else if (!podHealthy) {
    log.dim("Pod unreachable — cannot check IS status");
  } else {
    try {
      const isRes = await fetch(`${podUrl}/api/provision/status`, {
        signal: AbortSignal.timeout(5000),
      }).catch(() => null);
      if (isRes?.ok) {
        const isData = (await isRes.json()) as {
          intelligenceService?: { status?: string; url?: string } | null;
          credentialsValid?: boolean | null;
          connectionState?: string;
          connectionIssueDetails?: Array<{ code: string; hint: string }>;
        };
        const svc = isData?.intelligenceService;
        // Gate on `status`, not on the object: an older pod still ships a
        // status-less `{}` here, and that is "not provisioned", not a status.
        if (svc?.status === "active") {
          log.success(`Active${svc.url ? ` (${svc.url})` : ""}`);
          if (isData.credentialsValid === false) {
            log.warn("Credentials invalid — reprovision from Browser Settings");
          }
        } else if (svc?.status) {
          log.warn(`Status: ${svc.status}`);
        } else {
          log.dim("Not provisioned");
          if (creds) {
            log.dim("Run 'synap init' to provision, or enable in Browser Settings > Add-ons");
          } else {
            log.dim("Sign in with 'synap login' then run 'synap init' to provision");
          }
        }
        // The pod already computed a next action for each issue — show it.
        if (isData.connectionState && isData.connectionState !== "connected") {
          log.dim(`Connection state: ${isData.connectionState}`);
        }
        for (const issue of isData.connectionIssueDetails ?? []) {
          log.warn(`${issue.code}: ${issue.hint}`);
        }
      } else {
        log.dim("Could not check (pod may not support this endpoint)");
      }
    } catch {
      log.dim("Could not check IS status");
    }
  }

  // ── Connectors ─────────────────────────────────────────────────────────
  // Without this, `synap status` says "All set" on a pod where every OAuth
  // connect is doomed because no provider is configured server-side.
  log.heading("Connectors");
  if (!localConfig) {
    log.dim("No pod configured.");
  } else if (!podHealthy) {
    log.dim("Pod unreachable — cannot check connectors.");
  } else {
    try {
      const cfg = await resolveHubConfig();
      const params: Record<string, string> = {};
      if (localConfig.workspaceId) params.workspaceId = localConfig.workspaceId;
      const res = (await hubGet("/connectors/providers", params, cfg)) as Record<string, unknown>;
      const providers = (res.providers ?? []) as Array<{
        connected?: boolean;
        displayName?: string;
        provider?: string;
        id?: string;
      }>;
      const nangoError = res.nangoError as
        | { reason?: string; message?: string }
        | undefined;
      // An empty list is only "nothing is declared" when Nango ANSWERED. On a
      // lookup failure the list is ALSO empty — asserting "none configured"
      // there is a false diagnosis, and false diagnoses are the whole bug.
      if (res.nangoStatus === "error") {
        log.warn(
          `Could not check connectors (${nangoError?.reason ?? "unknown"}) — connection state is unknown.`
        );
        if (nangoError?.message) log.dim(nangoError.message);
      } else if (providers.length === 0) {
        log.warn("No providers available — connecting a service will not work.");
        log.dim("This pod's Nango declares no integrations. They're declared in the Nango dashboard.");
      } else {
        const connectedProviders = providers.filter((p) => p.connected);
        log.info(
          `${providers.length} provider${providers.length === 1 ? "" : "s"} available  ${chalk.dim(`[${connectedProviders.length} connected]`)}`
        );
        // Name the connected ones — a bare count doesn't tell the user WHAT is wired up.
        for (const p of connectedProviders) {
          log.dim(`  ${chalk.green("✓")} ${p.displayName ?? p.provider ?? p.id}`);
        }
      }
    } catch (err: unknown) {
      log.warn(`Could not check connectors: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // ── Data Context ───────────────────────────────────────────────────────
  // Show who the agent is, what workspace is active, and pending proposals.
  log.heading("Data Context");
  if (localConfig?.podUrl ?? podUrl) {
    const routing = getAgentWorkspaceRouting();
    const memWs = routing?.memoryWorkspaceId;
    if (localConfig?.workspaceId) {
      log.info(`Active ws  : ${localConfig.workspaceId}`);
    }
    if (localConfig?.agentUserId) {
      log.info(`Agent user : ${localConfig.agentUserId}`);
    }
    if (memWs) {
      log.info(`Memory ws  : ${memWs}`);
    }
    if (podHealthy) {
      try {
        const cfg = await resolveHubConfig();
        const proposalsRes = await hubGet("/proposals", { status: "pending", limit: 1 }, cfg)
          .catch(() => null);
        if (proposalsRes) {
          const total = Number(
            (proposalsRes as Record<string, unknown>).total ??
            ((proposalsRes as Record<string, unknown[]>).proposals?.length ?? 0)
          );
          if (total > 0) {
            log.warn(`${total} pending proposal${total !== 1 ? "s" : ""} — run: synap proposals`);
          } else {
            log.dim("No pending proposals.");
          }
        }
      } catch {
        log.dim("Could not check proposals.");
      }
    }
  } else {
    log.dim("No pod connected — run: synap init");
  }

  // ── Next Steps ─────────────────────────────────────────────────────────
  log.heading("Next Steps");
  // Ordered by the POD axis — reachability, then config, then key validity.
  // The synap.live account is deliberately NOT a gate here: a self-hosted pod
  // is fully usable without one, and telling that user to `synap login` is the
  // misleading advice this section used to lead with.
  if (!podUrl) {
    log.info("Connect to a pod: synap init");
    log.dim("Already have a self-hosted pod? Add it with: synap pods add");
  } else if (!podHealthy) {
    log.info("Pod unreachable — check it with: ./synap health on the pod host");
  } else if (!localConfig) {
    log.info("Pod reachable but no local config — run: synap init");
  } else if (keyValid === false) {
    const activeName = allProfiles.find((p) => p.active)?.name ?? "default";
    log.info(`Refresh pod credentials: ${chalk.cyan(`synap login --reconnect ${activeName}`)}`);
  } else {
    log.dim("All set. Run: synap context   to load workspace context for an agent session.");
    if (!cpLinked) {
      log.dim("Optional: link a synap.live account with 'synap login' for managed pods + marketplace.");
    }
  }

  log.blank();
}
