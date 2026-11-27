/**
 * The device self-description manifest v1: what THIS computer says about
 * itself to the pod (devices plan 767a5978 §3). The contract is the backend's
 * `packages/types/src/device-manifest` (`DeviceManifestSchema`); it is mirrored
 * here as a small local type + `validateDeviceManifest` because the published
 * `@synap-core/types` this CLI depends on does not carry the module yet. The
 * parity test (`test/device-manifest-parity.test.ts`) pins the version and the
 * capability pattern against the backend source when it is checked out.
 *
 * Rules: every probe has a timeout and never throws; a probe that fails
 * omits its field, nothing is invented; no storage tier is guessed.
 *
 * Doors (backend `computer-report.ts`, `host-jobs.ts`):
 *   POST /api/hub/computers/me/report  { manifest, reporter } every computer's own key
 *   POST /api/hub/host-jobs/lease      { …, manifest }       the host runner (the pod names it `host`)
 * The pod answers `device.manifest`: accepted | absent | refused.
 *
 * One computer runs several of these processes, each knowing part of what it
 * can do. Each names itself (`reporter`), the pod keeps each one's
 * capabilities apart and counts them for 30 minutes after its last report, so
 * a running process re-reports well inside that window.
 */

import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import os from "node:os";

export const DEVICE_MANIFEST_VERSION = 1 as const;
/** The expensive probes (disks, GPUs) run at most this often. */
export const MANIFEST_TTL_MS = 10 * 60_000;
/** A pod that does not know the report door is not asked again for this long. */
export const REPORT_UNSUPPORTED_MS = 60 * 60_000;
/**
 * A running process reports at least this often: the pod drops a reporter's
 * capabilities 30 min after its last report (`DEVICE_CAPABILITY_TTL_MS`) and
 * counts the device online for 5 min after a report (`DEVICE_ONLINE_WINDOW_MS`).
 */
export const REPORT_EVERY_MS = 4 * 60_000;
/** How often {@link DeviceReporter.keepReporting} asks whether a report is due (it costs nothing when none is). */
export const REPORT_CHECK_MS = 30_000;

/** The backend's `DEVICE_REPORTER`: a name the pod does not match is filed under its default, `runner`. */
export const DEVICE_REPORTER_NAME = /^[a-z][a-z0-9-]{0,31}$/;
/**
 * The processes of this CLI that report. `waker` and `host` are also the names
 * the pod gives the waker's polls and each host lease, so a process's own
 * reports and the pod's bookkeeping of it land on one entry.
 */
export const DEVICE_REPORTERS = ["waker", "worker", "host"] as const;
export type DeviceReporterName = (typeof DEVICE_REPORTERS)[number];

export interface DeviceDisk {
  mount: string;
  sizeMb: number;
  freeMb: number;
  fs?: string;
}
export interface DeviceManifest {
  manifestVersion: 1;
  identity?: { os?: string; osVersion?: string; arch?: string; hostname?: string };
  resources?: {
    cpu?: { model?: string; cores?: number };
    memoryMb?: number;
    gpus?: Array<{ model: string; vramMb?: number }>;
    disks?: DeviceDisk[];
  };
  capabilities?: string[];
}

/** The existing `agentMetadata` flags of this computer, as far as the runner knows them. */
export interface ComputerFlags {
  runsScripts?: boolean;
  wakesAgents?: boolean;
  hostsServices?: boolean;
}

/** Native capabilities the runner really supports, from the computer's flags. */
export function capabilitiesFrom(flags: ComputerFlags): string[] {
  const out: string[] = [];
  if (flags.runsScripts) out.push("run.tool");
  if (flags.wakesAgents) out.push("wake.agent");
  if (flags.hostsServices) out.push("serve.http");
  return out;
}

// ─── Parsers (pure) ─────────────────────────────────────────────────────────

const PSEUDO_FS = new Set([
  "tmpfs", "devtmpfs", "devfs", "overlay", "squashfs", "map", "autofs", "proc", "sysfs", "cgroup", "cgroup2",
  "none", "shm", "efivarfs", "udev", "ramfs", "fdescfs", "procfs", "mqueue", "securityfs", "pstore", "debugfs",
  "tracefs", "configfs", "fusectl", "binfmt_misc", "nsfs", "overlayfs", "shmfs",
]);

