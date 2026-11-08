/**
 * The compose writer: the manifest snapshot AS APPROVED → one Docker Compose
 * file for one installation. Nothing else feeds it: no free text, no flag, no
 * value from the job's parameters. What the person consented to is exactly
 * what runs (design ccd509f8 §6, addendum 000e75ff §6).
 *
 * The manifest's `services[]` is a strict subset of Compose (the pod checks it
 * with `HostServiceSchema`, `@synap-core/types/capability-manifest`). The
 * runner checks it AGAIN here, because the computer is the person's and a pod
 * bug must not become a root shell on it. Every key is allow-listed, so these
 * are refused, never dropped:
 *   - privileged mode, added capabilities, devices, host pid/ipc/userns;
 *   - host networking (`network_mode`, `networks`) of any kind;
 *   - a host path: a volume is a NAME the runner maps to a folder INSIDE the
 *     installation's own folder, and any other shape is refused;
 *   - an image not pinned by digest, or whose digest is not the consented one;
 *   - a port bound anywhere but 127.0.0.1 (Docker-published ports bypass the
 *     firewall), or below 1024;
 *   - declared egress, unless the computer's operator allowed it (this runner
 *     has no egress allow-list for long-running services yet, so an
 *     installation with none gets a bridge with no outbound NAT).
 *
 * Every service is hardened the same way: the runner's uid, all capabilities
 * dropped, no-new-privileges, a read-only root with /tmp on a scratch folder
 * inside the installation folder, the
 * manifest's CPU and memory caps, a pids cap, and bounded local logs.
 */

import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import YAML from "yaml";

/** An image pinned by digest — never a bare tag. Same rule as the pod's `IMAGE_BY_DIGEST_RE`. */
export const IMAGE_BY_DIGEST_RE = /^[a-z0-9]+([._/-][a-z0-9]+)*(:[A-Za-z0-9._-]{1,128})?@sha256:[a-f0-9]{64}$/;
const SERVICE_ID_RE = /^[a-z][a-z0-9_-]{0,63}$/;
const VOLUME_NAME_RE = SERVICE_ID_RE;
const ENV_NAME_RE = /^[A-Z_][A-Z0-9_]{0,127}$/;
const CONTAINER_PATH_RE = /^\/[^\s]{0,511}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** The keys a host service may carry. Anything else is refused by name. */
const SERVICE_KEYS = new Set(["id", "image", "ports", "health", "env", "limits", "volumes", "egress"]);
const PORT_KEYS = new Set(["container", "host", "bind", "protocol"]);
const VOLUME_KEYS = new Set(["name", "path"]);
const HEALTH_KEYS = new Set(["http", "port"]);
const LIMIT_KEYS = new Set(["cpus", "memoryMb", "diskMb"]);

/** Why a key is refused, in words a person reads on the installation's history. */
const FORBIDDEN_KEYS: Record<string, string> = {
  privileged: "privileged mode is never allowed",
  network_mode: "host networking is never allowed: a service gets the installation's own bridge",
  network: "host networking is never allowed: a service gets the installation's own bridge",
  networks: "a service cannot choose its network: it gets the installation's own bridge",
  cap_add: "added Linux capabilities are never allowed",
  devices: "host devices are never allowed",
  pid: "the host pid namespace is never allowed",
  ipc: "the host ipc namespace is never allowed",
  userns_mode: "the host user namespace is never allowed",
  security_opt: "security options are the runner's, not the manifest's",
  volumes_from: "volumes from another container are never allowed",
  user: "the runner decides the user a service runs as",
  command: "the image's own command runs: a manifest does not carry a command",
  entrypoint: "the image's own entrypoint runs: a manifest does not carry one",
};

/** Container paths a volume may never cover. */
const SYSTEM_PATHS = ["/", "/proc", "/sys", "/dev", "/etc", "/usr", "/bin", "/sbin", "/lib", "/lib64", "/var/run", "/tmp"];

export interface PortSpec {
  container: number;
  host: number;
  bind: "127.0.0.1";
  protocol: "tcp" | "udp";
}

