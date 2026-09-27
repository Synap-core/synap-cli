/**
 * `synap init` with no pod: create one in the browser and continue here.
 *
 * Before this, init exited with code 2 and a help box when it found no pod,
 * so its own "create one" branch (`waitForPodCallback`) was unreachable. This
 * is that branch, reachable: open the provision page, wait for the callback,
 * then wait until the new pod answers `/health` — a pod that is still booting
 * is "starting", not "failed".
 *
 * Deps are injected so the flow is testable without a browser or a network.
 */

export interface CreatePodDeps {
  /** Opens synap.live's provision page and resolves with the new pod's URL. */
  waitForPodCallback: () => Promise<{ podUrl: string } | null>;
  checkPodHealth: (podUrl: string) => Promise<{ healthy: boolean }>;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

export type CreatePodResult =
  | { ok: true; podUrl: string }
  /** The browser flow timed out or was closed — nothing was created that we know of. */
  | { ok: false; reason: "cancelled" }
  /** The pod exists but did not answer in time. Resume with `synap init --pod-url`. */
  | { ok: false; reason: "not-reachable"; podUrl: string };

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export async function waitUntilReachable(
  podUrl: string,
  deps: Pick<CreatePodDeps, "checkPodHealth" | "sleep" | "now">,
  opts: { timeoutMs?: number; intervalMs?: number } = {}
): Promise<boolean> {
  const sleep = deps.sleep ?? defaultSleep;
  const now = deps.now ?? Date.now;
  const timeoutMs = opts.timeoutMs ?? 300_000;
  const intervalMs = opts.intervalMs ?? 5_000;
  const deadline = now() + timeoutMs;
  for (;;) {
    if ((await deps.checkPodHealth(podUrl)).healthy) return true;
    if (now() >= deadline) return false;
    await sleep(intervalMs);
  }
}

export async function createPodInBrowser(
  deps: CreatePodDeps,
  opts: { timeoutMs?: number; intervalMs?: number } = {}
): Promise<CreatePodResult> {
  const created = await deps.waitForPodCallback();
  if (!created?.podUrl) return { ok: false, reason: "cancelled" };
  const reachable = await waitUntilReachable(created.podUrl, deps, opts);
  return reachable
    ? { ok: true, podUrl: created.podUrl }
    : { ok: false, reason: "not-reachable", podUrl: created.podUrl };
}
