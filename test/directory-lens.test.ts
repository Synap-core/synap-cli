/**
 * Per-directory lens — discovery, pod-qualification, write safety, provenance.
 *
 * RATIFIED: `./.synap/lens.json` is the durable default scope for a working
 * tree; the per-Claude-session lens is an explicit override on top of it.
 * Precedence: explicit flag › session lens › DIRECTORY lens › env var › global
 * config.
 *
 * The pod-qualification tests matter most: a directory lens outlives many
 * `synap pods use` switches, so a lens stamped for pod A must never contribute
 * a workspace id to a call against pod B — that is the "Access denied to
 * workspace" 403. The comparison is delegated to `lensMatchesPod`
 * (session-lens.ts), and these tests pin that it is genuinely the same rule,
 * including its deliberate leniency for un-stamped legacy lenses.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  findDirectoryLens,
  resolveDirectoryLensForPod,
  lensSearchPath,
  directoryLensWriteTarget,
  writeDirectoryLens,
  clearDirectoryLensField,
} from "../src/lib/directory-lens.js";
import { resolveLensProvenance } from "../src/lib/describe-lens.js";

const POD_A = "https://pod.perso.thearchitech.xyz";
const POD_B = "https://pod.team.thearchitech.xyz";
const WS_A = "808939d1-86b3-4c52-a153-ae06ece2c54e";

let root: string;

/** Create `<root>/<rel>/.synap/lens.json` with `lens`. */
function seedLens(rel: string, lens: Record<string, unknown>): string {
  const dir = path.join(root, rel);
  fs.mkdirSync(path.join(dir, ".synap"), { recursive: true });
  const file = path.join(dir, ".synap", "lens.json");
  fs.writeFileSync(file, JSON.stringify(lens));
  return file;
}

