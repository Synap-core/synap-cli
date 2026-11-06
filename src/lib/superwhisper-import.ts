/**
 * Superwhisper store-first import — pair meta.json + output.wav into pod-wide
 * notes with optional audio provenance. No AI structure on the WAV (IS STT is
 * a stub); transcript comes from Superwhisper's meta.
 *
 * ── How the units reach the pod (finding 51e086d8) ──────────────────────────
 * The bulk door (pods with `POST /import/enqueue-units`):
 *   1. the WAVs: `POST /import/unit-uploads` mints up to 100 presigned PUT URLs
 *      per call, and each file is PUT straight to storage (not a hub request);
 *   2. ONE `POST /import/enqueue-units` carries the manifest (key, title,
 *      transcript, properties, upload token) and returns a job id;
 *   3. `GET /import/units-job/<id>` is polled until the job is done; its output
 *      says, per recording, stored {entityId} | proposed {proposalId} | failed.
 * So 712 recordings cost ⌈712/100⌉ + 1 hub requests plus the polls, instead of
 * 712+ paced multipart requests. A pod without the bulk door (404/405), or
 * whose storage cannot presign (501), gets the per-unit door
 * (`POST /import/store-unit`) as before.
 *
 * Idempotency: local ledger (~/.synap/import-ledger/superwhisper.json) maps
 * recordingId → its outcome, so a re-run skips what is done. A unit the pod's
 * governance PARKED is recorded `proposed` with its proposal id: it is waiting
 * for review, not failed, and a re-run must not file it again. A job still
 * running when the terminal closed stays in the ledger (`pendingJobs`): the
 * next run (or `synap import --job-status <id> --source superwhisper`) reads it
 * before submitting anything. Every unit also carries the key
 * `superwhisper:<recordingId>`, the pod's create idempotency key, so a unit
 * sent twice lands on ONE entity.
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  readdirSync,
  statSync,
  type Dirent,
} from "node:fs";
import { join, basename } from "node:path";
import { homedir } from "node:os";
import chalk from "chalk";
import { log } from "../utils/logger.js";
import {
  resolveHubConfig,
  resolveUserId,
  hubGet,
  hubPost,
  hubPostMultipartRetryable,
  renderHubError,
  HubError,
  type HubConfig,
} from "./hub-client.js";

export interface SuperwhisperImportOpts {
  dryRun?: boolean;
  yes?: boolean;
  json?: boolean;
  withAudio?: boolean;
  /** Max units to process (for probes). */
  limit?: number;
  /** Max concurrent unit uploads (default 2). */
  concurrency?: number;
  /** Skip units already in the local ledger. Default true. */
  resume?: boolean;
  podUrl?: string;
  apiKey?: string;
  /** Gap between job polls (tests set 0). Default 10 s. */
  pollIntervalMs?: number;
}

export interface SuperwhisperUnit {
  recordingId: string;
  dir: string;
  metaPath: string;
  wavPath: string | null;
  wavSize: number;
  datetime?: string;
  language?: string;
  duration?: number;
  modeName?: string;
  transcript: string;
  title: string;
}

/**
 * One recording's outcome. `status` absent = a ledger written before
 * proposals were recorded: those entries were all stored.
 */
export interface LedgerEntry {
  recordingId: string;
  status?: "stored" | "proposed";
  /** Set when stored. */
  entityId?: string;
  /** Set when the pod's governance parked the create for review. */
  proposalId?: string;
  storedAt: string;
  hasAudio?: boolean;
  audioSkippedReason?: string;
}

/** A bulk job submitted and not yet read back. */
export interface PendingJob {
  jobId: string;
  /** recordingIds the job carries. */
  recordingIds: string[];
  /** Skip reasons known before upload (no WAV, over the cap), by recordingId. */
  audioSkipped?: Record<string, string>;
  submittedAt: string;
}

export interface LedgerFile {
  version: 1;
  entries: Record<string, LedgerEntry>;
  pendingJobs?: PendingJob[];
}

/** `SYNAP_IMPORT_LEDGER_DIR` moves the ledger (tests use a temp dir). */
function ledgerPath(): string {
  const dir =
    process.env.SYNAP_IMPORT_LEDGER_DIR || join(homedir(), ".synap", "import-ledger");
  return join(dir, "superwhisper.json");
}
/** The per-unit door's cap (backend SOURCE_BLOB_MAX_BYTES). */
const AUDIO_MAX_BYTES = 32 * 1024 * 1024;
/** The bulk door's cap for audio (presigned, backend maxUploadBytesForMimeType). */
const BULK_AUDIO_MAX_BYTES = 100 * 1024 * 1024;
/** Files per `POST /import/unit-uploads` (backend IMPORT_UNIT_UPLOADS_MAX). */
const UPLOAD_BATCH = 100;
/** Units per `POST /import/enqueue-units` (backend max 2000; under the 10 MB body cap). */
const MANIFEST_MAX_UNITS = 1000;
const MANIFEST_MAX_BYTES = 8 * 1024 * 1024;
/** PUTs to storage in flight at once (storage, not hub requests). */
const PUT_CONCURRENCY = 4;
/** Stop waiting after this long; the job keeps running and stays in the ledger. */
const JOB_WAIT_MAX_MS = 60 * 60 * 1000;

