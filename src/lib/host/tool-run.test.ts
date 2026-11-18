/**
 * The host runner's `tool` executor, end to end with a fake process runner:
 * which argv run, in which order, what is refused before anything runs, and
 * the steps and check a host job reports.
 */
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readComputerManifest, type ComputerManifest, type ProcessResult } from "./tool.js";
import { computerName, installTool, preflight, removeTool, verifyTool, type RunContext } from "./tool-run.js";

const FIXTURE = new URL("../../../test/fixtures/media-transcribe.capability.json", import.meta.url).pathname;
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
  it("runs this OS's steps in order, then the check; the job gets each step and what the check found", async () => {
    const { run, calls } = fakeRun({ mlx_whisper: HELP_OK });
    const r = await installTool(transcribe, ctxFor({ run }));
    expect(calls).toEqual([
      ["uv", "tool", "install", "mlx-whisper"],
      ["uvx", "--from", "huggingface_hub", "hf", "download", "mlx-community/whisper-large-v3-turbo"],
      ["mlx_whisper", "--help"],
    ]);
    expect(r.steps.map((x) => [x.name, x.ok])).toEqual([
      ["uv: tool install mlx-whisper", true],
      ["download the model mlx-community/whisper-large-v3-turbo, about 1.6 GB", true],
      ["check: mlx_whisper --help", true],
    ]);
    expect(r.check).toMatchObject({ os: "darwin", arch: "arm64", verify: { ok: true, exitCode: 0 } });
    expect(r).toMatchObject({ status: "installed", message: `Installed mlx-whisper on ${computerName()}, checked` });
  });

  it("--skip-models leaves the model download out", async () => {
    const { run, calls } = fakeRun({ mlx_whisper: HELP_OK });
    await installTool(transcribe, ctxFor({ run, skipModels: true }));
    expect(calls.map((c) => c[0])).toEqual(["uv", "mlx_whisper"]);
  });

  it("a check that fails after the steps is verify_failed, with the log, and the check says why", async () => {
    const { run } = fakeRun({ mlx_whisper: MISSING });
    const r = await installTool(transcribe, ctxFor({ run }));
    expect(r.status).toBe("verify_failed");
    expect(r.message).toMatch(/does not work on .*: mlx_whisper is not installed on this computer\. Log: /);
    expect(r.check?.verify).toMatchObject({ ok: false, exitCode: null });
    expect(r.steps.at(-1)).toMatchObject({ ok: false, detail: "mlx_whisper is not installed on this computer" });
  });

  it("a missing package manager stops before any step runs and says where to get it; only the check runs, so the job reports what is there", async () => {
    fs.rmSync(path.join(bin, "uv"));
    const { run, calls } = fakeRun({ mlx_whisper: MISSING });
    const r = await installTool(transcribe, ctxFor({ run }));
    expect(calls).toEqual([["mlx_whisper", "--help"]]);
    expect(r.status).toBe("failed");
    expect(r.message).toContain("uv is not installed on this computer (https://docs.astral.sh/uv/)");
    expect(r.check?.verify).toMatchObject({ ok: false, exitCode: null });
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
    const ctx = ctxFor({ run, dryRun: true });
    const r = await installTool(transcribe, { ...ctx, freeMb: () => 1000 });
    expect(r.status).toBe("dry-run");
    expect(ctx.lines.join("\n")).toContain("needs 4.0 GB free; this computer has 1.0 GB: the install would stop here");
    expect(calls).toEqual([]);
    expect(r.steps).toEqual([]);
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
    const r = await installTool(ffmpegLinux, ctxFor({ run, os: "linux", arch: "x64", interactive: false }));
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
    const r = await installTool(ffmpeg(), ctxFor({ run, os: "linux", arch: "x64", values: { tools: tools(), home } }));
    expect(calls[0]!.slice(0, 2)).toEqual(["tar", "-xf"]);
    expect(calls[0]!.slice(3)).toEqual(["-C", path.join(tools(), "ffmpeg"), "--strip-components=1"]);
    expect(fs.readFileSync(calls[0]![2]!, "utf8")).toBe("fake archive");
    expect(calls.slice(1)).toEqual([[pinned, "-version"], [pinned, "-h", "filter=subtitles"]]);
    expect(r).toMatchObject({ status: "installed", toolVersion: "9.0" });
    expect(r.message).toMatch(/, checked, smoke test passed$/);
    expect(r.check).toMatchObject({ observedVersion: "9.0", verify: { ok: true, smoke: { ok: true, exitCode: 0 } } });
  });

  it("an archive that does not match its sha256 is refused before anything is unpacked", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(Buffer.from("tampered"))));
    const { run, calls } = fakeRun({});
    const r = await installTool(ffmpeg(), ctxFor({ run, os: "linux", arch: "x64", values: { tools: tools(), home } }));
    // Nothing unpacked: the only process is the check (the pinned bin, absent).
    expect(calls).toEqual([[path.join(tools(), "ffmpeg", "bin", "ffmpeg"), "-version"]]);
    expect(r.message).toMatch(/refused: https:\/\/x\.test\/f-x64\.tar\.xz does not match its sha256/);
  });

  it("a smoke that fails is recorded apart: the tool is still installed, and the message says the smoke failed", async () => {
    const pinned = path.join(tools(), "ffmpeg", "bin", "ffmpeg");
    const { run } = fakeRun({ [pinned]: [{ exitCode: 0, stdout: "ffmpeg version 9.0", stderr: "" }, { exitCode: 0, stdout: "no such filter", stderr: "" }] });
    const r = await verifyTool(ffmpeg(), ctxFor({ run, os: "linux", arch: "x64", values: { tools: tools(), home } }));
    expect(r.status).toBe("installed");
    expect(r.message).toMatch(/but its smoke test failed$/);
    expect(r.check?.verify).toMatchObject({ ok: true, smoke: { ok: false } });
  });

  it("a smoke that needs a {fixture} is not run, and says so", async () => {
    const { run, calls } = fakeRun({ mlx_whisper: HELP_OK });
    const withSmoke = JSON.parse(JSON.stringify(TRANSCRIBE));
    withSmoke.spec.verify.darwin.smoke = { command: ["mlx_whisper", "{fixture}"], expect: { stdoutContains: "ask not" }, fixture: "jfk.wav" };
    const r = await verifyTool(readComputerManifest(withSmoke) as ComputerManifest, ctxFor({ run }));
    expect(calls).toEqual([["mlx_whisper", "--help"]]);
    expect(r.message).toMatch(/\(smoke test not run: the manifest uses \{fixture\}, which this computer does not know\)$/);
    expect(r.check?.verify).not.toHaveProperty("smoke");
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
    const load = async () => ({ manifest: macFfmpeg });
    const FF_MISSING: ProcessResult = { exitCode: null, stdout: "", stderr: "", error: "ffmpeg is not installed on this computer" };

    it("the worker never installs a prerequisite nobody approved", async () => {
      const { run, calls } = fakeRun({ ffmpeg: FF_MISSING });
      const r = await installTool(needsFfmpeg(), ctxFor({ run, load, interactive: false }));
      expect(calls).toEqual([["ffmpeg", "-version"]]);
      expect(r.message).toBe("Transcribe on your computer needs ffmpeg first: approve media-ffmpeg for this computer on the pod, then this one");
    });

    it("at the keyboard the prerequisite is its own install (its own yes), then the tool", async () => {
      const asked: string[] = [];
      const { run, calls } = fakeRun({ ffmpeg: FF_MISSING, mlx_whisper: HELP_OK });
      const r = await installTool(needsFfmpeg(), ctxFor({ run, load, interactive: true, skipModels: true, prerequisite: async (dep) => (asked.push(dep.slug), { ok: true }) }));
      expect(asked).toEqual(["media-ffmpeg"]);
      expect(calls).toEqual([["ffmpeg", "-version"], ["uv", "tool", "install", "mlx-whisper"], ["mlx_whisper", "--help"]]);
      expect(r.status).toBe("installed");
    });

    it("a prerequisite that does not install means nothing is installed", async () => {
      const { run, calls } = fakeRun({ ffmpeg: FF_MISSING });
      const r = await installTool(needsFfmpeg(), ctxFor({ run, load, interactive: true, prerequisite: async () => ({ ok: false, message: "you said no: nothing was installed" }) }));
      expect(calls).toEqual([["ffmpeg", "-version"]]);
      expect(r.message).toBe("Transcribe on your computer needs ffmpeg first: you said no: nothing was installed");
    });

    it("the tool's check runs with the approved prerequisite's programs FIRST on PATH, never another ffmpeg PATH finds first", async () => {
      // The founder's Mac, 2026-11-09: a brew `ffmpeg` an x265 upgrade broke sits
      // in /opt/homebrew/bin; mlx_whisper calls a bare `ffmpeg`.
      const prefix = fs.mkdtempSync(path.join(os.tmpdir(), "ct-brew-"));
      const full = path.join(prefix, "opt", "ffmpeg-full", "bin");
      fs.mkdirSync(full, { recursive: true });
      fs.writeFileSync(path.join(full, "ffmpeg"), "#!/bin/sh\n", { mode: 0o755 });
      const pinned = readComputerManifest({
        meta: { slug: "media-ffmpeg", name: "ffmpeg", version: "1.0.0" },
        spec: {
          placement: { runsOn: ["computer"] },
          install: {
            darwin: {
              steps: [{ kind: "brew", package: "ffmpeg-full" }],
              bins: { ffmpeg: "{brewPrefix}/opt/ffmpeg-full/bin/ffmpeg", ffprobe: "{brewPrefix}/opt/ffmpeg-full/bin/ffprobe" },
            },
          },
          verify: { darwin: { command: ["ffmpeg", "-version"], expect: { exitCode: 0 } } },
        },
      }) as ComputerManifest;
      const envs: Array<string | undefined> = [];
      const run = async (argv: string[], o?: { env?: NodeJS.ProcessEnv }): Promise<ProcessResult> => {
        envs.push(o?.env?.PATH);
        return argv[0] === "mlx_whisper" ? HELP_OK : { exitCode: 0, stdout: "", stderr: "" };
      };
      try {
        const ctx = ctxFor({ run, load: async () => ({ manifest: pinned }), values: { brewPrefix: prefix, home: "/h", models: "/h/models", workdir: "/h/work" }, env: { PATH: `${bin}:/usr/bin` } });
        const r = await verifyTool(needsFfmpeg(), ctx);
        expect(r.status).not.toBe("failed");
        // ffprobe is pinned but absent on disk: only the folder of a program that exists goes first.
        expect(envs[0]).toBe(`${full}:${bin}:/usr/bin`);
        // An install checks the tool the same way, reading the prerequisite once.
        envs.length = 0;
        let loads = 0;
        await installTool(needsFfmpeg(), { ...ctx, skipModels: true, load: async () => (loads++, { manifest: pinned }) });
        expect(loads).toBe(1);
        expect(envs.at(-1)).toBe(`${full}:${bin}:/usr/bin`);
        // A tool with no prerequisite keeps the PATH it was given.
        envs.length = 0;
        await verifyTool(transcribe, ctx);
        expect(envs[0]).toBe(`${bin}:/usr/bin`);
      } finally {
        fs.rmSync(prefix, { recursive: true, force: true });
      }
    });
  });
});

