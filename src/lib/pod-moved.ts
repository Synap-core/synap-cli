/**
 * A pod that moved to a new address.
 *
 * Hosted pods move from `{name}.synap.live` to `{name}.pod.synap.live`
 * (Control Plane "tenant domains v2"). For 90 days the old name answers every
 * request with a redirect to the new one. The CLI NEVER follows a redirect to
 * another host for an API call: the request carries the pod key, and a
 * redirect is something any server on the old name can send. Instead:
 *
 *   1. every pod call goes through `podFetch`, which refuses a cross-host
 *      redirect with `PodMovedError` (one line: what happened, what to run);
 *   2. `synap doctor` asks the Control Plane where the pod lives now —
 *      `POST {cp}/pods/handshake {targetUrl: <old url>}` answers
 *      `410 {code: "POD_MOVED", podId, podUrl, consoleUrl}` for a moved pod
 *      (CP `src/routes/pods.ts`, `src/lib/pod-handshake-problem.ts`) —
 *      and `synap doctor --fix` rewrites the saved profile through the one
 *      door for a URL change (`synap pods update`).
 *
 * The new address comes ONLY from the Control Plane, never from the redirect.
 */

/** What to run when a pod has moved. */
export const POD_MOVED_HINT = "Run: synap doctor --fix   (it finds the new address and updates your settings)";

/** The one line a command prints when its pod has moved. */
export function podMovedMessage(podUrl: string): string {
  return `The pod at ${podUrl} has a new address. Run: synap doctor --fix`;
}

export class PodMovedError extends Error {
  /** The address the CLI holds (origin). */
  readonly podUrl: string;
  /** Where the old address redirected — informational only, never used. */
  readonly redirectedTo: string;

  constructor(podUrl: string, redirectedTo: string) {
    super(podMovedMessage(podUrl));
    this.name = "PodMovedError";
    this.podUrl = podUrl;
    this.redirectedTo = redirectedTo;
  }
}

const MAX_SAME_HOST_HOPS = 5;

function isRedirect(status: number): boolean {
  return status === 301 || status === 302 || status === 303 || status === 307 || status === 308;
}

/**
 * A redirect the CLI may follow: the same origin, or the same host upgraded
 * from http to https (default ports). Anything else is another host.
 */
function isSameHost(from: URL, to: URL): boolean {
  if (from.origin === to.origin) return true;
  return (
    from.protocol === "http:" &&
    to.protocol === "https:" &&
    from.hostname === to.hostname &&
    from.port === "" &&
    to.port === ""
  );
}

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

/**
 * `fetch` for calls to a pod: redirects within the same host are followed (at
 * most 5), a redirect to another host throws `PodMovedError`. Network errors
 * propagate unchanged, so callers keep their own transport classification.
 */
export async function podFetch(
  url: string,
  init: RequestInit = {},
  fetchImpl: FetchLike = fetch
): Promise<Response> {
  const start = new URL(url);
  let current = start;
  let currentInit: RequestInit = init;
  for (let hop = 0; ; hop++) {
    const res = await fetchImpl(current.toString(), { ...currentInit, redirect: "manual" });
    if (!isRedirect(res.status)) return res;
    const location = res.headers.get("location");
    if (!location) return res;
    let next: URL;
    try {
      next = new URL(location, current);
    } catch {
      return res;
    }
    if (!isSameHost(start, next)) {
      throw new PodMovedError(start.origin, next.origin);
    }
    if (hop >= MAX_SAME_HOST_HOPS) return res;
    if (res.status === 303 && (currentInit.method ?? "GET").toUpperCase() !== "GET") {
      const { body: _body, ...rest } = currentInit;
      currentInit = { ...rest, method: "GET" };
    }
    current = next;
  }
}

/** What the Control Plane says about a pod address. */
export type PodMoveAnswer =
  | { kind: "moved"; podUrl: string; consoleUrl?: string; podId?: string }
  /** The CP knows this address as the pod's own (or knows nothing to move). */
  | { kind: "not-moved"; code?: string }
  /** No Control Plane sign-in on this computer, or it expired. */
  | { kind: "signed-out" }
  /** The CP could not be asked, or answered something unreadable. */
  | { kind: "unknown"; reason: string };

/**
 * Ask the Control Plane where a pod lives now. Needs the CP sign-in from
 * `synap login` (a bearer token); without one the answer is `signed-out`.
 */
export async function askControlPlaneWherePodIs(params: {
  podUrl: string;
  cpUrl: string;
  cpToken: string | undefined;
  fetchImpl?: FetchLike;
}): Promise<PodMoveAnswer> {
  if (!params.cpToken) return { kind: "signed-out" };
  const fetchImpl = params.fetchImpl ?? fetch;
  let res: Response;
  try {
    res = await fetchImpl(`${params.cpUrl.replace(/\/+$/, "")}/pods/handshake`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${params.cpToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ targetUrl: params.podUrl }),
      redirect: "manual",
      signal: AbortSignal.timeout(10_000),
    });
  } catch (err) {
    return { kind: "unknown", reason: err instanceof Error ? err.message : String(err) };
  }
  if (res.status === 401) return { kind: "signed-out" };
  const body = (await res.json().catch(() => null)) as {
    code?: unknown;
    podUrl?: unknown;
    consoleUrl?: unknown;
    podId?: unknown;
  } | null;
  if (res.status === 410 && body?.code === "POD_MOVED") {
    const podUrl = typeof body.podUrl === "string" ? safeHttpsOrigin(body.podUrl) : null;
    if (!podUrl) return { kind: "unknown", reason: "the Control Plane named no usable new address" };
    return {
      kind: "moved",
      podUrl,
      ...(typeof body.consoleUrl === "string" ? { consoleUrl: body.consoleUrl } : {}),
      ...(typeof body.podId === "string" ? { podId: body.podId } : {}),
    };
  }
  if (res.ok || res.status === 403 || res.status === 409) {
    return { kind: "not-moved", ...(typeof body?.code === "string" ? { code: body.code } : {}) };
  }
  return { kind: "unknown", reason: `the Control Plane answered ${res.status}` };
}

/** An https origin, or null. A new pod address is never plain http. */
function safeHttpsOrigin(value: string): string | null {
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.username || url.password) return null;
    return url.origin;
  } catch {
    return null;
  }
}