function loadLedger(): LedgerFile {
  try {
    const path = ledgerPath();
    if (!existsSync(path)) return { version: 1, entries: {} };
    const raw = JSON.parse(readFileSync(path, "utf8")) as LedgerFile;
    if (!raw || raw.version !== 1 || typeof raw.entries !== "object") {
      return { version: 1, entries: {} };
    }
    return raw;
  } catch {
    return { version: 1, entries: {} };
  }
}

function saveLedger(ledger: LedgerFile): void {
  const path = ledgerPath();
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, JSON.stringify(ledger, null, 2), "utf8");
}

function transcriptFromMeta(meta: Record<string, unknown>): string {
  const result = typeof meta.result === "string" ? meta.result.trim() : "";
  if (result) return result;
  const segs = Array.isArray(meta.segments) ? meta.segments : [];
  return segs
    .map((s) =>
      s && typeof s === "object" && typeof (s as { text?: string }).text === "string"
        ? (s as { text: string }).text
        : ""
    )
    .filter(Boolean)
    .join(" ")
    .trim();
}

/**
 * A voice note's title: its first spoken sentence when that is a complete,
 * short phrase; otherwise "Voice note — <when>". Never the transcript cut at
 * 80 characters + "…" — that left 158 voice notes on the founder's pod titled
 * by the first words of a sentence (title audit 2026-10-12). Naming a long
 * note by its content is the titler's job, not a slice's.
 */
export function titleFromTranscript(
  transcript: string,
  datetime?: string,
  id?: string
): string {
  const line = transcript.replace(/\s+/g, " ").trim();
  const sentence = line.match(/^(.+?[.!?])(?:\s|$)/)?.[1] ?? line;
  if (sentence.length >= 8 && sentence.length <= 80) return sentence;
  if (datetime) return `Voice note — ${datetime}`;
  return `Voice note ${id ?? "recording"}`;
}

/** Expand a Superwhisper recordings root (or a single clip dir) into units. */
export function collectSuperwhisperUnits(root: string): SuperwhisperUnit[] {
  if (!existsSync(root)) {
    throw new Error(`Path not found: ${root}`);
  }
  const st = statSync(root);
  const dirs: string[] = [];
  if (st.isDirectory()) {
    // Single clip dir: has meta.json at root
    if (existsSync(join(root, "meta.json"))) {
      dirs.push(root);
    } else {
      let entries: Dirent[] = [];
      try {
        entries = readdirSync(root, { withFileTypes: true }) as Dirent[];
      } catch (e) {
        throw new Error(`Cannot read directory: ${(e as Error).message}`);
      }
      for (const e of entries) {
        if (!e.isDirectory() || e.name.startsWith(".")) continue;
        const full = join(root, e.name);
        if (existsSync(join(full, "meta.json"))) dirs.push(full);
      }
    }
  } else {
    throw new Error(`Expected a Superwhisper recordings folder, got a file: ${root}`);
  }

  const units: SuperwhisperUnit[] = [];
  for (const dir of dirs) {
    const recordingId = basename(dir);
    const metaPath = join(dir, "meta.json");
    let meta: Record<string, unknown> = {};
    try {
      meta = JSON.parse(readFileSync(metaPath, "utf8")) as Record<string, unknown>;
    } catch {
      continue;
    }
    const transcript = transcriptFromMeta(meta);
    const wavPath = existsSync(join(dir, "output.wav"))
      ? join(dir, "output.wav")
      : null;
    const wavSize = wavPath ? statSync(wavPath).size : 0;
    const datetime =
      typeof meta.datetime === "string" ? meta.datetime : undefined;
    units.push({
      recordingId,
      dir,
      metaPath,
      wavPath,
      wavSize,
      datetime,
      language:
        typeof meta.languageSelected === "string"
          ? meta.languageSelected
          : undefined,
      duration: typeof meta.duration === "number" ? meta.duration : undefined,
      modeName: typeof meta.modeName === "string" ? meta.modeName : undefined,
      transcript,
      title: titleFromTranscript(transcript, datetime, recordingId),
    });
  }
  // Stable order by recording id (unix-ish)
  units.sort((a, b) => a.recordingId.localeCompare(b.recordingId));
  return units;
}

