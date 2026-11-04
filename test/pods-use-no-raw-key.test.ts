/**
 * `synap pods use` never writes this computer's own key into Cursor's or
 * Claude Desktop's config (plan f61a20a5, W1).
 *
 * It used to write the CLI's computer key, raw, into an MCP entry named
 * "synap", beside the pod-named entry `synap connect` writes with the
 * client's own key: two entries, two identities, and the computer's key in a
 * file the client reads. Those clients keep one entry per pod, so a switch
 * rewrites nothing; a pod with no entry gets the `synap connect` command.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const { podsUse } = await import("../src/commands/pods.js");
const { addPodProfile } = await import("../src/lib/pod.js");

const POD_URL = "https://pod.team.synap.live";
const COMPUTER_KEY = "computer-key-team-0123456789";
const cursorFile = () => path.join(os.homedir(), ".cursor", "mcp.json");

let out: string[];
beforeEach(() => {
  vi.stubEnv("HOME", fs.mkdtempSync(path.join(os.tmpdir(), "synap-pods-use-")));
  addPodProfile("team", {
    podUrl: POD_URL,
    workspaceId: "ws",
    agentUserId: "computer-agent",
    hubApiKey: COMPUTER_KEY,
    savedAt: new Date().toISOString(),
  });
  out = [];
  vi.spyOn(console, "log").mockImplementation((m) => void out.push(String(m)));
  vi.spyOn(console, "error").mockImplementation((m) => void out.push(String(m)));
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

function writeCursor(servers: Record<string, unknown>): void {
  fs.mkdirSync(path.dirname(cursorFile()), { recursive: true });
  fs.writeFileSync(cursorFile(), JSON.stringify({ mcpServers: servers }, null, 2));
}
const readCursor = () => JSON.parse(fs.readFileSync(cursorFile(), "utf8")) as { mcpServers: Record<string, unknown> };

describe("synap pods use", () => {
  it("leaves a Cursor config with no entry for the pod untouched, and prints the connect command", async () => {
    const other = { "synap-perso": { url: "https://pod.perso.synap.live/mcp", headers: { Authorization: "Bearer cursor-key" } } };
    writeCursor(other);
    await podsUse("team");
    expect(readCursor().mcpServers).toEqual(other);
    expect(fs.readFileSync(cursorFile(), "utf8")).not.toContain(COMPUTER_KEY);
    expect(out.join("\n")).toContain("synap connect cursor --name team");
  });

  it("keeps the pod's own entry, and removes the old 'synap' entry that held this computer's key", async () => {
    const own = { url: `${POD_URL}/mcp`, headers: { Authorization: "Bearer cursor-own-key" } };
    writeCursor({
      "synap-team": own,
      synap: { url: `${POD_URL}/mcp`, headers: { Authorization: `Bearer ${COMPUTER_KEY}` } },
    });
    await podsUse("team");
    expect(readCursor().mcpServers).toEqual({ "synap-team": own });
  });

  it("leaves a 'synap' entry that holds some other key", async () => {
    const servers = {
      "synap-team": { url: `${POD_URL}/mcp`, headers: { Authorization: "Bearer cursor-own-key" } },
      synap: { url: "https://pod.old.synap.live/mcp", headers: { Authorization: "Bearer someone-elses" } },
    };
    writeCursor(servers);
    await podsUse("team");
    expect(readCursor().mcpServers).toEqual(servers);
  });

  it("leaves a 'synap' entry for ANOTHER pod, even when it holds one of this computer's keys", async () => {
    // Another pod saved on this computer: its key is one of this computer's,
    // and the old "synap" entry is that pod's only entry in Cursor.
    addPodProfile("perso", {
      podUrl: "https://pod.perso.synap.live",
      workspaceId: "ws2",
      agentUserId: "computer-agent-2",
      hubApiKey: "computer-key-perso-9876543210",
      savedAt: new Date().toISOString(),
    });
    const servers = {
      "synap-team": { url: `${POD_URL}/mcp`, headers: { Authorization: "Bearer cursor-own-key" } },
      synap: { url: "https://pod.perso.synap.live/mcp", headers: { Authorization: "Bearer computer-key-perso-9876543210" } },
    };
    writeCursor(servers);
    await podsUse("team");
    expect(readCursor().mcpServers).toEqual(servers);
  });

  it("removes an old mcp-remote 'synap' entry for this pod that held this computer's key", async () => {
    const own = { url: `${POD_URL}/mcp`, headers: { Authorization: "Bearer cursor-own-key" } };
    writeCursor({
      "synap-team": own,
      synap: { command: "npx", args: ["-y", "mcp-remote", `${POD_URL}/mcp`, "--header", `Authorization: Bearer ${COMPUTER_KEY}`] },
    });
    await podsUse("team");
    expect(readCursor().mcpServers).toEqual({ "synap-team": own });
  });

  it("says a client that already has this pod is unchanged, never 'Updated'", async () => {
    writeCursor({ "synap-team": { url: `${POD_URL}/mcp`, headers: { Authorization: "Bearer cursor-own-key" } } });
    await podsUse("team");
    const text = out.join("\n");
    expect(text).toContain("Cursor already has 'synap-team' for this pod; nothing to change.");
    expect(text).not.toMatch(/Updated:.*Cursor/);
    expect(text).not.toMatch(/Now on 'team':.*Cursor/);
    expect(text).not.toContain("no agent surface is configured");
  });

  it("a client that needs an entry is not followed by 'no agent surface is configured'", async () => {
    writeCursor({});
    await podsUse("team");
    const text = out.join("\n");
    expect(text).toContain("synap connect cursor --name team");
    expect(text).not.toContain("no agent surface is configured");
  });

  it("--surface cursor writes no key either", async () => {
    writeCursor({});
    await podsUse("team", { surface: "cursor" });
    expect(fs.readFileSync(cursorFile(), "utf8")).not.toContain(COMPUTER_KEY);
    expect(out.join("\n")).toContain("synap connect cursor --name team");
  });
});
