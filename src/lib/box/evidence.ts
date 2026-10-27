/**
 * What a box run hands back: the evidence bundle (runbox design C4 "Outputs";
 * BOX-CONTRACT v2 finish). Exit code, duration, the log kept as head + tail
 * under a cap, the /out files (with their upload tokens), the blocked-egress
 * list and the packages actually installed.
 *
 * A run that did not answer (the clone failed, the box never reported) carries
 * status `infra`: INFRA is never the script's verdict. A wall-clock kill is
 * `timeout`, the script's doing, not INFRA.
 */

import type { BlockedEgress } from "./egress.js";
import type { FinishBody, FinishedFile, FinishStatus } from "./wire.js";

/** BOX-CONTRACT: head 64 KiB + tail 64 KiB. */
export const LOG_HEAD_BYTES = 64 * 1024;
export const LOG_TAIL_BYTES = 64 * 1024;

/** Keeps the first HEAD bytes and the last TAIL bytes of a stream, counts all. */
export class LogCapture {
  private head: Buffer[] = [];
  private headLen = 0;
  private tail: Buffer[] = [];
  private tailLen = 0;
  totalBytes = 0;

  constructor(
    private readonly headCap = LOG_HEAD_BYTES,
    private readonly tailCap = LOG_TAIL_BYTES
  ) {}

  append(chunk: Buffer | string): void {
    let buf = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
    this.totalBytes += buf.length;
    if (this.headLen < this.headCap) {
      const take = buf.subarray(0, this.headCap - this.headLen);
      this.head.push(take);
      this.headLen += take.length;
      buf = buf.subarray(take.length);
    }
    if (buf.length === 0) return;
    this.tail.push(buf);
    this.tailLen += buf.length;
    while (this.tail.length > 1 && this.tailLen - this.tail[0].length >= this.tailCap) {
      this.tailLen -= this.tail.shift()!.length;
    }
  }

  snapshot(): RunLog {
    const head = Buffer.concat(this.head).toString("utf8");
    let tailBuf = Buffer.concat(this.tail);
    if (tailBuf.length > this.tailCap) tailBuf = tailBuf.subarray(tailBuf.length - this.tailCap);
    const truncated = this.totalBytes > this.headLen + tailBuf.length;
    return { head, tail: tailBuf.toString("utf8"), totalBytes: this.totalBytes, truncated };
  }
}

export interface RunLog {
  head: string;
  /** Everything after the head when nothing was dropped; otherwise the last bytes. */
  tail: string;
  totalBytes: number;
  /** Bytes were dropped between head and tail. */
  truncated: boolean;
}

export interface InstalledPackage {
  name: string;
  version: string;
  manager: "pip" | "npm";
}

export interface RunOutcome {
  /** The exit code the box runner reported, or null when it reported none. */
  exitCode: number | null;
  timedOut: boolean;
  /** A person pressed Stop. */
  stopped: boolean;
  /** Set when the run did not answer for an infrastructure reason. */
  infraReason?: string;
}

/**
 * One status from what happened. Order matters: a person's Stop beats the
 * wall clock, the wall clock beats an exit code that came too late, and INFRA
 * is reported only when the script gave no verdict.
 */
export function deriveStatus(o: RunOutcome): { status: FinishStatus; infraReason?: string } {
  if (o.stopped) return { status: "stopped" };
  if (o.timedOut) return { status: "timeout" };
  if (o.infraReason) return { status: "infra", infraReason: o.infraReason };
  if (o.exitCode === null) return { status: "infra", infraReason: "the box ended without reporting an exit code" };
  return { status: o.exitCode === 0 ? "done" : "failed" };
}

/**
 * The pod's finish schema (synap-backend `routers/hub-protocol/rest/box-runs.ts`
 * FinishBody). A body over any of these is refused whole (400), and the run's
 * evidence is lost with it, so the bundle is cut to fit HERE, and every cut is
 * said in the log the person reads.
 */
export const WIRE = {
  maxBlocked: 500,
  maxPackages: 500,
  hostChars: 300,
  reasonChars: 500,
  infraReasonChars: 1000,
  pathChars: 500,
  titleChars: 255,
  packageNameChars: 214,
  packageVersionChars: 64,
} as const;

const cut = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

export function assembleFinish(input: {
  leaseId: string;
  outcome: RunOutcome;
  startedAt: number;
  finishedAt: number;
  log: LogCapture;
  blockedEgress: BlockedEgress[];
  installedPackages: InstalledPackage[];
  files: FinishedFile[];
}): FinishBody {
  const d = deriveStatus(input.outcome);
  const blocked = input.blockedEgress;
  if (blocked.length > WIRE.maxBlocked) {
    input.log.append(`\n[synap box] ${blocked.length - WIRE.maxBlocked} more blocked connections not listed (first ${WIRE.maxBlocked} kept)\n`);
  }
  const packages = input.installedPackages.filter((p) => p.name && p.version);
  if (packages.length > WIRE.maxPackages) {
    input.log.append(`\n[synap box] ${packages.length - WIRE.maxPackages} more installed packages not listed\n`);
  }
  return {
    leaseId: input.leaseId,
    status: d.status,
    exitCode: input.outcome.exitCode,
    durationMs: Math.max(0, Math.round(input.finishedAt - input.startedAt)),
    ...(d.infraReason ? { infraReason: cut(d.infraReason, WIRE.infraReasonChars) } : {}),
    log: input.log.snapshot(),
    files: input.files.map((f) => ({
      ...f,
      path: cut(f.path, WIRE.pathChars),
      ...(f.title !== undefined ? { title: cut(f.title, WIRE.titleChars) } : {}),
    })),
    blockedEgress: blocked.slice(0, WIRE.maxBlocked).map((b) => ({
      ...b,
      host: cut(b.host, WIRE.hostChars),
      reason: cut(b.reason, WIRE.reasonChars),
    })),
    installedPackages: packages.slice(0, WIRE.maxPackages).map((p) => ({
      ...p,
      name: cut(p.name, WIRE.packageNameChars),
      version: cut(p.version, WIRE.packageVersionChars),
    })),
  };
}
