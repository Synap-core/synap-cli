import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import {
  buildServiceSpec,
  findServices,
  installService,
  notMacMessage,
  parseDisabled,
  parseLaunchctlPrint,
  parsePlist,
  plistPathFor,
  renderPlist,
  serviceLabel,
  serviceStatuses,
  startServices,
  statusLine,
  stopServices,
  uninstallService,
  type Launchctl,
  type ServiceContext,
  type ServiceDeps,
} from "./worker-service.js";

// ─── a fake launchd: what is loaded, running, disabled; every call recorded ───

interface FakeLaunchd {
  calls: string[][];
  loaded: Map<string, { plist: string; pid?: number }>;
  disabled: Set<string>;
  run: Launchctl;
}

function fakeLaunchd(uid = 501): FakeLaunchd {
  const f: FakeLaunchd = { calls: [], loaded: new Map(), disabled: new Set(), run: async () => ({ code: 0, stdout: "", stderr: "" }) };
  let nextPid = 4000;
  const label = (t: string) => t.replace(`gui/${uid}/`, "");
  f.run = async (args) => {
    f.calls.push(args);
    const [verb, a1, a2] = args;
    const ok = (stdout = "") => ({ code: 0, stdout, stderr: "" });
    const fail = (code: number, stderr: string) => ({ code, stdout: "", stderr });
    switch (verb) {
      case "print": {
        const s = f.loaded.get(label(a1));
        if (!s) return fail(113, `Could not find service "${label(a1)}" in domain for user gui: ${uid}`);
        return ok(
          `${a1} = {\n\tactive count = 1\n\tstate = ${s.pid ? "running" : "not running"}\n\truns = 1\n` +
            (s.pid ? `\tpid = ${s.pid}\n\tlast exit code = (never exited)\n` : `\tlast exit code = 1\n`) +
            `\tresource coalition = {\n\t\tstate = active\n\t}\n}\n`
        );
      }
      case "bootstrap": {
        const text = fs.readFileSync(a2, "utf8");
        const l = parsePlist(text).label!;
        if (f.loaded.has(l)) return fail(5, "Bootstrap failed: 5: Input/output error");
        if (f.disabled.has(l)) return fail(5, "Bootstrap failed: 5: Input/output error (disabled)");
        f.loaded.set(l, { plist: a2, pid: nextPid++ });
        return ok();
      }
      case "bootout":
        if (!f.loaded.delete(label(a1))) return fail(3, "Boot-out failed: 3: No such process");
        return ok();
      case "kickstart": {
        const s = f.loaded.get(label(a1));
        if (!s) return fail(113, "Could not find service");
        s.pid ??= nextPid++;
        return ok();
      }
      case "enable":
        f.disabled.delete(label(a1));
        return ok();
      case "disable":
        f.disabled.add(label(a1));
        return ok();
      case "print-disabled":
        return ok(`disabled services = {\n${[...f.disabled].map((l) => `\t\t"${l}" => disabled\n`).join("")}\t}\n`);
      default:
        return fail(64, `unknown verb ${verb}`);
    }
  };
  return f;
}

let home: string;
let ld: FakeLaunchd;
let deps: ServiceDeps;
let ctx: ServiceContext;

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "worker-service-"));
  ld = fakeLaunchd();
  deps = { home, uid: 501, platform: "darwin", launchctl: ld.run, sleep: async () => {} };
  const bin = path.join(home, ".local", "bin");
  fs.mkdirSync(bin, { recursive: true });
  fs.writeFileSync(path.join(bin, "claude"), "#!/bin/sh\n", { mode: 0o755 });
  ctx = {
    home,
    cwd: path.join(home, "here"),
    nodePath: "/opt/node/v22/bin/node",
    synapPath: "/opt/node/v22/bin/synap",
    searchPath: `/nowhere:${bin}`,
  };
});

const verbs = () => ld.calls.map((c) => c[0]);

// ─── the plist ────────────────────────────────────────────────────────────────

