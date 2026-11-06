/**
 * Provider ops: the computer-side operations of a reachability provider
 * (addendum 000e75ff §4: `expose_http`, `open_tunnel`), run as containers of
 * the PROVIDER's own installation. Deterministic: each op is code here, its
 * inputs come from the job as queued, its image from the provider's approved
 * manifest by the consented digest, and nothing else.
 *
 * The job's `spec` (what the pod queues for `kind: provider_op`):
 *   { provider: "tailnet-expose" | "cloudflare-tunnel",
 *     op: "create" | "status" | "revoke",
 *     input: { installationId, needKey, service, source: { kind: "local_port", port } } }
 * `input.installationId` is the CONSUMER (e.g. HyperFrames), whose service the
 * binding makes reachable. One binding = one Compose project,
 * `synap-b<first 11 hex of the binding id>`, so `create` is idempotent (same
 * binding, same project) and `revoke` removes exactly what `create` started.
 *
 * Networking, without host networking:
 *   - the provider container joins the consumer installation's bridge and
 *     reaches the consumer service by its container name (the consumer's
 *     compose file on this computer says which service publishes
 *     `source.port`);
 *   - tailnet-expose publishes its listener on the computer's TAILNET IPv4 only
 *     (100.64.0.0/10, read from the runner config), never 0.0.0.0. The devbox
 *     must forward tailscale0 to Docker bridges for that port (U14, infra);
 *   - cloudflare-tunnel publishes nothing (cloudflared dials out) and needs
 *     egress, so it runs only where the operator allowed declared egress; its
 *     token is read from a mode-600 file the runner was handed for the binding,
 *     never from the job.
 *
 * Every op returns the contract's output shape: { url, state, handle,
 * authApplied, public, expiresAt, checkedAt, detail }.
 */

import fs from "node:fs";
import path from "node:path";
import YAML from "yaml";
import {
  IMAGE_BY_DIGEST_RE,
  isInside,
  sha256Of,
  type ContainerRuntime,
  type InstallationPlan,
  type PlannedService,
} from "./compose.js";
import type { LeasedHostJob } from "./wire.js";

export const PROVIDERS = ["tailnet-expose", "cloudflare-tunnel"] as const;
export type ProviderKey = (typeof PROVIDERS)[number];
export const PROVIDER_OPS = ["create", "status", "revoke"] as const;
export type ProviderOpName = (typeof PROVIDER_OPS)[number];

/** The container port the tailnet proxy listens on (images/proxy in synap-videos). */
export const PROXY_CONTAINER_PORT = 8080;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const SLUG_RE = /^[a-z][a-z0-9_-]{0,63}$/;

export interface ProviderOpInput {
  installationId: string;
  needKey: string;
  service: string;
  source: { kind: "local_port"; port: number };
}

export interface ProviderOpSpec {
  provider: ProviderKey;
  op: ProviderOpName;
  input: ProviderOpInput;
}

export type ContractOutput = {
  url: string | null;
  state: "pending" | "live" | "degraded" | "revoked" | "failed";
  handle: string | null;
  authApplied: string | null;
  public: boolean;
  expiresAt: string | null;
  checkedAt: string;
  detail: string;
};

export interface ProviderEnv {
  installRoot: string;
  user: string;
  /** This computer's tailnet IPv4 (tailnet-expose listens there only). */
  tailnetIp?: string;
  /** Its tailnet name, for the URL (`devbox.internal.synap.live`); the address when absent. */
  tailnetHostname?: string;
  /** The port range the tailnet proxy may listen on (the devbox firewall lets 30xx in on tailscale0). */
  tailnetPorts?: { from: number; to: number };
  /** Folder of per-binding secret files (`<bindingId>.env`, mode 600). */
  secretsDir?: string;
  allowDeclaredEgress?: boolean;
}

