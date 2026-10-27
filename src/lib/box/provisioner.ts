/**
 * The provisioner's loop: one box per run, one run at a time (phase 0).
 *
 *   guards ok? ─no─▶ wait (the run keeps its turn: nothing is leased)
 *   lease ─▶ clone + start a box ─▶ the box fetches its job, installs, runs
 *        ─▶ done | a clock ran out | Stop | lease lost | provisioner stopping
 *   destroy the box, ALWAYS ─▶ upload /out ─▶ finish with the evidence
 *
 * Three clocks, one after the other: BOOT (the box must ask for its job, else
 * INFRA: it never started), SETUP (the declared packages must install, else
 * timeout), and the script's own wall clock from the moment it starts.
 *
 * A lost lease (404/409) ends the work without a finish: the pod already gave
 * the run up. A reaper destroys every tagged box no run holds, at start and
 * after every run, so a crash never leaves a box behind for long.
 */

import fs from "node:fs";
import path from "node:path";
import { assembleFinish, LogCapture, type RunOutcome } from "./evidence.js";
import type { BoxRegistry, BoxReport } from "./job-server.js";
import type { BoxBackend, HostReading } from "./proxmox.js";
import {
  LeaseLostError,
  WorkspaceRequiredError,
  type BoxHub,
  type BoxLimits,
  type FinishBody,
  type LeasedRun,
} from "./wire.js";

export interface HostGuards {
  /** Wait unless the host has at least this much MemAvailable. */
  minMemAvailableMb: number;
  /** Wait while the box storage (thin pool data) is fuller than this. */
  maxStorageUsedPct: number;
  /** Wait while the thin pool's metadata is fuller than this. */
  maxMetaUsedPct: number;
}

/** Phase 0 on the founder's host: swap is full, so the margin is RAM only. */
export const DEFAULT_GUARDS: HostGuards = { minMemAvailableMb: 6144, maxStorageUsedPct: 85, maxMetaUsedPct: 70 };

/**
 * BOX-CONTRACT "Phase 0 caps". The pod enforces them when a run is queued; the
 * provisioner re-applies them because the host is the person's, not the pod's.
 */
export const PHASE0_CAPS: BoxLimits = { wallSeconds: 3600, cpus: 2, memoryMb: 2048, diskMb: 8192, outMb: 200 };

/** A box that has not asked for its job by then did not start: INFRA, not the script's verdict. */
export const BOOT_SECONDS = 180;
/** The declared packages must be installed by then; past it the run timed out in setup. */
export const SETUP_SECONDS = 900;

/** Limits cut to the phase 0 caps, and the names of the ones that were cut. */
export function clampLimits(l: BoxLimits): { limits: BoxLimits; clamped: string[] } {
  const clamped: string[] = [];
  const out = { ...l };
  for (const k of Object.keys(PHASE0_CAPS) as Array<keyof BoxLimits>) {
    const v = Number.isFinite(l[k]) && l[k] > 0 ? l[k] : PHASE0_CAPS[k];
    out[k] = Math.min(v, PHASE0_CAPS[k]);
    if (out[k] !== l[k]) clamped.push(`${k} ${l[k]} → ${out[k]}`);
  }
  return { limits: out, clamped };
}

export function checkGuards(r: HostReading, g: HostGuards): { ok: true } | { ok: false; reason: string } {
  if (r.memAvailableMb < g.minMemAvailableMb) {
    return { ok: false, reason: `host MemAvailable ${r.memAvailableMb} MB < ${g.minMemAvailableMb} MB` };
  }
  if (r.storageUsedPct > g.maxStorageUsedPct) {
    return { ok: false, reason: `box storage ${r.storageUsedPct.toFixed(1)}% full > ${g.maxStorageUsedPct}%` };
  }
  if (r.metaUsedPct !== null && r.metaUsedPct > g.maxMetaUsedPct) {
    return { ok: false, reason: `thin pool metadata ${r.metaUsedPct.toFixed(1)}% full > ${g.maxMetaUsedPct}%` };
  }
  return { ok: true };
}

export interface ProvisionerDeps {
  hub: BoxHub;
  backend: BoxBackend;
  registry: BoxRegistry;
  log: (line: string) => void;
  now?: () => number;
  /** Destroy attempts before leaving a box to the reaper. */
  destroyAttempts?: number;
  /** The provisioner is stopping: end the current run (box destroyed, finish INFRA). */
  signal?: AbortSignal;
  /** Clock overrides (tests). */
  bootMs?: number;
  setupMs?: number;
}

