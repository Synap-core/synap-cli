/**
 * Tripwire: no test can reach the person's real home directory.
 *
 * Holds in EVERY vitest pool — run it with `--pool=threads` too: there,
 * `vi.stubEnv("HOME")` alone does not move `os.homedir()` (worker threads copy
 * `process.env`), which is how a test fixture once landed in a real
 * ~/.synap/config.json. Does NOT cover a test that builds an absolute path to
 * the real home by hand (e.g. from `os.userInfo()`); none does today.
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { homedir as namedHomedir } from "node:os";

const realHome = os.userInfo().homedir;

afterEach(() => vi.unstubAllEnvs());

describe("tests never touch the real home", () => {
  it("os.homedir() is a temp dir, not the real home", () => {
    expect(realHome.length).toBeGreaterThan(1); // non-vacuity: we know the real one
    expect(os.homedir()).not.toBe(realHome);
    expect(namedHomedir()).not.toBe(realHome);
    expect(os.homedir().startsWith(fs.realpathSync(os.tmpdir())) || os.homedir().startsWith(os.tmpdir())).toBe(true);
  });

  it("a test that stubs HOME gets exactly its own dir — in this pool too", () => {
    const mine = fs.mkdtempSync(path.join(os.tmpdir(), "synap-own-home-"));
    vi.stubEnv("HOME", mine);
    expect(os.homedir()).toBe(mine);
    expect(namedHomedir()).toBe(mine);
  });
});
