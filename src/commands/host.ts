/**
 * `synap host serve` — run THIS computer as a host for installed capabilities:
 * lease the host jobs its person approved on the pod (install, update, remove,
 * a provider's computer-side op), run each exactly as the approved manifest
 * says, report health, and remove everything it started when a job fails.
 * Deterministic: no AI anywhere in this path (design ccd509f8 D3).
 *
 * The runner is a COMPUTER (device flow: `synap init` on it, then the person
 * turns on "Hosts services" for it in pod admin › Computers — scope
 * `host.runner`). It pulls work; the pod never starts anything here. Run it as
 * a dedicated OS user (`synap-host`) with access to a container engine; its
 * state files (compose files, volume folders) never hold a pod key.
 *
 * Config: /etc/synap-host/config.json (optional; defaults below).
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { resolveHubConfig } from "../lib/hub-client.js";
import { createDockerRuntime } from "../lib/host/compose.js";
import { serveHost, statfsFreeMb, type RunnerConfig } from "../lib/host/lease.js";
import { createHostHub } from "../lib/host/wire.js";

export interface HostOptions {
  config?: string;
  once?: boolean;
}

export const DEFAULT_HOST_CONFIG_PATH = "/etc/synap-host/config.json";

/** Renders and builds compete with everything else for the disk: keep 15 GB free by default. */
export const DEFAULT_MIN_FREE_DISK_MB = 15 * 1024;

export function readHostConfig(file: string | undefined): RunnerConfig {
  const explicit = file !== undefined;
  const at = file ?? DEFAULT_HOST_CONFIG_PATH;
  let raw: Partial<RunnerConfig> = {};
  if (fs.existsSync(at)) raw = JSON.parse(fs.readFileSync(at, "utf8")) as Partial<RunnerConfig>;
  else if (explicit) throw new Error(`${at}: no such config file`);
  const uid = typeof process.getuid === "function" ? process.getuid() : 0;
  const gid = typeof process.getgid === "function" ? process.getgid() : 0;
  if (uid === 0 && !raw.user) {
    throw new Error("synap host serve does not run containers as root: run it as its own user (synap-host), or set \"user\" in the config");
  }
  const cfg: RunnerConfig = {
    installRoot: raw.installRoot ?? path.join(os.homedir(), ".local", "share", "synap-host", "installations"),
    user: raw.user ?? `${uid}:${gid}`,
    minFreeDiskMb: raw.minFreeDiskMb ?? DEFAULT_MIN_FREE_DISK_MB,
    ...(raw.maxLimits ? { maxLimits: raw.maxLimits } : {}),
    ...(raw.tailnetIp ? { tailnetIp: raw.tailnetIp } : {}),
    ...(raw.tailnetHostname ? { tailnetHostname: raw.tailnetHostname } : {}),
    ...(raw.tailnetPorts ? { tailnetPorts: raw.tailnetPorts } : {}),
    ...(raw.secretsDir ? { secretsDir: raw.secretsDir } : {}),
    ...(raw.allowDeclaredEgress ? { allowDeclaredEgress: true } : {}),
  };
  if (!path.isAbsolute(cfg.installRoot)) throw new Error(`${at}: installRoot must be an absolute path`);
  return cfg;
}

function stamp(line: string): void {
  process.stdout.write(`${new Date().toISOString()} ${line}\n`);
}

export async function hostServeCommand(opts: HostOptions): Promise<void> {
  const config = readHostConfig(opts.config);
  const hubCfg = await resolveHubConfig();
  fs.mkdirSync(config.installRoot, { recursive: true, mode: 0o750 });
  stamp(
    `host runner for ${hubCfg.podUrl}: installations in ${config.installRoot}, containers as ${config.user}, ` +
      `${statfsFreeMb(config.installRoot)} MB free (keeps ${config.minFreeDiskMb})` +
      (config.tailnetIp ? `, tailnet ${config.tailnetIp}` : ", no tailnet address (tailnet-expose ops refused)")
  );
  const stop = new AbortController();
  for (const sig of ["SIGINT", "SIGTERM"] as const) process.once(sig, () => stop.abort());
  await serveHost(
    {
      hub: createHostHub(hubCfg),
      runtime: createDockerRuntime(),
      config,
      log: stamp,
      secrets: [hubCfg.apiKey],
    },
    { idleMs: 10_000, errorWaitMs: 30_000, once: opts.once, signal: stop.signal }
  );
}
