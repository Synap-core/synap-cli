/**
 * The rules of a computer capability's steps (plan b647769e §2.1): which steps
 * run on which computer, the exact argv, the refusals, what a verify run means
 * and the report the pod records.
 */
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildToolReport,
  elevationRefusal,
  EXCERPT_MAX,
  fillPlaceholders,
  matchVerify,
  parseIsoDuration,
  planStep,
  planSteps,
  platformAllowed,
  readComputerManifest,
  redactSecrets,
  statusAfterVerify,
  stepsFor,
  verifyArgv,
  verifyFor,
  versionSatisfies,
  type ComputerSpec,
} from "./computer-tools.js";

/** The transcription capability, in the catalog's shape (schema/computer.ts). */
const TRANSCRIBE = JSON.parse(
  fs.readFileSync(new URL("../../test/fixtures/media-transcribe.capability.json", import.meta.url).pathname, "utf8")
);

const spec = TRANSCRIBE.spec as unknown as ComputerSpec;

describe("readComputerManifest", () => {
  it("reads the catalog shape: slug, name, the manifest's own version", () => {
    const m = readComputerManifest(TRANSCRIBE);
    expect(m).toMatchObject({ slug: "media-transcribe", name: "Transcribe on your computer", version: "0.1.0" });
  });

  it("refuses a pod capability: nothing to install on a computer", () => {
    const m = readComputerManifest({ meta: { slug: "exa" }, spec: { key: "exa", placement: { runsOn: ["pod"] } } });
    expect(m).toEqual({ error: "exa runs on the pod, not on a computer: there is nothing to install here" });
  });

  it("without a declared version, the version is a hash of the steps (a changed step is a new version)", () => {
    const { meta, ...rest } = TRANSCRIBE;
    const a = readComputerManifest({ ...rest, meta: { slug: meta.slug } });
    const changed = JSON.parse(JSON.stringify(TRANSCRIBE));
    delete changed.meta.version;
    changed.spec.install.linux.steps[0].package = "faster-whisper";
    const b = readComputerManifest(changed);
    expect("version" in a && a.version).toMatch(/^sha256:[a-f0-9]{12}$/);
    expect("version" in b && b.version).not.toBe("version" in a && a.version);
  });
});

describe("which computer, which steps", () => {
  it("a Mac with Apple Silicon may run it, an Intel Mac may not, and is told why", () => {
    expect(platformAllowed(spec, "darwin", "arm64")).toEqual({ ok: true });
    const intel = platformAllowed(spec, "darwin", "x64");
    expect(intel.ok).toBe(false);
    expect(!intel.ok && intel.reason).toBe(
      "needs a Mac (Apple Silicon or ARM) or Linux (Intel or AMD (x64), Apple Silicon or ARM) or Windows (Intel or AMD (x64)); this computer is Mac x64"
    );
  });

  it("no platforms listed means any computer", () => {
    expect(platformAllowed({ placement: { runsOn: ["computer"] } }, "linux", "arm64")).toEqual({ ok: true });
  });

  it("picks this OS's steps and only this OS's", () => {
    const mac = stepsFor(spec.install, "darwin");
    const linux = stepsFor(spec.install, "linux");
    expect("steps" in mac && mac.steps.map((s) => s.package ?? s.id)).toEqual(["mlx-whisper", "mlx-community/whisper-large-v3-turbo"]);
    expect("steps" in linux && linux.steps.map((s) => s.package)).toEqual(["whisper-ctranslate2"]);
    expect(stepsFor(spec.uninstall, "linux")).toEqual({ error: "no steps for Linux" });
  });

  it("picks this OS's verify check", () => {
    expect(verifyFor(spec, "darwin")?.command).toEqual(["mlx_whisper", "--help"]);
    expect(verifyFor(spec, "linux")?.captureVersion).toBe(1);
    expect(verifyFor({ verify: {} }, "darwin")).toBeUndefined();
  });
});