export class ProviderOpRefusal extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProviderOpRefusal";
  }
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** Read and check a provider_op job's spec. Throws ProviderOpRefusal with the first problem. */
export function parseProviderOp(job: LeasedHostJob): ProviderOpSpec {
  const s = job.spec;
  if (!isObject(s)) throw new ProviderOpRefusal("the job carries no op");
  if (!PROVIDERS.includes(s.provider as ProviderKey)) {
    throw new ProviderOpRefusal(`this runner has no computer-side op for provider "${String(s.provider)}"`);
  }
  if (!PROVIDER_OPS.includes(s.op as ProviderOpName)) throw new ProviderOpRefusal(`unknown op "${String(s.op)}"`);
  const i = s.input;
  if (!isObject(i)) throw new ProviderOpRefusal("the op has no input");
  if (typeof i.installationId !== "string" || !UUID_RE.test(i.installationId)) {
    throw new ProviderOpRefusal("input.installationId is not an installation id");
  }
  if (typeof i.needKey !== "string" || !SLUG_RE.test(i.needKey.replace(/_/g, "-"))) throw new ProviderOpRefusal("input.needKey is not a slug");
  if (typeof i.service !== "string" || !SLUG_RE.test(i.service)) throw new ProviderOpRefusal("input.service is not a service id");
  const src = i.source;
  if (!isObject(src) || src.kind !== "local_port" || typeof src.port !== "number" || !Number.isInteger(src.port) || src.port < 1024 || src.port > 65535) {
    throw new ProviderOpRefusal("input.source must be { kind: local_port, port 1024-65535 }");
  }
  if (!job.bindingId || !UUID_RE.test(job.bindingId)) throw new ProviderOpRefusal("a provider op needs the binding it serves");
  return {
    provider: s.provider as ProviderKey,
    op: s.op as ProviderOpName,
    input: { installationId: i.installationId, needKey: i.needKey, service: i.service, source: { kind: "local_port", port: src.port } },
  };
}

export function bindingProject(bindingId: string): string {
  return `synap-b${bindingId.replace(/-/g, "").slice(0, 11)}`;
}

/** 100.64.0.0/10, the tailnet's address range. */
export function isTailnetIPv4(ip: string): boolean {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(ip);
  if (!m) return false;
  const [a, b, c, d] = m.slice(1).map(Number);
  if ([a, b, c, d].some((n) => n > 255)) return false;
  return a === 100 && b >= 64 && b <= 127;
}

/** The consumer service that publishes `port` on 127.0.0.1, read from ITS compose file on this computer. */
export function upstreamOf(env: ProviderEnv, input: ProviderOpInput): { network: string; host: string; port: number } {
  const dir = path.join(env.installRoot, input.installationId);
  const file = path.join(dir, "compose.yaml");
  if (!isInside(env.installRoot, dir) || !fs.existsSync(file)) {
    throw new ProviderOpRefusal(`installation ${input.installationId} is not installed on this computer`);
  }
  const doc = YAML.parse(fs.readFileSync(file, "utf8")) as {
    name?: string;
    services?: Record<string, { container_name?: string; ports?: string[] }>;
    networks?: { installation?: { name?: string } };
  };
  const svc = doc.services?.[input.service];
  if (!svc) throw new ProviderOpRefusal(`installation ${input.installationId} has no service "${input.service}"`);
  const mapping = (svc.ports ?? []).map((p) => /^127\.0\.0\.1:(\d+):(\d+)\/tcp$/.exec(p)).find((m) => m && Number(m[1]) === input.source.port);
  if (!mapping || !svc.container_name || !doc.networks?.installation?.name) {
    throw new ProviderOpRefusal(`service "${input.service}" does not publish 127.0.0.1:${input.source.port}`);
  }
  return { network: doc.networks.installation.name, host: svc.container_name, port: Number(mapping[2]) };
}

/** The provider's own image, by the consented digest. */
function providerImage(job: LeasedHostJob, serviceId: string): { image: string; limits: PlannedService["limits"] } {
  const services = (isObject(job.installation.manifest) ? job.installation.manifest.services : undefined) as unknown;
  const svc = Array.isArray(services) ? services.find((s) => isObject(s) && s.id === serviceId) : undefined;
  if (!isObject(svc)) throw new ProviderOpRefusal(`the provider's manifest has no "${serviceId}" service`);
  const image = typeof svc.image === "string" ? svc.image : "";
  const consented = job.installation.digests[serviceId] ? sha256Of(job.installation.digests[serviceId]) : null;
  if (!IMAGE_BY_DIGEST_RE.test(image) || !consented || sha256Of(image) !== consented) {
    throw new ProviderOpRefusal(`the provider image "${image}" is not pinned to its consented digest`);
  }
  const l = isObject(svc.limits) ? svc.limits : {};
  return {
    image,
    limits: {
      cpus: typeof l.cpus === "number" && l.cpus > 0 ? Math.min(l.cpus, 2) : 0.5,
      memoryMb: typeof l.memoryMb === "number" && l.memoryMb >= 64 ? Math.min(l.memoryMb, 1024) : 128,
      diskMb: typeof l.diskMb === "number" ? l.diskMb : 256,
    },
  };
}

