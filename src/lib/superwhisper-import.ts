/**
 * Superwhisper store-first import — pair meta.json + output.wav into pod-wide
 * notes with optional audio provenance. No AI structure on the WAV (IS STT is
 * a stub); transcript comes from Superwhisper's meta.
 *
 * Idempotency: local ledger (~/.synap/import-ledger/superwhisper.json) maps
 * recordingId → entityId so resume/re-run skips completed units. Server-side
 * external_links land in Wave 3; ledger is the v1 resume story.
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
  hubPost,
  hubPostMultipartRetryable,
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

interface LedgerEntry {
  entityId: string;
  recordingId: string;
  storedAt: string;
  hasAudio?: boolean;
  audioSkippedReason?: string;
}

interface LedgerFile {
  version: 1;
  entries: Record<string, LedgerEntry>;
}

const LEDGER_DIR = join(homedir(), ".synap", "import-ledger");
const LEDGER_PATH = join(LEDGER_DIR, "superwhisper.json");
/** Matches backend SOURCE_BLOB_MAX_BYTES. */
const AUDIO_MAX_BYTES = 32 * 1024 * 1024;

function loadLedger(): LedgerFile {
  try {
    if (!existsSync(LEDGER_PATH)) return { version: 1, entries: {} };
    const raw = JSON.parse(readFileSync(LEDGER_PATH, "utf8")) as LedgerFile;
    if (!raw || raw.version !== 1 || typeof raw.entries !== "object") {
      return { version: 1, entries: {} };
    }
    return raw;
  } catch {
    return { version: 1, entries: {} };
  }
}

function saveLedger(ledger: LedgerFile): void {
  mkdirSync(LEDGER_DIR, { recursive: true });
  writeFileSync(LEDGER_PATH, JSON.stringify(ledger, null, 2), "utf8");
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

function titleFromTranscript(transcript: string, datetime?: string, id?: string): string {
  const line = transcript.split(/\n/).map((l) => l.trim()).find(Boolean) ?? "";
  if (line.length >= 8) {
    return line.length > 80 ? `${line.slice(0, 79)}…` : line;
  }
  if (datetime) return `Voice note ${datetime}`;
  return `Superwhisper ${id ?? "recording"}`;
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

function buildStoreUnitForm(
  unit: SuperwhisperUnit,
  withAudio: boolean
): { form: FormData; audioSkippedReason?: string } {
  const form = new FormData();
  form.append("title", unit.title);
  form.append("profileSlug", "note");
  form.append("source", "cli");
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
      form.append(
        "file",
        new File([buf], "output.wav", { type: "audio/wav" })
      );
    }
  } else if (withAudio && !unit.wavPath) {
    audioSkippedReason = "no_wav";
  }
  return { form, audioSkippedReason };
}

/** Prefer 1-request store-unit; fall back to create + source-file if 404. */
let storeUnitMode: "combined" | "two-step" | "unknown" = "unknown";

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
      const entityId = String(res.id ?? res.entityId ?? "");
      if (!entityId) {
        throw new Error(
          `store-unit returned no id: ${JSON.stringify(res).slice(0, 200)}`
        );
      }
      const hasAudio = Boolean(res.audio);
      const audioSkippedReason =
        skipReason ??
        (typeof res.audioSkippedReason === "string"
          ? res.audioSkippedReason
          : undefined);
      return {
        entityId,
        recordingId: unit.recordingId,
        storedAt: new Date().toISOString(),
        hasAudio,
        audioSkippedReason,
      };
    } catch (e) {
      const msg = (e as Error).message;
      // Only fall back when the combined door is missing (not yet deployed).
      if (msg.includes("HTTP 404") || msg.includes("HTTP 405")) {
        storeUnitMode = "two-step";
        console.error(
          "[hub] /import/store-unit not available — falling back to 2-step (deploy backend for 1-req/unit)"
        );
      } else {
        throw e;
      }
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
      description: unit.transcript
        ? undefined
        : "Empty Superwhisper transcript",
      properties: unitProperties(unit),
      source: "cli",
    },
    cfg,
    60_000
  )) as Record<string, unknown>;

  const entityId = String(
    createRes.id ??
      (createRes.entity as { id?: string } | undefined)?.id ??
      ""
  );
  if (!entityId) {
    throw new Error(
      `Create entity returned no id: ${JSON.stringify(createRes).slice(0, 200)}`
    );
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
          form.append(
            "file",
            new File([buf], "output.wav", { type: "audio/wav" })
          );
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
    entityId,
    recordingId: unit.recordingId,
    storedAt: new Date().toISOString(),
    hasAudio,
    audioSkippedReason,
  };
}

