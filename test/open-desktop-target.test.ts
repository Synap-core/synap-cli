import { describe, expect, it } from "vitest";
import {
  DESKTOP_BUNDLE_ID,
  buildDeepLink,
  darwinOpenArgvCandidates,
  desktopAppPaths,
} from "../src/commands/open.js";

describe("synap open targets the installed desktop app", () => {
  it("keeps the synap:// grammar the desktop handler parses", () => {
    expect(buildDeepLink("entity", "abc-1")).toBe("synap://open/entity/abc-1");
    expect(buildDeepLink("proposal", "p 1")).toBe("synap://open/proposal/p%201");
    expect(buildDeepLink("cell", "generated:product-development-board")).toBe(
      "synap://open/cell/generated%3Aproduct-development-board",
    );
  });

  it("bundle id matches electron-builder appId", () => {
    expect(DESKTOP_BUNDLE_ID).toBe("live.synap.browser");
  });

  it("prefers /Applications/Synap.app when it exists", () => {
    const argv = darwinOpenArgvCandidates("synap://open/entity/x", (p) => p === "/Applications/Synap.app");
    expect(argv[0]).toEqual(["-a", "/Applications/Synap.app", "synap://open/entity/x"]);
    expect(argv.some((a) => a[0] === "-b" && a[1] === DESKTOP_BUNDLE_ID)).toBe(true);
    expect(argv.at(-1)).toEqual(["synap://open/entity/x"]);
  });

  it("falls back to bundle id then Launch Services when no .app is on disk", () => {
    const argv = darwinOpenArgvCandidates("synap://open/view/y", () => false);
    expect(argv[0]).toEqual(["-b", DESKTOP_BUNDLE_ID, "synap://open/view/y"]);
    expect(argv).toHaveLength(2);
  });

  it("lists the two standard install locations", () => {
    expect(desktopAppPaths("/Users/ada")).toEqual([
      "/Applications/Synap.app",
      "/Users/ada/Applications/Synap.app",
    ]);
  });
});
