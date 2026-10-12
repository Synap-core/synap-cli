/**
 * Doctor default output hides internal addresses, ids and raw timestamps;
 * `-v` shows them verbatim. Pure (`forDisplay`), from real detail strings the
 * checks produce.
 */
import { describe, it, expect } from "vitest";
import { forDisplay } from "../src/commands/doctor.js";

describe("forDisplay", () => {
  const is = "intelligence-service answered at http://10.10.0.20:3001 in 4ms (checked as workspace 808939d1-86b3-4c52-a153-ae06ece2c54e)";
  it("drops internal URLs and id-only parentheticals by default", () => {
    expect(forDisplay(is)).toBe("intelligence-service answered in 4ms");
  });
  it("shortens ISO timestamps to the date, ids to …", () => {
    expect(forDisplay("valid until 2026-11-03T04:30:16.000Z; key 808939d1-86b3-4c52-a153-ae06ece2c54e is gone")).toBe("valid until 2026-11-03; key … is gone");
  });
  it("keeps public URLs (the pod's own address is the person's)", () => {
    expect(forDisplay("https://pod.antoinesrvt.synap.live did not answer /health")).toBe("https://pod.antoinesrvt.synap.live did not answer /health");
  });
  it("-v shows everything verbatim", () => {
    expect(forDisplay(is, true)).toBe(is);
  });
});