describe("service label and plist", () => {
  it("names the service live.synap.worker-<agent>", () => {
    expect(serviceLabel("claude-code-mac")).toBe("live.synap.worker-claude-code-mac");
    expect(plistPathFor("/Users/a", "live.synap.worker-x")).toBe("/Users/a/Library/LaunchAgents/live.synap.worker-x.plist");
    expect(() => serviceLabel("a b")).toThrow(/cannot name a service/);
    expect(() => serviceLabel("../x")).toThrow(/cannot name a service/);
  });

  it("runs node + synap worker with the flags given, absolute paths, login + keep-alive, log under ~/.synap", () => {
    const spec = buildServiceSpec(
      { agent: "claude-code-mac", interval: "30s", workRoot: "~/synap-work", cwd: "repos", accounts: "acc.json", skipPermissions: true },
      ctx
    );
    expect(spec.label).toBe("live.synap.worker-claude-code-mac");
    expect(spec.programArguments).toEqual([
      "/opt/node/v22/bin/node",
      "/opt/node/v22/bin/synap",
      "worker",
      "--agent",
      "claude-code-mac",
      "--interval",
      "30s",
      "--cwd",
      path.join(home, "here", "repos"),
      "--work-root",
      path.join(home, "synap-work"),
      "--claude-bin",
      path.join(home, ".local", "bin", "claude"),
      "--accounts",
      path.join(home, "here", "acc.json"),
      "--skip-permissions",
    ]);
    expect(spec.environment.HOME).toBe(home);
    expect(spec.environment.PATH.split(":").slice(0, 3)).toEqual(["/opt/node/v22/bin", path.join(home, ".local", "bin"), "/opt/homebrew/bin"]);
    expect(spec.logPath).toBe(path.join(home, ".synap", "worker", "claude-code-mac", "worker.log"));

    const xml = renderPlist(spec);
    expect(xml).toContain("<key>RunAtLoad</key><true/>");
    expect(xml).toContain("<key>KeepAlive</key><true/>");
    expect(xml).toContain("<key>ThrottleInterval</key><integer>30</integer>");
    expect(xml).toContain(`<key>StandardOutPath</key><string>${spec.logPath}</string>`);
    expect(xml).toContain(`<key>StandardErrorPath</key><string>${spec.logPath}</string>`);
    expect(xml).toContain(`<key>WorkingDirectory</key><string>${home}</string>`);
    // It reads back to what was written.
    const back = parsePlist(xml);
    expect(back.label).toBe(spec.label);
    expect(back.programArguments).toEqual(spec.programArguments);
    expect(back.agent).toBe("claude-code-mac");
    expect(back.logPath).toBe(spec.logPath);
  });

  it("escapes XML in values", () => {
    const spec = buildServiceSpec({ agent: "a", allowedTools: "Bash(git <x> & y)" }, ctx);
    const xml = renderPlist(spec);
    expect(xml).toContain("Bash(git &lt;x&gt; &amp; y)");
    expect(parsePlist(xml).programArguments).toContain("Bash(git <x> & y)");
  });

  it("never carries a secret: --env refuses secret-looking names and HOME/PATH", () => {
    expect(buildServiceSpec({ agent: "a", env: ["HYPERFRAMES_NO_TELEMETRY=1"] }, ctx).environment.HYPERFRAMES_NO_TELEMETRY).toBe("1");
    for (const bad of ["CLAUDE_CODE_OAUTH_TOKEN=x", "SYNAP_HUB_API_KEY=x", "GITHUB_APP_PRIVATE_KEY=x", "MY_SECRET=x", "PATH=/x"]) {
      expect(() => buildServiceSpec({ agent: "a", env: [bad] }, ctx)).toThrow();
    }
    expect(() => buildServiceSpec({ agent: "a", env: ["novalue"] }, ctx)).toThrow(/NAME=value/);
    // Nothing from the calling environment is copied in.
    const xml = renderPlist(buildServiceSpec({ agent: "a" }, ctx));
    expect(Object.keys(buildServiceSpec({ agent: "a" }, ctx).environment).sort()).toEqual(["HOME", "PATH"]);
    expect(xml).not.toMatch(/TOKEN|API_KEY|hubApiKey/);
  });

  it("refuses a synap that runs from source or npx's cache", () => {
    expect(() => buildServiceSpec({ agent: "a" }, { ...ctx, synapPath: "/repo/src/index.ts" })).toThrow(/runs from source/);
    expect(() => buildServiceSpec({ agent: "a" }, { ...ctx, synapPath: "/u/.npm/_npx/abc/node_modules/.bin/synap" })).toThrow(/npx/);
  });

  it("an agent whose template wakes another program: its folder is on the service's PATH, no --claude-bin, --run-timeout carried", () => {
    const hermes = path.join(home, "tools", "bin", "hermes");
    const spec = buildServiceSpec(
      { agent: "hermes-mac", runTimeout: "30m" },
      {
        ...ctx,
        engine: {
          kind: "program",
          template: "hermes",
          program: "hermes",
          programPath: hermes,
          wake: { program: "hermes", args: ["chat", "-q", "{prompt}"], params: {}, envStrip: [] },
        },
      }
    );
    expect(spec.programArguments).not.toContain("--claude-bin");
    expect(spec.programArguments.slice(-2)).toEqual(["--run-timeout", "30m"]);
    expect(spec.environment.PATH.split(":")).toContain(path.join(home, "tools", "bin"));
    // A Claude Code agent is as before: claude pinned.
    expect(buildServiceSpec({ agent: "a" }, { ...ctx, engine: { kind: "claude", template: "claude-code" } }).programArguments).toContain("--claude-bin");
  });

  it("carries --protocols, so the Mac's service takes work-folder runs only; a typo is refused at install", () => {
    const spec = buildServiceSpec({ agent: "a", protocols: " work-folder " }, ctx);
    expect(spec.programArguments.slice(-2)).toEqual(["--protocols", "work-folder"]);
    // Absent: the service follows the worker's own default (every protocol).
    expect(buildServiceSpec({ agent: "a" }, ctx).programArguments).not.toContain("--protocols");
    expect(() => buildServiceSpec({ agent: "a", protocols: "work-folders" }, ctx)).toThrow(/--protocols takes/);
    expect(() => buildServiceSpec({ agent: "a", protocols: "" }, ctx)).toThrow(/--protocols takes/);
  });

  it("keeps a bare claude name when it is not on PATH", () => {
    const spec = buildServiceSpec({ agent: "a" }, { ...ctx, searchPath: "/nowhere" });
    expect(spec.programArguments.slice(-2)).toEqual(["--claude-bin", "claude"]);
  });

  it("off a Mac, says what to run instead", () => {
    const msg = notMacMessage("linux", buildServiceSpec({ agent: "a", allowedTools: "Read,Bash(git *)" }, ctx));
    expect(msg).toMatch(/runs linux/);
    expect(msg).toContain("/opt/node/v22/bin/node /opt/node/v22/bin/synap worker --agent a");
    expect(msg).toContain("'Read,Bash(git *)'");
  });
});

