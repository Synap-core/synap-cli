/**
 * `synap tools install|verify|remove` and the worker's desired-state loop, end
 * to end with a fake process runner and a fake pod door: which argv run, in
 * which order, what is refused before anything runs, and what the pod records.
 */
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readComputerManifest, type ComputerManifest, type ProcessResult, type ToolReport } from "../lib/computer-tools.js";
import {
  computerName,
  createToolsReconciler,
  installTool,
  planReconcile,
  preflight,
  reconcileComputerTools,
  removeTool,
  takeReconcileLock,
  toolsInstallCommand,
  verifyTool,
  type DesiredTool,
  type RunContext,
  type ToolsDoor,
} from "./computer-tools.js";

const FIXTURE = new URL("../../test/fixtures/media-transcribe.capability.json", import.meta.url).pathname;
const TRANSCRIBE = JSON.parse(fs.readFileSync(FIXTURE, "utf8"));
const transcribe = readComputerManifest(TRANSCRIBE) as ComputerManifest;

let bin: string;
beforeEach(() => {
  bin = fs.mkdtempSync(path.join(os.tmpdir(), "ct-bin-"));
  for (const p of ["uv", "uvx", "brew", "sudo", "apt-get", "dnf"]) fs.writeFileSync(path.join(bin, p), "#!/bin/sh\n", { mode: 0o755 });
});
afterEach(() => fs.rmSync(bin, { recursive: true, force: true }));

/** A fake runner: answers per program, records every argv. */
function fakeRun(answers: Record<string, ProcessResult | ProcessResult[]>) {
  const calls: string[][] = [];
  const run = async (argv: string[]): Promise<ProcessResult> => {
    calls.push(argv);
    const a = answers[argv[0]!];
    const r = Array.isArray(a) ? (a.length > 1 ? a.shift()! : a[0]!) : a;
    return r ?? { exitCode: 0, stdout: "", stderr: "" };
  };
  return { run, calls };
}

function fakeDoor(rows: DesiredTool[] = []) {
  const reports: ToolReport[] = [];
  const door: ToolsDoor = {
    report: async (r) => void reports.push(r),
    desired: async () => rows,
  };
  return { door, reports };
}

function ctxFor(over: Partial<RunContext>): RunContext & { lines: string[] } {
  const lines: string[] = [];
  return {
    os: "darwin",
    arch: "arm64",
    env: { PATH: bin },
    values: { brewPrefix: "/opt/homebrew", home: "/h", models: "/h/models", workdir: "/h/work" },
    interactive: false,
    say: (l) => lines.push(l),
    freeMb: () => 100_000,
    lines,
    ...over,
  };
}

const HELP_OK: ProcessResult = { exitCode: 0, stdout: "usage: mlx_whisper [-h] audio", stderr: "" };
const MISSING: ProcessResult = { exitCode: null, stdout: "", stderr: "", error: "mlx_whisper is not installed on this computer" };

