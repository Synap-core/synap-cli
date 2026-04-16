/**
 * synap update
 *
 * Update the synap skill and optionally trigger a server-side redeploy
 * via Dokploy when DOKPLOY_API_KEY is configured.
 *
 *   synap update              — update skill + show service status
 *   synap update --server     — also trigger Dokploy redeploy of control-plane
 *   synap update --all        — trigger redeploy of all registered Dokploy services
 */

import chalk from "chalk";
import ora from "ora";
import { log, banner } from "../utils/logger.js";
import { detectOpenClaw } from "../lib/openclaw.js";
import { installSynapSkill } from "../lib/pod.js";

export interface UpdateOptions {
  server?: boolean;
  all?: boolean;
}

// ─── Dokploy helpers ─────────────────────────────────────────────────────────

interface DokployApp {
  id: string;
  name: string;
  appName?: string;
  status: string;
  env?: string;
}

function getDokployBase(): { url: string; key: string } | null {
  const key = process.env.DOKPLOY_API_KEY ?? "";
  if (!key) return null;

  const domain = process.env.DEPLOY_DOMAIN ?? "deploy.synap.live";
  const url = process.env.DOKPLOY_URL ?? `https://${domain}`;
  return { url, key };
}

async function fetchApps(): Promise<DokployApp[]> {
  const dok = getDokployBase();
  if (!dok) return [];

  try {
    const res = await fetch(`${dok.url}/api/application.all`, {
      headers: { "x-api-key": dok.key },
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return [];
    return (await res.json()) as DokployApp[];
  } catch {
    return [];
  }
}

async function triggerDeploy(appId: string): Promise<boolean> {
  const dok = getDokployBase();
  if (!dok) return false;

  try {
    const res = await fetch(`${dok.url}/api/application.deploy`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-api-key": dok.key },
      body: JSON.stringify({ applicationId: appId }),
      signal: AbortSignal.timeout(10000),
    });
    return res.ok;
  } catch {
    return false;
  }
}

// ─── Main ────────────────────────────────────────────────────────────────────

export async function update(opts: UpdateOptions = {}): Promise<void> {
  banner();
  log.heading("Update");

  // ── 1. Skill update (OpenClaw) ────────────────────────────────────────────
  const oc = detectOpenClaw();
  if (oc.found) {
    const spinner = ora("Updating synap skill...").start();
    try {
      installSynapSkill();
      spinner.succeed("Synap skill updated");
    } catch (err) {
      spinner.fail(err instanceof Error ? err.message : "Skill update failed");
    }
  } else {
    log.dim("OpenClaw not detected — skipping skill update");
  }

  // ── 2. Dokploy service status ─────────────────────────────────────────────
  log.blank();
  const dok = getDokployBase();

  if (!dok) {
    log.dim("Dokploy not configured (DOKPLOY_API_KEY not set)");
    log.dim("To enable server management: set DOKPLOY_API_KEY + DEPLOY_DOMAIN in your env");
    log.blank();
    log.info("To update the CLI itself:");
    log.dim("  npm update -g @synap/cli");
    log.blank();
    return;
  }

  const appsSpinner = ora("Fetching service status from Dokploy...").start();
  const apps = await fetchApps();
  appsSpinner.stop();

  if (apps.length === 0) {
    log.dim("No services found in Dokploy (or API unreachable)");
  } else {
    log.heading("Services");
    for (const app of apps) {
      const status =
        app.status === "running"
          ? chalk.green(app.status)
          : app.status === "error"
          ? chalk.red(app.status)
          : chalk.yellow(app.status);
      console.log(
        `  ${chalk.bold(app.name.padEnd(24))} ${status}  ${chalk.dim(app.env ?? "")}`
      );
    }
  }

  // ── 3. Trigger redeploys if requested ─────────────────────────────────────
  if (opts.server || opts.all) {
    log.blank();
    log.heading(opts.all ? "Redeploying all services" : "Redeploying control-plane");

    const targets = opts.all
      ? apps
      : apps.filter((a) =>
          a.name.toLowerCase().includes("control-plane") ||
          a.appName?.toLowerCase().includes("control-plane")
        );

    if (targets.length === 0) {
      log.dim("No matching services found in Dokploy");
      log.dim("Register services first: synap infra status");
    } else {
      for (const app of targets) {
        const spinner = ora(`Deploying ${app.name}...`).start();
        const ok = await triggerDeploy(app.id);
        if (ok) {
          spinner.succeed(`${app.name}: deploy triggered`);
        } else {
          spinner.fail(`${app.name}: deploy failed`);
        }
      }
    }

    log.blank();
    log.dim(`Watch progress: ${chalk.cyan(`${dok.url}`)}`);
    log.dim("Or tail logs:   synap infra logs <service-name>");
  } else if (apps.length > 0) {
    log.blank();
    log.dim(
      `To redeploy:  ${chalk.cyan("synap update --server")}  (control-plane only)`
    );
    log.dim(
      `              ${chalk.cyan("synap update --all")}     (all services)`
    );
  }

  // ── 4. CLI update reminder ────────────────────────────────────────────────
  log.blank();
  log.info("To update the CLI itself:");
  log.dim("  npm update -g @synap/cli");
  log.blank();
}