// ─── install ──────────────────────────────────────────────────────────────────

describe("install", () => {
  it("writes the plist, makes the log folder, enables and bootstraps it", async () => {
    const spec = buildServiceSpec({ agent: "mac" }, ctx);
    const r = await installService(spec, deps);
    expect(r.action).toBe("installed");
    expect(fs.readFileSync(plistPathFor(home, spec.label), "utf8")).toBe(renderPlist(spec));
    expect(fs.statSync(path.dirname(spec.logPath)).isDirectory()).toBe(true);
    expect(ld.calls.filter((c) => c[0] !== "print")).toEqual([
      ["enable", "gui/501/live.synap.worker-mac"],
      ["bootstrap", "gui/501", plistPathFor(home, spec.label)],
    ]);
    expect(ld.loaded.has(spec.label)).toBe(true);
  });

  it("is idempotent: the same settings again change nothing and call nothing but print", async () => {
    const spec = buildServiceSpec({ agent: "mac" }, ctx);
    await installService(spec, deps);
    const file = plistPathFor(home, spec.label);
    const mtime = fs.statSync(file).mtimeMs;
    ld.calls.length = 0;
    const r = await installService(buildServiceSpec({ agent: "mac" }, ctx), deps);
    expect(r.action).toBe("unchanged");
    expect(verbs()).toEqual(["print"]);
    expect(fs.statSync(file).mtimeMs).toBe(mtime);
  });

  it("new settings: rewrites the file, boots out the old one, bootstraps the new", async () => {
    await installService(buildServiceSpec({ agent: "mac" }, ctx), deps);
    ld.calls.length = 0;
    const spec = buildServiceSpec({ agent: "mac", interval: "1m" }, ctx);
    const r = await installService(spec, deps);
    expect(r.action).toBe("updated");
    expect(verbs().filter((v) => v !== "print")).toEqual(["bootout", "enable", "bootstrap"]);
    expect(parsePlist(fs.readFileSync(plistPathFor(home, spec.label), "utf8")).programArguments).toContain("1m");
  });

  it("same file but not loaded (e.g. after stop): enables and bootstraps without rewriting", async () => {
    const spec = buildServiceSpec({ agent: "mac" }, ctx);
    await installService(spec, deps);
    await stopServices(deps, "mac");
    ld.calls.length = 0;
    const r = await installService(spec, deps);
    expect(r.action).toBe("started");
    expect(verbs().filter((v) => v !== "print")).toEqual(["enable", "bootstrap"]);
  });

  it("refuses a second service for the same agent made another way, and --replace swaps it", async () => {
    // The hand-made shape on the founder's Mac: another label, same --agent.
    const handLabel = "live.synap.worker-mac";
    const handFile = plistPathFor(home, handLabel);
    fs.mkdirSync(path.dirname(handFile), { recursive: true });
    fs.writeFileSync(
      handFile,
      `<plist version="1.0"><dict><key>Label</key><string>${handLabel}</string><key>ProgramArguments</key><array>` +
        `<string>/n/node</string><string>/n/synap</string><string>worker</string><string>--agent</string><string>claude-code-mac</string>` +
        `</array><key>StandardOutPath</key><string>/l/worker.log</string></dict></plist>`
    );
    ld.loaded.set(handLabel, { plist: handFile, pid: 9095 });

    const spec = buildServiceSpec({ agent: "claude-code-mac" }, ctx);
    await expect(installService(spec, deps)).rejects.toThrow(/already runs as another service.*live\.synap\.worker-mac.*--replace/s);
    expect(fs.existsSync(plistPathFor(home, spec.label))).toBe(false);
    expect(ld.loaded.has(handLabel)).toBe(true);

    const r = await installService(spec, deps, { replace: true });
    expect(r.action).toBe("installed");
    expect(r.replaced).toEqual([{ label: handLabel, keptAt: path.join(home, ".synap", "worker", "claude-code-mac", "replaced-live.synap.worker-mac.plist") }]);
    expect(ld.loaded.has(handLabel)).toBe(false);
    expect(fs.existsSync(handFile)).toBe(false);
    expect(fs.existsSync(r.replaced[0].keptAt)).toBe(true);
    expect(findServices(home).map((s) => s.label)).toEqual(["live.synap.worker-claude-code-mac"]);
  });

  it("refuses off a Mac before touching anything", async () => {
    await expect(installService(buildServiceSpec({ agent: "mac" }, ctx), { ...deps, platform: "linux" })).rejects.toThrow(/macOS/);
    expect(ld.calls).toEqual([]);
  });

  it("a launchctl failure is said, with its words", async () => {
    const failing: Launchctl = async (args) => (args[0] === "bootstrap" ? { code: 5, stdout: "", stderr: "Bootstrap failed: 5: Input/output error" } : ld.run(args));
    await expect(installService(buildServiceSpec({ agent: "mac" }, ctx), { ...deps, launchctl: failing })).rejects.toThrow(
      /Starting the service failed: launchctl bootstrap gui\/501 .*Input\/output error/
    );
  });
});

