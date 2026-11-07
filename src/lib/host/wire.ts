/**
 * The pod side of a host job, as the host runner sees it: lease, heartbeat,
 * report, finish. ONE module, so the wire shape lives in one place.
 *
 * The wire's single definition is `@synap-core/types/host-jobs` (backend,
 * plan 64072312 U7, PR #779), the zod schemas the pod's routes parse every body
 * with. Until a types release carries it, this file mirrors its shapes in plain
 * TypeScript, and test/host-wire-parity.test.ts compares the two whenever the
 * backend source is checked out beside this repo. Routes: `/api/hub/host-jobs/*`.
 *
 * Every call carries the COMPUTER's own key (device flow, scope `host.runner`,
 * "Installs from the pod" in pod admin › Computers). The runner never holds an
 * installation's key in its state files; it reads its own key from the CLI's
 * config at start, like `synap worker` and `synap box serve`.
 */

import type { HubConfig } from "../hub-client.js";

/**
 * What a host job does. Mirrors `HOST_JOB_WIRE_KINDS` (`host_jobs.kind`).
 * `verify` (one installer, reconciliation f75fbb48 §3.2): check an installation
 * again and report what was found; the pod queues it when a check is due.
 */
export const HOST_JOB_KINDS = ["install", "remove", "update", "verify", "provider_op", "verb"] as const;
export type HostJobKind = (typeof HOST_JOB_KINDS)[number];

/** Each log end, in UTF-8 bytes. Mirrors `HOST_LOG_CAP`. */
export const HOST_LOG_CAP = 64 * 1024;
/** The pod refuses a body past this size (413). Mirrors `HOST_BODY_MAX_BYTES`. */
export const HOST_BODY_MAX_BYTES = 2 * 1024 * 1024;

/**
 * What an installation is (reconciliation f75fbb48 §3.1): `service` runs as
 * compose services from the approved manifest; `tool` is a program installed
 * by the per-OS steps the manifest declares.
 */
export const INSTALLATION_KINDS = ["service", "tool"] as const;
export type InstallationKind = (typeof INSTALLATION_KINDS)[number];

/** The finish verdicts. Mirrors `HostJobFinishBodySchema.status`. */
export const HOST_FINISH_STATUSES = ["done", "failed", "stopped", "timeout", "infra"] as const;
export type HostFinishStatus = (typeof HOST_FINISH_STATUSES)[number];

export interface HostLog {
  head?: string;
  tail?: string;
  totalBytes?: number | null;
  truncated?: boolean;
}

/** A leased job, as the lease route answers it (`LeasedHostJob`). */
export interface LeasedHostJob {
  id: string;
  kind: HostJobKind;
  leaseId: string;
  leaseExpiresAt: string;
  heartbeatIntervalSeconds: number;
  attempt: number;
  queuedAt: string;
  installation: {
    id: string;
    /** Always sent by the pod; derived from the manifest when absent (`installationKind`). */
    kind?: InstallationKind;
    capabilityKey: string;
    /** The version the person approved (an upgrade is a new approval). */
    desiredVersion?: string | null;
    capabilityVersion: string | null;
    upstreamVersion: string | null;
    /** The manifest AS APPROVED: the runner writes compose from it only. */
    manifest: Record<string, unknown>;
    /** Service id → image digest, as consented. */
    digests: Record<string, string>;
  };
  bindingId: string | null;
  skillId: string | null;
  /** The job as queued (the op, its input). */
  spec: Record<string, unknown>;
  parameters: Record<string, unknown>;
}

export interface HeartbeatAnswer {
  leaseExpiresAt: string;
  stopRequested: boolean;
  /** A person asked for this job's logs: send them in the next report. */
  logsRequested: boolean;
}

export interface ServiceHealth {
  healthy: boolean;
  detail?: string;
  checkedAt?: string;
}

export interface HealthReport {
  services: Record<string, ServiceHealth>;
  versions?: Record<string, { digest?: string; version?: string }>;
  ports?: Array<{ service: string; port: number; host: "127.0.0.1" }>;
  disk?: { usedMb?: number; freeMb?: number };
}

/**
 * A tool's check, as a report and a finish carry it (`ComputerToolReportSchema`
 * merged into the host-job wire, @synap-core/types/host-jobs, backend#779). The pod
 * derives health from it: drift from `observedVersion` against the manifest's
 * range, stale from the check's age.
 */
export interface ToolCheck {
  /** The version the tool printed (`captureVersion`), null when none was captured. */
  observedVersion: string | null;
  /** `process.platform` / `process.arch` of this computer. */
  os: string;
  arch: string;
  /** Null when no check ran (a step failed before it). */
  verify: {
    ok: boolean;
    exitCode: number | null;
    /** Redacted, at most 2000 characters. */
    excerpt: string;
    /** sha256 of the full output, before redaction. */
    outputSha256: string;
    smoke?: { ok: boolean; exitCode: number | null; excerpt: string };
  } | null;
}

export interface ReportBody extends Partial<ToolCheck> {
  leaseId: string;
  health?: HealthReport;
  /** Sent only after a heartbeat answered `logsRequested`; masked. */
  log?: HostLog;
}

