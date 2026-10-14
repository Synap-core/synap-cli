import { describe, expect, it } from "vitest";
import { openExternalUrl } from "../src/lib/safe-open.js";

/** Guard for test/setup/no-real-browser.ts: the default launcher must never reach a real browser in tests. */
describe("tests never open the real browser", () => {
  it("swallows the default launcher's opener and records it", () => {
    const blocked = (globalThis as { __blockedBrowserOpens?: Array<{ cmd: string; args: readonly string[] }> })
      .__blockedBrowserOpens;
    expect(blocked).toBeDefined();
    const before = blocked!.length;
    const url = "https://browser-guard.example.test/never-opened";
    expect(openExternalUrl(url, { platform: "darwin" })).toBe(true);
    expect(blocked!.length).toBe(before + 1);
    expect(blocked![before]).toEqual({ cmd: "open", args: [url] });
  });
});