function unitProperties(unit: SuperwhisperUnit): Record<string, unknown> {
  return {
    source: "superwhisper",
    recordingId: unit.recordingId,
    datetime: unit.datetime,
    language: unit.language,
    duration: unit.duration,
    modeName: unit.modeName,
    localPath: unit.dir,
    hasTranscript: Boolean(unit.transcript),
  };
}

/** The pod's create idempotency key for a recording (both doors send it). */
export function unitKey(recordingId: string): string {
  return `superwhisper:${recordingId}`;
}

function recordingIdOfKey(key: string): string {
  return key.startsWith("superwhisper:") ? key.slice("superwhisper:".length) : key;
}

/** Running totals of one run. `proposed` is NOT `failed`: it waits for review. */
interface Tally {
  stored: number;
  proposed: number;
  failed: number;
  audioOk: number;
  audioSkipped: number;
  errors: Array<{ id: string; error: string }>;
}

function newTally(): Tally {
  return { stored: 0, proposed: 0, failed: 0, audioOk: 0, audioSkipped: 0, errors: [] };
}

/** Record one unit's outcome in the ledger (saved at once) and the tally. */
function recordOutcome(ledger: LedgerFile, tally: Tally, entry: LedgerEntry): void {
  ledger.entries[entry.recordingId] = entry;
  saveLedger(ledger);
  if (entry.status === "proposed") tally.proposed++;
  else tally.stored++;
  if (entry.hasAudio) tally.audioOk++;
  if (entry.audioSkippedReason) tally.audioSkipped++;
}

function recordFailure(tally: Tally, id: string, error: string, json?: boolean): void {
  tally.failed++;
  tally.errors.push({ id, error });
  if (!json) log.error(`${id}: ${error}`);
}

/** A pod's answer that the governed create was parked for review. */
function proposedEntry(
  unit: SuperwhisperUnit,
  res: Record<string, unknown>,
  audioSkippedReason?: string
): LedgerEntry | null {
  if (res.status !== "proposed") return null;
  return {
    recordingId: unit.recordingId,
    status: "proposed",
    ...(typeof res.proposalId === "string" ? { proposalId: res.proposalId } : {}),
    storedAt: new Date().toISOString(),
    hasAudio: false,
    audioSkippedReason:
      audioSkippedReason ??
      (typeof res.audioSkippedReason === "string" ? res.audioSkippedReason : undefined),
  };
}

// ─── per-unit door (pods without the bulk door) ──────────────────────────────

function buildStoreUnitForm(
  unit: SuperwhisperUnit,
  withAudio: boolean
): { form: FormData; audioSkippedReason?: string } {
  const form = new FormData();
  form.append("title", unit.title);
  form.append("profileSlug", "note");
  form.append("source", "cli");
  form.append("idempotencyKey", unitKey(unit.recordingId));
  if (unit.transcript) form.append("content", unit.transcript);
  else form.append("description", "Empty Superwhisper transcript");
  form.append("properties", JSON.stringify(unitProperties(unit)));

  let audioSkippedReason: string | undefined;
  if (withAudio && unit.wavPath) {
    if (unit.wavSize > AUDIO_MAX_BYTES) {
      audioSkippedReason = `over_limit_${AUDIO_MAX_BYTES}`;
    } else if (unit.wavSize === 0) {
      audioSkippedReason = "empty_wav";
    } else {
      const buf = readFileSync(unit.wavPath);
      form.append("file", new File([buf], "output.wav", { type: "audio/wav" }));
    }
  } else if (withAudio && !unit.wavPath) {
    audioSkippedReason = "no_wav";
  }
  return { form, audioSkippedReason };
}

/** Prefer 1-request store-unit; fall back to create + source-file if 404. */
let storeUnitMode: "combined" | "two-step" | "unknown" = "unknown";

function isDoorMissing(e: unknown): boolean {
  return e instanceof HubError && (e.status === 404 || e.status === 405);
}

/**
 * Store one unit through the per-unit door. Returns its ledger entry, stored
 * OR proposed (a create the pod's governance parked is waiting for review, not
 * failed). Throws only for a real failure.
 */
