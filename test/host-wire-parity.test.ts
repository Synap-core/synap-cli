/**
 * The host-job wire's single definition is `@synap-core/types/host-jobs`
 * (backend, plan 64072312 U7). Until a types release carries it, the runner
 * mirrors its shapes (src/lib/host/wire.ts); this test pins the mirror to the
 * backend source whenever that source is checked out beside this repo (CI
 * checks out Synap-core/backend as ../synap-backend). It skips, and says so,
 * while backend main does not have the file yet (#779 unmerged).
 * HOST_WIRE_SOURCE=<file> points it at another copy.
 */

import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { HOST_BODY_MAX_BYTES, HOST_FINISH_STATUSES, HOST_JOB_KINDS, HOST_LOG_CAP } from "../src/lib/host/wire.js";

const source =
  process.env.HOST_WIRE_SOURCE ?? path.resolve(__dirname, "../../synap-backend/packages/types/src/host-jobs/index.ts");
const present = fs.existsSync(source);
if (!present) console.warn(`host-wire parity: ${source} is absent (backend #779 not on main yet): skipped`);

const list = (text: string, re: RegExp) => [...(re.exec(text)?.[1] ?? "").matchAll(/"([a-z_]+)"/g)].map((m) => m[1]);

describe.skipIf(!present)("host-job wire mirror = @synap-core/types/host-jobs", () => {
  const text = present ? fs.readFileSync(source, "utf8") : "";
  it("job kinds", () => {
    expect(list(text, /HOST_JOB_WIRE_KINDS = \[([^\]]+)\]/)).toEqual([...HOST_JOB_KINDS]);
  });
  it("finish verdicts", () => {
    expect(list(text, /status: z\.enum\(\[([^\]]+)\]\)/)).toEqual([...HOST_FINISH_STATUSES]);
  });
  it("log cap and body cap", () => {
    expect(text).toMatch(/HOST_LOG_CAP = 64 \* 1024;/);
    expect(HOST_LOG_CAP).toBe(64 * 1024);
    expect(text).toMatch(/HOST_BODY_MAX_BYTES = 2 \* 1024 \* 1024;/);
    expect(HOST_BODY_MAX_BYTES).toBe(2 * 1024 * 1024);
  });
  it("heartbeat phases and the 127.0.0.1-only port report", () => {
    expect(text).toMatch(/phase: z\.enum\(\["setup", "running"\]\)/);
    expect(text).toMatch(/host: z\.literal\("127\.0\.0\.1"\)/);
  });
});
