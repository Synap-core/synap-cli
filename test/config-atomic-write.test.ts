/**
 * S2 — ~/.synap/config.json writes are atomic and never wipe profiles.
 *
 * The defect: `writeMultiConfig` read the existing file with `catch { start
 * fresh }`, so an unparsable file (a half-written one, a stray edit) became
 * `{}` and the next write persisted `{}` + one field — every pod profile and
 * agent key gone. And `writeFileSync` truncates before writing.
 *
 * Drives the REAL exported writers (`addPodProfile`, `setSurfaceAgentKey`,
 * `addAgent`) against the throwaway HOME from test/setup/temp-home.ts.
 * Not covered: a crash between fsync and rename (not simulable in-process) —
 * covered by construction (rename is the only step that touches the target).
 */

import { describe, it, expect, beforeEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { addPodProfile, setSurfaceAgentKey } from "../src/lib/pod.js";
import { addAgent } from "../src/lib/agents-config.js";
import { ConfigUnreadableError, writeFileAtomic, readJsonStrict } from "../src/lib/atomic-file.js";

const dir = () => path.join(os.homedir(), ".synap");
const file = () => path.join(dir(), "config.json");

beforeEach(() => {
  fs.rmSync(dir(), { recursive: true, force: true });
  fs.mkdirSync(dir(), { recursive: true });
});

describe("config writes", () => {
  it("an unparsable config.json makes every writer THROW and leaves the bytes untouched", () => {
    const corrupt = '{"activePod":"perso","pods":{"perso":{"podUrl":"https://p","hubApiKey":"k"}}'; // truncated
    fs.writeFileSync(file(), corrupt, { mode: 0o600 });
    expect(() => setSurfaceAgentKey("codex", { hubApiKey: "a", agentUserId: "u", podUrl: "https://p" })).toThrow(ConfigUnreadableError);
    expect(() => addPodProfile("team", { podUrl: "https://t", hubApiKey: "t" } as never)).toThrow(ConfigUnreadableError);
    expect(() => addAgent("x", { podName: "perso", apiKey: "k", createdAt: "" })).toThrow(ConfigUnreadableError);
    expect(fs.readFileSync(file(), "utf8")).toBe(corrupt);
  });

  it("a write keeps every other profile, lands mode 0600, and leaves no temp file", () => {
    fs.writeFileSync(
      file(),
      JSON.stringify({ activePod: "perso", pods: { perso: { podUrl: "https://p", hubApiKey: "k1" }, team: { podUrl: "https://t", hubApiKey: "k2" } }, agents: { a: { podName: "perso" } } }),
      { mode: 0o644 }
    );
    setSurfaceAgentKey("codex", { hubApiKey: "agent", agentUserId: "u", podUrl: "https://p" });
    const after = JSON.parse(fs.readFileSync(file(), "utf8"));
    expect(Object.keys(after.pods).sort()).toEqual(["perso", "team"]);
    expect(after.agents).toEqual({ a: { podName: "perso" } });
    expect(fs.statSync(file()).mode & 0o777).toBe(0o600);
    expect(fs.readdirSync(dir()).filter((f) => f.endsWith(".tmp"))).toEqual([]);
  });

  it("writeFileAtomic replaces by rename (a reader holding the old inode never sees a truncated file)", () => {
    const f = path.join(dir(), "x.json");
    fs.writeFileSync(f, "old-content", { mode: 0o640 });
    const before = fs.statSync(f).ino;
    writeFileAtomic(f, "new");
    expect(fs.readFileSync(f, "utf8")).toBe("new");
    expect(fs.statSync(f).ino).not.toBe(before); // a new file was renamed in, not truncated in place
    expect(fs.statSync(f).mode & 0o777).toBe(0o640); // mode kept
  });

  it("readJsonStrict: null only when the file is missing", () => {
    expect(readJsonStrict(path.join(dir(), "nope.json"))).toBeNull();
    fs.writeFileSync(path.join(dir(), "bad.json"), "{");
    expect(() => readJsonStrict(path.join(dir(), "bad.json"))).toThrow(ConfigUnreadableError);
  });
});
