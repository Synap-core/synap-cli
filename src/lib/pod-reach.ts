/**
 * Why a pod probe failed, told apart: the network between this machine and the
 * pod (egress proxy, DNS, firewall, TLS) versus the pod itself answering badly.
 *
 * `checkPodHealth` used to fold every failure into `healthy: false`, so `synap
 * init` behind an egress proxy that answers 403 to CONNECT printed a pod-side
 * checklist ("is the container running?") for a pod that was never contacted.
 * This is the one place that taxonomy lives for the probe.
 */

export type ReachKind =
  /** An egress proxy refused the CONNECT tunnel — the pod was never contacted. */
  | "proxy"
  /** DNS, refused, reset, unroutable, timeout, TLS — no HTTP answer from anything. */
  | "network"
  /** The pod host answered, but not with a healthy /health. */
  | "pod";

export interface ReachFailure {
  kind: ReachKind;
  /** The underlying error, one line: status / error code / message. */
  detail: string;
  /** Env variable whose proxy this process used, with credentials stripped. */
  proxy?: { env: string; url: string };
}

const PROXY_ENV = ["HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy", "ALL_PROXY", "all_proxy"];

/** The env proxy that applies to `podUrl`, credentials removed. Honors NO_PROXY. */
export function proxyInUse(
  podUrl: string,
  env: NodeJS.ProcessEnv = process.env
): { env: string; url: string } | undefined {
  let target: URL;
  try {
    target = new URL(podUrl);
  } catch {
    return undefined;
  }
  const noProxy = (env.NO_PROXY ?? env.no_proxy ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  const bypass = noProxy.some(
    (p) =>
      p === "*" ||
      target.hostname === p.replace(/^\./, "") ||
      target.hostname.endsWith(p.startsWith(".") ? p : `.${p}`)
  );
  if (bypass) return undefined;
  const order = target.protocol === "https:" ? PROXY_ENV : [...PROXY_ENV.slice(2, 4), ...PROXY_ENV.slice(0, 2), ...PROXY_ENV.slice(4)];
  for (const name of order) {
    const raw = env[name];
    if (!raw) continue;
    try {
      const u = new URL(raw);
      u.username = "";
      u.password = "";
      return { env: name, url: u.origin };
    } catch {
      return { env: name, url: "(unparseable)" };
    }
  }
  return undefined;
}

function codeOf(err: unknown): string {
  const cause = (err as { cause?: unknown } | null)?.cause;
  for (const e of [cause, err]) {
    const c = (e as { code?: unknown } | null | undefined)?.code;
    if (typeof c === "string") return c;
  }
  return "";
}

/** Classify a fetch that threw (no HTTP answer from the pod). */
export function classifyFetchError(err: unknown, podUrl: string, env: NodeJS.ProcessEnv = process.env): ReachFailure {
  const proxy = proxyInUse(podUrl, env);
  const cause = (err as { cause?: { message?: string } } | null)?.cause;
  const message = [cause?.message, err instanceof Error ? err.message : String(err)].filter(Boolean)[0] ?? "unknown error";
  const code = codeOf(err);
  // undici's ProxyAgent: "Proxy response (403) !== 200 when HTTP Tunneling";
  // Node's env-proxy support surfaces "Tunnel ... 403" / ERR_PROXY_TUNNEL.
  const tunnel = /proxy response \((\d{3})\)|tunnel.*?(\d{3})|ERR_PROXY_TUNNEL/i.exec(`${code} ${message}`);
  if (tunnel || code === "UND_ERR_PRX_TLS" || code === "ERR_PROXY_TUNNEL") {
    const status = tunnel?.[1] ?? tunnel?.[2];
    return {
      kind: "proxy",
      detail: status ? `the egress proxy refused the tunnel (HTTP ${status} to CONNECT)` : `the egress proxy refused the tunnel (${message})`,
      proxy,
    };
  }
  const name = err instanceof Error ? err.name : "";
  const label = code || (name === "TimeoutError" || name === "AbortError" ? "TIMEOUT" : message);
  return {
    kind: "network",
    detail: `${label}${label === message ? "" : `: ${message}`}`,
    proxy,
  };
}

/** Classify a /health that answered with a non-2xx status. */
export function classifyHttpStatus(status: number, podUrl: string, env: NodeJS.ProcessEnv = process.env): ReachFailure {
  return { kind: "pod", detail: `/health answered HTTP ${status}`, proxy: proxyInUse(podUrl, env) };
}

/** The lines `synap init` / `synap doctor` print under "not reachable", by cause. */
export function reachChecklist(f: ReachFailure | undefined): string[] {
  const proxyLine = f?.proxy ? [`Proxy in use: ${f.proxy.url} (from ${f.proxy.env})`] : [];
  if (f?.kind === "proxy") {
    return [
      ...proxyLine,
      "Your network's egress proxy blocked the connection. The pod was not contacted.",
      "- Ask the proxy's owner to allow CONNECT to the pod host (port 443).",
      "- Or bypass the proxy for it: export NO_PROXY=<pod-host>",
    ];
  }
  if (f?.kind === "network") {
    return [
      ...proxyLine,
      "This machine could not reach the pod host. The pod itself may be fine.",
      "- Is the pod URL correct? (scheme + host + port)",
      "- Are you online, on the right network/VPN, behind a firewall or proxy?",
      "- Can you open the URL in a browser from this machine?",
    ];
  }
  return [
    ...proxyLine,
    "- Is the pod URL correct? (scheme + host + port)",
    "- Is the pod container running? On the server: ./synap health",
    "- Is there a firewall or reverse proxy in the way?",
    "- For localhost setups, did you start the stack? ./synap start",
  ];
}

/** The one-line headline: names the underlying error, not just "not reachable". */
export function unreachableMessage(podUrl: string, failure?: ReachFailure): string {
  if (!failure) return `Pod at ${podUrl} is not reachable.`;
  return failure.kind === "pod"
    ? `Pod at ${podUrl} is not healthy: ${failure.detail}.`
    : `Could not reach ${podUrl}: ${failure.detail}.`;
}
