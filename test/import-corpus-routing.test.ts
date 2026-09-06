/**
 * `synap import` → the BACKGROUND corpus door.
 *
 * The synchronous `/import/analyze` door dies at 45–48s against the pod's 45s
 * request timeout, so a corpus of any real size (the 257-file memory backfill)
 * could never land through it. Above CORPUS_THRESHOLD the CLI must instead
 * POST /import/enqueue-corpus and poll GET /import/corpus-job/{id}.
 *
 * Four things are pinned here, each of which was a way to get this wrong:
 *   1. the THRESHOLD actually selects the door (asserted at the wire, not on the
 *      helper alone — "the constant is 3" is not evidence that the POST moved);
 *   2. `--dry-run` never enqueues — enqueueing IS a durable write;
 *   3. the timeout message never claims failure — the job keeps running, and
 *      telling a user their half-done 257-file import failed is worse than
 *      saying nothing;
 *   4. a job that ends in a dead pg-boss state exits non-zero.
 *
 * Network-free and DB-free: the hub transport and the shared poll loop are both
 * mocked, so no timer waits 5s and nothing touches a pod.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const JOB_ID = "3f2504e0-4f89-11d3-9a0c-0305e82c3301";
const WS = "808939d1-86b3-4c52-a153-ae06ece2c54e";

// vi.mock factories are hoisted above module-scope consts — build the spies in a
// hoisted block so both the factory and the tests see the SAME fn instances.
const { hubPost, hubGet, poll } = vi.hoisted(() => {
  const jobId = "3f2504e0-4f89-11d3-9a0c-0305e82c3301";
  const ws = "808939d1-86b3-4c52-a153-ae06ece2c54e";
  return {
    hubPost: vi.fn(async (path: string) => {
      if (path === "/import/enqueue-corpus") {
        return { queued: true, jobId, itemCount: 3, workspaceId: ws };
      }
      if (path === "/import/analyze") {
        return { operations: [], workspaceId: ws, summary: "nothing to do" };
      }
      return {};
    }),
    hubGet: vi.fn(async () => ({ workspaces: [] })),
    poll: { outcome: { kind: "completed" } as { kind: string; state?: string } },
  };
});

vi.mock("../src/lib/hub-client.js", () => ({
  hubPost,
  hubGet,
  resolveHubConfig: vi.fn(async () => ({
    podUrl: "http://127.0.0.1:1",
    apiKey: "test-key",
    userId: "user-1",
    workspaceId: WS,
  })),
  resolveUserId: vi.fn(async () => "user-1"),
  resolveActiveSessionId: vi.fn(() => undefined),
  renderHubError: vi.fn(),
  HubError: class HubError extends Error {},
}));

/**
 * Drive the shared poll loop deterministically. `pollOutcome` decides which of
 * the three branches processCorpusImport must handle. onTick is invoked exactly
 * as the real loop does, so the state-tracking in pollCorpusJob is exercised.
 */
vi.mock("../src/lib/approval-poll.js", () => ({
  pollForApproval: vi.fn(async (opts: any) => {
    const jobId = "3f2504e0-4f89-11d3-9a0c-0305e82c3301";
    if (poll.outcome.kind === "completed") {
      const data = { jobId, state: "completed" };
      opts.onTick?.({ data, elapsedMs: 1000 });
      return opts.onApproved(data);
    }
    if (poll.outcome.kind === "dead") {
      const data = { jobId, state: poll.outcome.state };
      opts.onTick?.({ data, elapsedMs: 1000 });
      opts.isRejected(data);
      throw new Error(opts.rejectedError);
    }
    opts.onTick?.({ data: { jobId, state: "active" }, elapsedMs: 1000 });
    throw new Error(opts.timeoutError);
  }),
}));

import {
  chooseBatchDoor,
  corpusPollTimeoutMs,
  corpusTimeoutLines,
  importExitCode,
  CORPUS_THRESHOLD,
  importData,
} from "../src/commands/import.js";

// ─── harness ──────────────────────────────────────────────────────────────────

let dir: string;
let exitCode: number | undefined;
let stdout: string[];

class ExitSignal extends Error {}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "synap-import-corpus-"));
  hubPost.mockClear();
  hubGet.mockClear();
  poll.outcome = { kind: "completed" };
  exitCode = undefined;
  stdout = [];
  vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => {
    stdout.push(a.map(String).join(" "));
  });
  vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
    exitCode = code;
    throw new ExitSignal("exit");
  }) as never);
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

/** Write `n` markdown files and run `synap import <dir> --json`. */
async function runImport(n: number, opts: Record<string, unknown> = {}) {
  const paths: string[] = [];
  for (let i = 0; i < n; i++) {
    const p = join(dir, `note-${i}.md`);
    writeFileSync(p, `# Note ${i}\n\nSome content about thing ${i}.\n`, "utf8");
    paths.push(p);
  }
  try {
    await importData(paths, { json: true, yes: true, ...opts });
  } catch (e) {
    if (!(e instanceof ExitSignal)) throw e;
  }
  const payload = stdout.map((l) => l.trim()).find((l) => l.startsWith("{"));
  return payload ? JSON.parse(payload) : null;
}

const postedPaths = () => hubPost.mock.calls.map((c) => c[0]);

// ─── 1. threshold routing ─────────────────────────────────────────────────────

