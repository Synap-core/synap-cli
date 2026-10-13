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
import { ensureSecretDir, writeSecretFile } from "./atomic-file.js";
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
    ensureSecretDir(path.dirname(file));
    writeSecretFile(file, id + "\n");
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

/**
 * This computer's NAME for the person — sent as `instanceLabel` with every
 * agent-key mint, so a connection reads "Claude Code on devbox" on the
 * approval page and in `synap agents list`. Display only: the pod replaces by
 * `instanceId`, never by this. `SYNAP_COMPUTER_NAME` renames it; otherwise the
 * OS hostname without its domain ("MacBook-Pro.local" → "MacBook-Pro"). Pure.
 */
export function deriveInstanceLabel(hostname: string, override?: string | null): string | undefined {
  const named = override?.trim();
  if (named) return named.slice(0, 64);
  const short = hostname.trim().split(".")[0]?.trim();
  return short ? short.slice(0, 64) : undefined;
}

/** This computer's name (see {@link deriveInstanceLabel}). */
export function machineInstanceLabel(): string | undefined {
  return deriveInstanceLabel(os.hostname(), process.env.SYNAP_COMPUTER_NAME);
}

/**
 * The ONE surface → pod agentType mapping, for the surfaces whose keys are
 * minted under ANOTHER agent type. Every other surface mints under its own
 * name (surface === agentType). Keys are minted with
 * `machineInstanceId(surface)`, but the pod lists connections by agentType —
 * so "is this connection from this computer?" must hash the SURFACE(s), never
 * the agentType alone (ChatGPT's keys are `generic` agents labelled with the
 * `chatgpt` surface hash).
 */
export const SURFACE_AGENT_TYPE: Readonly<Record<string, string>> = { chatgpt: "generic" };

/** The pod agentType a surface's keys are minted under. */
export function agentTypeOfSurface(surface: string): string {
  return SURFACE_AGENT_TYPE[surface] ?? surface;
}

/**
 * This computer's instance ids for keys of `agentType`: one per surface that
 * mints under it (the agentType itself included — a mint with no surface name
 * hashes the agentType).
 */
export function thisComputerInstanceIds(agentType: string, idFor: (surface: string) => string = (s) => machineInstanceId(s)): Set<string> {
  const surfaces = [agentType, ...Object.entries(SURFACE_AGENT_TYPE).filter(([, t]) => t === agentType).map(([s]) => s)];
  return new Set(surfaces.map(idFor));
}
