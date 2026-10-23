/**
 * `synap hooks install-wake` / `synap init` — the wake hook merge. Pins:
 *   • into an empty or missing file: one Stop group with our asyncRewake entry;
 *   • every other hook, event and key is kept exactly (no clobber);
 *   • a second install is a no-op — the file is byte-identical;
 *   • an older wake entry is updated where it stands, duplicates collapse;
 *   • uninstall removes only ours and drops the empty containers it leaves;
 *   • a file that does not parse, or a `hooks.Stop` that is not a list, is
 *     refused and left untouched — never rewritten from `{}`.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect } from "vitest";
import {
  WAKE_HOOK_COMMAND,
  WAKE_HOOK_ENTRY,
  applyWakeHook,
  isWakeHook,
  wakeHookSettingsPath,
  withWakeHook,
  withoutWakeHook,
} from "../src/lib/wake-hook-settings.js";

function project(settings?: unknown): { dir: string; file: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wake-hook-"));
  const file = wakeHookSettingsPath({ dir });
  if (settings !== undefined) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, typeof settings === "string" ? settings : JSON.stringify(settings, null, 2));
  }
  return { dir, file };
}
const read = (file: string) => JSON.parse(fs.readFileSync(file, "utf8"));

const OTHER_STOP = { type: "command", command: "~/.claude/hooks/notify.sh" };
const RICH = {
  env: { FOO: "bar" },
  permissions: { allow: ["Bash(git status)"] },
  hooks: {
    PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "guard.sh" }] }],
    Stop: [{ hooks: [OTHER_STOP] }],
  },
};

describe("withWakeHook / applyWakeHook", () => {
  it("creates the file with one asyncRewake Stop entry", () => {
    const { file } = project();
    expect(applyWakeHook(file)).toBe("added");
    expect(read(file)).toEqual({ hooks: { Stop: [{ hooks: [WAKE_HOOK_ENTRY] }] } });
    expect(WAKE_HOOK_ENTRY).toMatchObject({ type: "command", asyncRewake: true, timeout: 3600 });
    expect(WAKE_HOOK_ENTRY.command).toBe(WAKE_HOOK_COMMAND);
  });

  it("keeps every other hook, event and key", () => {
    const { file } = project(RICH);
    expect(applyWakeHook(file)).toBe("added");
    const after = read(file);
    expect(after.env).toEqual(RICH.env);
    expect(after.permissions).toEqual(RICH.permissions);
    expect(after.hooks.PreToolUse).toEqual(RICH.hooks.PreToolUse);
    expect(after.hooks.Stop).toEqual([{ hooks: [OTHER_STOP] }, { hooks: [WAKE_HOOK_ENTRY] }]);
  });

  it("a second install is a no-op: the file is byte-identical", () => {
    const { file } = project(RICH);
    applyWakeHook(file);
    const once = fs.readFileSync(file, "utf8");
    expect(applyWakeHook(file)).toBe("unchanged");
    expect(fs.readFileSync(file, "utf8")).toBe(once);
  });

  it("updates an older wake entry where it stands and collapses duplicates", () => {
    const old = { type: "command", command: "synap session wait --events session_message --hook", asyncRewake: true };
    const { settings, change } = withWakeHook({
      hooks: { Stop: [{ hooks: [OTHER_STOP, old] }, { hooks: [{ ...old }] }] },
    });
    expect(change).toBe("updated");
    expect((settings.hooks as { Stop: unknown }).Stop).toEqual([{ hooks: [OTHER_STOP, WAKE_HOOK_ENTRY] }]);
  });

  it("refuses a file that does not parse, and leaves it as it was", () => {
    const { file } = project("{ not json");
    expect(() => applyWakeHook(file)).toThrow(/could not be read as JSON/);
    expect(fs.readFileSync(file, "utf8")).toBe("{ not json");
  });

  it("refuses a hooks.Stop that is not a list", () => {
    expect(() => withWakeHook({ hooks: { Stop: { command: "x" } } })).toThrow(/not a list/);
    expect(() => withWakeHook({ hooks: "nope" })).toThrow(/not an object/);
  });
});

describe("withoutWakeHook", () => {
  it("removes only ours and drops the empty containers it leaves", () => {
    const { file } = project(RICH);
    applyWakeHook(file);
    expect(applyWakeHook(file, true)).toBe("removed");
    expect(read(file)).toEqual(RICH);

    const alone = withoutWakeHook({ hooks: { Stop: [{ hooks: [WAKE_HOOK_ENTRY] }] }, model: "x" });
    expect(alone).toEqual({ settings: { model: "x" }, change: "removed" });
  });

  it("is a no-op when there is nothing to remove, file or no file", () => {
    const { file } = project(RICH);
    expect(applyWakeHook(file, true)).toBe("absent");
    expect(read(file)).toEqual(RICH);
    expect(applyWakeHook(project().file, true)).toBe("absent");
  });
});

describe("isWakeHook", () => {
  it("recognises ours in any form, and nothing else", () => {
    expect(isWakeHook(WAKE_HOOK_ENTRY)).toBe(true);
    expect(isWakeHook({ type: "command", command: "/usr/local/bin/synap session wait abc --hook" })).toBe(true);
    expect(isWakeHook({ type: "command", command: "synap session wait abc" })).toBe(false);
    expect(isWakeHook({ type: "command", command: "synap hooks install-wake" })).toBe(false);
    expect(isWakeHook({ type: "http", command: WAKE_HOOK_COMMAND })).toBe(false);
    expect(isWakeHook(OTHER_STOP)).toBe(false);
  });
});

describe("installWakeHookForProject (synap init)", () => {
  it("installs into a project, never into the home directory or a stray directory", async () => {
    const { installWakeHookForProject } = await import("../src/commands/hooks.js");
    const repo = project();
    fs.mkdirSync(path.join(repo.dir, ".git"));
    installWakeHookForProject(repo.dir);
    expect(read(repo.file).hooks.Stop).toEqual([{ hooks: [WAKE_HOOK_ENTRY] }]);

    const stray = project();
    installWakeHookForProject(stray.dir);
    expect(fs.existsSync(stray.file)).toBe(false);

    installWakeHookForProject(os.homedir());
    expect(fs.existsSync(path.join(os.homedir(), ".claude", "settings.json"))).toBe(false);
  });
});
