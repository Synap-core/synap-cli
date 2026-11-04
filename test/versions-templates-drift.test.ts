/**
 * `synap versions` printed "in sync" on 2026-11-04 while the CP catalog was
 * 0.23.0 and npm still served 0.12.0 (its publish step had failed since
 * August), so a fresh CLI install bundled a September catalog. The verdict
 * must name every copy that is behind, npm included.
 */
import { describe, expect, it } from "vitest";
import { templatesDrift } from "../src/commands/versions.js";

describe("templatesDrift", () => {
  it("is red when npm is behind the CP (the 2026-11-04 state)", () => {
    const d = templatesDrift({ local: "0.12.0", npm: "0.12.0", cp: "0.23.0" });
    expect(d.inSync).toBe(false);
    expect(d.message).toContain("npm is behind the CP");
    expect(d.message).toContain("0.12.0");
    expect(d.message).toContain("0.23.0");
  });

  it("is red when the CP is behind npm", () => {
    const d = templatesDrift({ local: "0.23.0", npm: "0.23.0", cp: "0.12.0" });
    expect(d.inSync).toBe(false);
    expect(d.message).toContain("CP is behind npm");
  });

  it("is red when the local bundle is behind npm", () => {
    const d = templatesDrift({ local: "0.12.0", npm: "0.23.0", cp: "0.23.0" });
    expect(d.inSync).toBe(false);
    expect(d.message).toContain("Local CLI bundle is behind npm");
  });

  it("cannot say when npm or the CP is unknown", () => {
    expect(templatesDrift({ local: "0.23.0", cp: "0.23.0" }).inSync).toBe(false);
    expect(templatesDrift({ local: "0.23.0", npm: "0.23.0" }).inSync).toBe(false);
  });

  it("is in sync only when all three agree", () => {
    expect(templatesDrift({ local: "0.23.0", npm: "0.23.0", cp: "0.23.0" })).toEqual({
      inSync: true,
      message: "in sync",
    });
  });
});