async function storeUnit(
  unit: SuperwhisperUnit,
  cfg: HubConfig,
  userId: string,
  withAudio: boolean
): Promise<LedgerEntry> {
  // Combined door: 1 auth hit per unit (entity + optional WAV).
  if (storeUnitMode !== "two-step") {
    try {
      // Rebuild form on each 429 retry (body is one-shot).
      const skipReason = buildStoreUnitForm(unit, withAudio).audioSkippedReason;
      const res = (await hubPostMultipartRetryable(
        "/import/store-unit",
        () => buildStoreUnitForm(unit, withAudio).form,
        cfg,
        180_000
      )) as Record<string, unknown>;
      storeUnitMode = "combined";
      const parked = proposedEntry(unit, res, skipReason);
      if (parked) return parked;
      const entityId = String(res.id ?? res.entityId ?? "");
      if (!entityId) {
        throw new Error(`store-unit returned no id: ${JSON.stringify(res).slice(0, 200)}`);
      }
      return {
        recordingId: unit.recordingId,
        status: "stored",
        entityId,
        storedAt: new Date().toISOString(),
        hasAudio: Boolean(res.audio),
        audioSkippedReason:
          skipReason ??
          (typeof res.audioSkippedReason === "string" ? res.audioSkippedReason : undefined),
      };
    } catch (e) {
      // Only fall back when the combined door is missing (not yet deployed).
      if (!isDoorMissing(e)) throw e;
      storeUnitMode = "two-step";
      console.error(
        "[hub] /import/store-unit not available — falling back to 2-step (deploy backend for 1-req/unit)"
      );
    }
  }

  // Two-step fallback (pre-deploy pods): POST /entities + POST …/source-file.
  const createRes = (await hubPost(
    "/entities",
    {
      userId,
      profileSlug: "note",
      title: unit.title,
      content: unit.transcript || undefined,
      description: unit.transcript ? undefined : "Empty Superwhisper transcript",
      properties: unitProperties(unit),
      source: "cli",
      idempotencyKey: unitKey(unit.recordingId),
    },
    cfg,
    60_000
  )) as Record<string, unknown>;

  const parked = proposedEntry(unit, createRes, withAudio && unit.wavPath ? "entity_proposed" : undefined);
  if (parked) return parked;
  const entityId = String(
    createRes.id ?? (createRes.entity as { id?: string } | undefined)?.id ?? ""
  );
  if (!entityId) {
    throw new Error(`Create entity returned no id: ${JSON.stringify(createRes).slice(0, 200)}`);
  }

  let hasAudio = false;
  let audioSkippedReason: string | undefined;

  if (withAudio && unit.wavPath) {
    if (unit.wavSize > AUDIO_MAX_BYTES) {
      audioSkippedReason = `over_limit_${AUDIO_MAX_BYTES}`;
    } else if (unit.wavSize === 0) {
      audioSkippedReason = "empty_wav";
    } else {
      const buf = readFileSync(unit.wavPath);
      await hubPostMultipartRetryable(
        `/entities/${entityId}/source-file`,
        () => {
          const form = new FormData();
          form.append("file", new File([buf], "output.wav", { type: "audio/wav" }));
          return form;
        },
        cfg,
        180_000
      );
      hasAudio = true;
    }
  } else if (withAudio && !unit.wavPath) {
    audioSkippedReason = "no_wav";
  }

  return {
    recordingId: unit.recordingId,
    status: "stored",
    entityId,
    storedAt: new Date().toISOString(),
    hasAudio,
    audioSkippedReason,
  };
}

async function storeUnitsOneByOne(
  units: SuperwhisperUnit[],
  ctx: RunContext
): Promise<void> {
  const { cfg, userId, withAudio, ledger, tally, opts } = ctx;
  // Default concurrency 1 — each unit is a Hub request; concurrent workers
  // burn the per-key rate window and cascade 429s.
  const concurrency = Math.max(1, Math.min(opts.concurrency ?? 1, 4));
  let idx = 0;
  async function worker(): Promise<void> {
    while (idx < units.length) {
      const unit = units[idx++]!;
      try {
        recordOutcome(ledger, tally, await storeUnit(unit, cfg, userId, withAudio));
      } catch (e) {
        recordFailure(tally, unit.recordingId, (e as Error).message, opts.json);
      }
      if (!opts.json) {
        process.stdout.write(
          chalk.dim(
            `\r  ${tally.stored + tally.proposed + tally.failed}/${units.length} stored=${tally.stored} proposed=${tally.proposed} failed=${tally.failed} audio=${tally.audioOk}`
          )
        );
      }
    }
  }
  await Promise.all(Array.from({ length: concurrency }, () => worker()));
  if (!opts.json) process.stdout.write("\n");
}

// ─── bulk door: batch-minted uploads + one queued job ────────────────────────

/** The pod has no bulk door, or its storage cannot presign: use the per-unit door. */
class BulkDoorUnavailable extends Error {}
/** This manifest was not queued; its units are already counted failed. */
class ManifestRefused extends Error {}

interface UploadTicket {
  uploadUrl: string;
  method: "PUT";
  headers: Record<string, string>;
  uploadToken: string;
}

interface UnitsJobStatus {
  jobId: string;
  state: string;
  output: {
    total: number;
    stored: number;
    proposed: number;
    failed: number;
    results: Record<
      string,
      | { status: "stored"; entityId: string; audio: boolean; audioSkippedReason: string | null }
      | { status: "proposed"; proposalId: string | null; audioSkippedReason: string | null }
      | { status: "failed"; error: string }
    >;
  } | null;
}

