/**
 * No test may open the person's real browser.
 *
 * Every CLI opener goes through `safe-open.ts`, whose default launcher is
 * `execFile("open" | "xdg-open" | "rundll32", [url])`. Tests that drive the
 * login or key-approval flows without injecting a launcher used to pop the
 * fixture URLs (`https://pod-admin.example.test/approve-agent/tok-1`,
 * `https://www.synap.live/cli?request=req-1`) in the founder's browser on
 * every full run (found 2026-10-14).
 *
 * Same technique as temp-home.ts: patch the builtin and sync ESM exports, so
 * a named `import { execFile } from "node:child_process"` sees it in every
 * pool. Only the three browser openers are swallowed (recorded in
 * `globalThis.__blockedBrowserOpens`); every other command runs for real.
 */

import childProcess from "node:child_process";
import { EventEmitter } from "node:events";
import { syncBuiltinESMExports } from "node:module";

const BROWSER_OPENERS = new Set(["open", "xdg-open", "rundll32"]);
const blocked: Array<{ cmd: string; args: readonly string[] }> = [];
(globalThis as { __blockedBrowserOpens?: typeof blocked }).__blockedBrowserOpens = blocked;

const realExecFile = childProcess.execFile;
childProcess.execFile = function patchedExecFile(this: unknown, ...argv: unknown[]) {
  const [cmd, args] = argv as [string, unknown];
  if (BROWSER_OPENERS.has(cmd)) {
    blocked.push({ cmd, args: Array.isArray(args) ? (args as string[]) : [] });
    const fake = new EventEmitter() as EventEmitter & { unref: () => void; pid?: number };
    fake.unref = () => {};
    const cb = argv.find((a) => typeof a === "function") as ((e: Error | null, so: string, se: string) => void) | undefined;
    if (cb) queueMicrotask(() => cb(null, "", ""));
    return fake;
  }
  return (realExecFile as (...a: unknown[]) => unknown).apply(this, argv);
} as typeof childProcess.execFile;
syncBuiltinESMExports();
