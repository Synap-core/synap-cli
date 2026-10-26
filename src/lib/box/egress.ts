/**
 * The run box's ONE way out: an HTTP(S) proxy on the provisioner, bound to the
 * box bridge. A box has no gateway and no resolver; everything it fetches goes
 * through here, and here decides (runbox design C4 "Egress"):
 *
 *   setup phase → the package registries only (PyPI, npm)
 *   run phase   → the hosts the script declared, nothing else
 *
 * A name that passes is resolved HERE, every address it resolves to is checked
 * against internal ranges (RFC1918, loopback, link-local and cloud metadata,
 * CGNAT = the tailnet), and the connection goes to the address that was
 * checked, never to a second lookup — so a declared host that resolves to the
 * pod (DNS rebinding) is refused. Every refusal is recorded for the evidence
 * bundle. The bridge firewall is the wall; this is the policy.
 */

import dns from "node:dns/promises";
import http from "node:http";
import net from "node:net";

export type BoxPhase = "setup" | "run";

/** Hosts a box may reach while it installs declared packages. */
export const REGISTRY_HOSTS: readonly string[] = [
  "pypi.org",
  "files.pythonhosted.org",
  "registry.npmjs.org",
];

/** Ports a bare allow entry opens: the web only. */
export const ALLOWED_PORTS: readonly number[] = [80, 443];

export interface BlockedEgress {
  host: string;
  port: number;
  phase: BoxPhase;
  reason: string;
  at: string;
}

// ─── addresses ───────────────────────────────────────────────────────────────

function v4ToInt(ip: string): number {
  return ip.split(".").reduce((acc, o) => (acc << 8) + Number(o), 0) >>> 0;
}

function inV4(ip: number, cidr: string): boolean {
  const [base, bits] = cidr.split("/");
  const mask = Number(bits) === 0 ? 0 : (~0 << (32 - Number(bits))) >>> 0;
  return (ip & mask) === (v4ToInt(base) & mask);
}

/** IPv4 ranges a box must never reach, whatever name led there. */
const FORBIDDEN_V4 = [
  "0.0.0.0/8", // "this network"
  "10.0.0.0/8", // RFC1918: vmbr1 (the pod at 10.10.0.10) and the box bridge
  "100.64.0.0/10", // CGNAT: the tailnet
  "127.0.0.0/8", // loopback
  "169.254.0.0/16", // link-local, incl. cloud metadata 169.254.169.254
  "172.16.0.0/12", // RFC1918
  "192.0.0.0/24", // IETF protocol assignments
  "192.168.0.0/16", // RFC1918: the LAN, the Proxmox host
  "198.18.0.0/15", // benchmarking
  "224.0.0.0/4", // multicast
  "240.0.0.0/4", // reserved, incl. broadcast
];

/** Expands a valid IPv6 literal to 8 hextets (zone id dropped, embedded v4 folded). */
function v6Hextets(ip: string): number[] | null {
  let addr = ip.split("%")[0].toLowerCase();
  const embedded = /^(.*:)(\d+\.\d+\.\d+\.\d+)$/.exec(addr);
  if (embedded) {
    if (!net.isIPv4(embedded[2])) return null;
    const n = v4ToInt(embedded[2]);
    addr = `${embedded[1]}${(n >>> 16).toString(16)}:${(n & 0xffff).toString(16)}`;
  }
  const parts = addr.split("::");
  if (parts.length > 2) return null;
  const left = parts[0] ? parts[0].split(":") : [];
  const right = parts.length === 2 && parts[1] ? parts[1].split(":") : [];
  const missing = 8 - left.length - right.length;
  if (parts.length === 1 ? missing !== 0 : missing < 0) return null;
  const out = [...left, ...Array<string>(missing).fill("0"), ...right].map((h) => parseInt(h, 16));
  return out.every((h) => Number.isInteger(h) && h >= 0 && h <= 0xffff) ? out : null;
}

/**
 * True when a box must not connect to this address. An unparsable address is
 * forbidden: the check fails closed.
 */
