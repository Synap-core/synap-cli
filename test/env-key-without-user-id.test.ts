/**
 * `SYNAP_POD_URL` + `SYNAP_HUB_API_KEY` are enough to talk to a pod.
 *
 * The owner tried another key the documented way —
 *   HOME=$(mktemp -d) SYNAP_POD_URL=… SYNAP_HUB_API_KEY=… synap app connect
 * — and got "✗ No pod configured. Run: synap pods add": step 3 of
 * resolveHubConfig only honoured the env key when SYNAP_USER_ID was ALSO set
 * (a June revert, b311866, left with no reason). The user is resolvable from
 * the key itself (`"cli"` → resolveUserId → GET /users/me), as `--pod` and
 * SYNAP_AGENT already do.
 *
 * The safety step 3 does provide is kept: a `claude-code` surface key pinned
 * to the same pod still wins over an inherited env key.
 *
 * Driven through the REAL resolveHubConfig against a temp HOME (the config and
 * lens paths are computed at module load, hence resetModules + re-import).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const POD = "https://pod.example.test";
const ENV_KEY = "synap_user_env-key-aaaaaa";

let home: string;

async function load() {
  vi.resetModules();
  return {
    hub: await import("../src/lib/hub-client.js"),
    keySource: await import("../src/lib/key-source.js"),
    pod: await import("../src/lib/pod.js"),
  };
}

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "synap-envkey-"));
  vi.stubEnv("HOME", home);
  vi.stubEnv("USERPROFILE", home);
  // This test must not inherit the developer's (or a Claude session's) env.
  for (const k of [
    "SYNAP_USER_ID",
    "SYNAP_AGENT",
    "SYNAP_WORKSPACE_ID",
    "SYNAP_PROJECT_ID",
    "SYNAP_KEY_SCOPES",
    "SYNAP_LENS_SESSION",
    "CLAUDE_CODE_SESSION_ID",
  ])
    vi.stubEnv(k, undefined as unknown as string);
  vi.stubEnv("SYNAP_POD_URL", POD);
  vi.stubEnv("SYNAP_HUB_API_KEY", ENV_KEY);
});

afterEach(() => {
  vi.unstubAllEnvs();
  fs.rmSync(home, { recursive: true, force: true });
});

describe("env pod + key without SYNAP_USER_ID", () => {
  it("resolves to the env pod and key, with the user asked of the pod", async () => {
    expect(process.env.SYNAP_USER_ID).toBeUndefined();
    const { hub, keySource } = await load();
    const cfg = await hub.resolveHubConfig();
    expect(cfg.podUrl).toBe(POD);
    expect(cfg.apiKey).toBe(ENV_KEY);
    // "cli" = resolveUserId fetches /users/me for the real id.
    expect(cfg.userId).toBe("cli");
    // whoami names the same rung resolveHubConfig took.
    expect(keySource.resolveKeySource()).toEqual({
      source: "env",
      detail: "SYNAP_HUB_API_KEY",
    });
  });

  it("an explicit SYNAP_USER_ID is still used as given", async () => {
    vi.stubEnv("SYNAP_USER_ID", "u-explicit");
    const { hub } = await load();
    expect((await hub.resolveHubConfig()).userId).toBe("u-explicit");
  });

  it("KEPT: a claude-code surface key pinned to this pod still beats the env key", async () => {
    const { pod } = await load();
    pod.setSurfaceAgentKey("claude-code", {
      podUrl: POD,
      hubApiKey: "synap_hub_surface-key-bbbbbb",
      agentUserId: "agent-1",
    } as never);
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const { hub, keySource } = await load();
    const cfg = await hub.resolveHubConfig();
    expect(cfg.apiKey).toBe("synap_hub_surface-key-bbbbbb");
    expect(cfg.userId).toBe("agent-1");
    expect(keySource.resolveKeySource().source).toBe("env-surface");
    stderr.mockRestore();
  });
});
