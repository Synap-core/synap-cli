/**
 * Does this pod know agents inside a computer (plan "Computer once, agents
 * inside" rev 3, pod document 31470fd5; backend migration 0395)? Asked BEFORE
 * anything is minted, because the answer changes what the CLI may send:
 *
 *   - the device request: a pod that knows sends back nothing different, but
 *     a pod that does not gets TODAY's request body, byte for byte (no seat,
 *     no `held`, no jobs);
 *   - a job (`--as`): a pod that does not know jobs would ignore it and make
 *     or re-key the engine's PLAIN agent, the one the person already uses.
 *     That is the 2 Nov incident by another road, so the CLI refuses instead.
 *
 * The mark is read from the pod's public `GET /health` (`features[]`), which
 * every pod answers without a key. A pod with no `features`, or one that does
 * not list the mark, is an older pod. A read that FAILED is not "older": it is
 * `unknown`, so a caller can say why it refuses (decision: an empty result and
 * a failed read are different facts), and every caller treats it like an older
 * pod, the safe side.
 */

import { podFetch } from "./pod-moved.js";

/**
 * The mark a pod lists in `/health` `features[]` once it knows seats and jobs
 * (`AGENT_SEATS_FEATURE` in `@synap-core/types/device`, synap-backend; a
 * mirror, because the published types this CLI depends on predate it).
 */
export const AGENT_SEATS_FEATURE = "agent-seats";

export type PodFeature = "yes" | "no" | "unknown";

/** Read a feature mark from `/health`. Never throws. */
export async function readPodFeature(
  podUrl: string,
  feature: string,
  deps: { fetch?: typeof fetch } = {}
): Promise<PodFeature> {
  const f = deps.fetch ?? podFetch;
  try {
    const res = await f(`${podUrl.replace(/\/+$/, "")}/health`, { signal: AbortSignal.timeout(5_000) });
    if (!res.ok) return "unknown";
    const body = (await res.json().catch(() => null)) as { features?: unknown } | null;
    if (!body || typeof body !== "object") return "unknown";
    return Array.isArray(body.features) && body.features.includes(feature) ? "yes" : "no";
  } catch {
    return "unknown";
  }
}

/** Whether `podUrl` knows seats, jobs and `held` on its agent doors. */
export function podKnowsAgentSeats(podUrl: string, deps: { fetch?: typeof fetch } = {}): Promise<PodFeature> {
  return readPodFeature(podUrl, AGENT_SEATS_FEATURE, deps);
}

/** Why a job (`--as`) cannot be asked of this pod; null when it can. Pure. */
export function jobRefusal(feature: PodFeature, host: string): string | null {
  if (feature === "yes") return null;
  if (feature === "no") {
    return (
      `${host} cannot give an agent a job yet: it predates agents inside a computer. ` +
      `Asking anyway would make or reconnect the engine's plain agent, the one you already use. ` +
      `Update the pod, then run this again.`
    );
  }
  return `Could not tell whether ${host} can give an agent a job (its /health did not answer). Nothing was asked; run this again.`;
}
