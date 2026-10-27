/**
 * `synap box serve` — run THIS computer as a run box provisioner: lease the
 * box runs its person queued on the pod, run each in a fresh unprivileged LXC
 * on an isolated bridge, hand back the evidence, destroy the box.
 *
 * The provisioner is a COMPUTER (device flow: `synap init` on it, then the
 * person turns on "Runs scripts" for it in pod-admin › Computers — scope
 * `box.runner`). It pulls work; the pod never starts anything here. The box
 * holds no credential and has no route to the pod (runbox design C4).
 *
 * Host side (bridge, firewall, pool-scoped Proxmox token, template CT):
 * `my server` docs/RUNBOX.md. Config: /etc/synap-box/config.json (below).
 */

import fs from "node:fs";
import { resolveHubConfig } from "../lib/hub-client.js";
import { createEgressProxy } from "../lib/box/egress.js";
import { BoxRegistry, createJobServer } from "../lib/box/job-server.js";
import { createProxmoxApi, createProxmoxBackend, type BoxHostConfig } from "../lib/box/proxmox.js";
import { DEFAULT_GUARDS, reap, serve, type HostGuards } from "../lib/box/provisioner.js";
import { createBoxHub } from "../lib/box/wire.js";

export interface BoxConfig {
  proxmox: {
    endpoint: string;
    node: string;
    /** File holding `user@realm!tokenid=secret` (mode 600). */
    tokenFile: string;
    /** The host CA, /etc/pve/pve-root-ca.pem copied here. */
    caFile: string;
    /** Verify the host cert as this name when the endpoint is an address it does not list. */
    serverName?: string;
  };
  host: BoxHostConfig;
  /** The provisioner's own address on the box bridge (proxy + job server bind here only). */
  bridgeIp: string;
  jobPort: number;
  proxyPort: number;
  stagingDir: string;
  guards?: Partial<HostGuards>;
}

export interface BoxOptions {
  config?: string;
  once?: boolean;
}

export const DEFAULT_CONFIG_PATH = "/etc/synap-box/config.json";

export function readBoxConfig(file: string): BoxConfig {
  const cfg = JSON.parse(fs.readFileSync(file, "utf8")) as BoxConfig;
  for (const k of ["proxmox", "host", "bridgeIp", "jobPort", "proxyPort", "stagingDir"] as const) {
    if (cfg[k] === undefined) throw new Error(`${file}: missing "${k}"`);
  }
  return cfg;
}

function stamp(line: string): void {
  process.stdout.write(`${new Date().toISOString()} ${line}\n`);
}

function backendFrom(cfg: BoxConfig) {
  const api = createProxmoxApi({
    endpoint: cfg.proxmox.endpoint,
    node: cfg.proxmox.node,
    token: fs.readFileSync(cfg.proxmox.tokenFile, "utf8").trim(),
    ca: fs.readFileSync(cfg.proxmox.caFile, "utf8"),
    serverName: cfg.proxmox.serverName,
  });
  return createProxmoxBackend(api, cfg.proxmox.node, cfg.host);
}

function listen(server: import("node:http").Server, port: number, host: string): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => resolve());
  });
}

export async function boxServeCommand(opts: BoxOptions): Promise<void> {
  const cfg = readBoxConfig(opts.config ?? DEFAULT_CONFIG_PATH);
  const hubCfg = await resolveHubConfig();
  const registry = new BoxRegistry(cfg.stagingDir);
  const backend = backendFrom(cfg);

  const proxy = createEgressProxy({
    policyFor: (ip) => registry.policyFor(ip),
    onBlock: (ip, block) => {
      registry.recordBlock(ip, block);
      stamp(`egress refused for ${ip}: ${block.host}:${block.port} (${block.phase}) — ${block.reason}`);
    },
  });
  const jobs = createJobServer(registry);
  await listen(proxy, cfg.proxyPort, cfg.bridgeIp);
  await listen(jobs, cfg.jobPort, cfg.bridgeIp);
  stamp(`box provisioner on ${cfg.bridgeIp} (jobs :${cfg.jobPort}, egress :${cfg.proxyPort}) for ${hubCfg.podUrl}`);
  if (!cfg.host.thinpool) stamp("thin pool metadata guard OFF: host.thinpool is not set in the config");

  const stop = new AbortController();
  for (const sig of ["SIGINT", "SIGTERM"] as const) process.once(sig, () => stop.abort());
  try {
    await serve(
      { hub: createBoxHub(hubCfg), backend, registry, log: stamp },
      {
        guards: { ...DEFAULT_GUARDS, ...cfg.guards },
        idleMs: 10_000,
        guardWaitMs: 30_000,
        once: opts.once,
        signal: stop.signal,
      }
    );
  } finally {
    proxy.close();
    jobs.close();
  }
}

export async function boxReapCommand(opts: BoxOptions): Promise<void> {
  const cfg = readBoxConfig(opts.config ?? DEFAULT_CONFIG_PATH);
  const gone = await reap(backendFrom(cfg), new Set(), stamp);
  stamp(`reaper: ${gone.length} box(es) destroyed`);
}
