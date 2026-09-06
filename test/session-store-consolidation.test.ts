/**
 * ONE "current session" store — the legacy per-CWD `.synap-session` retired.
 *
 * Before this, `sessionHeaders()` read the Claude-session lens OR a per-CWD
 * `.synap-session` file: two concurrent stores for one concept where the lens
 * silently shadowed the file. These tests pin the consolidated contract:
 *
 *   env SYNAP_SESSION_ID › session lens (per Claude tab) › directory lens
 *
 * plus the two things a consolidation can silently break — an existing
 * `.synap-session` must not lose the user their attached session (migration),
 * and `attach` outside Claude Code must not no-op (directory-lens fallback).
 *
 * The module memoizes the migration check per process, so every case that
 * touches it re-imports through `vi.resetModules()`.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { readLens, writeLens } from "../src/lib/session-lens.js";

const POD_A = "https://pod.perso.thearchitech.xyz";
const POD_B = "https://pod.team.thearchitech.xyz";
const SESSION_X = "11111111-1111-4111-8111-111111111111";
const SESSION_Y = "22222222-2222-4222-8222-222222222222";

let root: string;
let cwdSpy: ReturnType<typeof vi.spyOn>;
/** Synthetic CLAUDE_CODE_SESSION_ID — its lens file is removed in afterEach. */
let claudeSession: string | undefined;

async function loadHubClient() {
  vi.resetModules();
  return import("../src/lib/hub-client.js");
}

function lensFileFor(sessionId: string): string {
  return path.join(os.homedir(), ".synap", "lenses", `${sessionId}.json`);
}

function enterClaudeSession(): string {
  claudeSession = `test-${Math.random().toString(36).slice(2)}`;
  process.env.CLAUDE_CODE_SESSION_ID = claudeSession;
  return claudeSession;
}

function seedDirectoryLens(lens: Record<string, unknown>): void {
  fs.mkdirSync(path.join(root, ".synap"), { recursive: true });
  fs.writeFileSync(path.join(root, ".synap", "lens.json"), JSON.stringify(lens));
}

function readDirectoryLens(): Record<string, unknown> | null {
  try {
    return JSON.parse(fs.readFileSync(path.join(root, ".synap", "lens.json"), "utf-8"));
  } catch {
    return null;
  }
}

beforeEach(() => {
  // Inside home on purpose — the directory-lens walk stops at `~` and its write
  // guard only adopts a lens at or below it (same reason as directory-lens.test).
  root = fs.mkdtempSync(path.join(os.homedir(), ".synap-sessionstore-test-"));
  cwdSpy = vi.spyOn(process, "cwd").mockReturnValue(root);
  delete process.env.SYNAP_SESSION_ID;
  delete process.env.CLAUDE_CODE_SESSION_ID;
  delete process.env.SYNAP_LENS_SESSION;
});

afterEach(() => {
  cwdSpy.mockRestore();
  fs.rmSync(root, { recursive: true, force: true });
  if (claudeSession) {
    fs.rmSync(lensFileFor(claudeSession), { force: true });
    claudeSession = undefined;
  }
  delete process.env.SYNAP_SESSION_ID;
  delete process.env.CLAUDE_CODE_SESSION_ID;
});

describe("legacy .synap-session migration (compat)", () => {
  it("migrates an existing .synap-session into the directory lens and deletes it", async () => {
    fs.writeFileSync(path.join(root, ".synap-session"), `${SESSION_X}\n`);
    const { resolveActiveSessionId } = await loadHubClient();

    // The user does NOT lose their attached session across the upgrade.
    expect(resolveActiveSessionId(POD_A)).toBe(SESSION_X);
    expect(readDirectoryLens()?.focusSessionId).toBe(SESSION_X);
    // …and the retired store is gone, so it can never shadow the lens again.
    expect(fs.existsSync(path.join(root, ".synap-session"))).toBe(false);
  });

  it("merges into an existing directory lens rather than clobbering its scope", async () => {
    seedDirectoryLens({ workspaceId: "ws-1", podUrl: POD_A });
    fs.writeFileSync(path.join(root, ".synap-session"), SESSION_X);
    const { resolveActiveSessionId } = await loadHubClient();

    expect(resolveActiveSessionId(POD_A)).toBe(SESSION_X);
    expect(readDirectoryLens()?.workspaceId).toBe("ws-1");
  });

  it("removes an empty legacy file without inventing a session", async () => {
    fs.writeFileSync(path.join(root, ".synap-session"), "   \n");
    const { resolveActiveSessionId } = await loadHubClient();

    expect(resolveActiveSessionId(POD_A)).toBeUndefined();
    expect(fs.existsSync(path.join(root, ".synap-session"))).toBe(false);
  });
});