describe("planStep: exact argv, never a shell line", () => {
  it("package managers become argv lists", () => {
    const argv = (step: object, os = "darwin", action: "install" | "uninstall" = "install") => {
      const p = planStep(step as never, action, os);
      return "argv" in p ? p.argv : p;
    };
    expect(argv({ kind: "brew", package: "ffmpeg-full" })).toEqual(["brew", "install", "ffmpeg-full"]);
    expect(argv({ kind: "brew", package: "ffmpeg", tap: "homebrew-ffmpeg/ffmpeg" })).toEqual(["brew", "install", "homebrew-ffmpeg/ffmpeg/ffmpeg"]);
    expect(argv({ kind: "brew", package: "ffmpeg-full" }, "darwin", "uninstall")).toEqual(["brew", "uninstall", "ffmpeg-full"]);
    expect(argv({ kind: "uv", action: "tool-install", package: "yt-dlp", with: ["curl-cffi"], python: "3.12" })).toEqual([
      "uv", "tool", "install", "yt-dlp", "--with", "curl-cffi", "--python", "3.12",
    ]);
    expect(argv({ kind: "uv", action: "tool-uninstall", package: "yt-dlp" })).toEqual(["uv", "tool", "uninstall", "yt-dlp"]);
    expect(argv({ kind: "winget", id: "Gyan.FFmpeg" }, "win32")).toEqual([
      "winget", "install", "--id", "Gyan.FFmpeg", "-e", "--accept-source-agreements", "--accept-package-agreements",
    ]);
    expect(argv({ kind: "pip", package: "rembg" }, "win32")).toEqual(["python", "-m", "pip", "install", "--user", "rembg"]);
    expect(argv({ kind: "npm", package: "x" })).toEqual(["npm", "install", "-g", "x"]);
    expect(argv({ kind: "download", what: "model", id: "org/model" })).toEqual(["uvx", "--from", "huggingface_hub", "hf", "download", "org/model"]);
  });

  it("apt and dnf need admin rights; package managers in the home folder do not", () => {
    const apt = planStep({ kind: "apt", package: "ffmpeg" }, "install", "linux");
    expect("admin" in apt && apt.admin).toBe(true);
    expect("argv" in apt && apt.argv?.[0]).toBe("sudo");
    const uv = planStep({ kind: "uv", action: "tool-install", package: "x" }, "install", "linux");
    expect("admin" in uv && uv.admin).toBe(false);
  });

  it("refuses a script without a sha256, and a step kind it does not know", () => {
    expect(planStep({ kind: "script", url: "https://x.test/i.sh", command: ["sh", "{script}"], elevation: "never" }, "install", "linux")).toEqual({
      error: "refused: the script https://x.test/i.sh has no sha256, so it cannot run",
    });
    expect(planStep({ kind: "script", command: ["sh", "i.sh"], sha256: "a".repeat(64), elevation: "never" }, "install", "linux")).toEqual({
      error: "refused: a script step with no url has nothing to check its sha256 against",
    });
    expect(planStep({ kind: "curl-pipe-sh", url: "https://x.test" }, "install", "linux")).toEqual({
      error: 'refused: "curl-pipe-sh" is not a step this computer runs',
    });
  });

  it("a pinned script runs its declared command on the fetched file", () => {
    const p = planStep({ kind: "script", url: "https://x.test/i.sh", sha256: "b".repeat(64), command: ["sh", "{script}", "--quiet"], elevation: "never" }, "install", "linux");
    expect("argv" in p && p.argv).toEqual(["sh", "{script}", "--quiet"]);
  });

  it("refuses a download by URL without a sha256", () => {
    expect(planStep({ kind: "download", what: "binary", url: "https://x.test/tool", dest: "{home}/t" }, "install", "darwin")).toEqual({
      error: "refused: the download https://x.test/tool has no sha256 to check it against",
    });
  });

  it("one refused step refuses the whole plan: nothing runs", () => {
    const r = planSteps([{ kind: "brew", package: "a" }, { kind: "telnet" }], "install", "darwin");
    expect(r).toEqual({ error: 'refused: "telnet" is not a step this computer runs' });
  });

  it("an admin step under `elevation: never` is a manifest error, never a prompt", () => {
    const plan = planSteps([{ kind: "apt", package: "ffmpeg" }], "install", "linux");
    expect("planned" in plan && elevationRefusal({ install: { elevation: "never" } }, plan.planned)).toMatch(/needs admin rights, and the manifest says it never asks/);
    expect("planned" in plan && elevationRefusal({ install: {} }, plan.planned)).toBeUndefined();
  });
});

describe("placeholders and pinned programs", () => {
  it("fills known placeholders and refuses an unknown one", () => {
    expect(fillPlaceholders("{models}/rvm", { models: "/m" })).toEqual({ value: "/m/rvm" });
    expect(fillPlaceholders("{nope}/x", { models: "/m" })).toEqual({ error: "the manifest uses {nope}, which this computer does not know" });
  });

  it("a verify command naming a pinned bin runs the pinned path", () => {
    const pinned: ComputerSpec = { install: { darwin: { steps: [], bins: { ffmpeg: "{brewPrefix}/opt/ffmpeg-full/bin/ffmpeg" } } } };
    expect(verifyArgv(pinned, "darwin", ["ffmpeg", "-version"], { brewPrefix: "/opt/homebrew" })).toEqual({
      argv: ["/opt/homebrew/opt/ffmpeg-full/bin/ffmpeg", "-version"],
    });
    expect(verifyArgv(pinned, "linux", ["ffmpeg", "-version"], {})).toEqual({ argv: ["ffmpeg", "-version"] });
  });
});