export interface FinishStep {
  name: string;
  ok: boolean;
  detail?: string;
  durationMs?: number;
}

export interface FinishBody extends Partial<ToolCheck> {
  leaseId: string;
  status: HostFinishStatus;
  durationMs?: number | null;
  /** Required when status = infra. */
  infraReason?: string;
  steps?: FinishStep[];
  log?: HostLog;
  /** A provider op's contract output (url, state, handle, …). */
  output?: Record<string, unknown>;
  /** What the runner removed on a failure path. */
  cleanedUp?: string[];
}

/** 404 / 409: the pod no longer holds this lease for us. Stop, clean up, never report or finish. */
export class HostLeaseLostError extends Error {
  constructor(jobId: string, status: number) {
    super(`lease on host job ${jobId} lost (HTTP ${status})`);
    this.name = "HostLeaseLostError";
  }
}

/**
 * The pod will not lease to this computer: 401/403 (its key lacks `host.runner`:
 * the person has not turned on "Installs from the pod" for it) or 404 (a pod
 * without the host-job doors). Not a failed read: retrying soon changes nothing.
 */
export class HostDoorClosedError extends Error {
  constructor(readonly status: number) {
    super(
      status === 404
        ? "this pod has no host-job doors yet (update the pod)"
        : `this computer does not install from the pod: turn on "Installs from the pod" for it in pod admin › Computers (HTTP ${status})`
    );
    this.name = "HostDoorClosedError";
  }
}

/** service when the manifest declares `services`, tool when it declares `install` steps; both or neither: null. */
export function installationKind(job: Pick<LeasedHostJob, "installation">): InstallationKind | null {
  if (job.installation.kind) return job.installation.kind;
  const m = job.installation.manifest ?? {};
  const spec = (m.spec && typeof m.spec === "object" ? m.spec : m) as Record<string, unknown>;
  const service = Array.isArray(spec.services);
  const tool = !!spec.install && typeof spec.install === "object";
  if (service === tool) return null;
  return service ? "service" : "tool";
}

export interface HostHub {
  lease(capacity?: { cpus?: number; memoryMb?: number; diskGb?: number }): Promise<LeasedHostJob | null>;
  heartbeat(job: LeasedHostJob, phase: "setup" | "running"): Promise<HeartbeatAnswer>;
  report(job: LeasedHostJob, body: Omit<ReportBody, "leaseId">): Promise<unknown>;
  finish(job: LeasedHostJob, body: Omit<FinishBody, "leaseId">): Promise<unknown>;
}

export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

/** Cut a log end to the wire's cap (UTF-8 bytes), keeping its start (head) or its end (tail). */
export function capLogEnd(text: string, end: "head" | "tail", cap = HOST_LOG_CAP): string {
  const buf = Buffer.from(text, "utf8");
  if (buf.length <= cap) return text;
  const cut = end === "head" ? buf.subarray(0, cap) : buf.subarray(buf.length - cap);
  // A cut inside a multi-byte character decodes to U+FFFD; drop it rather than send a broken glyph.
  return cut.toString("utf8").replace(/^�|�$/g, "");
}

export function createHostHub(cfg: Pick<HubConfig, "podUrl" | "apiKey">, fetchImpl: FetchLike = fetch): HostHub {
  const base = `${cfg.podUrl.replace(/\/+$/, "")}/api/hub/host-jobs`;

  async function post(path: string, body: unknown, jobId?: string): Promise<unknown> {
    const payload = JSON.stringify(body);
    if (Buffer.byteLength(payload) > HOST_BODY_MAX_BYTES) {
      throw new Error(`POST host-jobs${path}: body is over ${HOST_BODY_MAX_BYTES} bytes`);
    }
    const res = await fetchImpl(`${base}${path}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${cfg.apiKey}`, "Content-Type": "application/json" },
      body: payload,
      signal: AbortSignal.timeout(30_000),
    });
    if (jobId && (res.status === 404 || res.status === 409)) throw new HostLeaseLostError(jobId, res.status);
    if (!jobId && [401, 403, 404].includes(res.status)) throw new HostDoorClosedError(res.status);
    if (!res.ok) {
      // empty-ok: only the error's detail; the HTTP status is thrown either way.
      const text = await res.text().catch(() => "");
      throw new Error(`POST host-jobs${path} failed (HTTP ${res.status})${text ? `: ${text.slice(0, 300)}` : ""}`);
    }
    return res.json();
  }

  const jobPath = (job: LeasedHostJob, verb: string) => `/${encodeURIComponent(job.id)}/${verb}`;

  return {
    async lease(capacity) {
      const body = (await post("/lease", capacity ? { capacity } : {})) as { job?: LeasedHostJob | null };
      return body.job ?? null;
    },
    async heartbeat(job, phase) {
      return (await post(jobPath(job, "heartbeat"), { leaseId: job.leaseId, phase }, job.id)) as HeartbeatAnswer;
    },
    async report(job, body) {
      return post(jobPath(job, "report"), { leaseId: job.leaseId, ...body }, job.id);
    },
    async finish(job, body) {
      return post(jobPath(job, "finish"), { leaseId: job.leaseId, ...body }, job.id);
    },
  };
}