const SKIP_MOUNT = /^(\/dev|\/proc|\/sys|\/run|\/snap|\/var\/lib\/snapd|\/System\/Volumes|\/private\/var\/vm|\/boot\/efi)(\/|$)/;

/**
 * `df -kP` → real filesystems. Columns: Filesystem, 1024-blocks, Used,
 * Available, Capacity, Mounted on (the mount may hold spaces). Pseudo
 * filesystems, snap loops and Apple's system sub-volumes are dropped; one
 * device mounted twice (bind mounts) is kept once, at its shortest mount.
 */
export function parseDf(text: string): DeviceDisk[] {
  const byFs = new Map<string, DeviceDisk>();
  for (const line of text.split("\n")) {
    const m = /^(\S.*?)\s+(\d+)\s+(\d+)\s+(\d+)\s+(?:\d+%|-)\s+(\/.*|[A-Za-z]:.*)$/.exec(line.trim());
    if (!m) continue; // the header, a blank line, anything unreadable
    const [, fs, sizeKb, , freeKb, mount] = m as unknown as [string, string, string, string, string, string];
    if (PSEUDO_FS.has(fs.toLowerCase())) continue;
    if (fs.startsWith("/dev/loop") || SKIP_MOUNT.test(mount)) continue;
    const sizeMb = Math.floor(Number(sizeKb) / 1024);
    const freeMb = Math.min(Math.floor(Number(freeKb) / 1024), sizeMb);
    if (!Number.isFinite(sizeMb) || sizeMb <= 0 || mount.length > 512) continue;
    const disk: DeviceDisk = { mount, sizeMb, freeMb };
    const seen = byFs.get(fs);
    if (!seen || mount.length < seen.mount.length) byFs.set(fs, disk);
  }
  return [...byFs.values()];
}

/** `nvidia-smi --query-gpu=name,memory.total --format=csv,noheader` → GPUs ("NVIDIA RTX 4090, 24564 MiB"). */
export function parseNvidiaSmi(text: string): Array<{ model: string; vramMb?: number }> {
  const out: Array<{ model: string; vramMb?: number }> = [];
  for (const line of text.split("\n")) {
    const t = line.trim();
    if (!t) continue;
    const i = t.lastIndexOf(",");
    const model = (i === -1 ? t : t.slice(0, i)).trim();
    const mem = i === -1 ? null : /^(\d+)\s*MiB$/i.exec(t.slice(i + 1).trim());
    if (!model) continue;
    out.push(mem ? { model: model.slice(0, 200), vramMb: Number(mem[1]) } : { model: model.slice(0, 200) });
  }
  return out;
}

/** `system_profiler SPDisplaysDataType -json` → GPUs (Apple silicon reports no VRAM: it is left out). */
export function parseSystemProfilerGpus(text: string): Array<{ model: string; vramMb?: number }> {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return [];
  }
  const items = (json as { SPDisplaysDataType?: unknown })?.SPDisplaysDataType;
  if (!Array.isArray(items)) return [];
  const out: Array<{ model: string; vramMb?: number }> = [];
  for (const it of items as Array<Record<string, unknown>>) {
    const model = typeof it.sppci_model === "string" ? it.sppci_model.trim() : "";
    if (!model) continue;
    const vram = typeof it.spdisplays_vram === "string" ? /^(\d+)\s*(MB|GB)$/i.exec(it.spdisplays_vram.trim()) : null;
    const vramMb = vram ? Number(vram[1]) * (vram[2]!.toUpperCase() === "GB" ? 1024 : 1) : undefined;
    out.push(vramMb ? { model: model.slice(0, 200), vramMb } : { model: model.slice(0, 200) });
  }
  return out;
}