describe("synap tools install", () => {
  it("runs this OS's steps in order, then the check, and the pod records installing then installed", async () => {
    const { run, calls } = fakeRun({ mlx_whisper: HELP_OK });
    const { door, reports } = fakeDoor();
    const r = await installTool(transcribe, ctxFor({ run, door }));
    expect(calls).toEqual([
      ["uv", "tool", "install", "mlx-whisper"],
      ["uvx", "--from", "huggingface_hub", "hf", "download", "mlx-community/whisper-large-v3-turbo"],
      ["mlx_whisper", "--help"],
    ]);
    expect(reports.map((x) => x.status)).toEqual(["installing", "installed"]);
    expect(reports[1]).toMatchObject({ capabilitySlug: "media-transcribe", manifestVersion: "0.1.0", observedOs: "darwin", observedArch: "arm64" });
    expect(r).toMatchObject({ status: "installed", recorded: "recorded", message: `Installed mlx-whisper on ${computerName()}, checked` });
  });

  it("--skip-models leaves the model download out", async () => {
    const { run, calls } = fakeRun({ mlx_whisper: HELP_OK });
    await installTool(transcribe, ctxFor({ run, skipModels: true }));
    expect(calls.map((c) => c[0])).toEqual(["uv", "mlx_whisper"]);
  });

  it("a check that fails after the steps is recorded as verify_failed, with the log", async () => {
    const { run } = fakeRun({ mlx_whisper: MISSING });
    const { door, reports } = fakeDoor();
    const r = await installTool(transcribe, ctxFor({ run, door }));
    expect(r.status).toBe("verify_failed");
    expect(r.message).toMatch(/does not work on .*: mlx_whisper is not installed on this computer\. Log: /);
    expect(reports.at(-1)).toMatchObject({ status: "verify_failed", verifyResult: { exitCode: null } });
  });

  it("a missing package manager stops before anything runs and says where to get it", async () => {
    fs.rmSync(path.join(bin, "uv"));
    const { run, calls } = fakeRun({});
    const r = await installTool(transcribe, ctxFor({ run }));
    expect(calls).toEqual([]);
    expect(r.message).toContain("uv is not installed on this computer (https://docs.astral.sh/uv/)");
  });

  it("on a computer the capability does not support, nothing runs and the reason is plain", async () => {
    const { run, calls } = fakeRun({});
    const r = await installTool(transcribe, ctxFor({ run, os: "darwin", arch: "x64" }));
    expect(calls).toEqual([]);
    expect(r).toMatchObject({ status: "refused" });
    expect(r.message).toMatch(/^Transcribe on your computer needs a Mac \(Apple Silicon or ARM\)/);
  });

  it("refuses when the disk is too small", () => {
    expect(preflight(transcribe, ctxFor({}), "install", 3000)).toEqual({
      error: "Transcribe on your computer needs 4.0 GB free; this computer has 3.0 GB",
    });
    expect("planned" in preflight(transcribe, ctxFor({}), "install", 5000)).toBe(true);
  });

  it("--skip-models needs the space without the skipped model (4.0 GB less 1.6 GB)", async () => {
    expect("planned" in preflight(transcribe, ctxFor({ skipModels: true }), "install", 2500)).toBe(true);
    expect(preflight(transcribe, ctxFor({ skipModels: true }), "install", 2300)).toEqual({
      error: "Transcribe on your computer needs 2.4 GB free; this computer has 2.3 GB",
    });
    const { run, calls } = fakeRun({});
    const r = await installTool(transcribe, ctxFor({ run, freeMb: () => 1000 }));
    expect(calls).toEqual([]);
    expect(r.message).toBe("Transcribe on your computer needs 4.0 GB free; this computer has 1.0 GB");
  });

  it("--dry-run prints the steps and the check; nothing runs, nothing is recorded", async () => {
    const { run, calls } = fakeRun({});
    const { door, reports } = fakeDoor();
    const ctx = ctxFor({ run, door, dryRun: true });
    const r = await installTool(transcribe, { ...ctx, freeMb: () => 1000 });
    expect(r.status).toBe("dry-run");
    expect(ctx.lines.join("\n")).toContain("needs 4.0 GB free; this computer has 1.0 GB: the install would stop here");
    expect(calls).toEqual([]);
    expect(reports).toEqual([]);
    expect(ctx.lines.join("\n")).toContain("uv tool install mlx-whisper");
    expect(ctx.lines.join("\n")).toContain("then check: mlx_whisper --help");
  });
});