export function isForbiddenAddress(ip: string): boolean {
  if (net.isIPv4(ip)) {
    const n = v4ToInt(ip);
    return FORBIDDEN_V4.some((c) => inV4(n, c));
  }
  if (!net.isIPv6(ip)) return true;
  const h = v6Hextets(ip);
  if (!h) return true;
  // IPv4-mapped (::ffff:a.b.c.d) and NAT64 (64:ff9b::a.b.c.d) carry a v4 address.
  const isMapped = h.slice(0, 5).every((x) => x === 0) && h[5] === 0xffff;
  const isNat64 = h[0] === 0x64 && h[1] === 0xff9b && h.slice(2, 6).every((x) => x === 0);
  if (isMapped || isNat64) {
    const v4 = `${h[6] >>> 8}.${h[6] & 0xff}.${h[7] >>> 8}.${h[7] & 0xff}`;
    return isForbiddenAddress(v4);
  }
  // ::/96 holds ::, ::1 and the deprecated IPv4-compatible ::a.b.c.d: none is a public peer.
  if (h.slice(0, 6).every((x) => x === 0)) return true;
  // 6to4 (2002::/16) carries a v4 address in hextets 1-2.
  if (h[0] === 0x2002) return isForbiddenAddress(`${h[1] >>> 8}.${h[1] & 0xff}.${h[2] >>> 8}.${h[2] & 0xff}`);
  if (h[0] === 0x2001 && h[1] === 0) return true; // Teredo 2001::/32 (an obfuscated v4 inside)
  if (h[0] === 0x2001 && h[1] === 0x0db8) return true; // documentation 2001:db8::/32
  if ((h[0] & 0xfe00) === 0xfc00) return true; // fc00::/7 unique local
  if ((h[0] & 0xffc0) === 0xfe80) return true; // fe80::/10 link-local
  if ((h[0] & 0xff00) === 0xff00) return true; // multicast
  return false;
}

// ─── names ───────────────────────────────────────────────────────────────────

/** Lower-cased, trailing dot dropped, brackets of an IPv6 literal removed. */
export function normalizeHost(host: string): string {
  return host.trim().toLowerCase().replace(/^\[(.*)\]$/, "$1").replace(/\.$/, "");
}

/**
 * `host` matches an allow entry exactly, or a `*.example.com` entry as a
 * strict subdomain (never the apex, never a suffix like `evilexample.com`).
 */
export function hostMatches(host: string, allow: readonly string[]): boolean {
  const h = normalizeHost(host);
  return allow.some((raw) => {
    const a = normalizeHost(raw);
    if (a.startsWith("*.")) return h.endsWith(a.slice(1)) && h.length > a.length - 1;
    return h === a;
  });
}

export interface EgressPolicy {
  phase: BoxPhase;
  /** The script's declared hosts (the run-phase allowlist). */
  runHosts: readonly string[];
}

export type EgressDecision = { allow: true } | { allow: false; reason: string };

/** An allow entry split into its host and, when it names one, its port. */
function splitEntry(entry: string): { host: string; port: number | null } {
  const m = /^(.*):(\d{1,5})$/.exec(entry.trim());
  return m && !m[1].includes(":") ? { host: m[1], port: Number(m[2]) } : { host: entry, port: null };
}

/**
 * The name-level decision, before any lookup. A bare entry opens the web
 * ports (80, 443); a `host:port` entry opens that port on that host only.
 */
export function decideByName(host: string, port: number, policy: EgressPolicy): EgressDecision {
  const h = normalizeHost(host);
  if (net.isIP(h)) return { allow: false, reason: "an address literal is never allowed; declare a host name" };
  const entries = (policy.phase === "setup" ? REGISTRY_HOSTS : policy.runHosts).map(splitEntry);
  const named = entries.filter((e) => hostMatches(h, [e.host]));
  if (named.length === 0) {
    return {
      allow: false,
      reason:
        policy.phase === "setup"
          ? "only the package registries are reachable while packages install"
          : "not a host this script declared",
    };
  }
  const portOk = named.some((e) => (e.port === null ? ALLOWED_PORTS.includes(port) : e.port === port));
  if (!portOk) return { allow: false, reason: `port ${port} is not declared for this host` };
  return { allow: true };
}

export type Resolver = (host: string) => Promise<string[]>;

const systemResolver: Resolver = async (host) =>
  (await dns.lookup(host, { all: true, verbatim: true })).map((a) => a.address);

/**
 * The full decision: by name, then by every resolved address. Returns the ONE
 * address to connect to, so the connection never re-resolves.
 */
