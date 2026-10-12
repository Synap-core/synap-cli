/**
 * The per-computer instance label: STABLE on one computer (a changing label
 * would strand the old key and never replace it) and DIFFERENT across
 * computers (a shared label is the 2026-10-12 incident again).
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { deriveInstanceId, deriveInstanceLabel, readMachineId, machineInstanceId, type MachineIdSources } from "../src/lib/machine-instance.js";

const src = (over: Partial<MachineIdSources>): MachineIdSources => ({
  platform: "linux",
  readFile: () => null,
  run: () => null,
  fallback: () => "fallback-id",
  ...over,
});

afterEach(() => vi.unstubAllEnvs());

describe("deriveInstanceId", () => {
  it("is stable for the same computer and surface", () => {
    expect(deriveInstanceId("machine-A", "claude-code")).toBe(deriveInstanceId("machine-A", "claude-code"));
    expect(deriveInstanceId("machine-A", "claude-code")).toMatch(/^m-[0-9a-f]{16}$/);
  });
  it("differs across computers, and across surfaces", () => {
    expect(deriveInstanceId("machine-A", "claude-code")).not.toBe(deriveInstanceId("machine-B", "claude-code"));
    expect(deriveInstanceId("machine-A", "claude-code")).not.toBe(deriveInstanceId("machine-A", "codex"));
  });
  it("never carries the raw machine id", () => {
    expect(deriveInstanceId("SECRET-MACHINE-UUID", "claude-code")).not.toContain("SECRET");
  });
});

describe("readMachineId — the OS id, not the hostname or ~/.synap", () => {
  it("macOS: IOPlatformUUID", () => {
    const out = `  "IOPlatformSerialNumber" = "C02X"\n  "IOPlatformUUID" = "ABCD-1234"\n`;
    expect(readMachineId(src({ platform: "darwin", run: () => out }))).toBe("ABCD-1234");
  });
  it("Linux: /etc/machine-id, else the dbus copy", () => {
    expect(readMachineId(src({ readFile: (p) => (p === "/etc/machine-id" ? "abc123\n" : null) }))).toBe("abc123");
    expect(readMachineId(src({ readFile: (p) => (p === "/var/lib/dbus/machine-id" ? "dbus9\n" : null) }))).toBe("dbus9");
  });
  it("Windows: MachineGuid", () => {
    const out = "\r\nHKEY_LOCAL_MACHINE\\SOFTWARE\\Microsoft\\Cryptography\r\n    MachineGuid    REG_SZ    1111-2222\r\n";
    expect(readMachineId(src({ platform: "win32", run: () => out }))).toBe("1111-2222");
  });
  it("no OS id → the fallback", () => {
    expect(readMachineId(src({ readFile: () => "  \n" }))).toBe("fallback-id");
  });
  it("the hostname plays no part", () => {
    const a = machineInstanceId("claude-code", src({ readFile: () => "same-machine" }));
    vi.spyOn(os, "hostname").mockReturnValue("renamed-host");
    expect(machineInstanceId("claude-code", src({ readFile: () => "same-machine" }))).toBe(a);
  });
});

describe("the persisted fallback is stable across runs", () => {
  it("writes once under HOME and reads the same id back", async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "synap-mid-"));
    vi.stubEnv("HOME", home);
    const { DEFAULT_MACHINE_ID_SOURCES } = await import("../src/lib/machine-instance.js");
    const first = DEFAULT_MACHINE_ID_SOURCES.fallback();
    expect(fs.readFileSync(path.join(home, ".synap", "machine-id"), "utf8").trim()).toBe(first);
    expect(DEFAULT_MACHINE_ID_SOURCES.fallback()).toBe(first);
  });
  it("this computer's real label is stable across calls", () => {
    expect(machineInstanceId("claude-code")).toBe(machineInstanceId("claude-code"));
  });
});

describe("deriveInstanceLabel — the computer's NAME (display only)", () => {
  it("is the hostname without its domain", () => {
    expect(deriveInstanceLabel("MacBook-Pro.local")).toBe("MacBook-Pro");
    expect(deriveInstanceLabel("devbox")).toBe("devbox");
  });
  it("SYNAP_COMPUTER_NAME renames it", () => {
    expect(deriveInstanceLabel("ip-10-0-0-1.ec2.internal", "  build box ")).toBe("build box");
  });
  it("an empty hostname sends no name (the pod shows it unlabelled)", () => {
    expect(deriveInstanceLabel("  ")).toBeUndefined();
  });
});
