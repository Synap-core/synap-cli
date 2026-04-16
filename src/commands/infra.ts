/**
 * synap infra
 *
 * Infrastructure management via Dokploy — view servers, trigger deploys,
 * tail logs, and sync server state into Synap entities.
 *
 *   synap infra               — overview: servers + services status
 *   synap infra status        — same as above
 *   synap infra deploy <app>  — trigger a redeploy for a named app
 *   synap infra logs <app>    — tail logs for a service
 *   synap infra sync          — pull Dokploy state into Synap entities
 *   synap infra open          — open Dokploy dashboard in browser
 */

import chalk from "chalk";
import ora from "ora";
import { execSync } from "child_process";
import { log, banner } from "../utils/logger.js";

// ─── Dokploy client helpers ───────────────────────────────────────────────────

interface DokployConfig {
  url: string;
  apiKey: string;
}

function getDokployConfig(): DokployConfig | null {
  const url = process.env.DOKPLOY_URL ?? process.env.DEPLOY_DOMAIN
    ? `https://${process.env.DEPLOY_DOMAIN}`
    : "https://deploy.synap.live";
  const apiKey = process.env.DOKPLOY_API_KEY ?? "";

  if (!apiKey) return null;
  return { url, apiKey };
}

async function dokployFetch<T>(
  path: string,
  options: RequestInit = {}
): Promise<T> {
  const config = getDokployConfig();
  if (!config) {
    throw new Error(
      "DOKPLOY_API_KEY not set. Get it from the Dokploy dashboard → Settings → API Keys,\n" +
        "  then add it to your .env or export DOKPLOY_API_KEY=<key>"
    );
  }

  const res = await fetch(`${config.url}${path}`, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      "x-api-key": config.apiKey,
      ...options.headers,
    },
  });

  if (!res.ok) {
    const text = await res.text().catch(() => res.statusText);
    throw new Error(`Dokploy ${path}: ${res.status} ${text}`);
  }

  return res.json() as Promise<T>;
}

// ─── Status overview ─────────────────────────────────────────────────────────

export async function infraStatus(): Promise<void> {
  banner();

  const config = getDokployConfig();
  if (!config) {
    log.warn("Dokploy API key not configured.");
    log.blank();
    log.dim("1. Open https://deploy.synap.live → Settings → API Keys → Create key");
    log.dim("2. Add to your shell:  export DOKPLOY_API_KEY=<key>");
    log.dim("3. Or add to .env:     DOKPLOY_API_KEY=<key>");
    log.blank();
    log.info(`Dashboard: ${chalk.cyan("https://deploy.synap.live")}`);
    return;
  }

  const spinner = ora("Fetching infrastructure status...").start();

  try {
    // Dokploy API: GET /api/servers and GET /api/applications
    const [servers, apps] = await Promise.all([
      dokployFetch<{ id: string; name: string; ip: string; status: string }[]>(
        "/api/server.all"
      ).catch(() => [] as { id: string; name: string; ip: string; status: string }[]),
      dokployFetch<{ id: string; name: string; status: string; env: string; serverId: string }[]>(
        "/api/application.all"
      ).catch(() => [] as { id: string; name: string; status: string; env: string; serverId: string }[]),
    ]);

    spinner.stop();

    // ── Servers ──
    log.heading("Servers");
    if (servers.length === 0) {
      log.dim("  No servers connected. Add one in the Dokploy dashboard.");
    } else {
      for (const s of servers) {
        const dot =
          s.status === "active"
            ? chalk.green("●")
            : s.status === "inactive"
            ? chalk.red("●")
            : chalk.yellow("●");
        console.log(`  ${dot} ${chalk.bold(s.name)}  ${chalk.dim(s.ip)}`);
      }
    }

    log.blank();

    // ── Services ──
    log.heading("Services");
    if (apps.length === 0) {
      log.dim("  No services deployed yet.");
    } else {
      const byServer = new Map<string, typeof apps>();
      for (const app of apps) {
        const key = app.serverId ?? "local";
        if (!byServer.has(key)) byServer.set(key, []);
        byServer.get(key)!.push(app);
      }

      for (const [serverId, list] of byServer) {
        const server = servers.find((s) => s.id === serverId);
        if (server) log.dim(`  ── ${server.name} ──`);

        for (const app of list) {
          const status =
            app.status === "running"
              ? chalk.green(app.status)
              : app.status === "error"
              ? chalk.red(app.status)
              : chalk.yellow(app.status);
          console.log(`  ${chalk.bold(app.name)}  ${status}  ${chalk.dim(app.env ?? "")}`);
        }
      }
    }

    log.blank();
    log.dim(`Dashboard: ${chalk.cyan(config.url)}`);
    log.dim("To deploy: synap infra deploy <app-name>");
    log.dim("To tail logs: synap infra logs <app-name>");
  } catch (err) {
    spinner.fail("Failed to reach Dokploy");
    const msg = err instanceof Error ? err.message : String(err);
    log.error(msg);
  }
}

// ─── Deploy ──────────────────────────────────────────────────────────────────