// ─── start / stop / status / uninstall ────────────────────────────────────────

describe("start, stop, status, uninstall", () => {
  beforeEach(async () => {
    await installService(buildServiceSpec({ agent: "mac" }, ctx), deps);
    await installService(buildServiceSpec({ agent: "box" }, ctx), deps);
    ld.calls.length = 0;
  });

  it("stop disables then boots out (a kill would be undone by KeepAlive); it acts on every service with no --agent", async () => {
    const out = await stopServices(deps);
    expect(out.map((o) => [o.agent, o.result])).toEqual([
      ["box", "stopped"],
      ["mac", "stopped"],
    ]);
    expect(ld.calls.find((c) => c[0] === "kill")).toBeUndefined();
    expect(ld.calls.filter((c) => c[0] !== "print").map((c) => c.join(" "))).toEqual([
      "disable gui/501/live.synap.worker-box",
      "bootout gui/501/live.synap.worker-box",
      "disable gui/501/live.synap.worker-mac",
      "bootout gui/501/live.synap.worker-mac",
    ]);
    expect((await stopServices(deps, "mac"))[0].result).toBe("already stopped");
  });

  it("start: enables + bootstraps a stopped one, kickstarts a loaded idle one, leaves a running one", async () => {
    await stopServices(deps, "mac");
    ld.calls.length = 0;
    const [started] = await startServices(deps, "mac");
    expect(started.result).toBe("started");
    expect(started.pid).toBeGreaterThan(0);
    expect(ld.calls.filter((c) => c[0] !== "print").map((c) => c[0])).toEqual(["enable", "bootstrap"]);

    ld.loaded.get("live.synap.worker-box")!.pid = undefined;
    ld.calls.length = 0;
    expect((await startServices(deps, "box"))[0].result).toBe("started");
    expect(ld.calls.filter((c) => c[0] !== "print").map((c) => c[0])).toEqual(["enable", "kickstart"]);

    expect((await startServices(deps, "box"))[0].result).toBe("already running");
  });

  it("status: loaded, pid, last exit, disabled, log — for each service", async () => {
    await stopServices(deps, "box");
    const all = await serviceStatuses(deps);
    const box = all.find((s) => s.agent === "box")!;
    const mac = all.find((s) => s.agent === "mac")!;
    expect(box).toMatchObject({ loaded: false, disabled: true, label: "live.synap.worker-box" });
    expect(mac).toMatchObject({ loaded: true, disabled: false, state: "running", lastExitCode: null });
    expect(mac.logPath).toBe(path.join(home, ".synap", "worker", "mac", "worker.log"));
    expect(statusLine(mac, home)).toMatch(/^mac {2}running \(pid \d+\) {2}· live\.synap\.worker-mac · log ~\/\.synap\/worker\/mac\/worker\.log$/);
    expect(statusLine(box, home)).toContain("stopped (stays stopped at login)");
    expect(statusLine({ ...mac, state: "xpcproxy", pid: 7 }, home)).toContain("starting (pid 7)");
  });

  it("an unknown agent is named, with how to set it up", async () => {
    await expect(startServices(deps, "nope")).rejects.toThrow(/No service runs the agent nope.*synap worker install --agent nope/);
  });

  it("uninstall boots out and removes the file, nothing else", async () => {
    const r = await uninstallService(deps, "mac");
    expect(r.result).toBe("removed");
    expect(fs.existsSync(plistPathFor(home, "live.synap.worker-mac"))).toBe(false);
    expect(ld.loaded.has("live.synap.worker-mac")).toBe(false);
    expect(ld.loaded.has("live.synap.worker-box")).toBe(true);
  });
});