const MIME: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".svg": "image/svg+xml",
  ".webp": "image/webp",
  ".pdf": "application/pdf",
  ".csv": "text/csv",
  ".json": "application/json",
  ".txt": "text/plain",
  ".md": "text/markdown",
  ".html": "text/html",
  ".zip": "application/zip",
  ".mp4": "video/mp4",
  ".mp3": "audio/mpeg",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
};

export function mimeOf(file: string): string {
  return MIME[path.extname(file).toLowerCase()] ?? "application/octet-stream";
}

/** Destroy every tagged box no run holds. Returns the VMIDs destroyed. */
export async function reap(backend: BoxBackend, held: ReadonlySet<number>, log: (l: string) => void): Promise<number[]> {
  const gone: number[] = [];
  for (const b of await backend.list()) {
    if (held.has(b.vmid)) continue;
    try {
      await backend.destroy(b.vmid);
      gone.push(b.vmid);
      log(`reaper: destroyed stray box ${b.vmid} (${b.name})`);
    } catch (err) {
      log(`reaper: could not destroy box ${b.vmid}: ${(err as Error).message}`);
    }
  }
  return gone;
}

/**
 * Work one leased run to its end (BOX-CONTRACT v2). Returns the finish body sent, or null when
 * the lease was lost (no finish is sent then).
 */
export async function runOne(leasedRun: LeasedRun, deps: ProvisionerDeps): Promise<FinishBody | null> {
  const now = deps.now ?? Date.now;
  const startedAt = now();
  const { limits, clamped } = clampLimits(leasedRun.script.limits);
  const run: LeasedRun = { ...leasedRun, script: { ...leasedRun.script, limits } };
  const bootMs = deps.bootMs ?? BOOT_SECONDS * 1000;
  const setupMs = deps.setupMs ?? SETUP_SECONDS * 1000;

  let phase: "setup" | "running" = "setup";
  let stopped = false;
  let lost = false;
  let timedOut = false;
  let infraReason: string | undefined;
  /** Said in the run's log once a box exists (a clock that ran out, a cap that cut a limit). */
  const notes: string[] = clamped.length ? [`limits cut to the phase 0 caps: ${clamped.join(", ")}`] : [];
  let wake: () => void = () => {};
  const interrupted = new Promise<void>((r) => (wake = r));

  const beat = async (): Promise<void> => {
    try {
      const reply = await deps.hub.heartbeat(run, phase);
      if (reply.stopRequested && !stopped) {
        stopped = true;
        deps.log(`run ${run.id}: Stop requested`);
        wake();
      }
    } catch (err) {
      if (err instanceof LeaseLostError) {
        lost = true;
        deps.log(`run ${run.id}: ${err.message}`);
        wake();
        return;
      }
      // A transient failure: the next beat retries before the lease runs out.
      deps.log(`run ${run.id}: heartbeat failed: ${(err as Error).message}`);
    }
  };

  const onAbort = () => {
    infraReason ??= "the provisioner was stopped mid-run";
    wake();
  };
  deps.signal?.addEventListener("abort", onAbort);

  let clock: NodeJS.Timeout | undefined;
  const arm = (ms: number, fire: () => void) => {
    clearTimeout(clock);
    clock = setTimeout(() => {
      fire();
      wake();
    }, ms);
  };

  await beat();
  if (lost) {
    deps.signal?.removeEventListener("abort", onAbort);
    return null;
  }
  const timer = setInterval(() => void beat(), Math.max(5, run.heartbeatIntervalSeconds) * 1000);
  deps.registry.onEvent = (r, event) => {
    if (r.id !== run.id) return;
    if (event === "job") {
      arm(setupMs, () => {
        timedOut = true;
        notes.push(`packages were still installing after ${Math.round(setupMs / 1000)} s: the box was destroyed`);
      });
      return;
    }
    phase = "running";
    void beat();
    arm(limits.wallSeconds * 1000, () => {
      timedOut = true;
      notes.push(`the script ran past its ${limits.wallSeconds} s wall clock: the box was destroyed`);
    });
  };

  let ip: string | null = null;
  let vmid: number | null = null;
  let report: BoxReport = { exitCode: null, installedPackages: [] };
  try {
    // A Stop, a lost lease or a stopping provisioner before the clone: no box at all.
    if (!stopped && !lost && !deps.signal?.aborted) {
      try {
        const handle = await deps.backend.create(run.id, { cpus: limits.cpus, memoryMb: limits.memoryMb });
        ip = handle.ip;
        vmid = handle.vmid;
      } catch (err) {
        infraReason = `clone failed: ${(err as Error).message}`;
      }
    }
    if (ip) {
      const box = deps.registry.register(ip, run);
      deps.log(`run ${run.id}: box ${vmid} at ${ip}`);
      arm(bootMs, () => {
        infraReason ??= `the box did not ask for its job within ${Math.round(bootMs / 1000)} s (boot or template problem)`;
      });
      const first = await Promise.race([box.done.then((d) => ({ d })), interrupted]);
      if (first && "d" in first) report = first.d;
    }
  } finally {
    clearTimeout(clock);
    deps.registry.onEvent = () => {};
    deps.signal?.removeEventListener("abort", onAbort);
    if (vmid !== null) {
      const attempts = deps.destroyAttempts ?? 3;
      for (let i = 1; i <= attempts; i++) {
        try {
          await deps.backend.destroy(vmid);
          deps.log(`run ${run.id}: box ${vmid} destroyed`);
          break;
        } catch (err) {
          deps.log(`run ${run.id}: destroy ${vmid} attempt ${i} failed: ${(err as Error).message}`);
        }
      }
    }
  }

  const box = ip ? deps.registry.get(ip) : undefined;
  const log = box?.log ?? new LogCapture();
  for (const n of notes) log.append(`\n[synap box] ${n}\n`);
  try {
    if (lost) return null;

    const files: FinishBody["files"] = [];
    let storable = true;
    for (const f of box?.outFiles ?? []) {
      try {
        if (!storable) throw new WorkspaceRequiredError();
        // The pod's upload door takes no empty file: listed in the evidence only.
        if (f.size === 0) throw new Error("the file is empty");
        const bytes = fs.readFileSync(path.join(box!.outDir, f.path));
        const uploadToken = await deps.hub.upload(run, { filename: path.basename(f.path), mimeType: mimeOf(f.path), bytes });
        files.push({ ...f, uploadToken, title: f.path });
      } catch (err) {
        if (err instanceof LeaseLostError) return null;
        if (err instanceof WorkspaceRequiredError) storable = false;
        // Recorded without a token (evidence only) and said in the log the
        // person reads, so a missing file is never silent.
        files.push({ ...f });
        log.append(`\n[synap box] /out/${f.path} (${f.size} bytes) was not stored: ${(err as Error).message}\n`);
      }
    }

    const outcome: RunOutcome = { exitCode: report.exitCode, timedOut, stopped, infraReason };
    const body = assembleFinish({
      leaseId: run.leaseId,
      outcome,
      startedAt,
      finishedAt: now(),
      log,
      blockedEgress: box?.blocked ?? [],
      installedPackages: report.installedPackages,
      files,
    });
    try {
      await deps.hub.finish(run, body);
      deps.log(`run ${run.id}: finished ${body.status}`);
    } catch (err) {
      deps.log(`run ${run.id}: finish failed: ${(err as Error).message}`);
      if (err instanceof LeaseLostError) return null;
      throw err;
    }
    return body;
  } finally {
    clearInterval(timer);
    if (ip) deps.registry.unregister(ip);
  }
}

