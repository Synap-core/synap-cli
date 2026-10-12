/**
 * S1 — a URL is never handed to a shell, and a pod-supplied approval link is
 * opened only on that pod's own origin (or its pod-admin origin).
 *
 * The defect: `openBrowserUrl` ran `exec(\`open "${url}"\`)` escaping only `"`,
 * so `$(…)` or backticks inside a pod-supplied URL executed on this computer.
 * The test drives the REAL exported openers with `node:child_process` mocked,
 * and asserts the shell door (`exec` / `execSync`) is never reached.
 *
 * Not covered: what the OS opener does with the URL once it has it (that is
 * the browser's job), and Windows at runtime (argv is asserted, not executed).
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const calls = vi.hoisted(() => ({ exec: [] as unknown[][], execSync: [] as unknown[][], execFile: [] as unknown[][] }));

vi.mock("node:child_process", async (orig) => {
  const real = await orig<typeof import("node:child_process")>();
  return {
    ...real,
    exec: (...a: unknown[]) => {
      calls.exec.push(a);
      return { unref() {} };
    },
    execSync: (...a: unknown[]) => {
      calls.execSync.push(a);
      return "";
    },
    execFile: (...a: unknown[]) => {
      calls.execFile.push(a);
      return { unref() {} };
    },
  };
});

import { openBrowserUrl } from "../src/lib/targets.js";
import { openBrowser } from "../src/lib/auth.js";
import { openExternalUrl, openerArgv, openPodPage, podPageRefusal } from "../src/lib/safe-open.js";
import { fixKeyHealth, type KeyHealthReport } from "../src/lib/key-doctor.js";

const EVIL = "https://pod.example.synap.live/x$(touch /tmp/synap-pwned)`id`\"&calc";

beforeEach(() => {
  calls.exec.length = 0;
  calls.execSync.length = 0;
  calls.execFile.length = 0;
  vi.stubEnv("DISPLAY", ":0");
});

describe("openBrowserUrl / openBrowser — no shell, ever", () => {
  for (const [name, fn] of [
    ["targets.openBrowserUrl", openBrowserUrl],
    ["auth.openBrowser", openBrowser],
  ] as const) {
    it(`${name} hands the URL to the OS opener as ONE argv element, never to a shell`, () => {
      fn(EVIL);
      expect(calls.exec).toHaveLength(0);
      expect(calls.execSync).toHaveLength(0);
      expect(calls.execFile).toHaveLength(1);
      const [cmd, args] = calls.execFile[0] as [string, string[]];
      expect(cmd).toBe(openerArgv("x")!.cmd);
      // The URL arrives as ONE argument; `$(…)` in it is inert because no shell reads it.
      expect(args.at(-1)).toBe(new URL(EVIL).href);
    });
  }

  it("refuses anything that is not http(s)", () => {
    for (const u of ["file:///etc/passwd", "javascript:alert(1)", "synap://x", "not a url", "-a /Applications/Calculator.app"])
      expect(openExternalUrl(u)).toBe(false);
    expect(calls.execFile).toHaveLength(0);
  });

  it("uses argv on every platform (Windows: rundll32, not `start` through cmd.exe)", () => {
    expect(openerArgv("https://a/b?x=1&y=2", "win32")).toEqual({ cmd: "rundll32", args: ["url.dll,FileProtocolHandler", "https://a/b?x=1&y=2"] });
    expect(openerArgv("https://a", "linux")).toEqual({ cmd: "xdg-open", args: ["https://a"] });
    expect(openerArgv("https://a", "darwin")).toEqual({ cmd: "open", args: ["https://a"] });
  });
});

describe("openPodPage — a pod-supplied link opens only on that pod", () => {
  const POD = "https://pod.example.synap.live";

  it("allows the pod and its pod-admin origin", () => {
    expect(podPageRefusal("https://pod-admin.example.synap.live/approve-agent/k1", POD)).toBeNull();
    expect(podPageRefusal("https://pod.example.synap.live/open/x", POD)).toBeNull();
    expect(podPageRefusal("http://localhost:4040/approve-agent/k", "http://localhost:4000")).toBeNull();
  });

  it("refuses any other origin, and non-http schemes", () => {
    const open = vi.fn();
    expect(openPodPage("https://evil.example/approve-agent/k1", POD, open)).toBe(false);
    expect(openPodPage("https://pod-admin.example.synap.live.evil.io/x", POD, open)).toBe(false);
    expect(openPodPage("http://pod-admin.example.synap.live/x", POD, open)).toBe(false); // downgraded scheme
    expect(openPodPage("javascript:alert(1)", POD, open)).toBe(false);
    expect(open).not.toHaveBeenCalled();
  });

  it("doctor --fix never opens an approval link the pod pointed off-pod", async () => {
    const opened: string[] = [];
    const report: KeyHealthReport = {
      podUrl: POD,
      locations: [],
      states: new Map(),
      podDescribesKeys: true,
      diagnoses: [
        {
          code: "awaiting_approval",
          severity: "error",
          surface: "codex",
          label: "Codex",
          title: "Codex is waiting",
          lines: [],
          action: "approve_and_wait",
          key: "k-pending",
          approvalUrl: "https://evil.example/approve-agent/k1?$(id)",
          locations: [],
        },
      ],
    };
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    await fixKeyHealth(report, { openUrl: (u) => opened.push(u), wait: async () => "timeout" });
    expect(opened).toEqual([]);
  });
});

describe("tripwire: no shell-string URL opener anywhere in src/", () => {
  // Hunts the exact shape that shipped: a template literal starting with an OS
  // opener and interpolating a value — `open "${url}"`, `start "" "${url}"`,
  // `xdg-open "${url}"`. It does NOT catch an opener built by concatenation;
  // the argv-only `safe-open.ts` is the door, this catches a copy of the old one.
  const SHAPE = /`\s*(?:open|xdg-open|start\s+"")\s+"\$\{/;
  it("finds none (and can still see the shape it hunts)", async () => {
    const fs = await import("node:fs");
    const path = await import("node:path");
    const files: string[] = [];
    const walk = (d: string) => {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        const p = path.join(d, e.name);
        if (e.isDirectory()) walk(p);
        else if (/\.ts$/.test(e.name) && !/\.test\.ts$/.test(e.name)) files.push(p);
      }
    };
    walk(path.join(__dirname, "..", "src"));
    expect(files.length).toBeGreaterThan(100); // non-vacuity: the scan sees the tree
    expect(SHAPE.test('`open "${url}"`')).toBe(true); // self-check: the regex still matches the defect
    expect(SHAPE.test('`start "" "${safe}"`')).toBe(true);
    const hits = files.filter((f) => SHAPE.test(fs.readFileSync(f, "utf8")));
    expect(hits).toEqual([]);
  });
});