describe("matchVerify", () => {
  const check = { command: ["ffmpeg", "-version"], expect: { exitCode: 0, stdoutMatches: "^ffmpeg version n?(\\d+\\.\\d+(?:\\.\\d+)?)" }, captureVersion: 1 };

  it("passes and captures the version the tool printed", () => {
    expect(matchVerify({ exitCode: 0, stdout: "ffmpeg version 7.1.1 Copyright", stderr: "" }, check)).toEqual({ ok: true, toolVersion: "7.1.1" });
  });

  it("fails on another exit code, on output that does not match, and when the program is missing", () => {
    expect(matchVerify({ exitCode: 1, stdout: "ffmpeg version 7.1", stderr: "" }, check)).toMatchObject({ ok: false, reason: "ffmpeg exited with 1, expected 0" });
    expect(matchVerify({ exitCode: 0, stdout: "avconv 9", stderr: "" }, check)).toMatchObject({ ok: false, toolVersion: null });
    expect(matchVerify({ exitCode: null, stdout: "", stderr: "", error: "ffmpeg is not installed on this computer" }, check)).toEqual({
      ok: false,
      toolVersion: null,
      reason: "ffmpeg is not installed on this computer",
    });
  });

  it("checks stdoutContains and stderrMatches", () => {
    const c = { command: ["t"], expect: { stdoutContains: "ask not", stderrMatches: "^ok$" } };
    expect(matchVerify({ exitCode: 0, stdout: "ask not what", stderr: "ok" }, c).ok).toBe(true);
    expect(matchVerify({ exitCode: 0, stdout: "something else", stderr: "ok" }, c).ok).toBe(false);
    expect(matchVerify({ exitCode: 0, stdout: "ask not what", stderr: "warn" }, c).ok).toBe(false);
  });

  it("no captureVersion: passes with no version", () => {
    expect(matchVerify({ exitCode: 0, stdout: "usage: mlx_whisper [-h]", stderr: "" }, verifyFor(spec, "darwin")!)).toEqual({ ok: true, toolVersion: null });
  });
});

describe("versions and drift", () => {
  it("compares dotted versions numerically", () => {
    expect(versionSatisfies("7.1.1", ">=6.0")).toBe(true);
    expect(versionSatisfies("1.10.0", ">=1.9 <2")).toBe(true);
    expect(versionSatisfies("5.9", ">=6.0")).toBe(false);
    expect(versionSatisfies("7.1", "~7")).toBeUndefined();
  });

  it("a passing check outside the manifest's range is drift, not installed", () => {
    const ranged: ComputerSpec = { placement: { requires: { tool: { version: ">=6.0" } } } };
    expect(statusAfterVerify(ranged, { ok: true, toolVersion: "5.1" })).toBe("drifted");
    expect(statusAfterVerify(ranged, { ok: true, toolVersion: "7.1" })).toBe("installed");
    expect(statusAfterVerify(ranged, { ok: false, toolVersion: null })).toBe("verify_failed");
  });

  it("reads reverifyEvery", () => {
    expect(parseIsoDuration("P7D")).toBe(7 * 24 * 3600_000);
    expect(parseIsoDuration("PT12H")).toBe(12 * 3600_000);
    expect(parseIsoDuration("7 days")).toBeUndefined();
  });
});

describe("the report the pod records", () => {
  it("carries the tool's state, never a computer id: the computer is the key that sends it", () => {
    const r = buildToolReport({
      slug: "media-ffmpeg",
      status: "installed",
      manifestVersion: "0.1.0",
      toolVersion: "7.1.1",
      os: "darwin",
      arch: "arm64",
      run: { exitCode: 0, stdout: "ffmpeg version 7.1.1", stderr: "" },
      at: new Date("2026-11-07T10:00:00Z"),
      sessionId: "s-1",
    });
    expect(Object.keys(r).sort()).toEqual(
      ["capabilitySlug", "manifestVersion", "observedArch", "observedOs", "sessionId", "status", "toolVersion", "verifiedAt", "verifyResult"].sort()
    );
    expect(r).toMatchObject({ capabilitySlug: "media-ffmpeg", status: "installed", toolVersion: "7.1.1", observedOs: "darwin", observedArch: "arm64", verifiedAt: "2026-11-07T10:00:00.000Z" });
    expect(r.verifyResult).toEqual({
      exitCode: 0,
      excerpt: "ffmpeg version 7.1.1",
      outputSha256: createHash("sha256").update("ffmpeg version 7.1.1").digest("hex"),
    });
  });

  it("no check run: no verifiedAt, no verifyResult", () => {
    const r = buildToolReport({ slug: "x", status: "installing", manifestVersion: "1", toolVersion: null, os: "linux", arch: "x64" });
    expect(r.verifiedAt).toBeNull();
    expect(r.verifyResult).toBeNull();
  });

  it("no secret leaves the computer, and the excerpt is clipped", () => {
    const out = `HF_TOKEN=hf_abcdefghijklmnopqrstu\nAuthorization: Bearer eyJhbGciOi.payload.sig\nsk-ant-api03-abcdefghijklmnop\n${"x".repeat(5000)}`;
    const r = buildToolReport({ slug: "x", status: "verify_failed", manifestVersion: "1", toolVersion: null, os: "linux", arch: "x64", run: { exitCode: 1, stdout: out, stderr: "" } });
    expect(r.verifyResult!.excerpt).not.toMatch(/hf_abcdef|eyJhbGci|sk-ant-api03/);
    expect(r.verifyResult!.excerpt.length).toBe(EXCERPT_MAX);
    expect(redactSecrets("API_KEY: 123abc")).toBe("API_KEY:[redacted]");
  });
});
