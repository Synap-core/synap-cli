import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect } from "vitest";
import { convCachePath, podCacheFile, podLockFile, writeStatuslineFile } from "./statusline-store.js";

describe("statusline store", () => {
  it("keeps every cache and lock under ~/.synap/statusline, never /tmp", () => {
    const dir = path.join(os.homedir(), ".synap", "statusline");
    for (const f of [podCacheFile(), podLockFile(), convCachePath("abc")]) {
      expect(path.dirname(f)).toBe(dir);
      expect(f.startsWith("/tmp/")).toBe(false);
    }
  });

  it("writes 0600 in a 0700 directory, even over an existing 0644 file", () => {
    const f = convCachePath("modes-test");
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, "old", { mode: 0o644 });
    writeStatuslineFile(f, '{"a":1}');
    expect(fs.readFileSync(f, "utf-8")).toBe('{"a":1}');
    expect(fs.statSync(f).mode & 0o777).toBe(0o600);
    expect(fs.statSync(path.dirname(f)).mode & 0o777).toBe(0o700);
  });

  it.skipIf(process.platform === "win32")("refuses to write through a symlink and leaves its target alone", () => {
    const target = path.join(os.tmpdir(), `statusline-victim-${process.pid}`);
    fs.writeFileSync(target, "victim");
    const f = convCachePath("symlink-test");
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.rmSync(f, { force: true });
    fs.symlinkSync(target, f);
    try {
      expect(() => writeStatuslineFile(f, "pwned")).toThrow();
      expect(fs.readFileSync(target, "utf-8")).toBe("victim");
    } finally {
      fs.rmSync(f, { force: true });
      fs.rmSync(target, { force: true });
    }
  });
});
