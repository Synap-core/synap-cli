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
 * "Hosts services" in pod admin › Computers). The runner never holds an
 * installation's key in its state files; it reads its own key from the CLI's
 * config at start, like `synap worker` and `synap box serve`.
 */

import type { HubConfig } from "../hub-client.js";

/** What a host job does. Mirrors `HOST_JOB_WIRE_KINDS` (`host_jobs.kind`, migration 0399). */
export const HOST_JOB_KINDS = ["install", "remove", "update", "provider_op", "verb"] as const;
export type HostJobKind = (typeof HOST_JOB_KINDS)[number];

/** Each log end, in UTF-8 bytes. Mirrors `HOST_LOG_CAP`. */
export const HOST_LOG_CAP = 64 * 1024;
/** The pod refuses a body past this size (413). Mirrors `HOST_BODY_MAX_BYTES`. */
export const HOST_BODY_MAX_BYTES = 2 * 1024 * 1024;

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
    capabilityKey: string;
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

export interface ReportBody {
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

export interface FinishBody {
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
    if (!res.ok) {
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
