/**
 * Every test file runs with a THROWAWAY HOME — no test can read or write the
 * person's real ~/.synap, ~/.claude or ~/.claude.json.
 *
 * Why this is global and not per-test: tests that "stubbed HOME" still leaked.
 * `os.homedir()` reads $HOME from the REAL process environment, and under
 * vitest's worker-thread pool `process.env` is a per-thread copy — so
 * `vi.stubEnv("HOME", tmp)` changed what the test saw and NOT where
 * `os.homedir()` pointed. A fixture (`agentKeysByPod.claude-code
 * ["https://pod.example.synap.live"] = {hubApiKey:"agent-key-new"}`) landed in
 * a real ~/.synap/config.json that way (found 2026-10-12).
 *
 * So: point HOME at a fresh temp dir, and make `os.homedir()` follow
 * `process.env.HOME` in every pool (named `homedir` imports included). A test
 * that stubs HOME to its own temp dir still gets exactly that dir.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { syncBuiltinESMExports } from "node:module";

const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "synap-cli-test-home-"));
process.env.HOME = tempHome;
process.env.USERPROFILE = tempHome;

const originalHomedir = os.homedir.bind(os);
os.homedir = () => process.env.HOME || originalHomedir();
syncBuiltinESMExports();
