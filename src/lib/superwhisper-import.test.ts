/**
 * Superwhisper store-first import (finding 51e086d8): 712 recordings were 712+
 * paced hub requests that still met 429s, and a unit the pod's governance
 * parked (`{status:'proposed'}`) was printed as failed and left out of the
 * ledger, so a re-run filed it again.
 *
 * These tests drive `importSuperwhisperStoreFirst` against a stubbed `fetch`
 * (the pod and its storage) and a temp ledger. They pin:
 *   - one submission: N recordings cost ⌈N/100⌉ upload mints + ONE enqueue +
 *     the polls, never a hub request per recording;
 *   - proposed ≠ failed: a parked unit is recorded `proposed` with its
 *     proposal id, counted apart, and skipped by a re-run, on the bulk door
 *     and on the per-unit door a pod without the bulk door still uses;
 *   - a job submitted by a run whose terminal closed is read back first.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { importSuperwhisperStoreFirst } from "./superwhisper-import.js";

const POD = "https://pod.example.test";
const JOB = "22222222-2222-4222-8222-222222222222";

let root: string;
let ledgerDir: string;
let recordings: string;

function makeRecordings(n: number): string[] {
  const ids: string[] = [];
  for (let i = 0; i < n; i++) {
    const id = String(1700000000 + i);
    const dir = join(recordings, id);
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "meta.json"),
      JSON.stringify({ result: `Recording number ${i} is here.`, datetime: "2026-11-04T10:00:00" })
    );
    writeFileSync(join(dir, "output.wav"), Buffer.from(`RIFF${i}`));
    ids.push(id);
  }
  return ids;
}

function ledger(): {
  entries: Record<string, Record<string, unknown>>;
  pendingJobs?: Array<Record<string, unknown>>;
} {
  return JSON.parse(readFileSync(join(ledgerDir, "superwhisper.json"), "utf8"));
}

interface Call {
  method: string;
  url: string;
  body: unknown;
}

/** A fake pod + storage. `outcome(key, i)` decides each unit's job result. */
function fakePod(opts: {
  bulk?: boolean;
  outcome?: (key: string, i: number) => Record<string, unknown>;
  storeUnit?: (form: FormData) => { status: number; body: Record<string, unknown> };
}) {
  const calls: Call[] = [];
  let enqueued: Array<Record<string, unknown>> = [];
  let polls = 0;
  let minted = 0;
  const fetchMock = vi.fn(async (url: string, init: RequestInit = {}) => {
    const method = (init.method ?? "GET").toUpperCase();
    const body =
      typeof init.body === "string" ? JSON.parse(init.body) : (init.body ?? null);
    calls.push({ method, url, body });
    const json = (status: number, b: unknown) =>
      new Response(JSON.stringify(b), {
        status,
        headers: { "Content-Type": "application/json" },
      });
    if (url.startsWith("https://storage.test/")) return new Response("", { status: 200 });
    const path = url.replace(`${POD}/api/hub`, "").split("?")[0];
    if (path === "/import/unit-uploads") {
      if (!opts.bulk) return json(404, { error: "Not Found" });
      const files = (body as { files: unknown[] }).files;
      return json(200, {
        uploads: files.map(() => {
          const n = minted++;
          return {
            uploadUrl: `https://storage.test/put/${n}`,
            method: "PUT",
            headers: { "Content-Type": "audio/wav" },
            uploadToken: `imports/user-1/${n}/output.wav`,
            expiresAt: "2026-11-04T11:00:00Z",
            maxBytes: 104857600,
          };
        }),
      });
    }
    if (path === "/import/enqueue-units") {
      if (!opts.bulk) return json(404, { error: "Not Found" });
      enqueued = (body as { units: Array<Record<string, unknown>> }).units;
      return json(202, { queued: true, jobId: JOB, unitCount: enqueued.length });
    }
    if (path === `/import/units-job/${JOB}`) {
      polls++;
      if (polls === 1) return json(200, { jobId: JOB, state: "active", output: null });
      const results: Record<string, unknown> = {};
      enqueued.forEach((u, i) => {
        results[u.key as string] = opts.outcome
          ? opts.outcome(u.key as string, i)
          : { status: "stored", entityId: `e-${i}`, audio: true, audioSkippedReason: null };
      });
      return json(200, {
        jobId: JOB,
        state: "completed",
        output: { total: enqueued.length, stored: 0, proposed: 0, failed: 0, results },
      });
    }
    if (path === "/import/store-unit" && opts.storeUnit) {
      const r = opts.storeUnit(init.body as FormData);
      return json(r.status, r.body);
    }
    return json(404, { error: `unexpected ${method} ${path}` });
  });
  vi.stubGlobal("fetch", fetchMock);
  return {
    calls,
    hubCalls: () => calls.filter((c) => c.url.startsWith(`${POD}/api/hub`)),
    enqueued: () => enqueued,
    reset: () => {
      calls.length = 0;
      polls = 0;
    },
  };
}