describe("admin rights", () => {
  const ffmpegLinux = readComputerManifest({
    meta: { slug: "media-ffmpeg", name: "ffmpeg", version: "0.1.0" },
    spec: {
      licence: "GPL-2.0-or-later",
      placement: { runsOn: ["computer"], platforms: [{ os: "linux" }] },
      install: { linux: { steps: [{ kind: "apt", package: "ffmpeg" }, { kind: "dnf", package: "ffmpeg", fallback: true }] } },
      verify: { linux: { command: ["ffmpeg", "-version"], expect: { stdoutMatches: "^ffmpeg version (\\S+)" }, captureVersion: 1 } },
    },
  }) as ComputerManifest;

  it("the worker (no person at the keyboard) never runs a step needing admin rights", async () => {
    const { run, calls } = fakeRun({});
    const r = await installTool(ffmpegLinux, ctxFor({ run, os: "linux", arch: "x64", interactive: false, approvedOnPod: true }));
    expect(calls).toEqual([]);
    expect(r.message).toMatch(/needs admin rights .*run `synap tools install media-ffmpeg` on this computer yourself/);
  });

  it("a person is asked first; no means nothing runs", async () => {
    const { run, calls } = fakeRun({});
    const asked: string[] = [];
    const r = await installTool(ffmpegLinux, ctxFor({ run, os: "linux", arch: "x64", interactive: true, confirm: async (q) => (asked.push(q), false) }));
    expect(asked).toEqual(["These steps need admin rights: apt (admin rights): install ffmpeg; dnf (admin rights): install ffmpeg. Continue?"]);
    expect(calls).toEqual([]);
    expect(r.message).toBe("you said no: nothing was installed");
  });

  it("yes runs apt; dnf runs only because apt failed", async () => {
    const { run, calls } = fakeRun({ sudo: [{ exitCode: 100, stdout: "", stderr: "E: no apt" }, { exitCode: 0, stdout: "", stderr: "" }], ffmpeg: { exitCode: 0, stdout: "ffmpeg version 6.1.1", stderr: "" } });
    const r = await installTool(ffmpegLinux, ctxFor({ run, os: "linux", arch: "x64", interactive: true, confirm: async () => true }));
    expect(calls).toEqual([
      ["sudo", "apt-get", "install", "-y", "ffmpeg"],
      ["sudo", "dnf", "install", "-y", "ffmpeg"],
      ["ffmpeg", "-version"],
    ]);
    expect(r).toMatchObject({ status: "installed", toolVersion: "6.1.1" });
  });
  it("apt succeeding means dnf (its fallback) does not run", async () => {
    const { run, calls } = fakeRun({ ffmpeg: { exitCode: 0, stdout: "ffmpeg version 6.1.1", stderr: "" } });
    await installTool(ffmpegLinux, ctxFor({ run, os: "linux", arch: "x64", interactive: true, confirm: async () => true }));
    expect(calls).toEqual([["sudo", "apt-get", "install", "-y", "ffmpeg"], ["ffmpeg", "-version"]]);
  });

  it("a manifest that says `elevation: never` is never asked for admin rights: refused before any step", async () => {
    const never = { ...ffmpegLinux, spec: { ...ffmpegLinux.spec, install: { ...ffmpegLinux.spec.install, elevation: "never" } } };
    const { run, calls } = fakeRun({});
    const asked: string[] = [];
    const r = await installTool(never, ctxFor({ run, os: "linux", arch: "x64", interactive: true, confirm: async (q) => (asked.push(q), true) }));
    expect(calls).toEqual([]);
    expect(asked).toEqual([]);
    expect(r.message).toMatch(/needs admin rights, and the manifest says it never asks for them/);
  });
});