/** The listener port for a binding: stable per binding, inside the allowed range. */
export function listenPortFor(bindingId: string, range: { from: number; to: number }): number {
  const span = range.to - range.from + 1;
  const n = parseInt(bindingId.replace(/-/g, "").slice(0, 8), 16);
  return range.from + (n % span);
}

export interface ProviderPlan {
  project: string;
  dir: string;
  composeFile: string;
  document: Record<string, unknown>;
  /** What the contract output says once live. */
  url: string | null;
  authApplied: string;
  /** The runner's own probe for `status`, from this computer. */
  probe: { url: string } | null;
  /** Where the provider reaches the consumer service, from inside the computer. */
  origin: string;
  images: string[];
  /** A plan shaped like an installation's, so health and cleanup are shared. */
  asInstallation: InstallationPlan;
}

/** Plan a binding's containers. Pure apart from reading the consumer's compose file (and the token file's presence). */
export function planProviderOp(job: LeasedHostJob, spec: ProviderOpSpec, env: ProviderEnv): ProviderPlan {
  const bindingId = job.bindingId!;
  const project = bindingProject(bindingId);
  const dir = path.join(env.installRoot, "bindings", bindingId);
  const composeFile = path.join(dir, "compose.yaml");
  const up = upstreamOf(env, spec.input);
  const labels = {
    "synap.managed-by": "synap-host",
    "synap.installation": job.installation.id,
    "synap.binding": bindingId,
  };
  const hardening = {
    user: env.user,
    read_only: true,
    tmpfs: ["/tmp:rw,nosuid,nodev,size=64m"],
    cap_drop: ["ALL"],
    security_opt: ["no-new-privileges:true"],
    pids_limit: 256,
    restart: "unless-stopped",
    labels,
    logging: { driver: "local", options: { "max-size": "5m", "max-file": "2" } },
  };

  if (spec.provider === "tailnet-expose") {
    if (!env.tailnetIp || !isTailnetIPv4(env.tailnetIp)) {
      throw new ProviderOpRefusal("this computer has no tailnet IPv4 in its runner config (tailnetIp, 100.64.0.0/10)");
    }
    const range = env.tailnetPorts ?? { from: 3045, to: 3045 };
    const port = listenPortFor(bindingId, range);
    const { image, limits } = providerImage(job, "proxy");
    const service = {
      image,
      container_name: `${project}-proxy`,
      ...hardening,
      cpus: limits.cpus,
      mem_limit: `${limits.memoryMb}m`,
      memswap_limit: `${limits.memoryMb}m`,
      environment: {
        PROXY_LISTEN: `0.0.0.0:${PROXY_CONTAINER_PORT}`,
        PROXY_UPSTREAM: `${up.host}:${up.port}`,
      },
      // The tailnet address only: never 0.0.0.0, never the LAN.
      ports: [`${env.tailnetIp}:${port}:${PROXY_CONTAINER_PORT}/tcp`],
      networks: ["upstream"],
    };
    const host = env.tailnetHostname ?? env.tailnetIp;
    return {
      project,
      dir,
      composeFile,
      document: {
        name: project,
        services: { proxy: service },
        networks: { upstream: { name: up.network, external: true } },
      },
      url: `http://${host}:${port}`,
      authApplied: "tailnet",
      probe: { url: `http://${env.tailnetIp}:${port}/__synap_proxy/health` },
      origin: `http://${up.host}:${up.port}`,
      images: [image],
      asInstallation: {
        installationId: job.installation.id,
        project,
        dir,
        composeFile,
        services: [
          {
            id: "proxy",
            image,
            digest: sha256Of(image)!,
            ports: [],
            env: {},
            limits,
            volumes: [],
            egress: [],
          },
        ],
        isolated: true,
      },
    };
  }

  // cloudflare-tunnel: cloudflared dials out to Cloudflare; it needs egress and a token.
  if (!env.allowDeclaredEgress) {
    throw new ProviderOpRefusal("cloudflare-tunnel needs egress to Cloudflare, and this computer's operator has not allowed declared egress");
  }
  if (!env.secretsDir) throw new ProviderOpRefusal("no secretsDir in the runner config: the tunnel token cannot be read");
  const tokenFile = path.join(env.secretsDir, `${bindingId}.env`);
  if (!fs.existsSync(tokenFile)) {
    throw new ProviderOpRefusal(`no tunnel token was handed to this computer for binding ${bindingId}`);
  }
  if ((fs.statSync(tokenFile).mode & 0o077) !== 0) throw new ProviderOpRefusal(`${tokenFile} must be mode 600`);
  const { image, limits } = providerImage(job, "cloudflared");
  return {
    project,
    dir,
    composeFile,
    document: {
      name: project,
      services: {
        cloudflared: {
          image,
          container_name: `${project}-cloudflared`,
          ...hardening,
          cpus: limits.cpus,
          mem_limit: `${limits.memoryMb}m`,
          memswap_limit: `${limits.memoryMb}m`,
          // A token-run tunnel takes its ingress from Cloudflare (set pod-side by the open_tunnel provider's create,
          // to `origin` below); the connector only dials out.
          command: ["tunnel", "--no-autoupdate", "run"],
          env_file: [tokenFile],
          networks: ["upstream", "egress"],
        },
      },
      networks: {
        upstream: { name: up.network, external: true },
        egress: { name: `${project}-egress`, driver: "bridge", labels },
      },
    },
    url: null, // the DNS half (dns_record, pod-side) names it; the tunnel alone has no public name
    authApplied: "provider",
    probe: null,
    origin: `http://${up.host}:${up.port}`,
    images: [image],
    asInstallation: {
      installationId: job.installation.id,
      project,
      dir,
      composeFile,
      services: [{ id: "cloudflared", image, digest: sha256Of(image)!, ports: [], env: {}, limits, volumes: [], egress: ["cloudflare"] }],
      isolated: false,
    },
  };
}