// ─── parsing launchctl ────────────────────────────────────────────────────────

describe("launchctl output", () => {
  // Trimmed from a real `launchctl print gui/501/live.synap.worker-mac` (macOS 26).
  const real = [
    "gui/501/live.synap.worker-mac = {",
    "\tactive count = 1",
    "\tpath = /Users/x/Library/LaunchAgents/live.synap.worker-mac.plist",
    "\ttype = LaunchAgent",
    "\tstate = running",
    "",
    "\tprogram = /n/node",
    "\tdomain = gui/501 [100025]",
    "\truns = 1",
    "\tpid = 9095",
    "\timmediate reason = speculative",
    "\tlast exit code = (never exited)",
    "",
    "\tresource coalition = {",
    "\t\tID = 1249",
    "\t\tstate = active",
    "\t}",
    "}",
  ].join("\n");

  it("reads state, pid, runs and last exit of the service, not of its nested blocks", () => {
    expect(parseLaunchctlPrint(real)).toEqual({ state: "running", pid: 9095, runs: 1, lastExitCode: null });
    expect(parseLaunchctlPrint("x = {\n\tstate = not running\n\truns = 3\n\tlast exit code = 78: EX_CONFIG\n}")).toEqual({
      state: "not running",
      runs: 3,
      lastExitCode: 78,
    });
  });

  it("reads the disabled labels", () => {
    const text = 'disabled services = {\n\t\t"com.a" => enabled\n\t\t"live.synap.worker-mac" => disabled\n\t\t"old" => true\n\t}';
    expect([...parseDisabled(text)].sort()).toEqual(["live.synap.worker-mac", "old"]);
  });
});