describe("downloads, prerequisites and smoke runs", () => {
  const archiveBytes = Buffer.from("fake archive");
  const archiveSha = createHash("sha256").update(archiveBytes).digest("hex");
  const ffmpeg = (over: object = {}) =>
    readComputerManifest({
      meta: { slug: "media-ffmpeg", name: "ffmpeg", version: "1.0.0" },
      spec: {
        licence: "GPL-2.0-or-later",
        placement: { runsOn: ["computer"] },
        install: {
          linux: {
            steps: [
              { kind: "download", what: "archive", url: "https://x.test/f-x64.tar.xz", sha256: archiveSha, dest: "{tools}/ffmpeg", stripComponents: 1, arch: ["x64"] },
              { kind: "download", what: "archive", url: "https://x.test/f-arm64.tar.xz", sha256: "0".repeat(64), dest: "{tools}/ffmpeg", stripComponents: 1, arch: ["arm64"] },
            ],
            bins: { ffmpeg: "{tools}/ffmpeg/bin/ffmpeg" },
          },
        },
        verify: {
          linux: {
            command: ["ffmpeg", "-version"],
            expect: { stdoutMatches: "^ffmpeg version n?(\\d+\\.\\d+)" },
            captureVersion: 1,
            smoke: { command: ["ffmpeg", "-h", "filter=subtitles"], expect: { stdoutContains: "libass" } },
          },
        },
        ...over,
      },
    }) as ComputerManifest;
  let home: string;
  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), "ct-home-"));
    vi.stubEnv("HOME", home);
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    fs.rmSync(home, { recursive: true, force: true });
  });
  const tools = () => path.join(home, ".synap", "tools", "opt");

  it("an archive for this CPU is fetched, checked against its sha256 and unpacked with tar; the pinned bin is checked", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(archiveBytes)));
    const pinned = path.join(tools(), "ffmpeg", "bin", "ffmpeg");
    const { run, calls } = fakeRun({ [pinned]: { exitCode: 0, stdout: "ffmpeg version n9.0 Copyright\nconfiguration: --enable-libass", stderr: "" }, tar: { exitCode: 0, stdout: "", stderr: "" } });
    const { door, reports } = fakeDoor();
    const r = await installTool(ffmpeg(), ctxFor({ run, door, os: "linux", arch: "x64", values: { tools: tools(), home } }));
    expect(calls[0]!.slice(0, 2)).toEqual(["tar", "-xf"]);
    expect(calls[0]!.slice(3)).toEqual(["-C", path.join(tools(), "ffmpeg"), "--strip-components=1"]);
    expect(fs.readFileSync(calls[0]![2]!, "utf8")).toBe("fake archive");
    expect(calls.slice(1)).toEqual([[pinned, "-version"], [pinned, "-h", "filter=subtitles"]]);
    expect(r).toMatchObject({ status: "installed", toolVersion: "9.0" });
    expect(r.message).toMatch(/, checked, smoke test passed$/);
    expect(reports.at(-1)).toMatchObject({ status: "installed", smokeResult: { ok: true, exitCode: 0 } });
    expect(reports.at(-1)!.smokeAt).toEqual(reports.at(-1)!.verifiedAt);
  });

  it("an archive that does not match its sha256 is refused before anything is unpacked", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(Buffer.from("tampered"))));
    const { run, calls } = fakeRun({});
    const r = await installTool(ffmpeg(), ctxFor({ run, os: "linux", arch: "x64", values: { tools: tools(), home } }));
    expect(calls).toEqual([]);
    expect(r.message).toMatch(/refused: https:\/\/x\.test\/f-x64\.tar\.xz does not match its sha256/);
  });

  it("a smoke that fails is recorded apart: the tool is still installed, and the message says the smoke failed", async () => {
    const pinned = path.join(tools(), "ffmpeg", "bin", "ffmpeg");
    const { run } = fakeRun({ [pinned]: [{ exitCode: 0, stdout: "ffmpeg version 9.0", stderr: "" }, { exitCode: 0, stdout: "no such filter", stderr: "" }] });
    const { door, reports } = fakeDoor();
    const r = await verifyTool(ffmpeg(), ctxFor({ run, door, os: "linux", arch: "x64", values: { tools: tools(), home } }));
    expect(r.status).toBe("installed");
    expect(r.message).toMatch(/but its smoke test failed$/);
    expect(reports[0]).toMatchObject({ status: "installed", smokeResult: { ok: false } });
  });

  it("a smoke that needs a {fixture} is not run, and says so", async () => {
    const { run, calls } = fakeRun({ mlx_whisper: HELP_OK });
    const withSmoke = JSON.parse(JSON.stringify(TRANSCRIBE));
    withSmoke.spec.verify.darwin.smoke = { command: ["mlx_whisper", "{fixture}"], expect: { stdoutContains: "ask not" }, fixture: "jfk.wav" };
    const { door, reports } = fakeDoor();
    const r = await verifyTool(readComputerManifest(withSmoke) as ComputerManifest, ctxFor({ run, door }));
    expect(calls).toEqual([["mlx_whisper", "--help"]]);
    expect(r.message).toMatch(/\(smoke test not run: the manifest uses \{fixture\}, which this computer does not know\)$/);
    expect(reports[0]).toMatchObject({ smokeAt: null, smokeResult: null });
  });

  describe("a prerequisite (requires.capabilities) is its own yes", () => {
    const needsFfmpeg = () => {
      const t = JSON.parse(JSON.stringify(TRANSCRIBE));
      t.spec.placement.requires = { capabilities: [{ slug: "media-ffmpeg" }] };
      return readComputerManifest(t) as ComputerManifest;
    };
    const macFfmpeg = readComputerManifest({
      meta: { slug: "media-ffmpeg", name: "ffmpeg", version: "1.0.0" },
      spec: {
        placement: { runsOn: ["computer"] },
        install: { darwin: { steps: [{ kind: "brew", package: "ffmpeg-full" }] } },
        verify: { darwin: { command: ["ffmpeg", "-version"], expect: { exitCode: 0 } } },
      },
    }) as ComputerManifest;
    const load = async () => ({ manifest: macFfmpeg, source: "test" });
    const FF_MISSING: ProcessResult = { exitCode: null, stdout: "", stderr: "", error: "ffmpeg is not installed on this computer" };

    it("the worker never installs a prerequisite nobody approved", async () => {
      const { run, calls } = fakeRun({ ffmpeg: FF_MISSING });
      const r = await installTool(needsFfmpeg(), ctxFor({ run, load, interactive: false, approvedOnPod: true }));
      expect(calls).toEqual([["ffmpeg", "-version"]]);
      expect(r.message).toBe("Transcribe on your computer needs ffmpeg first: install media-ffmpeg on this computer (approve it on the pod), then this one");
    });

    it("a person says yes: the prerequisite installs first, then the tool", async () => {
      const asked: string[] = [];
      const { run, calls } = fakeRun({ ffmpeg: [FF_MISSING, { exitCode: 0, stdout: "", stderr: "" }], mlx_whisper: HELP_OK });
      const r = await installTool(needsFfmpeg(), ctxFor({ run, load, interactive: true, skipModels: true, confirm: async (q) => (asked.push(q), true) }));
      expect(asked).toEqual(["Transcribe on your computer needs ffmpeg first. Install it?"]);
      expect(calls).toEqual([["ffmpeg", "-version"], ["brew", "install", "ffmpeg-full"], ["ffmpeg", "-version"], ["uv", "tool", "install", "mlx-whisper"], ["mlx_whisper", "--help"]]);
      expect(r.status).toBe("installed");
    });

    it("no means nothing is installed", async () => {
      const { run, calls } = fakeRun({ ffmpeg: FF_MISSING });
      const r = await installTool(needsFfmpeg(), ctxFor({ run, load, interactive: true, confirm: async () => false }));
      expect(calls).toEqual([["ffmpeg", "-version"]]);
      expect(r.message).toBe("you said no: Transcribe on your computer needs ffmpeg first, nothing was installed");
    });
  });
});