export function writeProviderPlan(plan: ProviderPlan): string[] {
  const created: string[] = [];
  for (const d of [path.dirname(plan.dir), plan.dir]) {
    if (!fs.existsSync(d)) {
      fs.mkdirSync(d, { recursive: true, mode: 0o750 });
      created.push(d);
    }
  }
  fs.writeFileSync(
    plan.composeFile,
    `# Written by synap host serve for a provider binding. Do not edit.\n${YAML.stringify(plan.document)}`,
    { mode: 0o640 }
  );
  return created;
}

export function output(
  state: ContractOutput["state"],
  plan: Pick<ProviderPlan, "url" | "project" | "authApplied" | "origin"> | null,
  detail: string,
  now: Date
): ContractOutput & { origin?: string } {
  return {
    ...(plan ? { origin: plan.origin } : {}),
    url: state === "live" && plan ? plan.url : null,
    state,
    handle: plan?.project ?? null,
    authApplied: plan?.authApplied ?? null,
    public: false,
    expiresAt: null,
    checkedAt: now.toISOString(),
    detail,
  };
}

/** Is a binding's listener answering, from this computer? */
export async function probeBinding(
  plan: ProviderPlan,
  runtime: ContainerRuntime,
  fetchImpl: (url: string, init: RequestInit) => Promise<Response> = fetch
): Promise<{ live: boolean; detail: string }> {
  const states = await runtime.ps(plan.project).catch(() => []);
  const down = plan.asInstallation.services.filter((s) => states.find((c) => c.service === s.id)?.state !== "running");
  if (down.length) return { live: false, detail: `not running: ${down.map((s) => s.id).join(", ")}` };
  if (!plan.probe) return { live: true, detail: "running" };
  try {
    const res = await fetchImpl(plan.probe.url, { method: "GET", signal: AbortSignal.timeout(5_000) });
    await res.body?.cancel().catch(() => {});
    return res.ok ? { live: true, detail: "listener answers" } : { live: false, detail: `listener answered ${res.status}` };
  } catch (err) {
    return { live: false, detail: `listener: ${(err as Error).message}` };
  }
}
