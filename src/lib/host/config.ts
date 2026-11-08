/**
 * The host runner's config on this computer: where installations live, which
 * user their containers run as, the disk to keep free, the tailnet address a
 * provider binds to. `synap worker` reads it (`--host-config`, else
 * /etc/synap-host/config.json when present, else the defaults below).
 *
 * The runner is a COMPUTER (device flow: `synap init` on it, then the person
 * turns on "Installs from the pod" for it in pod admin › Computers — scope
 * `host.runner`). It pulls work; the pod never starts anything here. On a
 * server, run it as a dedicated OS user (`synap-host`, `synap worker
 * --host-only`) with access to a container engine; its state files (compose
 * files, volume folders) never hold a pod key.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { RunnerConfig } from "./lease.js";

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
    throw new Error("synap worker does not run containers as root: run it as its own user (synap-host), or set \"user\" in the config");
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