describe("synap tools verify / remove", () => {
  it("verify records the version the tool printed", async () => {
    const linux = readComputerManifest(TRANSCRIBE) as ComputerManifest;
    const { run } = fakeRun({ "whisper-ctranslate2": { exitCode: 0, stdout: "0.5.2\n", stderr: "" } });
    const { door, reports } = fakeDoor();
    const r = await verifyTool(linux, ctxFor({ run, door, os: "linux", arch: "x64" }));
    expect(r).toMatchObject({ status: "installed", toolVersion: "0.5.2" });
    expect(reports).toHaveLength(1);
    expect(reports[0]).toMatchObject({ status: "installed", toolVersion: "0.5.2", verifyResult: { exitCode: 0, excerpt: "0.5.2" } });
  });

  it("remove runs the uninstall steps, checks the tool is gone, records removed and keeps models", async () => {
    const { run, calls } = fakeRun({ mlx_whisper: MISSING });
    const { door, reports } = fakeDoor();
    const r = await removeTool(transcribe, ctxFor({ run, door }));
    expect(calls).toEqual([["uv", "tool", "uninstall", "mlx-whisper"], ["mlx_whisper", "--help"]]);
    expect(reports.map((x) => x.status)).toEqual(["uninstalling", "removed"]);
    expect(r.message).toBe(`Removed mlx-whisper from ${computerName()} (downloaded models kept)`);
  });
});

