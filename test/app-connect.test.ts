/**
 * App Connect — pure unit tests (no network).
 *
 * Covers the two pure seams of `synap app init` / `synap app connect`:
 *   1. the `synap.app.json` read/write round-trip (parse ↔ serialize, and disk), and
 *   2. the `deploy.env` → target-write mapping (which var receives the key, the
 *      pod URL, and the workspace id), for both `vercel` and `env` targets.
 *
 * Pod calls are NOT exercised here — the App Connect routes were not on the pod
 * when this landed (parallel backend build); the client is a thin HubRestClient
 * subclass and its behaviour is integration, not unit.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import {
  parseManifest,
  serializeManifest,
  readManifest,
  writeManifest,
  manifestPath,
  buildEnvAssignments,
  applyEnvContent,
  quoteEnvValue,
  writeDeployTarget,
  MANIFEST_FILENAME,
  type AppManifest,
} from "../src/commands/app.js";

vi.mock("node:child_process", () => ({ execFileSync: vi.fn() }));

// ── fixtures ───────────────────────────────────────────────────────────────────

/** Full manifest, as `synap app connect` reads it after a first register. */
const REGISTERED: AppManifest = {
  version: 1,
  id: "app_3f2b1a9c-0000-4000-8000-abcdefabcdef",
  name: "synap.live",
  description: "The Synap landing page",
  logoUrl: null,
  mode: "specific",
  pod: "https://pod.antoinesrvt.synap.live",
  requests: [{ permission: "entity.person.create", workspace: "Operations" }],
  deploy: {
    target: "vercel",
    env: {
      key: "SYNAP_INTAKE_API_KEY",
      podUrl: "SYNAP_INTAKE_POD_URL",
      workspaceId: "SYNAP_INTAKE_WORKSPACE_ID",
    },
  },
};

/** The values `synap app connect` hands to the mapping after it mints the key. */
const values = { apiKey: "sk-live-123", podUrl: "https://pod.example", workspaceId: "ws-9" };

let tmp: string;
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "synap-app-"));
  vi.mocked(execFileSync).mockReset();
});
afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

// ── 1. manifest round-trip ──────────────────────────────────────────────────────

describe("manifest round-trip", () => {
  it("serialize → parse is lossless (registered manifest)", () => {
    const back = parseManifest(serializeManifest(REGISTERED));
    expect(back).toEqual(REGISTERED);
  });

  it("a first-run manifest keeps `id` ABSENT and round-trips", () => {
    const first: AppManifest = { ...REGISTERED, id: undefined };
    const json = serializeManifest(first);
    expect(json).not.toContain('"id"'); // spec §1: absent on first run
    expect(parseManifest(json)).toEqual(first);
  });

  it("read → write → read is stable, and manifestPath names the file", () => {
    const file = manifestPath(tmp);
    expect(file).toBe(path.join(tmp, MANIFEST_FILENAME));
    writeManifest(file, REGISTERED);
    const once = fs.readFileSync(file, "utf-8");
    const parsed = readManifest(file);
    writeManifest(file, parsed);
    expect(fs.readFileSync(file, "utf-8")).toBe(once);
    expect(parsed).toEqual(REGISTERED);
  });

  it("a missing manifest names the fix", () => {
    expect(() => readManifest(path.join(tmp, MANIFEST_FILENAME))).toThrow(/synap app init/);
  });

  it("rejects an unsupported mode / target / an empty requests list", () => {
    const base = JSON.parse(serializeManifest(REGISTERED));
    expect(() => parseManifest(JSON.stringify({ ...base, mode: "global" }))).toThrow(/only "specific"/);
    expect(() =>
      parseManifest(JSON.stringify({ ...base, deploy: { ...base.deploy, target: "netlify" } }))
    ).toThrow(/"vercel" or "env"/);
    expect(() => parseManifest(JSON.stringify({ ...base, requests: [] }))).toThrow(/at least one/);
  });
});

// ── 2. deploy.env → target-write mapping ────────────────────────────────────────