/** `/etc/os-release` → its `VERSION_ID` ("24.04"), quotes removed; undefined when absent. */
export function parseOsReleaseVersion(text: string): string | undefined {
  const m = /^VERSION_ID=(.*)$/m.exec(text);
  const v = m?.[1]?.trim().replace(/^(["'])(.*)\1$/, "$2").trim();
  return v ? v.slice(0, 120) : undefined;
}

// ─── Probes ─────────────────────────────────────────────────────────────────

/** Runs a program with a timeout; rejects on any failure (missing, non-zero, timeout). */
export type RunProbe = (cmd: string, args: string[], timeoutMs: number) => Promise<string>;

export const runProbe: RunProbe = (cmd, args, timeoutMs) =>
  new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024, windowsHide: true }, (err, stdout) =>
      err ? reject(err) : resolve(String(stdout))
    );
  });

export interface CollectDeps {
  run?: RunProbe;
  os?: Pick<typeof os, "cpus" | "totalmem" | "platform" | "arch" | "hostname" | "release">;
  platform?: NodeJS.Platform;
  readText?: (path: string) => Promise<string>;
}

/** One probe, never throws: undefined when it failed. */
async function attempt<T>(fn: () => Promise<T> | T): Promise<T | undefined> {
  try {
    return await fn();
  // empty-ok: the probe's contract is "a failed probe omits its field"; nothing is invented
  } catch {
    return undefined;
  }
}

/** What the machine says now. Every field a failed probe could not read is absent. */
export async function collectDeviceManifest(flags: ComputerFlags = {}, deps: CollectDeps = {}): Promise<DeviceManifest> {
  const run = deps.run ?? runProbe;
  const o = deps.os ?? os;
  const platform = deps.platform ?? process.platform;
  const readText = deps.readText ?? ((p: string) => readFile(p, "utf8"));

  const identity = await attempt(() => {
    const id: NonNullable<DeviceManifest["identity"]> = {};
    const p = o.platform();
    const a = o.arch();
    const h = o.hostname();
    if (p) id.os = p.slice(0, 64);
    if (a) id.arch = a.slice(0, 32);
    if (h) id.hostname = h.slice(0, 253);
    return id;
  });

  const cpu = await attempt(() => {
    const cpus = o.cpus();
    const model = cpus[0]?.model?.trim();
    return { ...(model ? { model: model.slice(0, 200) } : {}), ...(cpus.length > 0 ? { cores: Math.min(cpus.length, 4096) } : {}) };
  });
  const memoryMb = await attempt(() => {
    const mb = Math.floor(o.totalmem() / (1024 * 1024));
    if (!Number.isFinite(mb) || mb <= 0) throw new Error("no memory");
    return mb;
  });

  const [disks, nvidia, mac, osVersion] = await Promise.all([
    attempt(async () => parseDf(await run("df", ["-kP"], 5_000))),
    attempt(async () => parseNvidiaSmi(await run("nvidia-smi", ["--query-gpu=name,memory.total", "--format=csv,noheader"], 3_000))),
    platform === "darwin"
      ? attempt(async () => parseSystemProfilerGpus(await run("system_profiler", ["SPDisplaysDataType", "-json"], 1_500)))
      : Promise.resolve(undefined),
    attempt(() => readOsVersion(platform, run, readText, o)),
  ]);
  if (identity && osVersion) identity.osVersion = osVersion;
  const gpus = [...(nvidia ?? []), ...(mac ?? [])].slice(0, 32);

  const resources: NonNullable<DeviceManifest["resources"]> = {};
  if (cpu && Object.keys(cpu).length) resources.cpu = cpu;
  if (memoryMb !== undefined) resources.memoryMb = memoryMb;
  if (gpus.length) resources.gpus = gpus;
  if (disks && disks.length) resources.disks = disks.slice(0, 64);

  const capabilities = capabilitiesFrom(flags);
  return {
    manifestVersion: DEVICE_MANIFEST_VERSION,
    ...(identity && Object.keys(identity).length ? { identity } : {}),
    ...(Object.keys(resources).length ? { resources } : {}),
    ...(capabilities.length ? { capabilities } : {}),
  };
}

/**
 * The OS release a person recognises: the macOS version (`os.release()` there
 * is the Darwin kernel's), the distribution's on Linux; the kernel release
 * when neither can be read.
 */