let out: string[];
async function run() {
  await importSuperwhisperStoreFirst([recordings], {
    podUrl: POD,
    apiKey: "k",
    yes: true,
    json: true,
    pollIntervalMs: 0,
  });
  return JSON.parse(out[out.length - 1]!) as Record<string, unknown>;
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "sw-import-"));
  ledgerDir = join(root, "ledger");
  recordings = join(root, "recordings");
  mkdirSync(recordings, { recursive: true });
  process.env.SYNAP_IMPORT_LEDGER_DIR = ledgerDir;
  process.env.SYNAP_USER_ID = "user-1";
  out = [];
  vi.spyOn(console, "log").mockImplementation((m: unknown) => {
    out.push(String(m));
  });
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
    throw new Error(`process.exit(${code})`);
  }) as never);
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  delete process.env.SYNAP_IMPORT_LEDGER_DIR;
  delete process.env.SYNAP_USER_ID;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("one submission: hub requests are O(N / batch), not O(N)", () => {
  it("712 recordings cost 8 upload mints + 1 enqueue + the polls, and no per-unit request", async () => {
    const ids = makeRecordings(712);
    const pod = fakePod({ bulk: true });

    const summary = await run();

    const hub = pod.hubCalls().map((c) => `${c.method} ${c.url.replace(`${POD}/api/hub`, "")}`);
    expect(hub.filter((h) => h === "POST /import/unit-uploads")).toHaveLength(8);
    expect(hub.filter((h) => h === "POST /import/enqueue-units")).toHaveLength(1);
    expect(hub.filter((h) => h.startsWith("GET /import/units-job/"))).toHaveLength(2);
    expect(hub.filter((h) => h.includes("store-unit"))).toHaveLength(0);
    expect(hub).toHaveLength(11);
    // Every WAV went straight to storage.
    expect(pod.calls.filter((c) => c.method === "PUT")).toHaveLength(712);
    // ONE manifest with every recording, keyed for the pod's idempotency.
    const units = pod.enqueued();
    expect(units).toHaveLength(712);
    expect(units[0]).toMatchObject({
      key: `superwhisper:${ids[0]}`,
      profileSlug: "note",
      content: "Recording number 0 is here.",
    });
    expect(units.every((u) => typeof u.uploadToken === "string")).toBe(true);
    expect(summary).toMatchObject({ stored: 712, proposed: 0, failed: 0, audioOk: 712 });
    expect(Object.keys(ledger().entries)).toHaveLength(712);
    expect(ledger().pendingJobs ?? []).toEqual([]);
  });
});