describe("the worker's desired state (decision 2)", () => {
  const NOW = Date.parse("2026-11-07T12:00:00Z");
  const row = (over: Partial<DesiredTool>): DesiredTool => ({
    capabilitySlug: "media-transcribe",
    desiredVersion: "0.1.0",
    manifestVersion: "0.1.0",
    status: "installed",
    verifiedAt: "2026-11-06T12:00:00Z",
    ...over,
  });

  it.each<[string, Partial<DesiredTool>, string]>([
    ["an approved install runs", { status: "requested", manifestVersion: null, verifiedAt: null }, "install"],
    ["checked yesterday: nothing to do", {}, "none"],
    ["checked 8 days ago: check again", { verifiedAt: "2026-10-30T12:00:00Z" }, "verify"],
    ["stopped working, same version: repair without asking", { status: "verify_failed" }, "repair"],
    ["the catalog moved on, not approved: the upgrade waits", { manifestVersion: "0.0.9", desiredVersion: "0.0.9" }, "upgrade-waits"],
    ["the person approved the new version: upgrade", { manifestVersion: "0.0.9", desiredVersion: "0.1.0" }, "upgrade"],
    ["asked to remove", { status: "uninstalling" }, "remove"],
    ["removed: nothing", { status: "removed" }, "none"],
    ["requested at a version the catalog no longer has: waits", { status: "requested", desiredVersion: "0.0.9" }, "upgrade-waits"],
  ])("%s", (_name, over, action) => {
    expect(planReconcile(row(over), transcribe, NOW)).toBe(action);
  });

  it("a due check that fails is repaired in the same pass, and the pod sees it", async () => {
    const { run, calls } = fakeRun({ mlx_whisper: [MISSING, HELP_OK] });
    const { door, reports } = fakeDoor([row({ verifiedAt: "2026-10-01T00:00:00Z" })]);
    const lines = await reconcileComputerTools({ ...ctxFor({ run, skipModels: true }), door, now: () => NOW, load: async () => ({ manifest: transcribe, source: "test" }) });
    expect(calls.map((c) => c[0])).toEqual(["mlx_whisper", "uv", "mlx_whisper"]);
    expect(reports.map((r) => r.status)).toEqual(["verify_failed", "installing", "installed"]);
    expect(lines.at(-1)).toBe(`Installed mlx-whisper on ${computerName()}, checked`);
  });

  it("an upgrade not approved runs nothing and says it waits", async () => {
    const { run, calls } = fakeRun({});
    const { door, reports } = fakeDoor([row({ manifestVersion: "0.0.9", desiredVersion: "0.0.9" })]);
    const lines = await reconcileComputerTools({ ...ctxFor({ run }), door, now: () => NOW, load: async () => ({ manifest: transcribe, source: "test" }) });
    expect(calls).toEqual([]);
    expect(reports).toEqual([]);
    expect(lines).toEqual(["Transcribe on your computer: version 0.1.0 is in the catalog; the upgrade waits for your approval on the pod"]);
  });

  it("the worker reads the desired state at most every interval, under the computer's lock, and says a failed read once", async () => {
    let reads = 0;
    const said: string[] = [];
    let t = 0;
    const door: ToolsDoor = { report: async () => {}, desired: async () => (reads++, Promise.reject(new Error("HTTP 404"))) };
    const rec = createToolsReconciler({ door, say: (l) => said.push(l), everyMs: 1000, now: () => t, lock: () => () => {} });
    await rec.tick();
    await rec.tick(); // same instant: not due
    t = 1000;
    await rec.tick();
    expect(reads).toBe(2);
    expect(said).toEqual(["tools: could not read this computer's tools from the pod: HTTP 404"]);
    const locked = createToolsReconciler({ door, say: () => {}, now: () => 0, lock: () => undefined });
    await locked.tick();
    expect(reads).toBe(2);
  });

  it("one lock per computer: a second taker is refused while the first holds it", () => {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "ct-lock-")), "reconcile.lock");
    const release = takeReconcileLock(file);
    expect(release).toBeTypeOf("function");
    expect(takeReconcileLock(file)).toBeUndefined();
    release!();
    expect(fs.existsSync(file)).toBe(false);
  });
});

describe("the command", () => {
  it("--dry-run against a manifest file prints this computer's steps and records nothing", async () => {
    const file = path.join(bin, "media-transcribe.capability.json");
    fs.writeFileSync(file, JSON.stringify(TRANSCRIBE));
    const out = vi.spyOn(console, "log").mockImplementation(() => {});
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    try {
      process.exitCode = undefined;
      await toolsInstallCommand("media-transcribe", { dryRun: true, manifest: file });
      const text = out.mock.calls.map((c) => String(c[0])).join("\n");
      expect(text).toContain(`manifest: ${file}`);
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