export interface ServeOptions {
  guards: HostGuards;
  /** Wait between empty leases. */
  idleMs: number;
  /** Wait between guard readings while the host is short. */
  guardWaitMs: number;
  once?: boolean;
  signal?: AbortSignal;
  sleep?: (ms: number) => Promise<void>;
}

const realSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Lease and work runs until the signal aborts (or one pass with `once`). */
export async function serve(deps: ProvisionerDeps, opts: ServeOptions): Promise<void> {
  const sleep = opts.sleep ?? realSleep;
  await reap(deps.backend, new Set(), deps.log);
  let lastWait = "";
  while (!opts.signal?.aborted) {
    try {
      const guard = checkGuards(await deps.backend.readHost(), opts.guards);
      if (!guard.ok) {
        if (guard.reason !== lastWait) deps.log(`waiting, turn kept: ${guard.reason}`);
        lastWait = guard.reason;
        if (opts.once) return;
        await sleep(opts.guardWaitMs);
        continue;
      }
      lastWait = "";
      const run = await deps.hub.lease();
      if (run) {
        deps.log(`leased run ${run.id} (${run.script.name}, ${run.script.language})`);
        await runOne(run, { ...deps, signal: opts.signal });
        await reap(deps.backend, new Set(), deps.log);
      }
      if (opts.once) return;
      if (!run) await sleep(opts.idleMs);
    } catch (err) {
      deps.log(`error: ${(err as Error).message}`);
      if (opts.once) throw err;
      await sleep(opts.guardWaitMs);
    }
  }
}