async function readOsVersion(
  platform: NodeJS.Platform,
  run: RunProbe,
  readText: (path: string) => Promise<string>,
  o: Pick<typeof os, "release">
): Promise<string | undefined> {
  let v: string | undefined;
  if (platform === "darwin") v = (await attempt(async () => (await run("sw_vers", ["-productVersion"], 1_500)).trim()))?.slice(0, 120);
  if (platform === "linux") v = await attempt(async () => parseOsReleaseVersion(await readText("/etc/os-release")));
  if (!v) v = (await attempt(() => o.release().trim()))?.slice(0, 120);
  return v || undefined;
}

// ─── Local mirror of the schema's checks ────────────────────────────────────

const CAPABILITY_NAME = /^[a-z][a-z0-9-]*(\.[a-z0-9][a-z0-9-]*)+$/;

/** Null when `m` is a valid v1 manifest (the backend schema's limits), else one line naming the first bad field. */
export function validateDeviceManifest(m: unknown): string | null {
  if (!m || typeof m !== "object") return "manifest: not an object";
  const x = m as DeviceManifest;
  if (x.manifestVersion !== DEVICE_MANIFEST_VERSION) return "manifestVersion: must be 1";
  const word = (v: unknown, max: number) => typeof v === "string" && v.trim().length >= 1 && v.length <= max;
  const mb = (v: unknown) => Number.isInteger(v) && (v as number) >= 0;
  const id = x.identity;
  if (id !== undefined) {
    if (id.os !== undefined && !word(id.os, 64)) return "identity.os";
    if (id.osVersion !== undefined && !word(id.osVersion, 120)) return "identity.osVersion";
    if (id.arch !== undefined && !word(id.arch, 32)) return "identity.arch";
    if (id.hostname !== undefined && !word(id.hostname, 253)) return "identity.hostname";
  }
  const r = x.resources;
  if (r !== undefined) {
    if (r.cpu?.model !== undefined && !word(r.cpu.model, 200)) return "resources.cpu.model";
    const c = r.cpu?.cores;
    if (c !== undefined && !(Number.isInteger(c) && c > 0 && c <= 4096)) return "resources.cpu.cores";
    if (r.memoryMb !== undefined && !mb(r.memoryMb)) return "resources.memoryMb";
    if (r.gpus !== undefined) {
      if (r.gpus.length > 32) return "resources.gpus: too many";
      for (const g of r.gpus) if (!word(g.model, 200) || (g.vramMb !== undefined && !mb(g.vramMb))) return "resources.gpus";
    }
    if (r.disks !== undefined) {
      if (r.disks.length > 64) return "resources.disks: too many";
      for (const d of r.disks) if (!word(d.mount, 512) || !mb(d.sizeMb) || !mb(d.freeMb)) return "resources.disks";
    }
  }
  if (x.capabilities !== undefined) {
    if (x.capabilities.length > 64) return "capabilities: too many";
    for (const cap of x.capabilities) if (cap.length > 64 || !CAPABILITY_NAME.test(cap)) return `capabilities: ${cap}`;
  }
  return null;
}

// ─── Cache + report ─────────────────────────────────────────────────────────

/**
 * What this process can do now, or a reader of it (called on every check, so
 * it must be cheap). Undefined means unknown: the report then carries no
 * capabilities and the pod keeps this reporter's last ones.
 */
export type FlagsSource = ComputerFlags | undefined | (() => ComputerFlags | undefined);

export interface DeviceReporterDeps {
  /** Which process this is: the pod keeps each reporter's capabilities apart. */
  reporter: DeviceReporterName;
  collect?: (flags: ComputerFlags) => Promise<DeviceManifest>;
  now?: () => number;
  fetchImpl?: typeof fetch;
  log?: (line: string) => void;
}