/** pg-boss states a job never leaves. */
const JOB_DEAD_STATES = new Set(["failed", "cancelled", "expired"]);

interface RunContext {
  cfg: HubConfig;
  userId: string;
  withAudio: boolean;
  ledger: LedgerFile;
  tally: Tally;
  opts: SuperwhisperImportOpts;
}

function bulkSkipReason(unit: SuperwhisperUnit, withAudio: boolean): string | undefined {
  if (!withAudio) return undefined;
  if (!unit.wavPath) return "no_wav";
  if (unit.wavSize === 0) return "empty_wav";
  if (unit.wavSize > BULK_AUDIO_MAX_BYTES) return `over_limit_${BULK_AUDIO_MAX_BYTES}`;
  return undefined;
}

async function mintUploads(
  units: SuperwhisperUnit[],
  cfg: HubConfig
): Promise<UploadTicket[]> {
  try {
    const res = (await hubPost(
      "/import/unit-uploads",
      {
        files: units.map((u) => ({
          filename: "output.wav",
          mimeType: "audio/wav",
          size: u.wavSize,
        })),
      },
      cfg,
      60_000
    )) as { uploads?: UploadTicket[] };
    if (!Array.isArray(res.uploads) || res.uploads.length !== units.length) {
      throw new Error(`unit-uploads returned ${res.uploads?.length ?? 0} tickets for ${units.length} files`);
    }
    return res.uploads;
  } catch (e) {
    if (isDoorMissing(e) || (e instanceof HubError && e.status === 501)) {
      throw new BulkDoorUnavailable((e as Error).message);
    }
    throw e;
  }
}

/** PUT one file to storage (a storage request, not a hub request). */
async function putFile(ticket: UploadTicket, path: string): Promise<void> {
  const body = readFileSync(path);
  const res = await fetch(ticket.uploadUrl, {
    method: "PUT",
    headers: ticket.headers,
    body,
    signal: AbortSignal.timeout(300_000),
  });
  if (!res.ok) {
    // empty-ok: the upload already failed and is thrown below with its HTTP status; an unreadable body only drops the extra detail
    const text = await res.text().catch(() => "");
    throw new Error(`upload failed (HTTP ${res.status}) ${text.slice(0, 200)}`);
  }
}

/** Split units into manifests under the unit and byte caps of one enqueue. */
function manifestChunks(units: SuperwhisperUnit[]): SuperwhisperUnit[][] {
  const chunks: SuperwhisperUnit[][] = [];
  let cur: SuperwhisperUnit[] = [];
  let bytes = 0;
  for (const u of units) {
    const size = u.transcript.length + u.title.length + 1024;
    if (cur.length && (cur.length >= MANIFEST_MAX_UNITS || bytes + size > MANIFEST_MAX_BYTES)) {
      chunks.push(cur);
      cur = [];
      bytes = 0;
    }
    cur.push(u);
    bytes += size;
  }
  if (cur.length) chunks.push(cur);
  return chunks;
}

/**
 * Upload one manifest's WAVs and enqueue it. Returns the job, already saved in
 * the ledger's `pendingJobs` (a closed terminal does not lose it). A unit whose
 * PUT failed is not sent (counted failed; a re-run retries it).
 */
