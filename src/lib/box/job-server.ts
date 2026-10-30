/**
 * What the box talks to: a small HTTP server on the provisioner's bridge
 * address. The box holds no token: its identity IS its address on the isolated
 * bridge (the provisioner assigned it), so a request is answered only for the
 * run that address was given to.
 *
 *   GET  /job          the script, its packages, parameters and wall clock
 *   POST /phase        {"phase":"run"}: packages are in, egress narrows to the
 *                      declared hosts (one way: never back to setup)
 *   POST /log          a chunk of the run's stdout+stderr
 *   PUT  /out/<path>   one /out file, streamed to staging under the caps
 *   POST /done         {"exitCode", "installedPackages"}
 */

import { createHash } from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import type { BlockedEgress, BoxPhase, EgressPolicy } from "./egress.js";
import { LogCapture, type InstalledPackage } from "./evidence.js";
import type { LeasedRun } from "./wire.js";

/** BOX-CONTRACT v1: at most 20 files per run. */
export const MAX_OUT_FILES = 20;
const MAX_BODY_BYTES = 1024 * 1024;

export interface StagedFile {
  path: string;
  size: number;
  sha256: string;
}

export interface BoxReport {
  /** null when the runner sent no integer exit code (the runner's fault, read as INFRA). */
  exitCode: number | null;
  installedPackages: InstalledPackage[];
}

export interface ActiveBox {
  run: LeasedRun;
  phase: BoxPhase;
  log: LogCapture;
  blocked: BlockedEgress[];
  outDir: string;
  outBytes: number;
  outFiles: StagedFile[];
  /** The runner asked for its job (the box booted and reached the provisioner). */
  jobFetched: boolean;
  /** Resolves when the runner reports done. */
  done: Promise<BoxReport>;
}

/**
 * A safe relative path for an /out file, or null. Each segment is decoded
 * once; no empty, `.`, `..`, NUL or separator inside a segment.
 */