export interface PlannedService {
  id: string;
  image: string;
  /** The sha256 digest the image is pinned to (`sha256:<hex>`). */
  digest: string;
  ports: PortSpec[];
  health?: { http: string; port: number; hostPort: number };
  env: Record<string, string>;
  limits: { cpus: number; memoryMb: number; diskMb: number };
  /** Host folder → container path; every host folder is inside the installation folder. */
  volumes: Array<{ name: string; hostPath: string; path: string }>;
  egress: string[];
}

export interface InstallationPlan {
  installationId: string;
  /** The Compose project: `synap-<first 12 hex of the installation id>`. */
  project: string;
  /** `<installRoot>/<installationId>`: everything this installation owns on the computer. */
  dir: string;
  composeFile: string;
  services: PlannedService[];
  /** No service declares egress: the bridge gets no outbound NAT. */
  isolated: boolean;
}

export interface ComposeContext {
  installationId: string;
  /** The runner's folder for installations, e.g. /var/lib/synap-host/installations. */
  installRoot: string;
  /** Service id → the consented digest (the lease's `installation.digests`). */
  digests: Record<string, string>;
  /** `uid:gid` every service runs as (the runner's own user by default). */
  user: string;
  /** The operator allowed services that declare egress (no allow-list enforcement yet). */
  allowDeclaredEgress?: boolean;
  /** The computer's ceiling; a manifest asking for more is refused. */
  maxLimits?: { cpus: number; memoryMb: number };
}

