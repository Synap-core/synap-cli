/**
 * Line 2 of the status line, through the REAL exported `statusline()`:
 * refresh writes the caches from a mocked pod, render prints from them.
 *
 * - a failed needs-you read is shown as OLD (dimmed, with its age), never as
 *   a fresh count (review 27d65a72, must-fix 2: the empty-vs-failed rule);
 * - "N need you" opens the desktop's Inbox, the page the browser opens for
 *   needs-you, not the pod's review queue;
 * - the project shows its NAME (the single-row route answers the row);
 * - no pod string reaches the terminal with its control characters.
 *
 * Only `statusline()` is imported, so this file also runs against a tree
 * without the fixes (the negative control).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { convCachePath, podCacheFile } from "../lib/statusline-store.js";

const tmpFiles = new Map<string, string>();
let stdin = "";
const isTmp = (p: unknown) => typeof p === "string" && /[/\\]\.synap[/\\]statusline[/\\](pod|conv)-/.test(p);

vi.mock("node:fs", async () => {
  const real = await vi.importActual<typeof import("node:fs")>("node:fs");
  const fs = {
    ...real,
    readFileSync: ((p: unknown, ...rest: unknown[]) => {
      if (p === 0) return stdin;
      if (isTmp(p)) {
        if (!tmpFiles.has(p as string)) throw new Error(`ENOENT ${String(p)}`);
        return tmpFiles.get(p as string)!;
      }
      return (real.readFileSync as (...a: unknown[]) => unknown)(p, ...rest);
    }) as typeof real.readFileSync,
    writeFileSync: ((p: unknown, data: unknown, ...rest: unknown[]) => {
      if (isTmp(p)) return void tmpFiles.set(p as string, String(data));
      return (real.writeFileSync as (...a: unknown[]) => unknown)(p, data, ...rest);
    }) as typeof real.writeFileSync,
    chmodSync: ((p: unknown, ...rest: unknown[]) => {
      if (isTmp(p)) return;
      return (real.chmodSync as (...a: unknown[]) => unknown)(p, ...rest);
    }) as typeof real.chmodSync,
    unlinkSync: ((p: unknown) => {
      if (isTmp(p)) return void tmpFiles.delete(p as string);
      return real.unlinkSync(p as string);
    }) as typeof real.unlinkSync,
    statSync: ((p: unknown, ...rest: unknown[]) => {
      if (isTmp(p)) {
        if (!tmpFiles.has(p as string)) throw new Error(`ENOENT ${String(p)}`);
        return { mtimeMs: Date.now(), size: tmpFiles.get(p as string)!.length };
      }
      return (real.statSync as (...a: unknown[]) => unknown)(p, ...rest);
    }) as typeof real.statSync,
  };
  return { ...fs, default: fs };
});

// A refresh render wants is recorded, never run.
const spawn = vi.fn((_cmd: string, _args: string[]) => ({ unref: () => {} }));
vi.mock("node:child_process", () => ({
  spawn: (cmd: string, args: string[]) => spawn(cmd, args),
  execSync: () => "",
  execFileSync: () => "",
}));

const PROJECT_ID = "d4b84ad8-6fbe-4c09-9cee-5715be1637d9";
const hubGet = vi.fn();
vi.mock("../lib/hub-client.js", async () => {
  const real = await vi.importActual<Record<string, unknown>>("../lib/hub-client.js");
  return {
    ...real,
    resolveHubConfig: async () => ({
      podUrl: "https://pod.test",
      apiKey: "k",
      workspaceId: "ws-A",
      projectId: process.env.TEST_PROJECT_ID || undefined,
    }),
    hubGet: (...args: unknown[]) => hubGet(...(args as [])),
  };
});
vi.mock("../lib/session-lens.js", () => ({ resolveActiveLens: () => null }));
vi.mock("../lib/pod.js", () => ({ getSurfaceAgentKey: () => null, SURFACE_NAMES: [] }));

const { statusline } = await import("./statusline.js");

const SHARED = podCacheFile();
const CONV = "eeee1111-2222-3333-4444-555555555555";
const CONV_FILE = convCachePath(CONV);
const BOLD_YELLOW = "\x1b[01;33m";
// eslint-disable-next-line no-control-regex
const plain = (s: string) => s.replace(/\x1b\[[0-9;]*m|\x1b\]8;;[^\x1b]*\x1b\\/g, "");

interface Pod {
  needsYou?: number | "fail";
  workspaceName?: string;
  goal?: string;
  project?: unknown;
}
function pod(p: Pod = {}): void {
  hubGet.mockImplementation(async (path: string) => {
    if (path === "/workspaces") return { workspaces: [{ id: "ws-A", name: p.workspaceName ?? "Alpha", entityCount: 3 }] };
    if (path.startsWith("/agent-skills")) return { total: 7 };
    if (path === "/needs-you") {
      if (p.needsYou === "fail") throw Object.assign(new Error("500"), { status: 500 });
      return { count: { needsYou: p.needsYou ?? 3, truncated: false } };
    }
    if (path.startsWith("/focus-sessions")) return { sessions: [{ id: "fs-1", goal: p.goal ?? "Ship RF-cli" }] };
    if (path === `/projects/${PROJECT_ID}`) return p.project ?? { id: PROJECT_ID, name: "Synap", usedWorkspaceIds: [] };
    return null;
  });
}

const due = (file: string) => tmpFiles.set(file, JSON.stringify({ ...JSON.parse(tmpFiles.get(file)!), attemptedTs: 0 }));
const shared = () => JSON.parse(tmpFiles.get(SHARED)!);

async function refresh(): Promise<void> {
  vi.stubEnv("SYNAP_LENS_SESSION", CONV);
  await statusline({ refresh: true });
}

/** The raw lines (ANSI kept) of one render. */
async function render(): Promise<string[]> {
  stdin = JSON.stringify({ session_id: CONV, model: { display_name: "Opus" } });
  const out: string[] = [];
  const log = vi.spyOn(console, "log").mockImplementation((s: unknown) => void out.push(String(s)));
  try {
    await statusline();
  } finally {
    log.mockRestore();
  }
  return out;
}