describe("synap tools verify / remove", () => {
  it("verify captures the version the tool printed", async () => {
    const linux = readComputerManifest(TRANSCRIBE) as ComputerManifest;
    const { run } = fakeRun({ "whisper-ctranslate2": { exitCode: 0, stdout: "0.5.2\n", stderr: "" } });
    const r = await verifyTool(linux, ctxFor({ run, os: "linux", arch: "x64" }));
    expect(r).toMatchObject({ status: "installed", toolVersion: "0.5.2" });
    expect(r.check).toMatchObject({ observedVersion: "0.5.2", os: "linux", arch: "x64", verify: { ok: true, exitCode: 0, excerpt: "0.5.2" } });
  });

  it("remove runs the uninstall steps, checks the tool is gone, and keeps models", async () => {
    const { run, calls } = fakeRun({ mlx_whisper: MISSING });
    const r = await removeTool(transcribe, ctxFor({ run }));
    expect(calls).toEqual([["uv", "tool", "uninstall", "mlx-whisper"], ["mlx_whisper", "--help"]]);
    expect(r.steps.map((x) => x.ok)).toEqual([true, true]);
    expect(r.status).toBe("removed");
    expect(r.message).toBe(`Removed mlx-whisper from ${computerName()} (downloaded models kept)`);
  });
});

