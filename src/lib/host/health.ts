/**
 * Health: is each service of an installation up, checked from THIS computer
 * only (127.0.0.1), within a clock. The clocks follow the box runner's shape
 * (BOOT, SETUP, wall): one budget per step, and a step that runs out of it is
 * the job's failure, never a hang.
 *
 * A service with a declared health path is healthy when its container runs AND
 * `GET http://127.0.0.1:<host port><path>` answers below 400. A service with
 * none (a worker that only pulls jobs) is healthy when its container has been
 * running for two checks in a row, so a crash loop never reads as healthy.
 */

import type { ContainerRuntime, ContainerState, InstallationPlan } from "./compose.js";
import type { ServiceHealth } from "./wire.js";

/** Pull every image by digest (big images: HyperFrames is ~3.7 GB). */
export const PULL_SECONDS = 30 * 60;
/** `compose up` must return by then. */
export const START_SECONDS = 5 * 60;
/** Every service must be healthy by then. */
export const HEALTH_SECONDS = 3 * 60;

export interface HealthDeps {
  runtime: ContainerRuntime;
  fetchImpl?: (url: string, init: RequestInit) => Promise<Response>;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  intervalMs?: number;
  /** Stops the wait early (Stop requested, lease lost, runner stopping). */
  signal?: AbortSignal;
}

export interface HealthResult {
  healthy: boolean;
  services: Record<string, ServiceHealth>;
}

const realSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** One reading of every service. */
export async function checkHealth(plan: InstallationPlan, deps: HealthDeps, previous?: HealthResult): Promise<HealthResult> {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const at = new Date((deps.now ?? Date.now)()).toISOString();
  let states: ContainerState[] = [];
  let psError: string | null = null;
  try {
    states = await deps.runtime.ps(plan.project);
  } catch (err) {
    psError = (err as Error).message;
  }
  const services: Record<string, ServiceHealth> = {};
  for (const s of plan.services) {
    if (psError) {
      services[s.id] = { healthy: false, detail: `could not read the containers: ${psError}`.slice(0, 500), checkedAt: at };
      continue;
    }
    const st = states.find((c) => c.service === s.id);
    if (!st) {
      services[s.id] = { healthy: false, detail: "no container", checkedAt: at };
      continue;
    }
    if (st.state !== "running") {
      services[s.id] = {
        healthy: false,
        detail: `container ${st.state}${st.exitCode !== null ? ` (exit ${st.exitCode})` : ""}`,
        checkedAt: at,
      };
      continue;
    }
    if (!s.health) {
      // Running twice in a row: a container that restarts in a loop is caught between the two readings.
      const before = previous?.services[s.id];
      const steady = before?.detail === "running" || before?.detail === "running, steady";
      services[s.id] = { healthy: steady, detail: steady ? "running, steady" : "running", checkedAt: at };
      continue;
    }
    const url = `http://127.0.0.1:${s.health.hostPort}${s.health.http}`;
    try {
      const res = await fetchImpl(url, { method: "GET", redirect: "manual", signal: AbortSignal.timeout(5_000) });
      await res.body?.cancel().catch(() => {});
      services[s.id] =
        res.status < 400
          ? { healthy: true, detail: `GET ${s.health.http} ${res.status}`, checkedAt: at }
          : { healthy: false, detail: `GET ${s.health.http} answered ${res.status}`, checkedAt: at };
    } catch (err) {
      services[s.id] = { healthy: false, detail: `GET ${s.health.http}: ${(err as Error).message}`.slice(0, 500), checkedAt: at };
    }
  }
  return { healthy: plan.services.length > 0 && Object.values(services).every((h) => h.healthy), services };
}

/** Check until every service is healthy or the clock runs out. Returns the last reading either way. */
export async function waitHealthy(plan: InstallationPlan, deps: HealthDeps, timeoutMs = HEALTH_SECONDS * 1000): Promise<HealthResult> {
  const now = deps.now ?? Date.now;
  const sleep = deps.sleep ?? realSleep;
  const deadline = now() + timeoutMs;
  let last = await checkHealth(plan, deps);
  while (!last.healthy && now() < deadline && !deps.signal?.aborted) {
    await sleep(deps.intervalMs ?? 2_000);
    last = await checkHealth(plan, deps, last);
  }
  return last;
}

/** A short sentence for a reading that is not healthy. */
export function unhealthySummary(r: HealthResult): string {
  return Object.entries(r.services)
    .filter(([, h]) => !h.healthy)
    .map(([id, h]) => `${id}: ${h.detail ?? "not healthy"}`)
    .join("; ");
}