async function submitManifest(
  units: SuperwhisperUnit[],
  ctx: RunContext
): Promise<PendingJob> {
  const { cfg, withAudio, ledger, tally, opts } = ctx;
  const audioSkipped: Record<string, string> = {};
  const tokens = new Map<string, string>();
  const failedUpload = new Set<string>();

  const withWav = units.filter((u) => {
    const skip = bulkSkipReason(u, withAudio);
    if (skip) audioSkipped[u.recordingId] = skip;
    return withAudio && !skip;
  });
  for (let i = 0; i < withWav.length; i += UPLOAD_BATCH) {
    const batch = withWav.slice(i, i + UPLOAD_BATCH);
    let tickets: UploadTicket[];
    try {
      tickets = await mintUploads(batch, cfg);
    } catch (e) {
      if (e instanceof BulkDoorUnavailable) throw e;
      // The pod refused this batch (a file over its cap, a bad type): its
      // recordings are not sent this run, and a re-run retries them.
      for (const unit of batch) {
        failedUpload.add(unit.recordingId);
        recordFailure(tally, unit.recordingId, (e as Error).message, opts.json);
      }
      continue;
    }
    let next = 0;
    await Promise.all(
      Array.from({ length: Math.min(PUT_CONCURRENCY, batch.length) }, async () => {
        while (next < batch.length) {
          const j = next++;
          const unit = batch[j]!;
          try {
            await putFile(tickets[j]!, unit.wavPath!);
            tokens.set(unit.recordingId, tickets[j]!.uploadToken);
          } catch (e) {
            failedUpload.add(unit.recordingId);
            recordFailure(tally, unit.recordingId, (e as Error).message, opts.json);
          }
        }
      })
    );
    if (!opts.json) {
      log.dim(`uploaded ${Math.min(i + UPLOAD_BATCH, withWav.length)}/${withWav.length} recordings`);
    }
  }

  const sent = units.filter((u) => !failedUpload.has(u.recordingId));
  if (sent.length === 0) {
    // Every recording of this manifest is already counted failed.
    throw new ManifestRefused("no unit left to enqueue (every upload failed)");
  }
  let res: { jobId?: string | null };
  try {
    res = (await hubPost(
      "/import/enqueue-units",
      {
        source: "cli",
        units: sent.map((u) => ({
          key: unitKey(u.recordingId),
          title: u.title,
          profileSlug: "note",
          ...(u.transcript
            ? { content: u.transcript }
            : { description: "Empty Superwhisper transcript" }),
          properties: unitProperties(u),
          ...(tokens.has(u.recordingId) ? { uploadToken: tokens.get(u.recordingId) } : {}),
        })),
      },
      cfg,
      120_000
    )) as { jobId?: string | null };
  } catch (e) {
    if (isDoorMissing(e)) throw new BulkDoorUnavailable((e as Error).message);
    for (const u of sent) recordFailure(tally, u.recordingId, (e as Error).message, opts.json);
    throw new ManifestRefused((e as Error).message);
  }
  if (!res.jobId) {
    for (const u of sent) recordFailure(tally, u.recordingId, "enqueue-units returned no job id", opts.json);
    throw new ManifestRefused("enqueue-units returned no job id");
  }

  const job: PendingJob = {
    jobId: res.jobId,
    recordingIds: sent.map((u) => u.recordingId),
    audioSkipped,
    submittedAt: new Date().toISOString(),
  };
  ledger.pendingJobs = [...(ledger.pendingJobs ?? []), job];
  saveLedger(ledger);
  if (!opts.json) {
    log.info(`Queued ${sent.length} recording(s) as job ${job.jobId}`);
    log.dim(`If this terminal closes, read it back with:  synap import --job-status ${job.jobId} --source superwhisper`);
  }
  return job;
}

/** Fold a finished job's output into the ledger, then drop it from pendingJobs. */
function applyJobOutput(
  job: PendingJob,
  output: NonNullable<UnitsJobStatus["output"]>,
  ctx: Pick<RunContext, "ledger" | "tally" | "opts">
): void {
  const { ledger, tally, opts } = ctx;
  const ids = new Set([
    ...job.recordingIds,
    ...Object.keys(output.results ?? {}).map(recordingIdOfKey),
  ]);
  for (const id of ids) {
    const r = output.results?.[unitKey(id)];
    const preSkip = job.audioSkipped?.[id];
    if (!r) {
      recordFailure(tally, id, `not in the output of job ${job.jobId}`, opts.json);
    } else if (r.status === "stored") {
      recordOutcome(ledger, tally, {
        recordingId: id,
        status: "stored",
        entityId: r.entityId,
        storedAt: new Date().toISOString(),
        hasAudio: r.audio,
        audioSkippedReason: preSkip ?? r.audioSkippedReason ?? undefined,
      });
    } else if (r.status === "proposed") {
      recordOutcome(ledger, tally, {
        recordingId: id,
        status: "proposed",
        ...(r.proposalId ? { proposalId: r.proposalId } : {}),
        storedAt: new Date().toISOString(),
        hasAudio: false,
        audioSkippedReason: preSkip ?? r.audioSkippedReason ?? undefined,
      });
    } else {
      recordFailure(tally, id, r.error, opts.json);
    }
  }
  ledger.pendingJobs = (ledger.pendingJobs ?? []).filter((j) => j.jobId !== job.jobId);
  saveLedger(ledger);
}

async function readJob(jobId: string, cfg: HubConfig): Promise<UnitsJobStatus> {
  return (await hubGet(`/import/units-job/${jobId}`, {}, cfg)) as UnitsJobStatus;
}

/**
 * Poll a job until it ends. `done`: its outcome is in the ledger. `dead`: it
 * ended without output; its units are counted failed and left out of the
 * ledger, so a re-run submits them again (the idempotency key keeps that
 * safe). `running`: still going after the wait cap; it stays in the ledger.
 */