export function safeOutPath(urlPath: string): string | null {
  const raw = urlPath.replace(/^\/out\//, "");
  // 500 = the pod's finish `files[].path` limit.
  if (!raw || raw.length > 500) return null;
  const segments: string[] = [];
  for (const enc of raw.split("/")) {
    let seg: string;
    try {
      seg = decodeURIComponent(enc);
    } catch {
      return null;
    }
    if (!seg || seg === "." || seg === ".." || /[\0/\\]/.test(seg) || seg.length > 255) return null;
    segments.push(seg);
  }
  return segments.length <= 16 ? segments.join("/") : null;
}

/** The job document the box runner reads. */
export function jobFor(run: LeasedRun): Record<string, unknown> {
  const s = run.script;
  return {
    runId: run.id,
    language: s.language,
    entrypoint: s.entrypoint,
    code: s.code,
    packages: s.packages,
    parameters: run.parameters ?? null,
    wallSeconds: s.limits.wallSeconds,
  };
}

type Entry = ActiveBox & { finish: (r: BoxReport) => void };

/** `job`: the box booted and asked for its job; `run`: its packages are in, the script starts. */
export type BoxEvent = "job" | "run";

export class BoxRegistry {
  private boxes = new Map<string, Entry>();

  /** Called once per box and event (the provisioner sets it per run: its clocks hang on it). */
  onEvent: (run: LeasedRun, event: BoxEvent) => void = () => {};

  constructor(private readonly stagingRoot: string) {}

  register(ip: string, run: LeasedRun): ActiveBox {
    let finish!: (r: BoxReport) => void;
    const done = new Promise<BoxReport>((r) => (finish = r));
    const outDir = path.join(this.stagingRoot, run.id);
    fs.rmSync(outDir, { recursive: true, force: true });
    fs.mkdirSync(outDir, { recursive: true, mode: 0o700 });
    const box: Entry = {
      run,
      phase: "setup",
      log: new LogCapture(),
      blocked: [],
      outDir,
      outBytes: 0,
      outFiles: [],
      jobFetched: false,
      done,
      finish,
    };
    this.boxes.set(ip, box);
    return box;
  }

  /** Forget the box and drop its staged files. */
  unregister(ip: string): void {
    const box = this.boxes.get(ip);
    this.boxes.delete(ip);
    if (box) fs.rmSync(box.outDir, { recursive: true, force: true });
  }

  get(ip: string): Entry | undefined {
    return this.boxes.get(ip);
  }

  policyFor(ip: string): EgressPolicy | null {
    const b = this.boxes.get(ip);
    return b ? { phase: b.phase, runHosts: b.run.script.hosts } : null;
  }

  recordBlock(ip: string, block: BlockedEgress): void {
    this.boxes.get(ip)?.blocked.push(block);
  }

  markJobFetched(ip: string): void {
    const b = this.boxes.get(ip);
    if (!b || b.jobFetched) return;
    b.jobFetched = true;
    this.onEvent(b.run, "job");
  }

  enterRunPhase(ip: string): void {
    const b = this.boxes.get(ip);
    if (!b || b.phase === "run") return;
    b.phase = "run";
    this.onEvent(b.run, "run");
  }
}

function readBody(req: http.IncomingMessage, cap = MAX_BODY_BYTES): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let n = 0;
    req.on("data", (c: Buffer) => {
      n += c.length;
      if (n > cap) {
        reject(new Error("body too large"));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

function json(res: http.ServerResponse, status: number, body?: unknown): void {
  if (status === 204) {
    res.writeHead(204).end();
    return;
  }
  res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(body));
}

export function parseReport(raw: unknown): BoxReport {
  const body = (raw && typeof raw === "object" ? raw : {}) as { exitCode?: unknown; installedPackages?: unknown };
  const exitCode = typeof body.exitCode === "number" && Number.isInteger(body.exitCode) ? body.exitCode : null;
  const installedPackages = Array.isArray(body.installedPackages)
    ? (body.installedPackages as Array<Partial<InstalledPackage>>)
        .filter((p) => p && typeof p.name === "string" && typeof p.version === "string" && p.name && p.version)
        .slice(0, 2000)
        .map((p) => ({
          name: p.name!,
          version: p.version!,
          manager: p.manager === "npm" ? ("npm" as const) : ("pip" as const),
        }))
    : [];
  return { exitCode, installedPackages };
}

export function createJobServer(registry: BoxRegistry): http.Server {
  return http.createServer(async (req, res) => {
    const ip = (req.socket.remoteAddress ?? "").replace(/^::ffff:/, "");
    const box = registry.get(ip);
    if (!box) return json(res, 403, { error: "not a running box" });
    const url = new URL(req.url ?? "/", "http://box");
    try {
      if (req.method === "GET" && url.pathname === "/job") {
        registry.markJobFetched(ip);
        return json(res, 200, jobFor(box.run));
      }

      if (req.method === "POST" && url.pathname === "/phase") {
        const body = JSON.parse((await readBody(req)).toString("utf8") || "{}") as { phase?: string };
        if (body.phase !== "run") return json(res, 400, { error: "the only move is to the run phase" });
        registry.enterRunPhase(ip);
        return json(res, 200, { phase: "run" });
      }

      if (req.method === "POST" && url.pathname === "/log") {
        req.on("data", (c: Buffer) => box.log.append(c));
        req.on("end", () => json(res, 204));
        return;
      }

      if (req.method === "PUT" && url.pathname.startsWith("/out/")) {
        const rel = safeOutPath(url.pathname);
        if (!rel) return json(res, 400, { error: "bad out path" });
        if (box.outFiles.length >= MAX_OUT_FILES) return json(res, 413, { error: `more than ${MAX_OUT_FILES} files` });
        const cap = box.run.script.limits.outMb * 1024 * 1024;
        const dest = path.join(box.outDir, rel);
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        const hash = createHash("sha256");
        const file = fs.createWriteStream(dest, { mode: 0o600 });
        let size = 0;
        let over = false;
        // Over the cap or cut off mid-upload: no partial file is kept, and the
        // answer goes out only once it is gone.
        const abort = (status: number, error: string) => {
          if (over) return;
          over = true;
          file.destroy();
          file.once("close", () => {
            fs.rmSync(dest, { force: true });
            if (!res.headersSent) json(res, status, { error });
            req.destroy();
          });
        };
        // A write that fails (disk full), or a pending write cut short by the
        // destroy above: one answer either way, never an unhandled 'error'
        // (which would crash the provisioner and leave the box unanswered).
        file.on("error", () => abort(500, "could not stage the file"));
        req.on("data", (c: Buffer) => {
          if (over) return;
          size += c.length;
          if (box.outBytes + size > cap) return abort(413, `/out exceeds ${box.run.script.limits.outMb} MB`);
          hash.update(c);
          file.write(c);
        });
        req.on("end", () => {
          if (over) return;
          file.end(() => {
            box.outBytes += size;
            box.outFiles.push({ path: rel, size, sha256: hash.digest("hex") });
            json(res, 201, { path: rel, size });
          });
        });
        req.on("close", () => {
          if (!req.complete) abort(400, "upload cut off");
        });
        return;
      }

      if (req.method === "POST" && url.pathname === "/done") {
        box.finish(parseReport(JSON.parse((await readBody(req)).toString("utf8"))));
        return json(res, 200, { ok: true });
      }

      return json(res, 404, { error: "no such door" });
    } catch (err) {
      if (!res.headersSent) json(res, 400, { error: (err as Error).message });
    }
  });
}
