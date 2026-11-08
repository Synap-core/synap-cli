/**
 * `synap tools install|verify|remove`: the person's door goes through the pod
 * (a request, then the job the pod queued, run here by the host runner), and
 * `--dry-run` only plans. Fake door and fake runner pass: what is asked of the
 * pod, what runs, and what the person reads.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RunContext } from "../lib/host/tool-run.js";
import { HostDoorClosedError, type FinishBody } from "../lib/host/wire.js";
import { HubError } from "../lib/hub-client.js";
import { listFailureLine, toolsInstallCommand, toolViaPod, type InstallationsDoor, type PassDeps, type RanHere, type ToolsEnv } from "./computer-tools.js";

const FIXTURE = new URL("../../test/fixtures/media-transcribe.capability.json", import.meta.url).pathname;

const quietCtx = (over: Partial<RunContext> = {}): RunContext => ({
  os: "darwin",
  arch: "arm64",
  env: { PATH: "" },
  values: {},
  interactive: false,
  say: () => {},
  ...over,
});

function fakeEnv(answer: Awaited<ReturnType<InstallationsDoor["request"]>> | Error, ran: RanHere | Error = { ran: false, reason: "nothing" }) {
  const asked: unknown[] = [];
  const matched: Array<(j: { id: string; installation: { capabilityKey: string } }) => boolean> = [];
  const door: InstallationsDoor = {
    request: async (b) => {
      asked.push(b);
      if (answer instanceof Error) throw answer;
      return answer;
    },
    list: async () => [],
  };
  const pass: PassDeps = {
    leaseAndRun: async (m) => {
      matched.push(m);
      if (ran instanceof Error) throw ran;
      return ran;
    },
  };
  const env: ToolsEnv = { podUrl: "https://pod.example", pod: "pod.example", door, pass, ctx: quietCtx() };
  return { env, asked, matched };
}

const done = (over: Partial<FinishBody> = {}): FinishBody => ({ leaseId: "l", status: "done", steps: [], ...over });

describe("synap tools goes through the pod", () => {
  it("files the request as this computer's, then runs the job the pod queued, and says it is recorded", async () => {
    const { env, asked, matched } = fakeEnv({ status: "approved", installationId: "i1", jobId: "j1" }, { ran: true, finish: done(), message: "Installed mlx-whisper on mac, checked" });
    const r = await toolViaPod("install", "media-transcribe", env, { session: "s1" });
    expect(asked).toEqual([{ capabilityKey: "media-transcribe", action: "install", computer: "me", sessionId: "s1" }]);
    expect(matched[0]!({ id: "j1", installation: { capabilityKey: "x" } })).toBe(true);
    expect(matched[0]!({ id: "j2", installation: { capabilityKey: "media-transcribe" } })).toBe(false);
    expect(r).toEqual({ ok: true, lines: [{ level: "success", text: "Installed mlx-whisper on mac, checked (recorded on pod.example)" }] });
  });

  it("an ask that waits for the person (an agent's key) runs nothing here and points at the review", async () => {
    const { env, matched } = fakeEnv({ status: "proposed", reviewUrl: "https://pod.example/open/p1" });
    const r = await toolViaPod("install", "media-transcribe", env, {});
    expect(matched).toEqual([]);
    expect(r.ok).toBe(true);
    expect(r.lines[0]!.text).toMatch(/waits for your approval: https:\/\/pod\.example\/open\/p1$/);
  });

  it("a job that failed says why, from the step that failed, and is not ok", async () => {
    const { env } = fakeEnv(
      { status: "approved", jobId: "j1" },
      { ran: true, finish: done({ status: "failed", steps: [{ name: "Homebrew: install ffmpeg", ok: false, detail: "brew is not installed on this computer (https://brew.sh)" }] }) }
    );
    const r = await toolViaPod("install", "media-ffmpeg", env, {});
    expect(r).toEqual({ ok: false, lines: [{ level: "error", text: "brew is not installed on this computer (https://brew.sh) (recorded on pod.example)" }] });
  });

  it("a computer that does not install from the pod is told how to turn it on", async () => {
    const { env } = fakeEnv({ status: "approved", jobId: "j1" }, new HostDoorClosedError(403));
    const r = await toolViaPod("verify", "media-ffmpeg", env, {});
    expect(r.ok).toBe(false);
    expect(r.lines[0]!.text).toMatch(/turn on "Installs from the pod"/);
  });

  it("the worker on this computer has the job: said, not raced", async () => {
    const { env } = fakeEnv({ status: "approved", jobId: "j1" }, { ran: false, reason: "the worker on this computer is running a job; it runs this one next" });
    const r = await toolViaPod("install", "media-ffmpeg", env, {});
    expect(r.ok).toBe(true);
    expect(r.lines[0]!.text).toBe("pod.example queued it: the worker on this computer is running a job; it runs this one next. `synap tools list` shows the result.");
  });

  describe("a pod without the installations door", () => {
    const missing = Object.assign(new Error("Hub POST /installations/request failed (HTTP 404)"), { status: 404 });

    it("install is refused: nothing changes on a computer the pod cannot record", async () => {
      const { env, matched } = fakeEnv(missing);
      const r = await toolViaPod("install", "media-transcribe", env, { manifest: FIXTURE });
      expect(matched).toEqual([]);
      expect(r).toEqual({ ok: false, lines: [{ level: "error", text: "pod.example cannot record what is installed on its computers yet (no installations door): update the pod, then run this again" }] });
    });

    it("verify runs here (it changes nothing) and says it is not recorded", async () => {
      const { env } = fakeEnv(missing);
      env.ctx = quietCtx({ run: async () => ({ exitCode: 0, stdout: "usage: mlx_whisper", stderr: "" }) });
      const r = await toolViaPod("verify", "media-transcribe", env, { manifest: FIXTURE });
      expect(r.ok).toBe(false);
      expect(r.lines.map((l) => l.level)).toEqual(["success", "warn"]);
      expect(r.lines[1]!.text).toBe(`not recorded: pod.example has no installations door yet (manifest: ${FIXTURE})`);
    });

    it("the door's own 404 is not a missing door: the pod's reason is said (founder's Mac, 2026-11-08)", async () => {
      const notInstallable = new HubError({
        message: "Hub POST /installations/request failed (HTTP 404): media-ffmpeg is not a capability this pod can install on a computer.",
        status: 404,
        code: "NOT_INSTALLABLE",
        detail: "media-ffmpeg is not a capability this pod can install on a computer.",
        rawBody: '{"code":"NOT_INSTALLABLE","error":"media-ffmpeg is not a capability this pod can install on a computer."}',
        path: "/installations/request",
        method: "POST",
      });
      const { env } = fakeEnv(notInstallable);
      let ranHere = false;
      env.ctx = quietCtx({ run: async () => ((ranHere = true), { exitCode: 1, stdout: "", stderr: "" }) });
      const r = await toolViaPod("verify", "media-ffmpeg", env, { manifest: FIXTURE });
      expect(ranHere).toBe(false);
      expect(r).toEqual({
        ok: false,
        lines: [{ level: "error", text: "pod.example did not take the request: Hub POST /installations/request failed (HTTP 404): media-ffmpeg is not a capability this pod can install on a computer." }],
      });
    });

    it("a refused read says the pod's refusal; only the router's 404 is a missing door", () => {
      const refused = new HubError({
        message: "Hub GET /installations failed (HTTP 403): This door does not support scoped keys yet: its reads are not bounded by a grant.",
        status: 403,
        code: "GRANT_DOOR_UNSUPPORTED",
        rawBody: "{}",
        path: "/installations",
        method: "GET",
      });
      expect(listFailureLine("pod.example", "mac", refused)).toBe(
        "could not read what is installed on mac from pod.example: Hub GET /installations failed (HTTP 403): This door does not support scoped keys yet: its reads are not bounded by a grant."
      );
      const routerMissing = new HubError({ message: "Hub GET /installations failed (HTTP 404): Not found", status: 404, rawBody: '{"error":"Not found"}', path: "/installations", method: "GET" });
      expect(listFailureLine("pod.example", "mac", routerMissing)).toBe("pod.example cannot list what is installed on its computers yet (no installations door): update the pod");
    });

    it("any other refusal is said as it is", async () => {
      const { env } = fakeEnv(Object.assign(new Error("HTTP 403 forbidden"), { status: 403 }));
      const r = await toolViaPod("install", "media-transcribe", env, {});
      expect(r).toEqual({ ok: false, lines: [{ level: "error", text: "pod.example did not take the request: HTTP 403 forbidden" }] });
    });
  });
});

describe("the command", () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "ct-cmd-"));
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it("--dry-run against a manifest file prints this computer's steps and asks the pod nothing", async () => {
    const out = vi.spyOn(console, "log").mockImplementation(() => {});
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    try {
      process.exitCode = undefined;
      await toolsInstallCommand("media-transcribe", { dryRun: true, manifest: FIXTURE });
      const text = out.mock.calls.map((c) => String(c[0])).join("\n");
      expect(text).toContain(`manifest: ${FIXTURE}`);
      expect(text).toContain("dry run: nothing was installed or recorded");
      expect(text).toContain("then check:");
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      out.mockRestore();
      vi.unstubAllGlobals();
      process.exitCode = undefined;
    }
  });

  it("--computer naming another computer is refused: it runs where it is typed", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      process.exitCode = undefined;
      await toolsInstallCommand("media-transcribe", { computer: "some-other-box" });
      expect(process.exitCode).toBe(1);
      expect(err.mock.calls.map((c) => String(c[0])).join("\n")).toContain("To install on some-other-box, run it there.");
    } finally {
      err.mockRestore();
      process.exitCode = undefined;
    }
  });
});