async function waitForJob(
  job: PendingJob,
  ctx: RunContext
): Promise<"done" | "dead" | "running"> {
  const { cfg, ledger, tally, opts } = ctx;
  const interval = opts.pollIntervalMs ?? 10_000;
  const startedAt = Date.now();
  for (;;) {
    const status = await readJob(job.jobId, cfg);
    if (status.state === "completed" && status.output) {
      applyJobOutput(job, status.output, ctx);
      return "done";
    }
    if (JOB_DEAD_STATES.has(status.state) || (status.state === "completed" && !status.output)) {
      for (const id of job.recordingIds) {
        recordFailure(tally, id, `job ${job.jobId} ended "${status.state}" without an outcome`, opts.json);
      }
      ledger.pendingJobs = (ledger.pendingJobs ?? []).filter((j) => j.jobId !== job.jobId);
      saveLedger(ledger);
      return "dead";
    }
    if (Date.now() - startedAt > JOB_WAIT_MAX_MS) {
      if (!opts.json) {
        log.warn(`Job ${job.jobId} is still ${status.state}; nothing is lost.`);
        log.hint(`Read it back later:  synap import --job-status ${job.jobId} --source superwhisper`);
      }
      return "running";
    }
    if (interval > 0) await new Promise((r) => setTimeout(r, interval));
  }
}

/**
 * Store units through the bulk door, one manifest at a time. Returns the units
 * never submitted because the pod has no bulk door (for the per-unit door), or
 * an empty list.
 */
async function storeUnitsInBulk(
  units: SuperwhisperUnit[],
  ctx: RunContext
): Promise<{ notSubmitted: SuperwhisperUnit[]; jobs: string[] }> {
  const jobs: string[] = [];
  const chunks = manifestChunks(units);
  for (let c = 0; c < chunks.length; c++) {
    let job: PendingJob;
    try {
      job = await submitManifest(chunks[c]!, ctx);
    } catch (e) {
      if (e instanceof ManifestRefused) continue;
      if (e instanceof BulkDoorUnavailable && jobs.length === 0) {
        if (!ctx.opts.json) {
          console.error(
            "[hub] this pod has no bulk import door — storing one recording per request (update the pod for one queued job)"
          );
        }
        return { notSubmitted: chunks.slice(c).flat(), jobs };
      }
      throw e;
    }
    jobs.push(job.jobId);
    await waitForJob(job, ctx);
  }
  return { notSubmitted: [], jobs };
}

function printSummary(
  tally: Tally,
  extra: { skippedLedger: number; jobs: string[]; json?: boolean }
): void {
  if (extra.json) {
    console.log(
      JSON.stringify(
        {
          stored: tally.stored,
          proposed: tally.proposed,
          failed: tally.failed,
          audioOk: tally.audioOk,
          audioSkipped: tally.audioSkipped,
          skippedLedger: extra.skippedLedger,
          jobs: extra.jobs,
          errors: tally.errors,
        },
        null,
        2
      )
    );
    return;
  }
  log.blank();
  log.heading("Superwhisper import summary");
  const line =
    `${tally.stored} stored · ${tally.proposed} proposed (waiting for review) · ${tally.failed} failed` +
    ` · audio ok ${tally.audioOk} · audio skipped ${tally.audioSkipped} · ledger skips ${extra.skippedLedger}`;
  if (tally.failed > 0) log.warn(line);
  else log.success(line);
  if (tally.proposed > 0) {
    log.dim(`${tally.proposed} recording(s) wait for your review in Synap; a re-run will not file them again.`);
  }
  log.dim(`Ledger: ${ledgerPath()}`);
  for (const e of tally.errors.slice(0, 20)) {
    log.dim(`  ✗ ${e.id}: ${e.error}`);
  }
}

