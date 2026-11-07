/**
 * The host runner, wired for this computer: the pod's host-job doors with the
 * COMPUTER's own key, Docker for services, the per-OS steps for tools. One
 * runner per computer (reconciliation f75fbb48 §3.3): `synap worker` runs it
 * beside the agent's own work, `synap worker --host-only` runs it alone (a
 * server's `synap-host` user), and `synap tools` runs a pass of it at the
 * keyboard. Several workers on one computer share it through a lock file.
 */

import os from "node:os";
import path from "node:path";
import { createDockerRuntime } from "./compose.js";
import { readHostConfig } from "./config.js";
import { serveHost, statfsFreeMb, takeHostLock, type RunnerDeps, type ServeOptions } from "./lease.js";
import type { RunContext } from "./tool-run.js";
import { createHostHub } from "./wire.js";

export const hostLockFile = (): string => path.join(os.homedir(), ".synap", "host", "runner.lock");

export interface HostRunnerOptions {
  podUrl: string;
  /** This computer's own key (enrolment); never an agent's or the person's. */
  computerKey: string;
  /** The host config file (`--host-config`); default /etc/synap-host/config.json when present. */
  hostConfig?: string;
  log: (line: string) => void;
  toolContext?: () => RunContext;
}

export function createHostRunner(o: HostRunnerOptions): RunnerDeps {
  return {
    hub: createHostHub({ podUrl: o.podUrl, apiKey: o.computerKey }),
    runtime: createDockerRuntime(),
    config: readHostConfig(o.hostConfig),
    log: o.log,
    secrets: [o.computerKey],
    ...(o.toolContext ? { toolContext: o.toolContext } : {}),
  };
}

/** The line a runner says when it starts. */
export function hostRunnerLine(deps: RunnerDeps, podUrl: string): string {
  const c = deps.config;
  return (
    `host runner for ${podUrl}: services in ${c.installRoot} as ${c.user}, ${statfsFreeMb(c.installRoot)} MB free (keeps ${c.minFreeDiskMb})` +
    (c.tailnetIp ? `, tailnet ${c.tailnetIp}` : "")
  );
}

/** Lease and run this computer's host jobs until `signal` aborts, under the computer's lock. */
export function runHostLoop(deps: RunnerDeps, opts: Omit<ServeOptions, "lock"> & { lockFile?: string }): Promise<void> {
  const file = opts.lockFile ?? hostLockFile();
  return serveHost(deps, { ...opts, lock: () => takeHostLock(file) });
}