beforeEach(() => {
  // Inside the home dir on purpose: the walk stops at `~`, and the write guard
  // only adopts an ancestor lens that sits at or below it. A tmpdir outside
  // home would exercise a different branch than real usage.
  root = fs.mkdtempSync(path.join(os.homedir(), ".synap-dirlens-test-"));
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe("discovery walks UP like git finding .git", () => {
  it("finds a lens in the cwd itself", () => {
    const file = seedLens("repo", { workspaceId: WS_A, podUrl: POD_A });
    const found = findDirectoryLens(path.join(root, "repo"));
    expect(found?.file).toBe(file);
    expect(found?.lens.workspaceId).toBe(WS_A);
  });

  it("finds an ancestor's lens from a nested subdirectory", () => {
    const file = seedLens("repo", { workspaceId: WS_A, podUrl: POD_A });
    const deep = path.join(root, "repo", "packages", "api", "src");
    fs.mkdirSync(deep, { recursive: true });
    expect(findDirectoryLens(deep)?.file).toBe(file);
  });

  it("prefers the NEAREST lens when both a repo and a subpackage declare one", () => {
    seedLens("repo", { workspaceId: WS_A, podUrl: POD_A });
    const inner = seedLens(path.join("repo", "packages", "api"), {
      workspaceId: "inner-ws",
      podUrl: POD_A,
    });
    const found = findDirectoryLens(path.join(root, "repo", "packages", "api"));
    expect(found?.file).toBe(inner);
    expect(found?.lens.workspaceId).toBe("inner-ws");
  });

  it("returns null when no lens exists anywhere on the walk", () => {
    const dir = path.join(root, "bare");
    fs.mkdirSync(dir, { recursive: true });
    expect(findDirectoryLens(dir)).toBeNull();
  });

  it("stops at the home dir — never considers a directory above ~", () => {
    const dirs = lensSearchPath(path.join(root, "repo", "deep"));
    const home = path.resolve(os.homedir());
    expect(dirs).toContain(home);
    // Nothing above home is searched: a lens in `/` or `/Users` would silently
    // scope every unrelated project on the machine.
    for (const d of dirs) {
      expect(d === home || d.startsWith(home + path.sep)).toBe(true);
    }
    // And the walk terminates rather than looping at the root.
    expect(dirs[dirs.length - 1]).toBe(home);
  });

  it("treats a corrupt lens file as absent rather than crashing", () => {
    const dir = path.join(root, "repo");
    fs.mkdirSync(path.join(dir, ".synap"), { recursive: true });
    fs.writeFileSync(path.join(dir, ".synap", "lens.json"), "{ not json");
    expect(findDirectoryLens(dir)).toBeNull();
  });
});

describe("pod qualification reuses lensMatchesPod — no second comparison", () => {
  it("returns the lens when the pod matches", () => {
    seedLens("repo", { workspaceId: WS_A, podUrl: POD_A });
    expect(resolveDirectoryLensForPod(POD_A, path.join(root, "repo"))?.lens.workspaceId).toBe(WS_A);
  });

  it("IGNORES a lens stamped for a different pod — the 403 this closes", () => {
    seedLens("repo", { workspaceId: WS_A, podUrl: POD_A });
    // The file is still discoverable...
    expect(findDirectoryLens(path.join(root, "repo"))).not.toBeNull();
    // ...but must not contribute a pod-local workspace id to a call on POD_B.
    expect(resolveDirectoryLensForPod(POD_B, path.join(root, "repo"))).toBeNull();
  });

  it("accepts an UNSTAMPED legacy lens (same leniency as the session lens)", () => {
    seedLens("repo", { workspaceId: WS_A });
    expect(resolveDirectoryLensForPod(POD_B, path.join(root, "repo"))?.lens.workspaceId).toBe(WS_A);
  });

  it("accepts any lens when the target pod is unknown", () => {
    seedLens("repo", { workspaceId: WS_A, podUrl: POD_A });
    expect(resolveDirectoryLensForPod(undefined, path.join(root, "repo"))?.lens.workspaceId).toBe(WS_A);
  });
});

describe("write safety", () => {
  it("creates the lens in the cwd when no ancestor declares one", () => {
    const dir = path.join(root, "fresh");
    fs.mkdirSync(dir, { recursive: true });
    const written = writeDirectoryLens({ workspaceId: WS_A, podUrl: POD_A }, dir);
    expect(written.file).toBe(path.join(dir, ".synap", "lens.json"));
    expect(JSON.parse(fs.readFileSync(written.file, "utf-8")).workspaceId).toBe(WS_A);
  });

  it("re-pins the EXISTING repo lens from a subdirectory instead of nesting a new one", () => {
    const repoLens = seedLens("repo", { workspaceId: "old", podUrl: POD_A });
    const deep = path.join(root, "repo", "packages", "api");
    fs.mkdirSync(deep, { recursive: true });

    expect(directoryLensWriteTarget(deep)).toBe(path.join(root, "repo"));
    const written = writeDirectoryLens({ workspaceId: WS_A, podUrl: POD_A }, deep);
    expect(written.file).toBe(repoLens);
    // No stray nested lens was seeded.
    expect(fs.existsSync(path.join(deep, ".synap", "lens.json"))).toBe(false);
  });

  it("merges rather than replacing — pinning a project keeps the workspace", () => {
    const dir = path.join(root, "repo");
    fs.mkdirSync(dir, { recursive: true });
    writeDirectoryLens({ workspaceId: WS_A, podUrl: POD_A }, dir);
    const after = writeDirectoryLens({ projectId: "proj-1", podUrl: POD_A }, dir);
    expect(after.lens.workspaceId).toBe(WS_A);
    expect(after.lens.projectId).toBe("proj-1");
  });

  it("never writes above the home dir", () => {
    const home = path.resolve(os.homedir());
    // Even from a deep path, the target is a real directory at or below home.
    const target = directoryLensWriteTarget(path.join(root, "repo", "a", "b"));
    expect(target === home || target.startsWith(home + path.sep)).toBe(true);
    expect(target).not.toBe(path.parse(home).root);
  });
});

describe("clearing", () => {
  it("removes one field and leaves the rest", () => {
    const dir = path.join(root, "repo");
    fs.mkdirSync(dir, { recursive: true });
    writeDirectoryLens({ workspaceId: WS_A, projectId: "proj-1", podUrl: POD_A }, dir);
    const cleared = clearDirectoryLensField("workspaceId", dir);
    expect(cleared).not.toBeNull();
    const after = findDirectoryLens(dir)!.lens;
    expect(after.workspaceId).toBeUndefined();
    expect(after.projectId).toBe("proj-1");
  });

  it("reports null when there is nothing to clear", () => {
    const dir = path.join(root, "bare");
    fs.mkdirSync(dir, { recursive: true });
    expect(clearDirectoryLensField("workspaceId", dir)).toBeNull();
  });
});

describe("provenance says WHICH rung won", () => {
  it("session lens overrides the directory lens", () => {
    const p = resolveLensProvenance([
      { source: "session", workspaceId: "ws-session", detail: "abcd1234" },
      { source: "directory", workspaceId: "ws-dir", detail: "/repo/.synap/lens.json" },
      { source: "global", workspaceId: "ws-global", detail: "~/.synap/config.json" },
    ]);
    expect(p.workspace?.id).toBe("ws-session");
    expect(p.workspace?.source).toBe("session");
  });

  it("names the directory lens FILE when it is the winner", () => {
    const p = resolveLensProvenance([
      { source: "session" },
      { source: "directory", workspaceId: "ws-dir", detail: "/repo/.synap/lens.json" },
      { source: "env", workspaceId: "ws-env", detail: "SYNAP_WORKSPACE_ID" },
    ]);
    expect(p.workspace?.source).toBe("directory");
    // This exact string is what `synap lens` prints in parentheses — a
    // silently-resolved scope is what made the 403 class unexplainable.
    expect(p.workspace?.origin).toBe("directory lens: /repo/.synap/lens.json");
  });

  it("ranks the directory lens ABOVE the env var and global config", () => {
    const p = resolveLensProvenance([
      { source: "session" },
      { source: "directory", workspaceId: "ws-dir", detail: "/repo/.synap/lens.json" },
      { source: "env", workspaceId: "ws-env" },
      { source: "global", workspaceId: "ws-global" },
    ]);
    expect(p.workspace?.id).toBe("ws-dir");
  });

  it("falls through per FIELD, not per rung", () => {
    // The session lens pins only a project; the workspace must still come from
    // the directory lens rather than being dropped.
    const p = resolveLensProvenance([
      { source: "session", projectId: "proj-session" },
      { source: "directory", workspaceId: "ws-dir", detail: "/repo/.synap/lens.json" },
    ]);
    expect(p.project?.source).toBe("session");
    expect(p.workspace?.source).toBe("directory");
  });

  it("reports undefined when no rung supplies a field", () => {
    const p = resolveLensProvenance([{ source: "session" }, { source: "directory" }]);
    expect(p.workspace).toBeUndefined();
    expect(p.project).toBeUndefined();
  });
});
