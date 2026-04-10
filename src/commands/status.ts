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

export async function status(): Promise<void> {
  banner();

  // CLI version + update hint
  const cliVersion = getCliVersion();
  log.info(`CLI v${cliVersion}   ${chalk.dim("Update: npm update -g @synap/cli")}`);

  // Hoist creds so all sections can use it
  const creds = getStoredToken();

  // Auth status
  log.heading("Account");
  let loggedIn = false;
  if (creds) {
    const authStatus = await isLoggedIn();
    if (authStatus.valid) {
      loggedIn = true;
      log.success(`Logged in as ${authStatus.email}`);
      log.dim(`User ID: ${authStatus.userId}`);
      log.dim(`Token expires: ${new Date(creds.expiresAt).toLocaleDateString()}`);
    } else if (isTokenLocallyExpired(creds)) {
      log.warn("Session expired — run: synap login");
      log.dim("On a server? Use: synap login --token <token>");
    } else {
      log.warn("Could not reach Synap (network error?)");
      log.dim("Run: synap status  (when online)");
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
    // Local OpenClaw running
    log.info(`Version: ${oc.version ?? "unknown"}`);
    log.info(
      `Gateway: ${oc.gatewayRunning ? chalk.green("running") : chalk.dim("stopped")} (port ${oc.gatewayPort ?? 18789})`
    );
    const checks = runSecurityChecks(oc.version);
    const score = computeScore(checks);
    const passed = checks.filter((c) => c.passed).length;
    log.info(
      `Security: ${score === "A" ? chalk.green(score) : score === "B" ? chalk.yellow(score) : chalk.red(score)} (${passed}/${checks.length})`
    );
  } else if (localConfig?.podId && creds) {
    // Not local — check if provisioned on pod server
    log.dim("Not running locally — checking pod server...");
    const remoteStatus = await getOpenClawRemoteStatus(creds.token, localConfig.podId);
    if (!remoteStatus || remoteStatus.status === "not_provisioned") {
      log.dim("Not provisioned on pod server");
      log.dim("Enable via: synap init");
    } else if (remoteStatus.status === "provisioning") {
      log.info(`Pod server: ${chalk.yellow("provisioning")} — still starting up, check back in a few minutes`);
      log.dim("Run synap status again to check progress");
    } else if (remoteStatus.status === "running") {
      log.success(`Pod server: ${chalk.green("running")} — OpenClaw is active on your pod`);
      log.dim("To use locally: npm i -g openclaw && openclaw onboard");
      log.dim(`Then: synap finish --pod-url ${localConfig.podUrl}`);
    } else if (remoteStatus.status === "error") {
      log.warn(`Pod server: ${chalk.red("error")} — provisioning failed`);
      log.dim("Re-provision via: synap init");
    }
  } else {
    log.dim("Not installed");
    if (!creds) log.dim("Login to check pod server status: synap login");
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
  if (oc.found && oc.skillsDir) {
    const { existsSync } = await import("fs");
    const skillPath = join(oc.skillsDir, "synap");
    if (existsSync(skillPath)) {
      skillInstalled = true;
      log.success("Installed");
    } else {
      log.dim("Not installed. Run: openclaw skills install synap");
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
    log.info("OpenClaw not detected. Install:");
    log.dim("  npm i -g openclaw  OR  enable addon via: synap init");
  } else if (!skillInstalled) {
    log.info("Install skill: synap finish  OR  openclaw skills install synap");
  } else {
    log.dim("All set. Use synap update to refresh the skill.");
  }

  log.blank();
}
