/**
 * The pod side of a box run, as the provisioner sees it: lease, heartbeat,
 * upload, finish. ONE module, so the wire shape lives in one place. Contract:
 * lanes/code-runtime/BOX-CONTRACT.md v2 (2026-10-26, owned by the pod lane),
 * Hub routes `/api/hub/box-runs/*`.
 *
 * Every call carries the COMPUTER's own key (device flow, scope `box.runner`):
 * the provisioner is a computer that pulls runs, never an agent.
 */

import type { HubConfig } from "../hub-client.js";
import type { BlockedEgress } from "./egress.js";
import type { InstalledPackage, RunLog } from "./evidence.js";

export type BoxLanguage = "python" | "node";

export interface BoxLimits {
  wallSeconds: number;
  cpus: number;
  memoryMb: number;
  diskMb: number;
  outMb: number;
}

export interface BoxScript {
  skillId: string;
  name: string;
  language: BoxLanguage;
  entrypoint: string;
  code: string;
  packages: Array<{ name: string; version: string }>;
  /** Run-phase egress allowlist: host names, optionally `host:port`. */
  hosts: string[];
  limits: BoxLimits;
}

export interface LeasedRun {
  id: string;
  leaseId: string;
  leaseExpiresAt: string;
  heartbeatIntervalSeconds: number;
  script: BoxScript;
  parameters: unknown;
  queuedAt: string;
  attempt: number;
}

export interface HeartbeatReply {
  leaseExpiresAt: string;
  stopRequested: boolean;
}

export interface UploadTicket {
  uploadUrl: string;
  method: string;
  headers: Record<string, string>;
  uploadToken: string;
  expiresAt: string;
  maxBytes: number;
}

/** BOX-CONTRACT v2: timeout and infra are stored as failed with the verdict kept. */
export type FinishStatus = "done" | "failed" | "stopped" | "timeout" | "infra";

export interface FinishedFile {
  path: string;
  size: number;
  sha256: string;
  /** Absent when the file could not be uploaded: it is recorded in the evidence only. */
  uploadToken?: string;
  title?: string;
}

export interface FinishBody {
  leaseId: string;
  status: FinishStatus;
  exitCode: number | null;
  durationMs: number;
  /** Required when status = infra. */
  infraReason?: string;
  log: RunLog;
  files: FinishedFile[];
  blockedEgress: BlockedEgress[];
  installedPackages: InstalledPackage[];
}

/** 404 / 409: the pod no longer holds this lease for us. Stop, destroy, never finish. */
export class LeaseLostError extends Error {
  constructor(runId: string, status: number) {
    super(`lease on box run ${runId} lost (HTTP ${status})`);
    this.name = "LeaseLostError";
  }
}

/** The run has no workspace: its files cannot be stored (record them `stored: false`). */
export class WorkspaceRequiredError extends Error {
  constructor() {
    super("the run has no workspace: its files cannot be stored");
    this.name = "WorkspaceRequiredError";
  }
}

export interface BoxHub {
  lease(): Promise<LeasedRun | null>;
  heartbeat(run: LeasedRun, phase: "setup" | "running"): Promise<HeartbeatReply>;
  upload(run: LeasedRun, file: { filename: string; mimeType: string; bytes: Buffer }): Promise<string>;
  finish(run: LeasedRun, body: FinishBody): Promise<unknown>;
}

export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

export function createBoxHub(cfg: Pick<HubConfig, "podUrl" | "apiKey">, fetchImpl: FetchLike = fetch): BoxHub {
  const base = `${cfg.podUrl.replace(/\/+$/, "")}/api/hub/box-runs`;

  async function post(path: string, body: unknown, runId?: string): Promise<unknown> {
    const res = await fetchImpl(`${base}${path}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${cfg.apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(30_000),
    });
    if (runId && (res.status === 404 || res.status === 409)) throw new LeaseLostError(runId, res.status);
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      if (res.status === 400 && /WORKSPACE_REQUIRED/.test(text)) throw new WorkspaceRequiredError();
      throw new Error(`POST box-runs${path} failed (HTTP ${res.status})${text ? `: ${text.slice(0, 300)}` : ""}`);
    }
    return res.json();
  }

  const runPath = (run: LeasedRun, verb: string) => `/${encodeURIComponent(run.id)}/${verb}`;

  return {
    async lease() {
      const body = (await post("/lease", {})) as { run?: LeasedRun | null };
      return body.run ?? null;
    },
    async heartbeat(run, phase) {
      return (await post(runPath(run, "heartbeat"), { leaseId: run.leaseId, phase }, run.id)) as HeartbeatReply;
    },
    async upload(run, file) {
      const ticket = (await post(
        runPath(run, "uploads"),
        { leaseId: run.leaseId, filename: file.filename, mimeType: file.mimeType, size: file.bytes.length },
        run.id
      )) as UploadTicket;
      // Straight to object storage with exactly the headers the pod signed.
      const put = await fetchImpl(ticket.uploadUrl, {
        method: ticket.method || "PUT",
        headers: ticket.headers,
        body: new Uint8Array(file.bytes),
        signal: AbortSignal.timeout(10 * 60_000),
      });
      if (!put.ok) throw new Error(`storing ${file.filename} failed (HTTP ${put.status})`);
      return ticket.uploadToken;
    },
    async finish(run, body) {
      return post(runPath(run, "finish"), body, run.id);
    },
  };
}