/** Run store-first Superwhisper import for one or more roots. */
export async function importSuperwhisperStoreFirst(
  roots: string[],
  opts: SuperwhisperImportOpts
): Promise<void> {
  const cfg = await resolveHubConfig(opts);
  const userId = await resolveUserId(cfg);
  const withAudio = opts.withAudio !== false; // default true when store-first superwhisper
  // Default concurrency 1 — each unit is 2 Hub auth hits; concurrent workers
  // burn the per-key rate window and cascade 429s. Override with --concurrency 2
  // only after the raised server limit is deployed.
  const concurrency = Math.max(1, Math.min(opts.concurrency ?? 1, 4));
  const resume = opts.resume !== false;

  let units: SuperwhisperUnit[] = [];
  for (const root of roots) {
    units = units.concat(collectSuperwhisperUnits(root));
  }
  // Dedupe by recordingId
  const byId = new Map<string, SuperwhisperUnit>();
  for (const u of units) byId.set(u.recordingId, u);
  units = [...byId.values()].sort((a, b) =>
    a.recordingId.localeCompare(b.recordingId)
  );

  if (typeof opts.limit === "number" && opts.limit > 0) {
    units = units.slice(0, opts.limit);
  }

  const ledger = loadLedger();
  const pending = resume
    ? units.filter((u) => !ledger.entries[u.recordingId])
    : units;
  const skippedLedger = units.length - pending.length;

  if (opts.json) {
    // dry-run / status style
  } else {
    const rpm =
      process.env.SYNAP_HUB_RPM && parseInt(process.env.SYNAP_HUB_RPM, 10);
    log.info(
      `Superwhisper store-first: ${units.length} unit(s)` +
        (skippedLedger ? ` · ${skippedLedger} already in ledger` : "") +
        ` · ${pending.length} to process` +
        (withAudio ? " · with audio" : " · transcript only") +
        (opts.dryRun ? " · dry-run" : "") +
        ` · pace ≤${Number.isFinite(rpm) && (rpm as number) > 0 ? rpm : 80} Hub req/min` +
        (process.env.SYNAP_HUB_RPM
          ? ""
          : " (set SYNAP_HUB_RPM=1000 after server redeploy)")
    );
  }

  if (opts.dryRun) {
    const oversize = pending.filter((u) => u.wavSize > AUDIO_MAX_BYTES).length;
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

  if (!opts.yes && !opts.json) {
    log.warn(
      "This will create pod-wide notes (and optionally upload WAVs). Pass --yes to confirm."
    );
    process.exit(1);
  }

  let stored = 0;
  let failed = 0;
  let audioOk = 0;
  let audioSkipped = 0;
  const errors: Array<{ id: string; error: string }> = [];

  // Simple concurrency pool
  let idx = 0;
  async function worker(): Promise<void> {
    while (idx < pending.length) {
      const i = idx++;
      const unit = pending[i];
      try {
        const entry = await storeUnit(unit, cfg, userId, withAudio);
        ledger.entries[unit.recordingId] = entry;
        saveLedger(ledger);
        stored++;
        if (entry.hasAudio) audioOk++;
        if (entry.audioSkippedReason) audioSkipped++;
        if (!opts.json) {
          const n = stored + failed;
          process.stdout.write(
            chalk.dim(
              `\r  ${n}/${pending.length} stored=${stored} failed=${failed} audio=${audioOk}`
            )
          );
        }
      } catch (e) {
        failed++;
        const msg = (e as Error).message;
        errors.push({ id: unit.recordingId, error: msg });
        if (!opts.json) {
          log.error(`\n  ${unit.recordingId}: ${msg}`);
        }
      }
    }
  }

  const workers = Array.from({ length: concurrency }, () => worker());
  await Promise.all(workers);
  if (!opts.json) process.stdout.write("\n");

  if (opts.json) {
    console.log(
      JSON.stringify(
        { stored, failed, audioOk, audioSkipped, skippedLedger, errors },
        null,
        2
      )
    );
  } else {
    log.blank();
    log.heading("Superwhisper import summary");
    log.success(
      `${stored} stored · ${failed} failed · audio ok ${audioOk} · audio skipped ${audioSkipped} · ledger skips ${skippedLedger}`
    );
    log.dim(`Ledger: ${LEDGER_PATH}`);
    for (const e of errors.slice(0, 20)) {
      log.dim(`  ✗ ${e.id}: ${e.error}`);
    }
  }

  if (failed > 0) process.exit(1);
}
