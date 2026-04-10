/**
 * synap status
 *
 * Show Synap pod + OpenClaw health at a glance.
 */

import chalk from "chalk";
import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import { log, banner } from "../utils/logger.js";
import { detectOpenClaw } from "../lib/openclaw.js";
import { checkPodHealth, getLocalPodConfig } from "../lib/pod.js";
import { runSecurityChecks, computeScore } from "../lib/hardening.js";
import { execSync } from "child_process";
import { isLoggedIn, getStoredToken, isTokenLocallyExpired, getOpenClawRemoteStatus } from "../lib/auth.js";

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

interface DockerOpenClawStatus {
  state: string;   // running | exited | restarting | created | paused
  health: string | null;  // healthy | unhealthy | starting | null
  image: string;
  logs: string[];  // last N lines, cleaned
}

/**
 * Inspect the OpenClaw Docker container without needing CP auth.
 * Works even when `openclaw` binary isn't installed (server Docker path).
 */
function getOpenClawDockerStatus(): DockerOpenClawStatus | null {
  try {
    // Find the container — try common name patterns
    const psOut = execSync(
      "docker ps -a --format '{{.Names}}\\t{{.Image}}\\t{{.Status}}' 2>/dev/null",
      { encoding: "utf-8", timeout: 4000 }
    );

    let containerName: string | null = null;
    let image = "unknown";

    for (const line of psOut.split("\n")) {
      if (/openclaw/i.test(line)) {
        const parts = line.split("\t");
        containerName = parts[0]?.trim() ?? null;
        image = parts[1]?.trim() ?? "unknown";
        break;
      }
    }

    if (!containerName) return null;

    // Get structured state + health
    const inspectRaw = execSync(
      `docker inspect --format '{{.State.Status}}\\t{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' ${containerName} 2>/dev/null`,
      { encoding: "utf-8", timeout: 4000 }
    ).trim();

    const [state, healthRaw] = inspectRaw.split("\t");
    const health = healthRaw === "none" || !healthRaw ? null : healthRaw;

    // Grab last 15 log lines, strip ANSI codes and docker timestamps
    let logs: string[] = [];
    try {
      const rawLogs = execSync(
        `docker logs ${containerName} --tail 15 2>&1`,
        { encoding: "utf-8", timeout: 5000 }
      );
      logs = rawLogs
        .split("\n")
        // Strip ANSI escape codes
        .map((l) => l.replace(/\x1b\[[0-9;]*m/g, "").trim())
        // Strip docker log timestamps (2026-04-10T12:34:56.789Z )
        .map((l) => l.replace(/^\d{4}-\d{2}-\d{2}T[\d:.]+Z\s+/, ""))
        .filter((l) => l.length > 0)
        // Only show warnings, errors, or startup messages — skip noisy health pings
        .filter((l) => {
          const lower = l.toLowerCase();
          return (
            lower.includes("error") ||
            lower.includes("warn") ||
            lower.includes("fatal") ||
            lower.includes("start") ||
            lower.includes("listen") ||
            lower.includes("ready") ||
            lower.includes("connect") ||
            lower.includes("fail")
          );
        })
        .slice(-8); // cap at 8 meaningful lines
    } catch {
      // logs unavailable — not critical
    }

    return { state: state?.trim() ?? "unknown", health, image, logs };
  } catch {
    return null;
  }
}

export async function status(): Promise<void> {
  banner();

  // CLI version + update hint
  const cliVersion = getCliVersion();
  log.info(`CLI v${cliVersion}   ${chalk.dim("Update: npm update -g @synap/cli")}`);

  // Hoist creds so all sections can use it
  const creds = getStoredToken();

  // Auth status
  // Strategy: show what we know locally first (email from stored creds),
  // then validate with the server. If the server is unreachable, trust the
  // local token as long as it hasn't locally expired. Only prompt to re-login
  // when the server explicitly rejects it (401) or the local expiry has passed.
  log.heading("Account");
  let loggedIn = false;
  if (creds) {
    // Always show local identity immediately — don't wait for server
    log.success(`Logged in as ${chalk.bold(creds.email)}`);
    log.dim(`User ID: ${creds.userId}`);

    if (isTokenLocallyExpired(creds)) {
      // Local expiry passed — validate against server to confirm
      const authStatus = await isLoggedIn();
      if (authStatus.valid) {
        loggedIn = true;
        log.dim(`Token refreshed (valid until ${new Date(creds.expiresAt).toLocaleDateString()})`);
      } else {
        log.warn("Session expired — run: synap login");
        log.dim("On a server without a browser? Use: synap login --token <token>");
      }
    } else {
      // Token is locally fresh — validate in background but don't block on failure
      loggedIn = true;
      const authStatus = await isLoggedIn().catch(() => ({ valid: false as const }));
      if (authStatus.valid) {
        log.dim(`Token valid until ${new Date(creds.expiresAt).toLocaleDateString()}`);
      } else {
        // CP unreachable but token is fresh — trust it, just note it
        log.dim(`Token fresh (CP unreachable — cached credentials in use)`);
      }
    }
  } else {
    log.dim("Not logged in. Run: synap login");
  }

  // OpenClaw status
  log.heading("OpenClaw");
  const oc = detectOpenClaw();
  let skillInstalled = false;
  const localConfig = getLocalPodConfig();

  if (oc.found) {
    const runtimeLabel = oc.runtime === "docker"
      ? chalk.cyan(`Docker (${oc.containerName ?? "openclaw"})`)
      : chalk.dim("local install");
    log.success(`Gateway: ${oc.gatewayRunning ? chalk.green("running") : chalk.yellow("stopped")} (port ${oc.gatewayPort ?? 18789})  [${runtimeLabel}]`);
    if (oc.version) log.info(`Version: ${oc.version}`);
    const checks = runSecurityChecks(oc.version);
    const score = computeScore(checks);
    const passed = checks.filter((c) => c.passed).length;
    log.info(
      `Security: ${score === "A" ? chalk.green(score) : score === "B" ? chalk.yellow(score) : chalk.red(score)} (${passed}/${checks.length})`
    );
  } else {
    // Check Docker container (works even without CP login)
    const dockerInfo = getOpenClawDockerStatus();

    if (dockerInfo) {
      const { state, health, image, logs } = dockerInfo;
      const stateLabel =
        state === "running"
          ? chalk.green("running")
          : state === "restarting"
          ? chalk.yellow("restarting")
          : state === "exited"
          ? chalk.red("exited")
          : chalk.dim(state);

      log.info(`Container: ${stateLabel}${health ? ` (${health})` : ""}  [${image}]`);

      if (state === "running" && health !== "healthy") {
        log.warn("Container is up but gateway health check hasn't passed yet");
        log.dim("Give it another minute, then: synap status");
      } else if (state === "restarting") {
        log.warn("Container is crash-looping — check logs below");
      } else if (state === "exited") {
        log.warn("Container has stopped — check logs below");
        log.dim("Restart: docker compose --profile openclaw up -d openclaw");
      }

      if (logs.length > 0) {
        log.blank();
        log.info("Recent container logs:");
        for (const line of logs) {
          console.log(chalk.dim(`  ${line}`));
        }
      }
    } else if (localConfig?.podId && creds) {
      // No Docker container visible here — check CP for remote provisioning state
      const remoteStatus = await getOpenClawRemoteStatus(creds.token, localConfig.podId).catch(() => null);
      if (remoteStatus === null) {
        // CP unreachable — show what we know locally
        log.dim(`Pod ID: ${localConfig.podId}`);
        log.dim("CP unreachable — cannot check remote OpenClaw state");
        log.dim("If on the pod server, run: docker ps | grep openclaw");
      } else if (remoteStatus.status === "not_provisioned") {
        log.dim("Not provisioned on pod server. Run: synap init");
      } else if (remoteStatus.status === "provisioning") {
        log.info(`Pod server: ${chalk.yellow("provisioning")} — still starting up`);
        log.dim("Check: docker logs openclaw --tail 30");
        log.dim("Once ready: synap finish");
      } else if (remoteStatus.status === "running") {
        log.success(`Pod server: ${chalk.green("running")}`);
        if (remoteStatus.url) log.dim(`URL: ${remoteStatus.url}`);
        log.dim("Run synap finish to install the skill");
      } else if (remoteStatus.status === "error") {
        log.warn(`Pod server: ${chalk.red("error")} — provisioning failed`);
        log.dim("Re-run: synap init");
      }
    } else {
      log.dim("Not detected locally");
      if (!localConfig) {
        log.dim("Run synap init to connect to a pod");
      } else {
        log.dim("Run synap init to set up OpenClaw");
      }
    }
  }

  // Pod status
  log.heading("Synap Pod");
  const ocConfig = oc.found
    ? ((oc.config as Record<string, unknown>)?.synap as Record<string, unknown>)
    : null;
  const podUrl =
    (ocConfig?.podUrl as string) ??
    localConfig?.podUrl ??
    process.env.SYNAP_POD_URL;

  if (!podUrl) {
    log.dim("Not connected. Run: synap init");
  } else {
    const pod = await checkPodHealth(podUrl);
    log.info(`URL: ${podUrl}`);
    log.info(
      `Health: ${pod.healthy ? chalk.green("healthy") : chalk.red("unreachable")}`
    );
    if (pod.version) log.info(`Version: ${pod.version}`);
    if (localConfig?.workspaceId) log.dim(`Workspace: ${localConfig.workspaceId}`);
  }

  // Workspace Config section
  log.heading("Workspace Config");
  if (localConfig) {
    log.info(`Workspace ID: ${localConfig.workspaceId}`);
    log.info(`Agent User:   ${localConfig.agentUserId}`);
    log.info(`Saved:        ${timeAgo(localConfig.savedAt)}`);
  } else {
    log.dim("No local config — run: synap init");
  }

  // Intelligence Service
  log.heading("Intelligence Service");
  if (podUrl) {
    try {
      const isRes = await fetch(`${podUrl}/api/provision/status`, {
        signal: AbortSignal.timeout(5000),
      }).catch(() => null);
      if (isRes?.ok) {
        const isData = (await isRes.json()) as {
          intelligenceService?: { status: string; url?: string } | null;
          credentialsValid?: boolean | null;
        };
        const svc = isData?.intelligenceService;
        if (svc?.status === "active") {
          log.success(`Active${svc.url ? ` (${svc.url})` : ""}`);
          if (isData.credentialsValid === false) {
            log.warn("Credentials invalid — reprovision from Browser Settings");
          }
        } else if (svc) {
          log.warn(`Status: ${svc.status}`);
        } else {
          log.dim("Not provisioned");
          if (creds) {
            log.dim("Run 'synap init' to provision, or enable in Browser Settings > Add-ons");
          } else {
            log.dim("Sign in with 'synap login' then run 'synap init' to provision");
          }
        }
      } else {
        log.dim("Could not check (pod may not support this endpoint)");
      }
    } catch {
      log.dim("Could not check IS status");
    }
  } else {
    log.dim("No pod connected");
  }

  // Synap skill
  log.heading("Synap Skill");
  if (oc.found) {
    if (oc.runtime === "docker") {
      // Check inside the container
      const { isSynapSkillInstalledInDocker } = await import("../lib/pod.js");
      const container = oc.containerName ?? "openclaw";
      try {
        const installed = isSynapSkillInstalledInDocker(container);
        if (installed) {
          skillInstalled = true;
          log.success(`Installed (inside ${container})`);
        } else {
          log.dim(`Not installed. Run: docker exec ${container} openclaw skills install synap`);
          log.dim("Or: synap finish");
        }
      } catch {
        log.dim(`Could not check — try: docker exec ${container} openclaw skills list`);
      }
    } else if (oc.skillsDir) {
      const { existsSync } = await import("fs");
      const skillPath = join(oc.skillsDir, "synap");
      if (existsSync(skillPath)) {
        skillInstalled = true;
        log.success("Installed");
      } else {
        log.dim("Not installed. Run: openclaw skills install synap");
      }
    }
  } else {
    log.dim("Cannot check — OpenClaw not detected");
  }

  // Next Steps section
  log.heading("Next Steps");
  if (!loggedIn) {
    log.info("Login: synap login");
  } else if (!localConfig) {
    log.info("Connect to a pod: synap init");
  } else if (!oc.found) {
    log.info("OpenClaw not running. Start it or run: synap init");
  } else if (!skillInstalled) {
    log.info("Install skill: synap finish");
  } else {
    log.dim("All set. Use synap update to refresh the skill.");
  }

  log.blank();
}
