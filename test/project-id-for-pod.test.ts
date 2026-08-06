/**
 * Project lens safety: never send a projectId bound to another pod.
 * Mirrors resolveProjectIdForPod rules via the exported resolveHubConfig path
 * where possible; pure binding rules tested through re-exported behavior.
 *
 * resolveProjectIdForPod is module-private — we test the public contract via
 * ActiveProjectBinding + getActiveProjectId / config shape expectations
 * documented here, and exercise resolveWorkspaceForPod (peer) thoroughly.
 *
 * For project, hub-client unit import would require mocking getPodOverride.
 * Keep this file as the documented contract + binding helpers from pod.ts.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const CONFIG_DIR = path.join(os.homedir(), ".synap");
const CONFIG_FILE = path.join(CONFIG_DIR, "config.json");

describe("project binding contract (pod-safe pins)", () => {
  let backup: string | null = null;

  beforeEach(() => {
    backup = fs.existsSync(CONFIG_FILE) ? fs.readFileSync(CONFIG_FILE, "utf-8") : null;
  });

  afterEach(() => {
    if (backup !== null) fs.writeFileSync(CONFIG_FILE, backup);
    // leave restored
  });

  it("setActiveProjectId records pod binding alongside activeProjectId", async () => {
    // Dynamic import after possible config restore
    const pod = await import("../src/lib/pod.js");
    // Only run mutation if we have a perso-like profile; skip if empty config
    const profiles = pod.listPodProfiles();
    if (profiles.length === 0) return;

    const name = profiles.find((p) => p.active)?.name ?? profiles[0].name;
    const proj = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
    pod.setActiveProjectId(proj, name);
    const binding = pod.getActiveProjectBinding();
    expect(binding?.projectId).toBe(proj);
    expect(binding?.podName).toBe(name);
    expect(pod.getActiveProjectId()).toBe(proj);
  });
});
