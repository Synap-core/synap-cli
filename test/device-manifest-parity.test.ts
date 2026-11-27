/**
 * The CLI mirrors the backend's device manifest v1 (src/lib/device-manifest.ts).
 * When the backend is checked out beside this repo and carries the module,
 * the version, the capability-name pattern, the reporter-name pattern, the
 * osVersion limit and the windows the report cadence must fit in agree.
 * Skips when absent (older backend main, or no checkout), like the other
 * parity tests.
 */
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  DEVICE_MANIFEST_VERSION,
  DEVICE_REPORTER_NAME,
  DEVICE_REPORTERS,
  REPORT_CHECK_MS,
  REPORT_EVERY_MS,
} from "../src/lib/device-manifest.js";

const src = path.resolve(__dirname, "../../synap-backend/packages/types/src/device-manifest/index.ts");
const present = fs.existsSync(src);

/** `NAME = 30 * 60 * 1000;` in the backend source → its value in ms. */
function constMs(text: string, name: string): number {
  const m = new RegExp(`export const ${name} = ([\\d_ *]+);`).exec(text);
  if (!m) throw new Error(`${name} not found in the backend's device-manifest`);
  return m[1]!.split("*").reduce((acc, f) => acc * Number(f.trim().replace(/_/g, "")), 1);
}

describe.skipIf(!present)("device manifest parity with the backend", () => {
  const text = present ? fs.readFileSync(src, "utf8") : "";
  it("same manifest version", () => {
    expect(text).toContain(`DEVICE_MANIFEST_VERSION = ${DEVICE_MANIFEST_VERSION} as const`);
  });
  it("same capability pattern", () => {
    expect(text).toContain("/^[a-z][a-z0-9-]*(\\.[a-z0-9][a-z0-9-]*)+$/");
  });
  it("same reporter pattern, and every process name passes it", () => {
    expect(text).toContain(`export const DEVICE_REPORTER = ${DEVICE_REPORTER_NAME};`);
    for (const r of DEVICE_REPORTERS) expect(r).toMatch(DEVICE_REPORTER_NAME);
  });
  it("identity.osVersion is a Word(120)", () => {
    expect(text).toContain("osVersion: Word(120).optional(),");
  });
  it("a running process reports inside the capability TTL and the online window", () => {
    const worstGap = REPORT_EVERY_MS + REPORT_CHECK_MS;
    expect(worstGap).toBeLessThanOrEqual(10 * 60_000);
    expect(worstGap).toBeLessThan(constMs(text, "DEVICE_CAPABILITY_TTL_MS"));
    expect(worstGap).toBeLessThanOrEqual(constMs(text, "DEVICE_ONLINE_WINDOW_MS"));
  });
});

/** Two processes on one reporter name overwrite each other's capabilities: each names itself. */
describe("each reporting process names itself", () => {
  const read = (p: string) => fs.readFileSync(path.resolve(__dirname, "..", p), "utf8");
  it("the waker reports as waker", () => {
    expect(read("src/commands/waker.ts")).toContain(`createDeviceReporter({ reporter: "waker"`);
  });
  it("the worker as worker, `--host-only` as host", () => {
    const worker = read("src/commands/worker.ts");
    expect(worker).toContain(`createDeviceReporter({ reporter: "worker"`);
    expect(worker).toContain(`createDeviceReporter({ reporter: "host"`);
  });
  it("no module-wide reporter shared by every process", () => {
    expect(read("src/lib/device-manifest.ts")).not.toMatch(/export const \w+: DeviceReporter =/);
  });
});