describe("deploy.env → env var mapping", () => {
  it("maps key / podUrl / workspaceId onto the declared var names", () => {
    expect(buildEnvAssignments(REGISTERED.deploy, values)).toEqual([
      { name: "SYNAP_INTAKE_API_KEY", value: "sk-live-123" },
      { name: "SYNAP_INTAKE_POD_URL", value: "https://pod.example" },
      { name: "SYNAP_INTAKE_WORKSPACE_ID", value: "ws-9" },
    ]);
  });

  it("only writes DECLARED vars (omits an undeclared one)", () => {
    const deploy = { target: "env" as const, env: { key: "K" } };
    expect(buildEnvAssignments(deploy, values)).toEqual([{ name: "K", value: "sk-live-123" }]);
  });

  it("a declared workspace var with no resolved id is a visible error, not a half-write", () => {
    expect(() =>
      buildEnvAssignments(REGISTERED.deploy, { apiKey: "k", podUrl: "u" })
    ).toThrow(/workspace id was resolved/);
  });
});

describe("env target (.env.local)", () => {
  it("appends, updates in place, and is idempotent", () => {
    const first = applyEnvContent("EXISTING=1\n", [
      { name: "K", value: "abc" },
      { name: "P", value: "https://pod.example" },
    ]);
    expect(first).toBe("EXISTING=1\nK=abc\nP=https://pod.example\n");

    // re-running replaces in place rather than appending a second line
    const again = applyEnvContent(first, [{ name: "K", value: "rotated" }]);
    expect(again).toBe("EXISTING=1\nK=rotated\nP=https://pod.example\n");
    expect(again.match(/^K=/gm)).toHaveLength(1);
  });

  it("quotes only values that would be mis-read", () => {
    expect(quoteEnvValue("plain-uuid")).toBe("plain-uuid");
    expect(quoteEnvValue("has space")).toBe('"has space"');
  });

  it("writeDeployTarget(env) writes .env.local under the root", () => {
    const deploy = { ...REGISTERED.deploy, target: "env" as const };
    const where = writeDeployTarget(
      deploy,
      buildEnvAssignments(deploy, values),
      tmp
    );
    expect(where).toBe(".env.local");
    expect(fs.readFileSync(path.join(tmp, ".env.local"), "utf-8")).toBe(
      "SYNAP_INTAKE_API_KEY=sk-live-123\n" +
        "SYNAP_INTAKE_POD_URL=https://pod.example\n" +
        "SYNAP_INTAKE_WORKSPACE_ID=ws-9\n"
    );
  });
});

describe("vercel target", () => {
  it("running `synap app connect` twice rewrites `vercel env add <name> production` — remove then add", () => {
    writeDeployTarget(
      REGISTERED.deploy,
      buildEnvAssignments(REGISTERED.deploy, values),
      tmp
    );
    const calls = vi.mocked(execFileSync).mock.calls.map((c) => c[1] as string[]);
    // For each declared var: a remove (idempotency) followed by an add.
    expect(calls).toEqual([
      ["env", "rm", "SYNAP_INTAKE_API_KEY", "production", "-y"],
      ["env", "add", "SYNAP_INTAKE_API_KEY", "production"],
      ["env", "rm", "SYNAP_INTAKE_POD_URL", "production", "-y"],
      ["env", "add", "SYNAP_INTAKE_POD_URL", "production"],
      ["env", "rm", "SYNAP_INTAKE_WORKSPACE_ID", "production", "-y"],
      ["env", "add", "SYNAP_INTAKE_WORKSPACE_ID", "production"],
    ]);
    // The VALUE arrives on stdin of the `add` call — assert reachability, not shape.
    const addKey = vi
      .mocked(execFileSync)
      .mock.calls.find((c) => (c[1] as string[])[1] === "add" && (c[1] as string[])[2] === "SYNAP_INTAKE_API_KEY");
    expect((addKey?.[2] as { input?: string })?.input).toBe("sk-live-123\n");
  });
});
