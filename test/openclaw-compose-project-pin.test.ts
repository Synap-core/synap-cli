import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// update-door plan P0 → P4 (2026-10-04): the OpenClaw addon used to run a bare
// `docker compose -f docker-compose.yml` in the pod's deploy dir (no -p → a
// parallel "deploy" stack) and to rewrite the pod's .env itself. It now goes
// through the pod's own CLI only: `synap config set --stdin` (the ONE validated
// .env writer; values never in argv) and `synap profiles enable openclaw`.

const execCalls: string[] = [];
const spawnCalls: { argv: string[]; input?: string; env?: NodeJS.ProcessEnv }[] = [];
let deployDir = "";
let root = "";
let configStatus = 0;

vi.mock("child_process", () => ({
  execSync: (cmd: string) => {
    execCalls.push(cmd);
    if (cmd.startsWith("docker ps")) return "synap-backend-backend-1\n";
    if (cmd.startsWith("docker inspect")) return `${deployDir}\n`;
    return "";
  },
  spawnSync: (bin: string, args: string[], opts: { input?: string; env?: NodeJS.ProcessEnv }) => {
    spawnCalls.push({ argv: [bin, ...args], input: opts.input, env: opts.env });
    const isSet = args[1] === "config";
    return { status: isSet ? configStatus : 0, stdout: "", stderr: isSet && configStatus ? "config: refused — X" : "" };
  },
}));

const { startOpenClawOnServer, composeProjectFromEnv } = await import("../src/lib/pod.js");

beforeEach(() => {
  execCalls.length = 0;
  spawnCalls.length = 0;
  configStatus = 0;
  root = mkdtempSync(path.join(tmpdir(), "openclaw-pin-"));
  deployDir = path.join(root, "deploy");
  mkdirSync(deployDir);
  writeFileSync(path.join(deployDir, "docker-compose.yml"), "services:\n  backend:\n    image: x\n");
  writeFileSync(path.join(deployDir, "env-config.sh"), "# door\n");
  writeFileSync(path.join(root, "synap"), "#!/bin/sh\n");
  chmodSync(path.join(root, "synap"), 0o755);
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("OpenClaw addon on a pod", () => {
  it("sets its keys through `synap config set --stdin` and starts via `synap profiles enable openclaw`", () => {
    const env = "POSTGRES_PASSWORD=keep-me\nCOMPOSE_PROJECT_NAME=synap-backend\nSYNAP_POD_URL=old\n";
    writeFileSync(path.join(deployDir, ".env"), env);

    startOpenClawOnServer("hub-SECRET-key", "agent-1", "ws-1", "https://pod.example", "proj-1");

    const synap = path.join(root, "synap");
    expect(spawnCalls.map((c) => c.argv)).toEqual([
      ["bash", synap, "config", "set", "--stdin"],
      ["bash", synap, "profiles", "enable", "openclaw"],
    ]);
    expect(spawnCalls[0]!.input).toBe(
      "OPENCLAW_HUB_API_KEY=hub-SECRET-key\nSYNAP_AGENT_USER_ID=agent-1\nSYNAP_WORKSPACE_ID=ws-1\nSYNAP_POD_URL=https://pod.example\nSYNAP_PROJECT_ID=proj-1\n"
    );
    expect(spawnCalls.flatMap((c) => c.argv).join(" ")).not.toContain("hub-SECRET-key");
    for (const c of spawnCalls) {
      expect(c.env?.COMPOSE_PROJECT_NAME).toBe("synap-backend");
      expect(c.env?.SYNAP_DEPLOY_DIR).toBe(deployDir);
    }
    // the addon itself never wrote the file, never ran compose
    expect(readFileSync(path.join(deployDir, ".env"), "utf-8")).toBe(env);
    expect(execCalls.some((c) => c.includes("docker compose"))).toBe(false);
  });

  it("a refusal by the door stops before starting anything", () => {
    writeFileSync(path.join(deployDir, ".env"), "COMPOSE_PROJECT_NAME=synap-backend\n");
    configStatus = 1;
    expect(() => startOpenClawOnServer("k", "a", "w", "https://pod.example")).toThrow(/synap config set refused/);
    expect(spawnCalls.some((c) => c.argv.includes("profiles"))).toBe(false);
  });

  it("refuses without the pod's synap CLI (or one that predates the door) — never writes itself", () => {
    const env = "COMPOSE_PROJECT_NAME=synap-backend\n";
    writeFileSync(path.join(deployDir, ".env"), env);
    rmSync(path.join(deployDir, "env-config.sh"));
    expect(() => startOpenClawOnServer("k", "a", "w", "https://pod.example")).toThrow(/No synap CLI with the config door/);
    expect(spawnCalls).toHaveLength(0);
    expect(readFileSync(path.join(deployDir, ".env"), "utf-8")).toBe(env);
  });

  it("refuses when the project is not pinned — no write, no compose", () => {
    const env = "POSTGRES_PASSWORD=keep-me\n";
    writeFileSync(path.join(deployDir, ".env"), env);

    expect(() => startOpenClawOnServer("hub-key", "agent-1", "ws-1", "https://pod.example")).toThrow(
      /COMPOSE_PROJECT_NAME is not pinned/
    );
    expect(readFileSync(path.join(deployDir, ".env"), "utf-8")).toBe(env);
    expect(spawnCalls).toHaveLength(0);
  });

  it("refuses when there is no .env — never writes a fresh one", () => {
    expect(() => startOpenClawOnServer("hub-key", "agent-1", "ws-1", "https://pod.example")).toThrow(/No \.env/);
    expect(spawnCalls).toHaveLength(0);
  });

  it("parses the pin strictly", () => {
    expect(composeProjectFromEnv("COMPOSE_PROJECT_NAME=deploy\n")).toBe("deploy");
    expect(composeProjectFromEnv('COMPOSE_PROJECT_NAME="synap-backend"\n')).toBe("synap-backend");
    expect(composeProjectFromEnv("COMPOSE_PROJECT_NAME=\n")).toBeNull();
    expect(composeProjectFromEnv("COMPOSE_PROJECT_NAME=x; rm -rf /\n")).toBeNull();
    expect(composeProjectFromEnv("OTHER=1\n")).toBeNull();
  });
});