describe("chooseBatchDoor — the one place the threshold is applied", () => {
  it("keeps 1–2 files on the synchronous, interactive door", () => {
    expect(chooseBatchDoor({ fileCount: 1 })).toBe("analyze");
    expect(chooseBatchDoor({ fileCount: CORPUS_THRESHOLD - 1 })).toBe("analyze");
  });

  it("routes AT the threshold to the background door", () => {
    expect(chooseBatchDoor({ fileCount: CORPUS_THRESHOLD })).toBe("enqueue-corpus");
  });

  it("routes above the threshold to the background door", () => {
    expect(chooseBatchDoor({ fileCount: 257 })).toBe("enqueue-corpus");
  });
});

describe("threshold routing, asserted at the wire", () => {
  it("2 files POST /import/analyze and never touch the corpus door", async () => {
    await runImport(2);
    expect(postedPaths()).toContain("/import/analyze");
    expect(postedPaths()).not.toContain("/import/enqueue-corpus");
  });

  it("3 files POST /import/enqueue-corpus and never touch the sync door", async () => {
    await runImport(3);
    expect(postedPaths()).toContain("/import/enqueue-corpus");
    expect(postedPaths()).not.toContain("/import/analyze");
  });

  it("sends `content` (not `text`) and forwards the active workspace", async () => {
    await runImport(3);
    const call = hubPost.mock.calls.find((c) => c[0] === "/import/enqueue-corpus");
    const body = call![1] as Record<string, any>;
    expect(body.workspaceId).toBe(WS);
    expect(body.source).toBe("markdown");
    expect(body.items).toHaveLength(3);
    for (const item of body.items) {
      expect(typeof item.content).toBe("string");
      expect(item.content.length).toBeGreaterThan(0);
      expect(item).not.toHaveProperty("text");
    }
  });
});

// ─── 2. --dry-run must not enqueue ────────────────────────────────────────────

describe("--dry-run never enqueues", () => {
  it("keeps a 3-file dry run on the preview door (enqueueing IS a write)", () => {
    expect(chooseBatchDoor({ fileCount: 3, dryRun: true })).toBe("analyze");
    expect(chooseBatchDoor({ fileCount: 257, dryRun: true })).toBe("analyze");
  });

  it("a 257-scale dry run posts no corpus job at the wire", async () => {
    await runImport(5, { dryRun: true, yes: false });
    expect(postedPaths()).not.toContain("/import/enqueue-corpus");
    expect(postedPaths()).toContain("/import/analyze");
  });
});

// ─── 3. timeout is NOT failure ────────────────────────────────────────────────

describe("wait-window expiry", () => {
  it("scales the wait with corpus size and clamps it at both ends", () => {
    expect(corpusPollTimeoutMs(3)).toBe(10 * 60_000); // floor
    expect(corpusPollTimeoutMs(257)).toBe(2 * 60 * 60_000); // ceiling
    const mid = corpusPollTimeoutMs(40);
    expect(mid).toBeGreaterThan(10 * 60_000);
    expect(mid).toBeLessThan(2 * 60 * 60_000);
  });

  it("never says the import failed, and says the job keeps running", () => {
    const lines = corpusTimeoutLines(JOB_ID, 2 * 60 * 60_000).join(" ").toLowerCase();
    expect(lines).not.toMatch(/\bfailed\b/);
    expect(lines).not.toMatch(/\berror\b/);
    expect(lines).not.toMatch(/\baborted\b/);
    expect(lines).toContain("not a failure");
    expect(lines).toContain("keeps going");
    expect(lines).toContain("nothing was lost");
  });

  it("names a real re-poll command with the job id in it", () => {
    const lines = corpusTimeoutLines(JOB_ID, 60_000);
    const repoll = lines.find((l) => l.includes("--job-status"));
    expect(repoll).toBeDefined();
    expect(repoll).toContain(JOB_ID);
  });

  it("reports `queued`, keeps exit 0, and carries the jobId into --json", async () => {
    poll.outcome = { kind: "timeout" };
    const out = await runImport(3);
    expect(out.imported[0].status).toBe("queued");
    expect(out.corpus.jobId).toBe(JOB_ID);
    expect(out.corpus.timedOut).toBe(true);
    // A still-running job is not a degraded one.
    expect(exitCode).toBeUndefined();
    expect(importExitCode(out.imported)).toBe(0);
  });
});

// ─── 4. a dead job exits non-zero ─────────────────────────────────────────────

describe("a job that ends in a dead state", () => {
  it("reports failed with the state the pod actually returned", async () => {
    poll.outcome = { kind: "dead", state: "failed" };
    const out = await runImport(3);
    expect(out.imported[0].status).toBe("failed");
    expect(out.corpus.state).toBe("failed");
    expect(out.imported[0].error).toContain("failed");
    expect(exitCode).toBe(1);
  });

  it("treats an expired job as a failure too, naming that state", async () => {
    poll.outcome = { kind: "dead", state: "expired" };
    const out = await runImport(3);
    expect(out.imported[0].status).toBe("failed");
    expect(out.corpus.state).toBe("expired");
    expect(exitCode).toBe(1);
  });
});

// ─── outcome honesty on success ───────────────────────────────────────────────

describe("a completed corpus job", () => {
  it("reports `proposed` — the result is a pending proposal, not stored entities", async () => {
    const out = await runImport(3);
    expect(out.imported[0].status).toBe("proposed");
    expect(out.imported[0].entities).toBe(0);
    expect(out.corpus.state).toBe("completed");
    expect(out.corpus.timedOut).toBe(false);
    expect(exitCode).toBeUndefined();
  });

  it("gives an agent the review path in --json nextSteps", async () => {
    const out = await runImport(3);
    expect(out.nextSteps.map((s: any) => s.command)).toContain("synap proposals list");
  });
});