describe("a check that runs past its time (a cold first launch)", () => {
  // media-ffmpeg as the catalog ships it: a 30 s check. ffmpeg-full's first launch after
  // `brew install` took over 30 s on the founder's Mac (worker log, 2026-11-09), then 4 s, then 0.05 s.
  const ffmpeg = readComputerManifest({
    meta: { slug: "media-ffmpeg", name: "ffmpeg", version: "1.0.0" },
    spec: {
      placement: { runsOn: ["computer"] },
      install: { darwin: { steps: [{ kind: "brew", package: "ffmpeg-full" }] } },
      uninstall: { darwin: { steps: [{ kind: "brew", package: "ffmpeg-full" }] } },
      verify: { timeoutSec: 30, darwin: { command: ["ffmpeg", "-version"], expect: { stdoutMatches: "^ffmpeg version (\\S+)" }, captureVersion: 1 } },
    },
  }) as ComputerManifest;
  const COLD: ProcessResult = { exitCode: null, stdout: "", stderr: "", error: "ffmpeg took longer than 30 s and was stopped", timedOut: true };
  const WARM: ProcessResult = { exitCode: 0, stdout: "ffmpeg version 8.0 Copyright", stderr: "" };

  it("an install whose first check times out is checked once more, and the second answer counts", async () => {
    const { run, calls } = fakeRun({ ffmpeg: [COLD, WARM] });
    const ctx = ctxFor({ run });
    const r = await installTool(ffmpeg, ctx);
    expect(calls).toEqual([["brew", "install", "ffmpeg-full"], ["ffmpeg", "-version"], ["ffmpeg", "-version"]]);
    expect(r).toMatchObject({ status: "installed", toolVersion: "8.0" });
    expect(r.message).toBe(`Installed ffmpeg-full 8.0 on ${computerName()}, checked`);
    expect(ctx.lines).toContain("ffmpeg took longer than 30 s to answer (a first launch can be slow): checking once more");
  });

  it("two timeouts say the check timed out, never that the tool does not work", async () => {
    const { run, calls } = fakeRun({ ffmpeg: COLD });
    const r = await verifyTool(ffmpeg, ctxFor({ run }));
    expect(calls).toEqual([["ffmpeg", "-version"], ["ffmpeg", "-version"]]);
    expect(r.status).toBe("verify_failed");
    expect(r.message).not.toMatch(/does not work/);
    expect(r.message).toBe(
      `ffmpeg-full on ${computerName()} could not be checked: its check (ffmpeg -version) took longer than 30 s twice and was stopped. It may be installed; check it again with \`synap tools verify media-ffmpeg\``
    );
    expect(r.steps[0]).toMatchObject({ ok: false, detail: "its check (ffmpeg -version) took longer than 30 s twice and was stopped" });
  });

  it("a check that fails at once is not run again", async () => {
    const { run, calls } = fakeRun({ ffmpeg: { exitCode: null, stdout: "", stderr: "", error: "ffmpeg is not installed on this computer" } });
    const r = await verifyTool(ffmpeg, ctxFor({ run }));
    expect(calls).toEqual([["ffmpeg", "-version"]]);
    expect(r.message).toBe(`ffmpeg-full does not work on ${computerName()}: ffmpeg is not installed on this computer`);
  });

  it("a removal whose check times out is not reported removed", async () => {
    const { run } = fakeRun({ ffmpeg: COLD });
    const r = await removeTool(ffmpeg, ctxFor({ run }));
    expect(r.status).toBe("failed");
    expect(r.message).toMatch(/^ffmpeg-full on .* could not be checked after removing it: its check \(ffmpeg -version\) took longer than 30 s twice/);
    expect(r.steps.at(-1)).toMatchObject({ name: "check it is gone: ffmpeg -version", ok: false });
  });
});

