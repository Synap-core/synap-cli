/**
 * One agent key per COMPUTER — the `instanceId` every agent-key mint sends.
 *
 * The pod keeps ONE agent identity per (person × agent type): Claude Code on a
 * laptop and Claude Code on a devbox are the same agent. Without an instance
 * label on their keys, approving the devbox's new connection revokes EVERY live
 * key of that agent — the laptop's included (2026-10-12 incident). With a
 * label, `approvePendingAgentKey` replaces only the keys carrying the same one.
 *
 * The label must be STABLE for a computer (a changing label strands the old
 * key alive and never replaces it) and DIFFERENT across computers (a shared
 * label is the incident again). So it is derived from the OS's own machine
 * identifier, never from the hostname (renamed freely) or anything under
 * ~/.synap (copied between machines with the dotfiles). Only when the OS has
 * no readable id does it fall back to a random id persisted once per HOME.
 *
 * The label is a one-way hash: the raw machine id never leaves the computer.
 */

import { createHash, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export interface MachineIdSources {
  platform: NodeJS.Platform;
  readFile: (p: string) => string | null;
  run: (cmd: string, args: string[]) => string | null;
  /** Fallback store when the OS exposes no id: read, or create once. */
  fallback: () => string;
}

function readFileOrNull(p: string): string | null {
  try {
    return fs.readFileSync(p, "utf8");
  } catch {
    return null;
  }
}

function runOrNull(cmd: string, args: string[]): string | null {
  try {
    return execFileSync(cmd, args, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 5000 });
  } catch {
    return null;
  }
}

/** A random id written once under HOME — used only when the OS has none. */
function persistedFallbackId(): string {
  const file = path.join(os.homedir(), ".synap", "machine-id");
  const existing = readFileOrNull(file)?.trim();
  if (existing) return existing;
  const id = randomUUID();
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    fs.writeFileSync(file, id + "\n", { mode: 0o600 });
  } catch {
    /* unwritable HOME: the id still holds for this run */
  }
  return id;
}

export const DEFAULT_MACHINE_ID_SOURCES: MachineIdSources = {
  platform: process.platform,
  readFile: readFileOrNull,
  run: runOrNull,
  fallback: persistedFallbackId,
};

/** The OS's machine identifier, or the persisted fallback. Never empty. */
export function readMachineId(src: MachineIdSources = DEFAULT_MACHINE_ID_SOURCES): string {
  let id: string | null | undefined = null;
  if (src.platform === "darwin") {
    const out = src.run("ioreg", ["-rd1", "-c", "IOPlatformExpertDevice"]);
    id = out?.match(/"IOPlatformUUID"\s*=\s*"([^"]+)"/)?.[1];
  } else if (src.platform === "linux") {
    id = src.readFile("/etc/machine-id") ?? src.readFile("/var/lib/dbus/machine-id");
  } else if (src.platform === "win32") {
    const out = src.run("reg", ["query", "HKLM\\SOFTWARE\\Microsoft\\Cryptography", "/v", "MachineGuid"]);
    id = out?.match(/MachineGuid\s+REG_SZ\s+(\S+)/)?.[1];
  }
  const trimmed = id?.trim();
  return trimmed ? trimmed : src.fallback();
}

/**
 * The instance label for `surface` on the computer with `machineId`. Pure.
 * `m-` + 16 hex chars of sha256(machineId, surface): stable, opaque, and
 * different per computer.
 */
export function deriveInstanceId(machineId: string, surface: string): string {
  const digest = createHash("sha256").update(`synap-instance\u0000${machineId}\u0000${surface}`).digest("hex");
  return `m-${digest.slice(0, 16)}`;
}

const cache = new Map<string, string>();

/** This computer's instance label for an agent surface (memoised per process). */
export function machineInstanceId(surface: string, src?: MachineIdSources): string {
  if (src) return deriveInstanceId(readMachineId(src), surface);
  const hit = cache.get(surface);
  if (hit) return hit;
  const id = deriveInstanceId(readMachineId(), surface);
  cache.set(surface, id);
  return id;
}