/** The manifest cannot run on this computer as approved. Nothing was started. */
export class ComposeRefusal extends Error {
  constructor(readonly problems: string[]) {
    super(`the manifest cannot run as approved: ${problems.join("; ")}`);
    this.name = "ComposeRefusal";
  }
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const isInt = (v: unknown, min: number, max: number): v is number =>
  typeof v === "number" && Number.isInteger(v) && v >= min && v <= max;

/** `sha256:<hex>` from a digest or a `<name>@sha256:<hex>` reference, else null. */
export function sha256Of(ref: string): string | null {
  const m = /(?:^|@)(sha256:[a-f0-9]{64})$/.exec(ref);
  return m ? m[1] : null;
}

/** True when `child` is `parent` itself or inside it, by path (no `..` escape). */
export function isInside(parent: string, child: string): boolean {
  const rel = path.relative(path.resolve(parent), path.resolve(child));
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

export function projectName(installationId: string): string {
  return `synap-${installationId.replace(/-/g, "").slice(0, 12)}`;
}

/**
 * Check the manifest snapshot and plan the installation. Throws ComposeRefusal
 * with EVERY problem at once (a person fixes them in one go).
 */
export function planInstallation(manifest: unknown, ctx: ComposeContext): InstallationPlan {
  const problems: string[] = [];
  if (!UUID_RE.test(ctx.installationId)) problems.push(`the installation id "${ctx.installationId}" is not a uuid`);
  if (!path.isAbsolute(ctx.installRoot)) problems.push("the runner's installRoot must be an absolute path");
  if (!/^\d+:\d+$/.test(ctx.user)) problems.push(`the runner user "${ctx.user}" is not uid:gid`);
  const services = isObject(manifest) ? manifest.services : undefined;
  if (!Array.isArray(services) || services.length === 0) {
    problems.push("the manifest declares no services");
    throw new ComposeRefusal(problems);
  }
  if (services.length > 16) problems.push("a manifest runs at most 16 services");

  const dir = path.join(ctx.installRoot, ctx.installationId);
  const planned: PlannedService[] = [];
  const ids = new Set<string>();
  const hostPorts = new Set<number>();

  for (const [i, raw] of services.entries()) {
    const at = `services.${i}`;
    if (!isObject(raw)) {
      problems.push(`${at}: not an object`);
      continue;
    }
    for (const key of Object.keys(raw)) {
      if (SERVICE_KEYS.has(key)) continue;
      problems.push(`${at}: "${key}": ${FORBIDDEN_KEYS[key] ?? "not a key a host service may carry"}`);
    }
    const id = typeof raw.id === "string" ? raw.id : "";
    if (!SERVICE_ID_RE.test(id)) problems.push(`${at}: the service id "${String(raw.id)}" is not a slug`);
    else if (ids.has(id)) problems.push(`${at}: the service id "${id}" is declared twice`);
    ids.add(id);
    const where = id || at;

    // Image: pinned by digest, and the digest is the consented one.
    const image = typeof raw.image === "string" ? raw.image : "";
    const digest = sha256Of(image);
    if (!IMAGE_BY_DIGEST_RE.test(image) || !digest) {
      problems.push(`${where}: the image "${image}" is not pinned by digest (<name>@sha256:<64 hex>)`);
    } else {
      const consented = ctx.digests[id] !== undefined ? sha256Of(ctx.digests[id]) : null;
      if (!consented) problems.push(`${where}: no consented digest for this service`);
      else if (consented !== digest) problems.push(`${where}: the image digest ${digest} is not the consented ${consented}`);
    }

    // Ports: loopback only, unprivileged, unique on the host.
    const ports: PortSpec[] = [];
    if (raw.ports !== undefined && !Array.isArray(raw.ports)) problems.push(`${where}: ports must be a list`);
    for (const [j, p] of (Array.isArray(raw.ports) ? raw.ports : []).entries()) {
      const pat = `${where}: ports.${j}`;
      if (!isObject(p)) {
        problems.push(`${pat}: not an object`);
        continue;
      }
      for (const k of Object.keys(p)) if (!PORT_KEYS.has(k)) problems.push(`${pat}: "${k}" is not a port key`);
      const bind = p.bind ?? "127.0.0.1";
      if (bind !== "127.0.0.1") problems.push(`${pat}: binds ${String(bind)}; a port binds 127.0.0.1 only`);
      if (!isInt(p.container, 1, 65535)) problems.push(`${pat}: the container port is not 1-65535`);
      if (!isInt(p.host, 1024, 65535)) problems.push(`${pat}: the host port must be 1024-65535`);
      else if (hostPorts.has(p.host)) problems.push(`${pat}: the host port ${p.host} is used twice`);
      const protocol = p.protocol ?? "tcp";
      if (protocol !== "tcp" && protocol !== "udp") problems.push(`${pat}: the protocol is tcp or udp`);
      if (isInt(p.container, 1, 65535) && isInt(p.host, 1024, 65535)) {
        hostPorts.add(p.host);
        ports.push({ container: p.container, host: p.host, bind: "127.0.0.1", protocol: protocol as "tcp" | "udp" });
      }
    }

    // Health: an HTTP path on one of the service's own published ports, probed from 127.0.0.1.
    let health: PlannedService["health"];
    if (raw.health !== undefined) {
      const h = raw.health;
      if (!isObject(h)) problems.push(`${where}: health is not an object`);
      else {
        for (const k of Object.keys(h)) if (!HEALTH_KEYS.has(k)) problems.push(`${where}: health "${k}" is not a key`);
        const mapped = ports.find((p) => p.container === h.port && p.protocol === "tcp");
        if (typeof h.http !== "string" || !CONTAINER_PATH_RE.test(h.http)) problems.push(`${where}: health.http is not a path`);
        else if (!mapped) problems.push(`${where}: health.port ${String(h.port)} is not one of its published tcp ports`);
        else health = { http: h.http, port: mapped.container, hostPort: mapped.host };
      }
    }

    // Environment: names only from the manifest, values are strings.
    const env: Record<string, string> = {};
    if (raw.env !== undefined && !isObject(raw.env)) problems.push(`${where}: env is not an object`);
    for (const [k, v] of Object.entries(isObject(raw.env) ? raw.env : {})) {
      if (!ENV_NAME_RE.test(k)) problems.push(`${where}: env "${k}" is not an environment name`);
      else if (typeof v !== "string" || v.length > 4096) problems.push(`${where}: env ${k} is not a string under 4096 characters`);
      else env[k] = v;
    }

    // Limits: required, and within the computer's ceiling.
    const l = raw.limits;
    let limits = { cpus: 0, memoryMb: 0, diskMb: 0 };
    if (!isObject(l)) problems.push(`${where}: limits (cpus, memoryMb, diskMb) are required`);
    else {
      for (const k of Object.keys(l)) if (!LIMIT_KEYS.has(k)) problems.push(`${where}: limits "${k}" is not a key`);
      const cpus = typeof l.cpus === "number" && l.cpus > 0 && l.cpus <= 64 ? l.cpus : null;
      const memoryMb = isInt(l.memoryMb, 64, 262144) ? l.memoryMb : null;
      const diskMb = isInt(l.diskMb, 64, 2097152) ? l.diskMb : null;
      if (cpus === null) problems.push(`${where}: limits.cpus is not 0-64`);
      if (memoryMb === null) problems.push(`${where}: limits.memoryMb is not 64-262144`);
      if (diskMb === null) problems.push(`${where}: limits.diskMb is not 64-2097152`);
      if (cpus !== null && ctx.maxLimits && cpus > ctx.maxLimits.cpus) {
        problems.push(`${where}: asks ${cpus} CPUs; this computer allows ${ctx.maxLimits.cpus}`);
      }
      if (memoryMb !== null && ctx.maxLimits && memoryMb > ctx.maxLimits.memoryMb) {
        problems.push(`${where}: asks ${memoryMb} MB; this computer allows ${ctx.maxLimits.memoryMb}`);
      }
      limits = { cpus: cpus ?? 0, memoryMb: memoryMb ?? 0, diskMb: diskMb ?? 0 };
    }

    // Volumes: a NAME the runner maps inside the installation's folder. A host path is refused.
    const volumes: PlannedService["volumes"] = [];
    if (raw.volumes !== undefined && !Array.isArray(raw.volumes)) problems.push(`${where}: volumes must be a list`);
    for (const [j, v] of (Array.isArray(raw.volumes) ? raw.volumes : []).entries()) {
      const vat = `${where}: volumes.${j}`;
      if (typeof v === "string") {
        problems.push(`${vat}: "${v}" is a host path mount; only named volumes inside the installation folder are allowed`);
        continue;
      }
      if (!isObject(v)) {
        problems.push(`${vat}: not an object`);
        continue;
      }
      for (const k of Object.keys(v)) {
        if (!VOLUME_KEYS.has(k)) problems.push(`${vat}: "${k}" names a host path or a volume option; only {name, path} is allowed`);
      }
      const name = typeof v.name === "string" ? v.name : "";
      const cpath = typeof v.path === "string" ? v.path : "";
      if (!VOLUME_NAME_RE.test(name)) problems.push(`${vat}: the volume name "${name}" is not a slug`);
      if (!CONTAINER_PATH_RE.test(cpath) || cpath.split("/").includes("..")) problems.push(`${vat}: "${cpath}" is not an absolute container path`);
      else if (SYSTEM_PATHS.includes(path.posix.normalize(cpath).replace(/\/+$/, "") || "/")) {
        problems.push(`${vat}: a volume may not cover ${cpath}`);
      }
      const hostPath = path.join(dir, "volumes", name);
      if (!isInside(path.join(dir, "volumes"), hostPath)) problems.push(`${vat}: resolves outside the installation folder`);
      if (VOLUME_NAME_RE.test(name) && CONTAINER_PATH_RE.test(cpath)) volumes.push({ name, hostPath, path: cpath });
    }

    // Egress: none by default; declared egress needs the operator's yes.
    const egress = Array.isArray(raw.egress) ? raw.egress.filter((h): h is string => typeof h === "string") : [];
    if (raw.egress !== undefined && (!Array.isArray(raw.egress) || egress.length !== raw.egress.length)) {
      problems.push(`${where}: egress must be a list of host names`);
    }
    if (egress.length > 0 && !ctx.allowDeclaredEgress) {
      problems.push(
        `${where}: declares egress to ${egress.join(", ")}, and this runner cannot enforce an egress allow-list for services; ` +
          `the computer's operator must allow declared egress (allowDeclaredEgress)`
      );
    }

    planned.push({ id, image, digest: digest ?? "", ports, health, env, limits, volumes, egress });
  }

  if (problems.length > 0) throw new ComposeRefusal(problems);
  return {
    installationId: ctx.installationId,
    project: projectName(ctx.installationId),
    dir,
    composeFile: path.join(dir, "compose.yaml"),
    services: planned,
    isolated: planned.every((s) => s.egress.length === 0),
  };
}

/** The Compose document for a plan (a plain object; `renderCompose` writes it as YAML). */
export function composeDocument(plan: InstallationPlan, ctx: Pick<ComposeContext, "user">): Record<string, unknown> {
  const labels = (service?: string) => ({
    "synap.managed-by": "synap-host",
    "synap.installation": plan.installationId,
    ...(service ? { "synap.service": service } : {}),
  });
  const services: Record<string, unknown> = {};
  for (const s of plan.services) {
    const shmMb = Math.max(64, Math.min(1024, Math.floor(s.limits.memoryMb / 4)));
    services[s.id] = {
      image: s.image,
      container_name: `${plan.project}-${s.id}`,
      user: ctx.user,
      read_only: true,
      cap_drop: ["ALL"],
      security_opt: ["no-new-privileges:true"],
      cpus: s.limits.cpus,
      mem_limit: `${s.limits.memoryMb}m`,
      memswap_limit: `${s.limits.memoryMb}m`,
      pids_limit: 2048,
      shm_size: `${shmMb}m`,
      ...(Object.keys(s.env).length ? { environment: s.env } : {}),
      ...(s.ports.length
        ? { ports: s.ports.map((p) => `${p.bind}:${p.host}:${p.container}/${p.protocol}`) }
        : {}),
      // /tmp is a scratch folder on disk inside the installation folder, not a tmpfs: HyperFrames refuses to render
      // with under 1 GB free at its temp dir, and RAM is the scarcer resource on a shared computer.
      volumes: [
        { type: "bind", source: scratchDir(plan, s.id), target: "/tmp", bind: { create_host_path: false } },
        ...s.volumes.map((v) => ({ type: "bind", source: v.hostPath, target: v.path, bind: { create_host_path: false } })),
      ],
      networks: ["installation"],
      restart: "unless-stopped",
      labels: labels(s.id),
      logging: { driver: "local", options: { "max-size": "10m", "max-file": "3" } },
    };
  }
  return {
    name: plan.project,
    services,
    networks: {
      installation: {
        name: plan.project,
        driver: "bridge",
        labels: labels(),
        // No declared egress: no outbound NAT, so a service cannot reach the internet; its 127.0.0.1 ports still work.
        ...(plan.isolated ? { driver_opts: { "com.docker.network.bridge.enable_ip_masquerade": "false" } } : {}),
      },
    },
  };
}

/** A service's /tmp on disk: `<installation>/scratch/<service>`, emptied on every removal. */
export function scratchDir(plan: Pick<InstallationPlan, "dir">, serviceId: string): string {
  return path.join(plan.dir, "scratch", serviceId);
}

export function renderCompose(plan: InstallationPlan, ctx: Pick<ComposeContext, "user">): string {
  return `# Written by synap worker (host runner) from the approved manifest of installation ${plan.installationId}. Do not edit.\n${YAML.stringify(
    composeDocument(plan, ctx)
  )}`;
}

/**
 * Make the installation's folders and write its compose file. Every folder it
 * makes is checked to be a real directory inside the installation folder (a
 * symlink planted there is refused), so a bind mount can never reach outside.
 * Returns the paths it created, for cleanup.
 */
export function writeInstallation(plan: InstallationPlan, ctx: Pick<ComposeContext, "user">): string[] {
  const created: string[] = [];
  const mkdir = (dir: string) => {
    if (fs.existsSync(dir)) {
      const st = fs.lstatSync(dir);
      if (!st.isDirectory() || st.isSymbolicLink()) throw new ComposeRefusal([`${dir} exists and is not a plain folder`]);
    } else {
      fs.mkdirSync(dir, { recursive: false, mode: 0o750 });
      created.push(dir);
    }
    const real = fs.realpathSync(dir);
    if (!isInside(fs.realpathSync(path.dirname(plan.dir)), real)) {
      throw new ComposeRefusal([`${dir} resolves outside the runner's installation folder`]);
    }
  };
  fs.mkdirSync(path.dirname(plan.dir), { recursive: true, mode: 0o750 });
  mkdir(plan.dir);
  const volumesDir = path.join(plan.dir, "volumes");
  if (plan.services.some((s) => s.volumes.length)) mkdir(volumesDir);
  for (const s of plan.services) for (const v of s.volumes) if (!created.includes(v.hostPath)) mkdir(v.hostPath);
  mkdir(path.join(plan.dir, "scratch"));
  for (const s of plan.services) mkdir(scratchDir(plan, s.id));
  fs.writeFileSync(plan.composeFile, renderCompose(plan, ctx), { mode: 0o640 });
  return created;
}

// ── the container runtime (Docker Compose v2) ────────────────────────────────

export interface ContainerState {
  service: string;
  /** Docker's state: running, exited, restarting, created, … */
  state: string;
  exitCode: number | null;
}

/**
 * What the runner asks of the container engine. One interface so the job loop
 * is tested with a fake; the real one shells out to `docker` with argv (never
 * a shell string), as the computer's runner user.
 */
export interface ContainerRuntime {
  /** The image is on this computer already (a local build, or pulled before). */
  imagePresent(ref: string): Promise<boolean>;
  /** Pull by digest. */
  pull(ref: string): Promise<void>;
  up(plan: InstallationPlan): Promise<void>;
  /** Stop and remove every container and network of the project; with a file or without. */
  down(project: string, composeFile?: string): Promise<void>;
  ps(project: string): Promise<ContainerState[]>;
  logs(project: string, tailLines: number): Promise<string>;
  /** Compose projects on this computer labelled as ours. */
  projects(): Promise<string[]>;
}

export type Exec = (file: string, args: string[], opts?: { timeoutMs?: number }) => Promise<{ stdout: string; stderr: string }>;

export const execDocker: Exec = (file, args, opts) =>
  new Promise((resolve, reject) => {
    execFile(file, args, { timeout: opts?.timeoutMs ?? 120_000, maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) {
        const detail = (stderr || stdout || "").toString().trim().split("\n").slice(-5).join(" | ");
        reject(new Error(`${file} ${args.slice(0, 3).join(" ")} failed: ${detail || err.message}`));
      } else resolve({ stdout: stdout.toString(), stderr: stderr.toString() });
    });
  });

export function createDockerRuntime(exec: Exec = execDocker, docker = "docker"): ContainerRuntime {
  const compose = (project: string, file: string | undefined, args: string[], timeoutMs?: number) =>
    exec(docker, ["compose", "-p", project, ...(file ? ["-f", file] : []), ...args], { timeoutMs });
  return {
    async imagePresent(ref) {
      // empty-ok: "not present" makes the runner pull it by digest; a pull that fails then fails the job, with its reason.
      try {
        await exec(docker, ["image", "inspect", "--format", "{{.Id}}", ref], { timeoutMs: 30_000 });
        return true;
      } catch {
        return false;
      }
    },
    async pull(ref) {
      await exec(docker, ["pull", "--quiet", ref], { timeoutMs: 30 * 60_000 });
    },
    async up(plan) {
      // --pull never: every image was checked or pulled by digest just before; compose must not fetch a tag.
      await compose(plan.project, plan.composeFile, ["up", "--detach", "--no-build", "--pull", "never", "--remove-orphans"], 5 * 60_000);
    },
    async down(project, file) {
      await compose(project, file && fs.existsSync(file) ? file : undefined, ["down", "--remove-orphans", "--timeout", "20"], 3 * 60_000);
    },
    async ps(project) {
      const { stdout } = await compose(project, undefined, ["ps", "--all", "--format", "json"], 30_000);
      const rows: Array<Record<string, unknown>> = [];
      const text = stdout.trim();
      if (text.startsWith("[")) rows.push(...(JSON.parse(text) as Array<Record<string, unknown>>));
      else for (const line of text.split("\n")) if (line.trim()) rows.push(JSON.parse(line) as Record<string, unknown>);
      return rows.map((r) => ({
        service: String(r.Service ?? ""),
        state: String(r.State ?? "").toLowerCase(),
        exitCode: typeof r.ExitCode === "number" ? r.ExitCode : null,
      }));
    },
    async logs(project, tailLines) {
      const { stdout, stderr } = await compose(project, undefined, ["logs", "--no-color", "--timestamps", "--tail", String(tailLines)], 60_000);
      return stdout + stderr;
    },
    async projects() {
      const { stdout } = await exec(
        docker,
        ["ps", "--all", "--filter", "label=synap.managed-by=synap-host", "--format", '{{.Label "com.docker.compose.project"}}'],
        { timeoutMs: 30_000 }
      );
      return [...new Set(stdout.split("\n").map((l) => l.trim()).filter(Boolean))];
    },
  };
}
