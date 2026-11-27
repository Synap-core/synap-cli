/**
 * The CLI mirrors the backend's device manifest v1 (src/lib/device-manifest.ts).
 * When the backend is checked out beside this repo and carries the module,
 * the version and the capability-name pattern must agree. Skips when absent
 * (older backend main, or no checkout), like the other parity tests.
 */
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { DEVICE_MANIFEST_VERSION } from "../src/lib/device-manifest.js";

const src = path.resolve(__dirname, "../../synap-backend/packages/types/src/device-manifest/index.ts");
const present = fs.existsSync(src);

describe.skipIf(!present)("device manifest parity with the backend", () => {
  const text = present ? fs.readFileSync(src, "utf8") : "";
  it("same manifest version", () => {
    expect(text).toContain(`DEVICE_MANIFEST_VERSION = ${DEVICE_MANIFEST_VERSION} as const`);
  });
  it("same capability pattern", () => {
    expect(text).toContain("/^[a-z][a-z0-9-]*(\\.[a-z0-9][a-z0-9-]*)+$/");
  });
});