describe("resolution precedence — one store, ordered rungs", () => {
  it("session lens beats the directory lens (per-tab isolation is the point)", async () => {
    const cs = enterClaudeSession();
    writeLens(cs, { focusSessionId: SESSION_X });
    seedDirectoryLens({ focusSessionId: SESSION_Y });
    const { resolveActiveSessionId } = await loadHubClient();

    expect(resolveActiveSessionId(POD_A)).toBe(SESSION_X);
  });

  it("falls through to the directory lens when the tab pinned nothing", async () => {
    enterClaudeSession();
    seedDirectoryLens({ focusSessionId: SESSION_Y });
    const { resolveActiveSessionId } = await loadHubClient();

    expect(resolveActiveSessionId(POD_A)).toBe(SESSION_Y);
  });

  it("SYNAP_SESSION_ID overrides both lenses", async () => {
    const cs = enterClaudeSession();
    writeLens(cs, { focusSessionId: SESSION_X });
    process.env.SYNAP_SESSION_ID = SESSION_Y;
    const { resolveActiveSessionId } = await loadHubClient();

    expect(resolveActiveSessionId(POD_A)).toBe(SESSION_Y);
  });

  it("drops a session id pinned to a DIFFERENT pod (ids are pod-local)", async () => {
    seedDirectoryLens({ focusSessionId: SESSION_X, podUrl: POD_A });
    const { resolveActiveSessionId } = await loadHubClient();

    expect(resolveActiveSessionId(POD_A)).toBe(SESSION_X);
    expect(resolveActiveSessionId(POD_B)).toBeUndefined();
  });
});

describe("attach / detach never silently no-op", () => {
  it("attaches to the session lens inside Claude Code", async () => {
    const cs = enterClaudeSession();
    const { attachActiveSessionId, resolveActiveSessionId } = await loadHubClient();

    expect(attachActiveSessionId(SESSION_X)).toBe("session-lens");
    expect(readLens(cs)?.focusSessionId).toBe(SESSION_X);
    expect(resolveActiveSessionId(POD_A)).toBe(SESSION_X);
    // A plain terminal in the same tree must NOT inherit the tab's session.
    expect(readDirectoryLens()).toBeNull();
  });

  it("attaches to the directory lens in a plain terminal (no CLAUDE_CODE_SESSION_ID)", async () => {
    const { attachActiveSessionId, resolveActiveSessionId } = await loadHubClient();

    expect(attachActiveSessionId(SESSION_X)).toBe("directory-lens");
    expect(readDirectoryLens()?.focusSessionId).toBe(SESSION_X);
    expect(resolveActiveSessionId(POD_A)).toBe(SESSION_X);
  });

  it("detach clears BOTH rungs — detaching must not reveal the lower one", async () => {
    const cs = enterClaudeSession();
    writeLens(cs, { focusSessionId: SESSION_X });
    seedDirectoryLens({ focusSessionId: SESSION_Y, workspaceId: "ws-1" });
    const { detachActiveSessionId, resolveActiveSessionId } = await loadHubClient();

    expect(detachActiveSessionId(POD_A)).toBe(SESSION_X);
    expect(resolveActiveSessionId(POD_A)).toBeUndefined();
    // Detaching a session must not wipe the tree's workspace scope.
    expect(readDirectoryLens()?.workspaceId).toBe("ws-1");
  });
});

describe("X-Session-Id still reaches the pod", () => {
  it("tags a hub call with the attached session", async () => {
    seedDirectoryLens({ focusSessionId: SESSION_X });
    const { hubGet } = await loadHubClient();

    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("{}", { status: 200, headers: { "Content-Type": "application/json" } })
    );
    let init: RequestInit | undefined;
    try {
      await hubGet("/users/me", {}, { podUrl: POD_A, apiKey: "k", userId: "u" });
      // Read the calls BEFORE restoring — mockRestore also clears mock.calls.
      init = fetchSpy.mock.calls[0]?.[1] as RequestInit;
    } finally {
      fetchSpy.mockRestore();
    }

    expect((init?.headers as Record<string, string>)["X-Session-Id"]).toBe(SESSION_X);
  });
});