describe("an inline script step", () => {
  let home: string;
  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), "ct-home-"));
    vi.stubEnv("HOME", home);
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    fs.rmSync(home, { recursive: true, force: true });
  });
  const source = "#!/bin/sh\necho built\n";
  const matte = (src: string) =>
    readComputerManifest({
      meta: { slug: "media-matte", name: "Matte", version: "0.1.0" },
      spec: {
        placement: { runsOn: ["computer"] },
        install: { darwin: { steps: [{ kind: "script", name: "build-synap-matte.sh", source: src, sha256: createHash("sha256").update(source).digest("hex"), args: ["--quiet"], elevation: "never" }] } },
        verify: { darwin: { command: ["synap-matte", "--version"], expect: { exitCode: 0 } } },
      },
    }) as ComputerManifest;

  it("is written to a file, shown to the person, and run with sh and its args", async () => {
    const { run, calls } = fakeRun({ "synap-matte": { exitCode: 0, stdout: "1.0", stderr: "" } });
    const asked: string[] = [];
    const r = await installTool(matte(source), ctxFor({ run, interactive: true, confirm: async (q) => (asked.push(q), true) }));
    expect(asked).toEqual(["Run this script (build-synap-matte.sh)?"]);
    expect(calls[0]![0]).toBe("sh");
    expect(fs.readFileSync(calls[0]![1]!, "utf8")).toBe(source);
    expect(calls[0]![2]).toBe("--quiet");
    expect(r.status).toBe("installed");
  });

  it("a source changed after its sha256 was pinned is refused before anything runs", async () => {
    const { run, calls } = fakeRun({});
    const r = await installTool(matte(source + "rm -rf ~\n"), ctxFor({ run }));
    expect(calls).toEqual([]);
    expect(r).toMatchObject({ status: "refused", message: "refused: the script build-synap-matte.sh does not match its sha256" });
  });
});
