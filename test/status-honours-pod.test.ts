/**
 * `synap --pod <name> status` must report the named profile, not the active one.
 * `bootstrapPodOverride` registers the override; `status` once read
 * `getActivePodConfig()` directly and so probed (and printed) the active pod.
 *
 * Temp HOME + stubbed fetch: no real config, no network.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const PERSO = "https://pod.perso.example";
const SILLAGE = "https://sillage.pod.example";

let home: string;
let fetched: string[];

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "synap-status-pod-"));
  fs.mkdirSync(path.join(home, ".synap"), { mode: 0o700 });
  fs.writeFileSync(
    path.join(home, ".synap", "config.json"),
    JSON.stringify({
      activePod: "perso",
      pods: {
        perso: { podUrl: PERSO, workspaceId: "ws-perso", agentUserId: "", hubApiKey: "k-perso", savedAt: "2026-07-24" },
        sillage: { podUrl: SILLAGE, workspaceId: "ws-sillage", agentUserId: "", hubApiKey: "k-sillage", savedAt: "2026-07-24" },
      },
    })
  );
  vi.resetModules();
  vi.spyOn(os, "homedir").mockReturnValue(home);
  vi.stubEnv("HOME", home);
  vi.stubEnv("SYNAP_POD_URL", "");
  fetched = [];
  vi.stubGlobal("fetch", async (input: unknown) => {
    fetched.push(String(input));
    return new Response("{}", { status: 503 });
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  fs.rmSync(home, { recursive: true, force: true });
});

async function runStatus(argv: string[], json: boolean): Promise<string> {
  const { bootstrapPodOverride } = await import("../src/lib/pod.js");
  bootstrapPodOverride(argv);
  const out: string[] = [];
  vi.spyOn(process.stdout, "write").mockImplementation((s: unknown) => (out.push(String(s)), true));
  vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => void out.push(a.join(" ")));
  const { status } = await import("../src/commands/status.js");
  await status({ json });
  return out.join("\n");
}

describe("status honours --pod", () => {
  it("--json probes and reports the named profile's pod", async () => {
    const out = await runStatus(["node", "synap", "--pod", "sillage", "status", "--json"], true);
    expect(JSON.parse(out).podUrl).toBe(SILLAGE);
    expect(fetched.length).toBeGreaterThan(0);
    expect(fetched.every((u) => u.startsWith(SILLAGE))).toBe(true);
  });

  it("pretty output names the named profile's URL and workspace, not the active one's", async () => {
    const out = await runStatus(["node", "synap", "--pod", "sillage", "status"], false);
    expect(out).toContain(SILLAGE);
    expect(out).not.toContain(PERSO);
    expect(out).not.toContain("ws-perso");
  });

  it("without --pod the active profile is still used", async () => {
    const out = await runStatus(["node", "synap", "status", "--json"], true);
    expect(JSON.parse(out).podUrl).toBe(PERSO);
  });
});
