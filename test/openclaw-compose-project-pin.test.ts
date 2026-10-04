import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// update-door plan P0 (2026-10-04): the OpenClaw addon ran a bare
// `docker compose -f docker-compose.yml` in the pod's deploy dir (no -p → the
// project is named after the directory, "deploy" → a parallel empty stack) and,
// on an unreadable .env, wrote a fresh one holding only its four keys.

const calls: string[] = [];
let deployDir = "";

vi.mock("child_process", () => ({
  execSync: (cmd: string) => {
    calls.push(cmd);
    if (cmd.startsWith("docker ps")) return "synap-backend-backend-1\n";
    if (cmd.startsWith("docker inspect")) return `${deployDir}\n`;
    return "";
  },
}));

const { startOpenClawOnServer, composeProjectFromEnv } = await import("../src/lib/pod.js");

beforeEach(() => {
  calls.length = 0;
  deployDir = mkdtempSync(path.join(tmpdir(), "openclaw-pin-"));
  writeFileSync(
    path.join(deployDir, "docker-compose.yml"),
    "services:\n  backend:\n    image: ghcr.io/synap-core/backend:local\n"
  );
});
afterEach(() => rmSync(deployDir, { recursive: true, force: true }));

describe("OpenClaw addon on a pod", () => {
  it("passes the pinned project with -p and merges only its own keys", () => {
    const env = "POSTGRES_PASSWORD=keep-me\nCOMPOSE_PROJECT_NAME=synap-backend\nSYNAP_POD_URL=old\n";
    writeFileSync(path.join(deployDir, ".env"), env);

    startOpenClawOnServer("hub-key", "agent-1", "ws-1", "https://pod.example");

    const up = calls.filter((c) => c.includes(" up -d openclaw"));
    expect(up).toHaveLength(1);
    expect(up[0]).toMatch(/^docker compose -p synap-backend -f docker-compose\.yml /);
    const written = readFileSync(path.join(deployDir, ".env"), "utf-8");
    expect(written).toContain("POSTGRES_PASSWORD=keep-me\n");
    expect(written).toContain("COMPOSE_PROJECT_NAME=synap-backend\n");
    expect(written).toContain("SYNAP_POD_URL=https://pod.example\n");
    expect(written).not.toContain("SYNAP_POD_URL=old");
  });

  it("refuses when the project is not pinned — no .env write, no compose", () => {
    const env = "POSTGRES_PASSWORD=keep-me\n";
    writeFileSync(path.join(deployDir, ".env"), env);

    expect(() => startOpenClawOnServer("hub-key", "agent-1", "ws-1", "https://pod.example")).toThrow(
      /COMPOSE_PROJECT_NAME is not pinned/
    );
    expect(readFileSync(path.join(deployDir, ".env"), "utf-8")).toBe(env);
    expect(calls.some((c) => c.startsWith("docker compose"))).toBe(false);
  });

  it("refuses when there is no .env — never writes a fresh one", () => {
    expect(() => startOpenClawOnServer("hub-key", "agent-1", "ws-1", "https://pod.example")).toThrow(/No \.env/);
    expect(calls.some((c) => c.startsWith("docker compose"))).toBe(false);
  });

  it("parses the pin strictly", () => {
    expect(composeProjectFromEnv("COMPOSE_PROJECT_NAME=deploy\n")).toBe("deploy");
    expect(composeProjectFromEnv('COMPOSE_PROJECT_NAME="synap-backend"\n')).toBe("synap-backend");
    expect(composeProjectFromEnv("COMPOSE_PROJECT_NAME=\n")).toBeNull();
    expect(composeProjectFromEnv("COMPOSE_PROJECT_NAME=x; rm -rf /\n")).toBeNull();
    expect(composeProjectFromEnv("OTHER=1\n")).toBeNull();
  });
});