/** Run store-first Superwhisper import for one or more roots. */
export async function importSuperwhisperStoreFirst(
  roots: string[],
  opts: SuperwhisperImportOpts
): Promise<void> {
  const cfg = await resolveHubConfig(opts);
  const userId = await resolveUserId(cfg);
  const withAudio = opts.withAudio !== false; // default true when store-first superwhisper
  const resume = opts.resume !== false;

  let units: SuperwhisperUnit[] = [];
  for (const root of roots) {
    units = units.concat(collectSuperwhisperUnits(root));
  }
  // Dedupe by recordingId
  const byId = new Map<string, SuperwhisperUnit>();
  for (const u of units) byId.set(u.recordingId, u);
  units = [...byId.values()].sort((a, b) => a.recordingId.localeCompare(b.recordingId));

  if (typeof opts.limit === "number" && opts.limit > 0) {
    units = units.slice(0, opts.limit);
  }

  const ledger = loadLedger();
  const tally = newTally();
  const ctx: RunContext = { cfg, userId, withAudio, ledger, tally, opts };
  const jobs: string[] = [];

  // A job an earlier run submitted and never read back: read it first, so its
  // recordings are never submitted twice.
  const inFlight = new Set<string>();
  if (resume && !opts.dryRun) {
    for (const job of [...(ledger.pendingJobs ?? [])]) {
      if (!opts.json) log.info(`Reading back job ${job.jobId} from an earlier run…`);
      jobs.push(job.jobId);
      if ((await waitForJob(job, ctx)) === "running") {
        for (const id of job.recordingIds) inFlight.add(id);
      }
    }
  }

  const pending = resume
    ? units.filter((u) => !ledger.entries[u.recordingId] && !inFlight.has(u.recordingId))
    : units;
  const skippedLedger = units.length - pending.length;

  if (!opts.json) {
    log.info(
      `Superwhisper store-first: ${units.length} unit(s)` +
        (skippedLedger ? ` · ${skippedLedger} already in ledger` : "") +
        ` · ${pending.length} to process` +
        (withAudio ? " · with audio" : " · transcript only") +
        (opts.dryRun ? " · dry-run" : "")
    );
  }

  if (opts.dryRun) {
    const oversize = pending.filter((u) => u.wavSize > BULK_AUDIO_MAX_BYTES).length;
    const emptyTx = pending.filter((u) => !u.transcript).length;
    const totalWav = pending.reduce((n, u) => n + u.wavSize, 0);
    if (opts.json) {
      console.log(
        JSON.stringify(
          {
            mode: "superwhisper-store-first",
            dryRun: true,
            total: units.length,
            pending: pending.length,
            skippedLedger,
            emptyTranscript: emptyTx,
            oversizeAudio: oversize,
            totalWavBytes: totalWav,
            sample: pending.slice(0, 5).map((u) => ({
              recordingId: u.recordingId,
              title: u.title,
              wavSize: u.wavSize,
              transcriptLen: u.transcript.length,
            })),
          },
          null,
          2
        )
      );
    } else {
      log.heading("Dry run");
      log.info(
        `  pending=${pending.length} emptyTranscript=${emptyTx} oversizeAudio=${oversize} wavTotal=${(totalWav / 1e9).toFixed(2)}GB`
      );
      for (const u of pending.slice(0, 8)) {
        log.dim(
          `  ${u.recordingId}  ${(u.wavSize / 1e6).toFixed(2)}MB  tx=${u.transcript.length}  ${u.title.slice(0, 50)}`
        );
      }
      if (pending.length > 8) log.dim(`  … +${pending.length - 8} more`);
    }
    return;
  }

  if (pending.length > 0 && !opts.yes && !opts.json) {
    log.warn("This will create pod-wide notes (and optionally upload WAVs). Pass --yes to confirm.");
    process.exit(1);
  }

  if (pending.length > 0) {
    const bulk = await storeUnitsInBulk(pending, ctx);
    jobs.push(...bulk.jobs);
    if (bulk.notSubmitted.length > 0) {
      await storeUnitsOneByOne(bulk.notSubmitted, ctx);
    }
  }

  printSummary(tally, { skippedLedger, jobs, json: opts.json });
  if (tally.failed > 0) process.exit(1);
}

/**
 * `synap import --job-status <jobId> --source superwhisper`: read a bulk job
 * back once (no waiting) and fold a finished one into the ledger.
 */
export async function importSuperwhisperJobStatus(
  jobId: string,
  opts: Pick<SuperwhisperImportOpts, "json" | "podUrl" | "apiKey">
): Promise<void> {
  try {
    const cfg = await resolveHubConfig(opts);
    const ledger = loadLedger();
    const tally = newTally();
    const status = await readJob(jobId, cfg);
    const known = (ledger.pendingJobs ?? []).find((j) => j.jobId === jobId);
    if (status.state === "completed" && status.output) {
      applyJobOutput(
        known ?? { jobId, recordingIds: [], submittedAt: new Date().toISOString() },
        status.output,
        { ledger, tally, opts }
      );
      printSummary(tally, { skippedLedger: 0, jobs: [jobId], json: opts.json });
      if (tally.failed > 0) process.exit(1);
      return;
    }
    if (opts.json) {
      console.log(JSON.stringify({ jobId, state: status.state }, null, 2));
    } else {
      log.heading(`Superwhisper import job ${jobId}`);
      log.info(`state: ${status.state}`);
      if (JOB_DEAD_STATES.has(status.state)) {
        log.error("The job ended without an outcome. Re-run the import: it submits these recordings again, and the pod keeps one note per recording.");
      } else {
        log.info("Still running — nothing was lost. Re-run this command later.");
      }
    }
    if (known && JOB_DEAD_STATES.has(status.state)) {
      ledger.pendingJobs = (ledger.pendingJobs ?? []).filter((j) => j.jobId !== jobId);
      saveLedger(ledger);
    }
    if (JOB_DEAD_STATES.has(status.state)) process.exit(1);
  } catch (e) {
    renderHubError(e);
    process.exit(1);
  }
}