export interface DeviceReporter {
  /**
   * The manifest, probes cached for {@link MANIFEST_TTL_MS}. Its capabilities
   * follow `flags` on every call, an empty list included (a flag turned off is
   * said); without `flags` they are left out.
   */
  manifest(flags?: ComputerFlags): Promise<DeviceManifest | undefined>;
  /**
   * Sends the manifest to the report door when due: {@link REPORT_EVERY_MS}
   * after the last send, or at once when the capabilities changed. Never throws.
   */
  report(podUrl: string, computerKey: string, flags?: FlagsSource): Promise<void>;
  /** Reports now, then whenever due while the process runs (an unref'd timer). Returns the stop. */
  keepReporting(podUrl: string, computerKey: string, flags: FlagsSource): () => void;
}

export function createDeviceReporter(deps: DeviceReporterDeps): DeviceReporter {
  const reporter = deps.reporter;
  const collect = deps.collect ?? ((f) => collectDeviceManifest(f));
  const now = deps.now ?? Date.now;
  const f = deps.fetchImpl ?? fetch;
  const log = deps.log ?? (() => {});
  let cached: { at: number; manifest: DeviceManifest } | undefined;
  let inflight: Promise<DeviceManifest | undefined> | undefined;
  let lastSentAt = -Infinity;
  let lastSentCapabilities: string | undefined;
  let unsupportedUntil = -Infinity;
  let sending = false;
  let saidInvalid = false;

  async function manifest(flags?: ComputerFlags): Promise<DeviceManifest | undefined> {
    if (!cached || now() - cached.at >= MANIFEST_TTL_MS) {
      inflight ??= attempt(async () => {
        const m = await collect(flags ?? {});
        const bad = validateDeviceManifest(m);
        if (bad) {
          if (!saidInvalid) log(`device manifest not sent (${bad})`);
          saidInvalid = true;
          return undefined;
        }
        cached = { at: now(), manifest: m };
        return m;
      }).finally(() => {
        inflight = undefined;
      });
      const fresh = await inflight;
      if (!fresh) return undefined;
    }
    const { capabilities: _old, ...rest } = cached!.manifest;
    return flags ? { ...rest, capabilities: capabilitiesFrom(flags) } : rest;
  }

  async function report(podUrl: string, computerKey: string, flags?: FlagsSource): Promise<void> {
    // One send at a time: a slow pod never piles reports up behind it.
    if (sending) return;
    sending = true;
    try {
      const t = now();
      if (t < unsupportedUntil) return;
      const resolved = typeof flags === "function" ? flags() : flags;
      const capabilities = resolved ? capabilitiesFrom(resolved).join(",") : undefined;
      const changed = capabilities !== undefined && capabilities !== lastSentCapabilities;
      if (!changed && t - lastSentAt < REPORT_EVERY_MS) return;
      const m = await manifest(resolved);
      if (!m) return;
      // A failed send waits its turn as well: never a retry storm.
      lastSentAt = t;
      if (capabilities !== undefined) lastSentCapabilities = capabilities;
      const res = await f(`${podUrl.replace(/\/+$/, "")}/api/hub/computers/me/report`, {
        method: "POST",
        headers: { Authorization: `Bearer ${computerKey}`, "Content-Type": "application/json" },
        body: JSON.stringify({ reporter, manifest: m }),
        signal: AbortSignal.timeout(15_000),
      });
      if ([404, 405, 501].includes(res.status)) {
        // A pod that predates the registry: say nothing is wrong, ask again in an hour.
        unsupportedUntil = t + REPORT_UNSUPPORTED_MS;
        return;
      }
      if (!res.ok) return;
      // empty-ok: an unreadable ack only drops the refused-manifest note; the report itself went through
      const ack = (await res.json().catch(() => null)) as { device?: { manifest?: string; error?: string } } | null;
      if (ack?.device?.manifest === "refused") log(`the pod refused this computer's device manifest: ${ack.device.error ?? "unknown field"}`);
    // empty-ok: a report is best effort: the computer keeps working, the next due send tries again
    } catch {
    } finally {
      sending = false;
    }
  }

  return {
    manifest,
    report,
    keepReporting(podUrl, computerKey, flags) {
      const check = () => void report(podUrl, computerKey, flags);
      check();
      const timer = setInterval(check, REPORT_CHECK_MS);
      // The timer never keeps a finished process alive.
      timer.unref?.();
      return () => clearInterval(timer);
    },
  };
}
