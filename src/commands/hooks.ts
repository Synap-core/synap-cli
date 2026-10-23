/**
 * `synap hooks install-wake` — put the wake hook in a Claude Code settings
 * file (or take it out with `--uninstall`). The merge and the contract live in
 * `lib/wake-hook-settings.ts`; `synap init` calls {@link installWakeHookForProject}.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import chalk from "chalk";
import { log } from "../utils/logger.js";
import {
  WAKE_HOOK_COMMAND,
  applyWakeHook,
  wakeHookSettingsPath,
  type WakeHookChange,
} from "../lib/wake-hook-settings.js";

export interface InstallWakeOpts {
  uninstall?: boolean;
  user?: boolean;
  dir?: string;
  json?: boolean;
}

const SAID: Record<WakeHookChange, string> = {
  added: "Wake hook added",
  updated: "Wake hook updated",
  unchanged: "Wake hook already in place",
  removed: "Wake hook removed",
  absent: "No wake hook to remove",
};

export function installWakeCommand(opts: InstallWakeOpts): void {
  const file = wakeHookSettingsPath(opts);
  let change: WakeHookChange;
  try {
    change = applyWakeHook(file, opts.uninstall === true);
  } catch (e) {
    if (opts.json) console.log(JSON.stringify({ file, error: (e as Error).message }));
    else log.error((e as Error).message);
    process.exit(1);
    return;
  }
  if (opts.json) {
    console.log(JSON.stringify({ file, change, command: WAKE_HOOK_COMMAND }));
    return;
  }
  log.success(`${SAID[change]}: ${file}`);
  if (!opts.uninstall) {
    log.dim(`Stop → ${WAKE_HOOK_COMMAND} (asyncRewake)`);
    log.dim("A Claude Code terminal attached to a session (synap session attach <id>) now wakes when another");
    log.dim("session's agent hands it work or is blocked on it, or when you answer in the session's room.");
    log.dim(`Undo: ${chalk.cyan("synap hooks install-wake --uninstall" + (opts.user ? " --user" : ""))}`);
  }
}

/**
 * `synap init`'s step: install into the project init runs in — only when that
 * directory IS a project (it has `.git` or `.claude`), never into a stray
 * directory, and never into the home directory (that file is the user's
 * global settings: `--user` is a deliberate choice). Never fails init.
 */
export function installWakeHookForProject(dir = process.cwd()): void {
  const here = path.resolve(dir);
  const isProject = fs.existsSync(path.join(here, ".git")) || fs.existsSync(path.join(here, ".claude"));
  if (here === path.resolve(os.homedir()) && !isProject) {
    log.dim(`To let another session wake Claude Code here, run in your project: ${chalk.cyan("synap hooks install-wake")}`);
    return;
  }
  try {
    const file = wakeHookSettingsPath({ dir: here });
    const change = applyWakeHook(file);
    if (change === "added" || change === "updated") {
      log.success(`Claude Code wake hook ${change}: ${file}`);
      log.dim(`Undo: ${chalk.cyan("synap hooks install-wake --uninstall")}`);
    }
  } catch (e) {
    log.warn(`Wake hook not installed: ${(e as Error).message}`);
  }
}
