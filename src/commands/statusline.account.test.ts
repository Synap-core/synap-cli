/**
 * The ClaudeSwitch account segment on line 3, through the REAL `statusline()`:
 * drawn when the session was moved or the account is at 20% left or less;
 * absent, malformed or normal leaves the output exactly as before.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

let stdin = "";
vi.mock("node:fs", async () => {
  const real = await vi.importActual<typeof import("node:fs")>("node:fs");
  const fs = {
    ...real,
    readFileSync: ((p: unknown, ...rest: unknown[]) => {
      if (p === 0) return stdin;
      if (typeof p === "string" && /[/\\]\.synap[/\\]statusline[/\\]/.test(p)) throw new Error("ENOENT");
      return (real.readFileSync as (...a: unknown[]) => unknown)(p, ...rest);
    }) as typeof real.readFileSync,
  };
  return { ...fs, default: fs };
});
vi.mock("node:child_process", () => ({
  spawn: () => ({ unref: () => {} }),
  execSync: () => "",
  execFileSync: () => "",
}));
vi.mock("../lib/session-lens.js", () => ({ resolveActiveLens: () => null }));
vi.mock("../lib/pod.js", () => ({ getSurfaceAgentKey: () => null, SURFACE_NAMES: [] }));

const { statusline } = await import("./statusline.js");

const SID = "aaaa1111-2222-3333-4444-555555555555";
// eslint-disable-next-line no-control-regex
const plain = (s: string) => s.replace(/\x1b\[[0-9;]*m|\x1b\]8;;[^\x1b]*\x1b\\/g, "");

async function render(): Promise<string[]> {
  stdin = JSON.stringify({
    session_id: SID,
    model: { display_name: "Opus" },
    rate_limits: { five_hour: { used_percentage: 40 }, seven_day: { used_percentage: 10 } },
  });
  const out: string[] = [];
  const log = vi.spyOn(console, "log").mockImplementation((s: unknown) => void out.push(String(s)));
  try {
    await statusline();
  } finally {
    log.mockRestore();
  }
  return out;
}
const line3 = (l: string[]) => l.find((x) => plain(x).includes("5h"))!;

beforeEach(() => {
  vi.stubEnv("CLAUDE_SWITCH_STATUS", "");
  vi.stubEnv("CLAUDE_SWITCH_MOVED", "");
  vi.stubEnv("CLAUDE_CODE_SESSION_ID", "");
});
afterEach(() => vi.unstubAllEnvs());

describe("ClaudeSwitch account segment", () => {
  it("absent: line 3 is byte-identical to today's", async () => {
    const base = await render();
    expect(plain(line3(base))).toBe("5h 40%  7d 10%");
    vi.stubEnv("CLAUDE_SWITCH_STATUS", "work 80% left");
    expect(await render()).toEqual(base); // normal and not moved: hidden
  });
  it("moved session shows it even with plenty left", async () => {
    vi.stubEnv("CLAUDE_SWITCH_STATUS", "work 80% left");
    vi.stubEnv("CLAUDE_SWITCH_MOVED", `personal:${SID}`);
    expect(plain(line3(await render()))).toBe("5h 40%  7d 10%  work 80% left");
  });
  it("another session's move does not show it", async () => {
    vi.stubEnv("CLAUDE_SWITCH_STATUS", "work 80% left");
    vi.stubEnv("CLAUDE_SWITCH_MOVED", "personal:other-session");
    expect(plain(line3(await render()))).toBe("5h 40%  7d 10%");
  });
  it("low (20 or less) shows it; 21 hides it", async () => {
    vi.stubEnv("CLAUDE_SWITCH_STATUS", "work 20% left");
    expect(plain(line3(await render()))).toBe("5h 40%  7d 10%  work 20% left");
    vi.stubEnv("CLAUDE_SWITCH_STATUS", "work 21% left");
    expect(plain(line3(await render()))).toBe("5h 40%  7d 10%");
  });
  it("malformed or number-less values change nothing, even when moved", async () => {
    const base = await render();
    vi.stubEnv("CLAUDE_SWITCH_MOVED", `personal:${SID}`);
    for (const v of ["work", "work left", "work abc% left", "work 150% left", "work 5%"]) {
      vi.stubEnv("CLAUDE_SWITCH_STATUS", v);
      expect(await render(), v).toEqual(base);
    }
  });
});
