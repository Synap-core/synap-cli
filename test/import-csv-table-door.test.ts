/**
 * `synap import` — a CSV always takes the TABLE door.
 *
 * Observed 2026-10-21: `synap import Connections.csv --dry-run` (ONE file) went
 * down the single-file capture door (/capture/structure), which reads a CSV as
 * free text — the model returned nothing and the 1,500-row export degraded to
 * one note in the wrong space. Two files took /import/analyze with `source:
 * csv`, where the pod builds a column→kind plan. The door must not depend on
 * how many CSVs there are.
 *
 * Also pinned: a CSV never rides in a markdown batch (the pod would parse the
 * markdown as CSV), and a lone markdown file keeps the capture door.
 * Network-free: the hub transport is mocked.
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

import { importData, groupBatchFiles } from "../src/commands/import.js";

let dir: string;
class ExitSignal extends Error {}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "synap-import-csv-"));
  hubPost.mockClear();
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(process, "exit").mockImplementation((() => {
    throw new ExitSignal("exit");
  }) as never);
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

const CSV = [
  "Notes:",
  '"Some addresses may be missing."',
  "",
  "First Name,Last Name,URL,Email Address,Company,Position",
  "Ada,Quillfeather,https://www.linkedin.com/in/ada-q,,Brindlewood Labs,CTO",
].join("\n");

describe("a CSV takes the table door", () => {
  it("ONE csv file → /import/analyze with source csv, never /capture/structure", async () => {
    const p = join(dir, "Connections.csv");
    writeFileSync(p, CSV, "utf8");
    try {
      await importData([p], { json: true, dryRun: true });
    } catch (e) {
      if (!(e instanceof ExitSignal)) throw e;
    }
    const paths = hubPost.mock.calls.map((c) => c[0]);
    expect(paths).toContain("/import/analyze");
    expect(paths).not.toContain("/capture/structure");
    const body = hubPost.mock.calls.find((c) => c[0] === "/import/analyze")![1] as {
      source: string;
      items: Array<{ path: string; content: string }>;
      previewOnly?: boolean;
    };
    expect(body.source).toBe("csv");
    expect(body.items).toHaveLength(1);
    expect(body.items[0]!.content).toBe(CSV);
    expect(body.previewOnly).toBe(true);
  });
});

describe("groupBatchFiles", () => {
  const f = (path: string) => ({ path });
  it("a lone CSV is a batch of its own", () => {
    expect(groupBatchFiles([f("a.csv")])).toEqual({
      batches: [[f("a.csv")]],
      single: [],
    });
  });
  it("CSVs never ride with markdown; a lone markdown keeps the capture door", () => {
    expect(groupBatchFiles([f("a.md"), f("b.CSV")])).toEqual({
      batches: [[f("b.CSV")]],
      single: [f("a.md")],
    });
  });
  it("≥2 markdown files are still one batch, beside the CSV batch", () => {
    expect(groupBatchFiles([f("a.md"), f("x.csv"), f("b.md")])).toEqual({
      batches: [[f("x.csv")], [f("a.md"), f("b.md")]],
      single: [],
    });
  });
});