beforeEach(() => {
  tmpFiles.clear();
  spawn.mockClear();
  hubGet.mockReset();
  vi.stubEnv("CLAUDE_CODE_SESSION_ID", "");
  vi.stubEnv("SYNAP_STATUSLINE_TRANSCRIPT", "");
  vi.stubEnv("TEST_PROJECT_ID", "");
});
afterEach(() => vi.unstubAllEnvs());

describe("needs you: a failed read is old, never fresh", () => {
  it("a good read is drawn as a fresh count", async () => {
    pod({ needsYou: 3 });
    await refresh();
    const [, l2] = await render();
    expect(plain(l2!)).toContain("↳ 3 need you");
    expect(plain(l2!)).not.toContain("⚑");
    expect(l2).toContain(`${BOLD_YELLOW}`); // the fresh count's colour
  });

  it("a failed read keeps the count and its MEASURED time, and the line says how old it is", async () => {
    pod({ needsYou: 3 });
    await refresh();
    const measured = shared().needsYouAt;
    expect(typeof measured).toBe("number");

    pod({ needsYou: "fail" });
    due(SHARED);
    await refresh();
    expect(shared()).toMatchObject({ ok: true, needsYouCount: 3, needsYouOk: false, needsYouAt: measured });

    // 12 minutes on, still failing: the number is 12 minutes old, and says so.
    tmpFiles.set(SHARED, JSON.stringify({ ...shared(), needsYouAt: Date.now() - 12 * 60_000 }));
    const [, l2] = await render();
    expect(plain(l2!)).toContain("↳ 3 need you · ⚑ 12m old");
    expect(l2).not.toContain(`${BOLD_YELLOW}3 need you`);
  });

  it("a failed read right after a good one is still not drawn as fresh", async () => {
    pod({ needsYou: 3 });
    await refresh();
    pod({ needsYou: "fail" });
    due(SHARED);
    await refresh();
    const [, l2] = await render();
    expect(plain(l2!)).toMatch(/↳ 3 need you · ⚑ \d+s old/);
  });

  it("a pod that cannot be reached at all marks the count old too", async () => {
    pod({ needsYou: 3 });
    await refresh();
    hubGet.mockRejectedValue(new Error("502"));
    due(SHARED);
    await refresh();
    const [, l2] = await render();
    expect(plain(l2!)).toMatch(/↳ 3 need you · ⚑ \d+s old/);
  });

  it("a failed read with no measurement time to show says it was not read", async () => {
    // A cache from an older CLI (no `needsYouAt`) whose next read failed.
    tmpFiles.set(SHARED, JSON.stringify({ ts: Date.now() - 300_000, attemptedTs: 0, ok: true, workspaces: [], needsYouCount: 5, needsYouFetched: true }));
    pod({ needsYou: "fail" });
    await refresh();
    const [, l2] = await render();
    expect(plain(l2!)).toContain("↳ 5 need you · ⚑ not read");
  });

  it("a measured zero stays '0 need you'; never measured stays 'need you —'", async () => {
    pod({ needsYou: "fail" });
    await refresh();
    expect(plain((await render())[1]!)).toContain("↳ need you —");
    pod({ needsYou: 0 });
    due(SHARED);
    await refresh();
    expect(plain((await render())[1]!)).toMatch(/↳ 0 need you$/);
  });
});

describe("needs you opens the desktop's Inbox", () => {
  it("links to synap://open/app/inbox for the whole pod, not the review queue", async () => {
    pod({ needsYou: 3 });
    await refresh();
    const [, l2] = await render();
    expect(l2).toContain("\x1b]8;;synap://open/app/inbox?scope=pod\x1b\\3 need you");
    expect(l2).not.toContain("/open/proposals");
  });
});

describe("the project shows its name", () => {
  it("reads the name from the single-project route's row", async () => {
    vi.stubEnv("TEST_PROJECT_ID", PROJECT_ID);
    pod();
    await refresh();
    expect(JSON.parse(tmpFiles.get(CONV_FILE)!)).toMatchObject({ projectId: PROJECT_ID, projectName: "Synap" });
    const [, l2] = await render();
    expect(plain(l2!)).toContain("Synap");
    expect(plain(l2!)).not.toContain(PROJECT_ID);
  });
});

describe("no pod string reaches the terminal with its control characters", () => {
  it("a name carrying an OSC 8 link, a colour or a bell is printed inert", async () => {
    pod({
      workspaceName: "Al\x1b]8;;https://evil.test\x1b\\pha\x07",
      goal: "\x1b[31mred\x1b[0m goal\x9b2J",
    });
    await refresh();
    const [, l2] = await render();
    expect(l2).not.toContain("\x1b]8;;https://evil.test");
    expect(l2).not.toContain("\x1b[31m");
    expect(l2).not.toContain("\x07");
    expect(l2).not.toContain("\x9b");
    expect(plain(l2!)).toContain("red[0m goal");
  });
});