export async function decideEgress(
  host: string,
  port: number,
  policy: EgressPolicy,
  resolve: Resolver = systemResolver
): Promise<{ allow: true; address: string } | { allow: false; reason: string }> {
  const byName = decideByName(host, port, policy);
  if (!byName.allow) return byName;
  let addresses: string[];
  try {
    addresses = await resolve(normalizeHost(host));
  } catch (err) {
    return { allow: false, reason: `could not resolve: ${(err as Error).message}` };
  }
  if (addresses.length === 0) return { allow: false, reason: "resolved to no address" };
  const bad = addresses.find(isForbiddenAddress);
  if (bad) return { allow: false, reason: `resolves to an internal address (${bad})` };
  return { allow: true, address: addresses[0] };
}

// ─── the proxy ───────────────────────────────────────────────────────────────

export interface EgressProxyOptions {
  /** The policy for a box, by its address on the bridge; null = not a live box. */
  policyFor: (sourceIp: string) => EgressPolicy | null;
  onBlock: (sourceIp: string, block: BlockedEgress) => void;
  resolve?: Resolver;
  /** Connect to the checked address (tests replace it). */
  connect?: (address: string, port: number) => net.Socket;
}

function sourceIpOf(sock: net.Socket): string {
  return (sock.remoteAddress ?? "").replace(/^::ffff:/, "");
}

function splitHostPort(authority: string, defaultPort: number): { host: string; port: number } | null {
  const m = /^(\[[^\]]+\]|[^:]+)(?::(\d+))?$/.exec(authority);
  if (!m) return null;
  return { host: m[1], port: m[2] ? Number(m[2]) : defaultPort };
}

/**
 * An HTTP proxy: CONNECT for HTTPS (a tunnel to the checked address), and
 * absolute-form requests for plain HTTP. Anything else is refused.
 */
export function createEgressProxy(opts: EgressProxyOptions): http.Server {
  const resolve = opts.resolve ?? systemResolver;
  const connect = opts.connect ?? ((address, port) => net.connect({ host: address, port }));

  async function gate(
    sock: net.Socket,
    host: string,
    port: number
  ): Promise<{ address: string } | { status: number; reason: string }> {
    const src = sourceIpOf(sock);
    const policy = opts.policyFor(src);
    if (!policy) return { status: 403, reason: "not a running box" };
    const d = await decideEgress(host, port, policy, resolve);
    if (!d.allow) {
      opts.onBlock(src, { host: normalizeHost(host), port, phase: policy.phase, reason: d.reason, at: new Date().toISOString() });
      return { status: 403, reason: d.reason };
    }
    return { address: d.address };
  }

  const server = http.createServer(async (req, res) => {
    let target: URL;
    try {
      target = new URL(req.url ?? "");
    } catch {
      res.writeHead(400).end("absolute-form request required\n");
      return;
    }
    if (target.protocol !== "http:") {
      res.writeHead(400).end("only http:// is proxied in absolute form; use CONNECT for https\n");
      return;
    }
    const port = target.port ? Number(target.port) : 80;
    const g = await gate(req.socket, target.hostname, port);
    if (!("address" in g)) {
      res.writeHead(g.status, { "content-type": "text/plain" }).end(`synap box egress refused: ${g.reason}\n`);
      return;
    }
    const upstream = http.request(
      {
        host: g.address,
        port,
        method: req.method,
        path: target.pathname + target.search,
        headers: { ...req.headers, host: target.host },
        createConnection: () => connect(g.address, port),
      },
      (up) => {
        res.writeHead(up.statusCode ?? 502, up.headers);
        up.pipe(res);
      }
    );
    upstream.on("error", () => res.headersSent ? res.destroy() : res.writeHead(502).end());
    req.pipe(upstream);
  });

  server.on("connect", async (req: http.IncomingMessage, client: net.Socket, head: Buffer) => {
    const hp = splitHostPort(req.url ?? "", 443);
    if (!hp) {
      client.end("HTTP/1.1 400 Bad Request\r\n\r\n");
      return;
    }
    const g = await gate(client, hp.host, hp.port);
    if (!("address" in g)) {
      client.end(`HTTP/1.1 ${g.status} Forbidden\r\ncontent-type: text/plain\r\n\r\nsynap box egress refused: ${g.reason}\n`);
      return;
    }
    const upstream = connect(g.address, hp.port);
    upstream.once("connect", () => {
      client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      if (head.length) upstream.write(head);
      upstream.pipe(client);
      client.pipe(upstream);
    });
    upstream.on("error", () => client.destroy());
    client.on("error", () => upstream.destroy());
  });

  return server;
}
