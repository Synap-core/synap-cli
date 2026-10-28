/**
 * The worker end to end with a fake `claude`: each code run gets its own tree
 * folder, runs as the App token, and finished runs' trees are swept.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createWorker } from "./worker.js";
import { sweepTreeFolder } from "./worker-worktrees.js";

const git = (cwd: string, ...a: string[]) =>
  execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", ...a], { cwd, encoding: "utf8" });

let home: string;
let oldHome: string | undefined;
let root: string;
let repo: string;
let out: string;
let claude: string;

const SIDS = {
  aaaaaaaa: "aaaaaaaa-0000-4000-8000-000000000001", // clean worktree
  bbbbbbbb: "bbbbbbbb-0000-4000-8000-000000000002", // uncommitted change
  cccccccc: "cccccccc-0000-4000-8000-000000000003", // unpushed commit
};

beforeEach(() => {
  oldHome = process.env.HOME;
  home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "wk-home-")));
  process.env.HOME = home;
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "wk-root-")));
  out = path.join(root, "out");
  fs.mkdirSync(out);
  const origin = path.join(root, "origin.git");
  git(root, "init", "-q", "--bare", origin);
  repo = path.join(root, "code", "repo");
  fs.mkdirSync(repo, { recursive: true });
  git(repo, "init", "-q", "-b", "main");
  fs.writeFileSync(path.join(repo, "f"), "1");
  git(repo, "add", "f");
  git(repo, "commit", "-q", "-m", "init");
  git(repo, "remote", "add", "origin", origin);
  git(repo, "push", "-q", "origin", "main");
  git(repo, "fetch", "-q", "origin");
  claude = path.join(root, "fake-claude.sh");
  // $2 is the prompt; the run makes its worktree in its own cwd, as the prompt tells it.
  fs.writeFileSync(
    claude,
    `#!/bin/sh
sid=$(printf '%s' "$2" | sed -n 's/^Session: \\(........\\).*/\\1/p')
echo "$sid|$PWD|$GH_TOKEN" >> "${out}/runs.log"
git -C "${repo}" worktree add -q --no-track "$PWD/repo" -b "devbox/$sid-x" origin/main
case "$sid" in
  bbbbbbbb) echo dirty > "$PWD/repo/dirty" ;;
  cccccccc) echo c > "$PWD/repo/c" && git -C "$PWD/repo" add c && git -C "$PWD/repo" -c user.email=t@t -c user.name=t commit -q -m c ;;
esac
sleep 1
`,
    { mode: 0o755 }
  );
});

afterEach(() => {
  process.env.HOME = oldHome;
});

const handed = (...ids: string[]) =>
  JSON.stringify({ startHere: { pendingReview: { count: 0 }, handedToYou: { count: ids.length, items: ids.map((id) => ({ id, goal: "g" })) } } });
const sessionText = JSON.stringify({ session: { id: "s", goal: "g" }, outcomes: { status: "ok", outcomes: [] } });

const mk = (ids: string[], deps: { githubToken?: { get(): Promise<string> } } = {}) => {
  const lines: string[] = [];
  const worker = createWorker(
    { agent: "w1-test", cwd: path.join(root, "code"), claudeBin: claude, maxParallel: "3" },
    {
      mcp: {
        call: async (tool: string) =>
          tool === "synap_orient" ? { isError: false, text: handed(...ids) } : { isError: false, text: sessionText },
      },
      podUrl: "http://pod.test",
      apiKey: "k",
      selfAgentId: "self",
      say: (l) => lines.push(l),
      ...deps,
    }
  );
  return { worker, lines };
};

describe("a code run gets a tree folder of its own", () => {
  it("two runs at once work in different folders, as the App token; clean trees go, unpushed or dirty ones stay and are named", async () => {
    const { worker, lines } = mk(Object.values(SIDS), { githubToken: { get: async () => "ghs_app_token" } });
    expect((await worker.tick()).launched).toBe(3);
    await worker.waitForChildren();

    const runs = fs.readFileSync(path.join(out, "runs.log"), "utf8").trim().split("\n").map((l) => l.split("|"));
    const cwds = runs.map((r) => r[1]);
    expect(new Set(cwds).size).toBe(3);
    for (const [sid, cwd, token] of runs) {
      expect(cwd).toBe(path.join(home, ".synap", "worker", "w1-test", "trees", sid));
      expect(token).toBe("ghs_app_token");
    }
    const trees = path.join(home, ".synap", "worker", "w1-test", "trees");
    expect(fs.existsSync(path.join(trees, "aaaaaaaa"))).toBe(false); // clean: removed with its folder
    expect(fs.existsSync(path.join(trees, "bbbbbbbb", "repo", "dirty"))).toBe(true);
    expect(fs.existsSync(path.join(trees, "cccccccc", "repo", "c"))).toBe(true);
    expect(worker.state.runs[SIDS.aaaaaaaa].keptTrees).toBeUndefined();
    expect(worker.state.runs[SIDS.bbbbbbbb].result).toMatch(/KEPT.*uncommitted changes/);
    expect(worker.state.runs[SIDS.cccccccc].result).toMatch(/KEPT.*unpushed commits/);
    expect(lines.join("\n")).not.toContain("ghs_app_token");
  });

  it("the same hand-off is not launched twice, before or after its tree is swept", async () => {
    const { worker } = mk([SIDS.aaaaaaaa], { githubToken: { get: async () => "t" } });
    expect((await worker.tick()).launched).toBe(1);
    expect((await worker.tick()).launched).toBe(0); // still running
    await worker.waitForChildren();
    expect((await worker.tick()).launched).toBe(0); // done, tree swept
    expect(fs.readFileSync(path.join(out, "runs.log"), "utf8").trim().split("\n")).toHaveLength(1);
  });

  it("without the App files it still runs, and says LOUDLY whose login it uses", async () => {
    const { worker, lines } = mk([SIDS.aaaaaaaa]);
    expect((await worker.tick()).launched).toBe(1);
    await worker.waitForChildren();
    expect(lines.filter((l) => l.includes("WARNING") && l.includes("environment's GitHub login"))).toHaveLength(1);
  });

  it("a failing App token does not launch the run, and does not record it (retried next tick)", async () => {
    const { worker, lines } = mk([SIDS.aaaaaaaa], {
      githubToken: {
        get: async () => {
          throw new Error("GitHub POST … answered 401");
        },
      },
    });
    expect((await worker.tick()).launched).toBe(1); // counted as attempted; nothing ran
    expect(worker.state.runs[SIDS.aaaaaaaa]).toBeUndefined();
    expect(fs.existsSync(path.join(out, "runs.log"))).toBe(false);
    expect(lines.join("\n")).toMatch(/no GitHub App token.*not launching/);
  });
});

describe("sweepTreeFolder", () => {
  it("an unreadable status keeps the folder (never deletes on doubt)", async () => {
    const folder = path.join(root, "tree");
    fs.mkdirSync(path.join(folder, "repo"), { recursive: true });
    fs.writeFileSync(path.join(folder, "repo", ".git"), "gitdir: nowhere");
    const r = await sweepTreeFolder(folder, async () => ({ code: 128, stdout: "" }));
    expect(r.removed).toEqual([]);
    expect(r.kept[0].why).toBe("git status failed");
    expect(fs.existsSync(path.join(folder, "repo"))).toBe(true);
  });
});