export async function infraDeploy(appName: string): Promise<void> {
  const spinner = ora(`Triggering deploy for ${chalk.bold(appName)}...`).start();

  try {
    // List apps, find by name
    const apps = await dokployFetch<{ id: string; name: string; appName: string }[]>(
      "/api/application.all"
    );

    const match = apps.find(
      (a) =>
        a.name.toLowerCase() === appName.toLowerCase() ||
        a.appName?.toLowerCase() === appName.toLowerCase()
    );

    if (!match) {
      spinner.fail(`App not found: ${appName}`);
      log.blank();
      log.dim("Available apps:");
      for (const a of apps) log.dim(`  • ${a.name}`);
      return;
    }

    await dokployFetch(`/api/application.deploy`, {
      method: "POST",
      body: JSON.stringify({ applicationId: match.id }),
    });

    spinner.succeed(`Deploy triggered for ${chalk.bold(match.name)}`);
    log.dim(`Watch progress: synap infra logs ${appName}`);
  } catch (err) {
    spinner.fail("Deploy failed");
    log.error(err instanceof Error ? err.message : String(err));
  }
}

// ─── Logs ────────────────────────────────────────────────────────────────────

export async function infraLogs(
  appName: string,
  opts: { lines?: number; follow?: boolean }
): Promise<void> {
  try {
    const apps = await dokployFetch<{ id: string; name: string; appName: string; containerId?: string }[]>(
      "/api/application.all"
    );

    const match = apps.find(
      (a) =>
        a.name.toLowerCase() === appName.toLowerCase() ||
        a.appName?.toLowerCase() === appName.toLowerCase()
    );

    if (!match) {
      log.error(`App not found: ${appName}`);
      log.blank();
      log.dim("Available apps:");
      for (const a of apps) log.dim(`  • ${a.name}`);
      return;
    }

    // Use docker logs via container name (Dokploy uses appName as container name)
    const containerName = match.appName ?? match.name;
    const tail = opts.lines ?? 100;
    const followFlag = opts.follow ? "-f" : "";
    const cmd = `docker logs --tail ${tail} ${followFlag} ${containerName}`;

    log.dim(`> ${cmd}`);
    log.blank();

    execSync(cmd, { stdio: "inherit" });
  } catch (err) {
    log.error(err instanceof Error ? err.message : String(err));
  }
}

// ─── Sync ─────────────────────────────────────────────────────────────────────

export async function infraSync(podUrl: string, apiKey: string): Promise<void> {
  const spinner = ora("Syncing Dokploy state into Synap entities...").start();

  try {
    const [servers, apps] = await Promise.all([
      dokployFetch<{ id: string; name: string; ip: string; status: string; region?: string }[]>(
        "/api/server.all"
      ),
      dokployFetch<{
        id: string;
        name: string;
        status: string;
        env: string;
        serverId: string;
        domain?: string;
        image?: string;
      }[]>("/api/application.all"),
    ]);

    spinner.text = `Upserting ${servers.length} servers + ${apps.length} deployments...`;

    // Push to Synap Hub Protocol
    const headers = {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    };

    let created = 0;
    let updated = 0;

    for (const s of servers) {
      const res = await fetch(`${podUrl}/api/hub/entities/upsert`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          profileSlug: "server",
          dedupeKey: `dokploy:server:${s.id}`,
          title: s.name,
          properties: {
            ip: s.ip,
            status: s.status === "active" ? "online" : "offline",
            region: s.region ?? "",
            dokployServerId: s.id,
          },
        }),
      });
      if (res.ok) {
        const { created: c } = await res.json() as { created: boolean };
        c ? created++ : updated++;
      }
    }

    for (const app of apps) {
      const res = await fetch(`${podUrl}/api/hub/entities/upsert`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          profileSlug: "deployment",
          dedupeKey: `dokploy:app:${app.id}`,
          title: app.name,
          properties: {
            deployStatus: app.status,
            env: app.env ?? "production",
            url: app.domain ? `https://${app.domain}` : "",
            image: app.image ?? "",
            dokployAppId: app.id,
          },
        }),
      });
      if (res.ok) {
        const { created: c } = await res.json() as { created: boolean };
        c ? created++ : updated++;
      }
    }

    spinner.succeed(
      `Sync complete — ${chalk.green(created)} created, ${chalk.blue(updated)} updated`
    );
  } catch (err) {
    spinner.fail("Sync failed");
    log.error(err instanceof Error ? err.message : String(err));
  }
}

// ─── Open dashboard ──────────────────────────────────────────────────────────

export function infraOpen(): void {
  const config = getDokployConfig();
  const url = config?.url ?? "https://deploy.synap.live";

  try {
    const platform = process.platform;
    const cmd =
      platform === "darwin"
        ? "open"
        : platform === "win32"
        ? "start"
        : "xdg-open";
    execSync(`${cmd} ${url}`);
    log.success(`Opening ${url}`);
  } catch {
    log.info(`Dashboard: ${chalk.cyan(url)}`);
  }
}
