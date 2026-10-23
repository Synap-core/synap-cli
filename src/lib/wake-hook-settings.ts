/**
 * The wake hook in a Claude Code settings file — `synap hooks install-wake`
 * and `synap init`.
 *
 * One `Stop` hook, `asyncRewake: true`, running `synap session wait --hook`.
 * The contract, verified against Claude Code 2.1.309 (its bundled settings
 * schema and hook runner) and code.claude.com/docs/en/hooks:
 *   - `asyncRewake` runs the command in the background ("Implies async") and
 *     wakes the model when it exits 2; the hook's stderr (stdout if stderr is
 *     empty) is shown to Claude as a system reminder. Any other exit wakes no one.
 *   - `timeout` is enforced on it too (seconds; default 600, no maximum in the
 *     schema), so the entry sets one and the command stops on its own first.
 *   - Only an INTERACTIVE session (or the SDK with streaming input) backgrounds
 *     it; `claude -p` runs it in the foreground — the command exits at once there.
 *
 * The merge never clobbers: other hooks, other events and other keys are kept
 * as they are, a second install is a no-op, and a file that does not parse is
 * refused (`readJsonStrict`), never rewritten from `{}`. The command names
 * `synap` on PATH, not this machine's absolute path, because a project's
 * `.claude/settings.json` is usually committed and shared.
 */

import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { readJsonStrict, writeFileAtomic } from "./atomic-file.js";

/** Claude Code's own limit on the background process, in seconds. */
export const WAKE_HOOK_TIMEOUT_SECONDS = 3600;
/** Our own deadline sits under it, so we exit 0 (no wake) before Claude Code kills us. */
export const WAKE_HOOK_COMMAND = "synap session wait --hook --timeout 55m";

export interface WakeHookEntry {
  type: "command";
  command: string;
  asyncRewake: true;
  timeout: number;
}

export const WAKE_HOOK_ENTRY: WakeHookEntry = {
  type: "command",
  command: WAKE_HOOK_COMMAND,
  asyncRewake: true,
  timeout: WAKE_HOOK_TIMEOUT_SECONDS,
};

type Settings = Record<string, unknown>;
type HookGroup = { matcher?: string; hooks?: unknown[] } & Record<string, unknown>;

/** Ours, in any version: a command hook that runs `synap session wait … --hook`. */
export function isWakeHook(hook: unknown): boolean {
  if (!hook || typeof hook !== "object") return false;
  const h = hook as { type?: unknown; command?: unknown };
  return (
    h.type === "command" &&
    typeof h.command === "string" &&
    /(^|[\s/])synap\s+session\s+wait\b/.test(h.command) &&
    /\s--hook\b/.test(h.command)
  );
}

function sameEntry(hook: unknown): boolean {
  if (!hook || typeof hook !== "object") return false;
  const h = hook as Record<string, unknown>;
  return (
    h.type === WAKE_HOOK_ENTRY.type &&
    h.command === WAKE_HOOK_ENTRY.command &&
    h.asyncRewake === true &&
    h.timeout === WAKE_HOOK_ENTRY.timeout
  );
}

/** The settings' `hooks.Stop` array, or a refusal when the file holds something else there. */
function stopGroups(settings: Settings): HookGroup[] {
  const hooks = settings.hooks;
  if (hooks !== undefined && (typeof hooks !== "object" || hooks === null || Array.isArray(hooks))) {
    throw new Error("`hooks` in this settings file is not an object; fix it by hand, nothing was written.");
  }
  const stop = (hooks as Record<string, unknown> | undefined)?.Stop;
  if (stop === undefined) return [];
  if (!Array.isArray(stop)) {
    throw new Error("`hooks.Stop` in this settings file is not a list; fix it by hand, nothing was written.");
  }
  return stop as HookGroup[];
}

export type WakeHookChange = "added" | "updated" | "unchanged" | "removed" | "absent";

/**
 * Settings with the wake hook in place. An older wake entry (another command
 * line or timeout) is updated where it stands; anything else is untouched.
 */
export function withWakeHook(settings: Settings): { settings: Settings; change: WakeHookChange } {
  const groups = stopGroups(settings);
  let found = false;
  let updated = false;
  const nextGroups = groups.map((g) => {
    if (!Array.isArray(g?.hooks)) return g;
    const hooks = g.hooks.flatMap((h) => {
      if (!isWakeHook(h)) return [h];
      if (found) {
        updated = true; // a duplicate of ours: keep one
        return [];
      }
      found = true;
      if (sameEntry(h)) return [h];
      updated = true;
      return [{ ...WAKE_HOOK_ENTRY }];
    });
    return { ...g, hooks };
  });
  const cleaned = nextGroups.filter((g) => !Array.isArray(g?.hooks) || g.hooks.length > 0);
  void cleaned;
  const finalGroups = [{ hooks: [{ ...WAKE_HOOK_ENTRY }] }];
  return {
    settings: {
      ...settings,
      hooks: { ...((settings.hooks as Record<string, unknown>) ?? {}), Stop: finalGroups },
    },
    change: found ? "updated" : "added",
  };
}

/** Settings without the wake hook. Empty groups, an empty `Stop` and an empty `hooks` go too. */
export function withoutWakeHook(settings: Settings): { settings: Settings; change: WakeHookChange } {
  const groups = stopGroups(settings);
  let removed = false;
  const nextGroups = groups
    .map((g) => {
      if (!Array.isArray(g?.hooks)) return g;
      const hooks = g.hooks.filter((h) => {
        const ours = isWakeHook(h);
        if (ours) removed = true;
        return !ours;
      });
      return { ...g, hooks };
    })
    .filter((g) => !Array.isArray(g?.hooks) || g.hooks.length > 0);
  if (!removed) return { settings, change: "absent" };
  const { Stop: _stop, ...otherEvents } = (settings.hooks as Record<string, unknown>) ?? {};
  const hooks = nextGroups.length > 0 ? { ...otherEvents, Stop: nextGroups } : otherEvents;
  const { hooks: _hooks, ...rest } = settings;
  return {
    settings: Object.keys(hooks).length > 0 ? { ...rest, hooks } : rest,
    change: "removed",
  };
}

/** `<dir>/.claude/settings.json`, or the user's `~/.claude/settings.json`. */
export function wakeHookSettingsPath(opts: { user?: boolean; dir?: string }): string {
  if (opts.user) return path.join(os.homedir(), ".claude", "settings.json");
  return path.join(path.resolve(opts.dir ?? process.cwd()), ".claude", "settings.json");
}

/** Read, merge, write (only when something changed). Throws on a file that does not parse. */
export function applyWakeHook(file: string, uninstall = false): WakeHookChange {
  const existing = readJsonStrict<Settings>(file);
  if (!existing && uninstall) return "absent";
  const { settings, change } = uninstall ? withoutWakeHook(existing ?? {}) : withWakeHook(existing ?? {});
  if (change === "added" || change === "updated" || change === "removed") {
    // A new project settings file is shared config, not a secret: 0644. An
    // existing file keeps its own mode (~/.claude/settings.json holds keys).
    writeFileAtomic(file, JSON.stringify(settings, null, 2) + "\n", fs.existsSync(file) ? {} : { mode: 0o644 });
  }
  return change;
}
