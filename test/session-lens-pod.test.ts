/**
 * Unit tests for the pod-qualified session lens.
 *
 * The bug this guards: `SessionLens` stored a workspaceId/projectId with NO pod
 * identity, while `synap pods use` switches the active pod without touching the
 * lens. `resolveHubConfig` then short-circuited the deliberately pod-qualified
 * `getActiveWorkspaceIdForPod(...)` fallback with a workspace belonging to a
 * DIFFERENT pod — "Access denied to workspace" (403).
 *
 * `lensMatchesPod` is pure. `resolveActiveLensForPod` touches ~/.synap/lenses,
 * so it runs against a temp HOME with the module re-imported (LENS_DIR is
 * computed at module load).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { lensMatchesPod, type SessionLens } from "../src/lib/session-lens.js";

const POD_A = "https://pod.perso.example";
const POD_B = "https://pod.team.example";
const WS_A = "aaaaaaaa-1111-2222-3333-444444444444";

describe("lensMatchesPod", () => {
  it("THE BUG: a lens stamped with pod A does NOT match pod B", () => {
    expect(lensMatchesPod({ workspaceId: WS_A, podUrl: POD_A }, POD_B)).toBe(false);
  });

  it("matches its own pod, origin-wise (trailing slash / path insensitive)", () => {
    expect(lensMatchesPod({ podUrl: POD_A }, POD_A)).toBe(true);
    expect(lensMatchesPod({ podUrl: POD_A + "/" }, POD_A)).toBe(true);
    expect(lensMatchesPod({ podUrl: POD_A }, POD_A + "/trpc")).toBe(true);
  });

  it("BACKWARD COMPAT: an unstamped legacy lens matches any pod (lenient)", () => {
    // Every lens file written before `podUrl` existed lacks it. Strict would
    // silently drop the session scope for every existing user on upgrade.
    expect(lensMatchesPod({ workspaceId: WS_A }, POD_B)).toBe(true);
  });

  it("matches when the target pod is unknown (nothing to compare)", () => {
    expect(lensMatchesPod({ workspaceId: WS_A, podUrl: POD_A }, undefined)).toBe(true);
    expect(lensMatchesPod({ workspaceId: WS_A, podUrl: POD_A }, "")).toBe(true);
  });
});

describe("resolveActiveLensForPod", () => {
  let home: string;
  const SESSION = "11111111-2222-3333-4444-555555555555";

  async function loadModule() {
    vi.resetModules();
    return import("../src/lib/session-lens.js");
  }

  function writeLensFile(lens: SessionLens): void {
    const dir = path.join(home, ".synap", "lenses");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, `${SESSION}.json`), JSON.stringify(lens));
  }

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), "synap-lens-"));
    vi.stubEnv("HOME", home);
    vi.stubEnv("USERPROFILE", home);
    vi.stubEnv("SYNAP_LENS_SESSION", SESSION);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    fs.rmSync(home, { recursive: true, force: true });
  });

  it("returns the lens for its own pod", async () => {
    writeLensFile({ workspaceId: WS_A, podUrl: POD_A });
    const { resolveActiveLensForPod } = await loadModule();
    expect(resolveActiveLensForPod(POD_A)?.workspaceId).toBe(WS_A);
  });

  it("THE BUG: returns null for another pod, so the caller falls through to the pod-qualified fallback", async () => {
    writeLensFile({ workspaceId: WS_A, podUrl: POD_A });
    const { resolveActiveLensForPod } = await loadModule();
    expect(resolveActiveLensForPod(POD_B)).toBeNull();
  });

  it("returns an unstamped legacy lens unchanged (backward compat)", async () => {
    writeLensFile({ workspaceId: WS_A });
    const { resolveActiveLensForPod } = await loadModule();
    expect(resolveActiveLensForPod(POD_B)?.workspaceId).toBe(WS_A);
  });

  it("writeLens stamps podUrl and it survives a merge-write", async () => {
    const { writeLens, readLens } = await loadModule();
    writeLens(SESSION, { workspaceId: WS_A, podUrl: POD_A });
    writeLens(SESSION, { focusSessionId: "focus-1" });
    const stored = readLens(SESSION);
    expect(stored?.podUrl).toBe(POD_A);
    expect(stored?.focusSessionId).toBe("focus-1");
  });
});