describe("proposed is not failed", () => {
  it("bulk door: a parked unit is recorded proposed with its proposal id, and a re-run skips it", async () => {
    const ids = makeRecordings(5);
    const pod = fakePod({
      bulk: true,
      outcome: (key, i) =>
        i === 2
          ? { status: "proposed", proposalId: "prop-2", audioSkippedReason: "entity_proposed" }
          : i === 4
            ? { status: "failed", error: "Profile not found" }
            : { status: "stored", entityId: `e-${i}`, audio: true, audioSkippedReason: null },
    });

    await expect(run()).rejects.toThrow("process.exit(1)");
    const summary = JSON.parse(out[out.length - 1]!);
    expect(summary).toMatchObject({ stored: 3, proposed: 1, failed: 1 });
    expect(summary.errors).toEqual([{ id: ids[4], error: "Profile not found" }]);

    const entries = ledger().entries;
    expect(entries[ids[2]!]).toMatchObject({
      recordingId: ids[2],
      status: "proposed",
      proposalId: "prop-2",
      hasAudio: false,
    });
    expect(entries[ids[0]!]).toMatchObject({ status: "stored", entityId: "e-0", hasAudio: true });
    // The failed unit is NOT in the ledger: a re-run retries it.
    expect(entries[ids[4]!]).toBeUndefined();

    // Re-run: only the failed recording is submitted again; the proposed one is not.
    pod.reset();
    await run();
    expect(pod.enqueued().map((u) => u.key)).toEqual([`superwhisper:${ids[4]}`]);
  });

  it("per-unit door (pod without the bulk door): proposed goes to the ledger, not to failed", async () => {
    const ids = makeRecordings(2);
    const forms: FormData[] = [];
    const pod = fakePod({
      bulk: false,
      storeUnit: (form) => {
        forms.push(form);
        return form.get("idempotencyKey") === `superwhisper:${ids[0]}`
          ? {
              status: 202,
              body: {
                status: "proposed",
                proposalId: "prop-a",
                proposalType: "entity.create",
                audio: null,
                audioSkippedReason: "entity_proposed",
              },
            }
          : {
              status: 200,
              body: { id: "e-b", entityId: "e-b", audio: { documentId: "d" }, audioSkippedReason: null },
            };
      },
    });

    const summary = await run();
    expect(summary).toMatchObject({ stored: 1, proposed: 1, failed: 0, errors: [] });
    expect(ledger().entries[ids[0]!]).toMatchObject({
      status: "proposed",
      proposalId: "prop-a",
      audioSkippedReason: "entity_proposed",
    });
    expect(ledger().entries[ids[1]!]).toMatchObject({ status: "stored", entityId: "e-b" });
    expect(forms.map((f) => f.get("idempotencyKey"))).toEqual(
      ids.map((id) => `superwhisper:${id}`)
    );

    // Re-run: nothing is filed again.
    pod.reset();
    const again = await run();
    expect(pod.calls.filter((c) => c.url.includes("store-unit"))).toHaveLength(0);
    expect(again).toMatchObject({ stored: 0, proposed: 0, failed: 0, skippedLedger: 2 });
  });
});

describe("a closed terminal does not lose the job", () => {
  it("reads back a job an earlier run submitted before submitting anything", async () => {
    const ids = makeRecordings(3);
    const pod = fakePod({ bulk: true });
    // An earlier run enqueued the 3 recordings and its terminal closed.
    mkdirSync(ledgerDir, { recursive: true });
    writeFileSync(
      join(ledgerDir, "superwhisper.json"),
      JSON.stringify({
        version: 1,
        entries: {},
        pendingJobs: [{ jobId: JOB, recordingIds: ids, submittedAt: "2026-11-04T10:00:00Z" }],
      })
    );
    // The fake job answers for the units it was given.
    (pod.enqueued() as unknown[]).length = 0;
    ids.forEach((id) => pod.enqueued().push({ key: `superwhisper:${id}` }));

    const summary = await run();
    expect(summary).toMatchObject({ stored: 3, failed: 0, jobs: [JOB] });
    expect(pod.calls.filter((c) => c.url.endsWith("/import/enqueue-units"))).toHaveLength(0);
    expect(existsSync(join(ledgerDir, "superwhisper.json"))).toBe(true);
    expect(ledger().pendingJobs).toEqual([]);
    expect(Object.keys(ledger().entries).sort()).toEqual([...ids].sort());
  });
});
