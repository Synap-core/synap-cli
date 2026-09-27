/**
 * Which agents live on this machine — the list `synap init` offers to connect.
 *
 * Only the harnesses `synap connect` already has an installer for are listed
 * here (`installForTarget` in lib/targets.ts), so every row a user ticks runs
 * the same installer `synap connect --target=<name>` runs. OpenClaw is ONE row
 * among them, not the path.
 *
 * Detection is a presence check, never a probe: a config dir the harness
 * writes on first run, or its binary on PATH. `home`, `pathEnv`, `platform`
 * and the OpenClaw detector are injectable so tests can run against a fake
 * HOME and a fake PATH.
 */

import fs from "fs";
import os from "os";
import path from "path";
import { detectOpenClaw } from "./openclaw.js";
import type { TargetName } from "./targets.js";

export type DetectableAgent = Extract<TargetName, "claude-code" | "codex" | "cursor" | "openclaw">;

export interface DetectedAgent {
  target: DetectableAgent;
  label: string;
  found: boolean;
  /** What we saw, for the one-line "why we think it's here" hint. */
  evidence?: string;
}

export interface DetectAgentsEnv {
  home?: string;
  pathEnv?: string;
  platform?: NodeJS.Platform;
  /** OpenClaw has its own detector (Docker container or binary + ~/.openclaw). */
  openClawFound?: () => boolean;
}

interface AgentSignals {
  target: DetectableAgent;
  label: string;
  /** Paths relative to HOME whose existence means the harness has run here. */
  homePaths: string[];
  bins: string[];
  /** Absolute app bundle paths, macOS only. */
  macApps?: string[];
}

const SIGNALS: AgentSignals[] = [
  { target: "claude-code", label: "Claude Code", homePaths: [".claude.json", ".claude"], bins: ["claude"] },
  { target: "codex", label: "Codex", homePaths: [".codex"], bins: ["codex"] },
  {
    target: "cursor",
    label: "Cursor",
    homePaths: [".cursor"],
    bins: ["cursor"],
    macApps: ["/Applications/Cursor.app"],
  },
];

function onPath(bin: string, pathEnv: string, platform: NodeJS.Platform): string | null {
  const exts = platform === "win32" ? [".exe", ".cmd", ".bat", ""] : [""];
  for (const dir of pathEnv.split(path.delimiter)) {
    if (!dir) continue;
    for (const ext of exts) {
      const candidate = path.join(dir, bin + ext);
      try {
        if (fs.statSync(candidate).isFile()) return candidate;
      } catch {
        // not here
      }
    }
  }
  return null;
}

export function detectAgents(env: DetectAgentsEnv = {}): DetectedAgent[] {
  const home = env.home ?? os.homedir();
  const pathEnv = env.pathEnv ?? process.env.PATH ?? "";
  const platform = env.platform ?? process.platform;

  const rows: DetectedAgent[] = SIGNALS.map((s) => {
    for (const rel of s.homePaths) {
      if (fs.existsSync(path.join(home, rel))) {
        return { target: s.target, label: s.label, found: true, evidence: `~/${rel}` };
      }
    }
    for (const bin of s.bins) {
      if (onPath(bin, pathEnv, platform)) {
        return { target: s.target, label: s.label, found: true, evidence: `${bin} on PATH` };
      }
    }
    if (platform === "darwin") {
      for (const app of s.macApps ?? []) {
        if (fs.existsSync(app)) {
          return { target: s.target, label: s.label, found: true, evidence: app };
        }
      }
    }
    return { target: s.target, label: s.label, found: false };
  });

  const openClawFound = (env.openClawFound ?? (() => detectOpenClaw().found))();
  rows.push({ target: "openclaw", label: "OpenClaw", found: openClawFound });

  return rows;
}
