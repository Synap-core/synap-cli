/**
 * ONE canonical spelling for the pod-wide opt-in, with the old one still
 * accepted. `--pod-wide` is canonical; `--global` is the retained alias so no
 * existing script (or the `synap capture --global` line in CLAUDE.md) breaks.
 */

import { describe, it, expect } from "vitest";
import { resolvePodWide, isPodWideToken, POD_WIDE_FLAGS } from "../src/lib/pod-wide.js";

describe("resolvePodWide — canonical flag plus alias", () => {
  it("the canonical --pod-wide opts in", () => {
    expect(resolvePodWide({ podWide: true })).toBe(true);
  });

  it("the legacy --global alias still opts in", () => {
    expect(resolvePodWide({ global: true })).toBe(true);
  });

  it("both together are not a conflict", () => {
    expect(resolvePodWide({ podWide: true, global: true })).toBe(true);
  });

  it("neither means workspace-scoped — the default is unchanged", () => {
    expect(resolvePodWide({})).toBe(false);
    expect(resolvePodWide({ podWide: false, global: false })).toBe(false);
  });

  it("--pod-wide is declared first, i.e. canonical", () => {
    expect(POD_WIDE_FLAGS[0]).toBe("pod-wide");
    expect(POD_WIDE_FLAGS).toContain("global");
  });
});

describe("isPodWideToken — every spelling of the value", () => {
  it("accepts all four spellings found in the CLI, case- and space-insensitively", () => {
    for (const t of ["pod", "pod-wide", "podwide", "pod_wide", "global", " Pod-Wide ", "GLOBAL"]) {
      expect(isPodWideToken(t)).toBe(true);
    }
  });

  it("a real workspace name or id is not a pod-wide token", () => {
    expect(isPodWideToken("808939d1-86b3-4c52-a153-ae06ece2c54e")).toBe(false);
    expect(isPodWideToken("Builder")).toBe(false);
    expect(isPodWideToken("global-marketing")).toBe(false);
  });

  it("absent input is not an opt-in", () => {
    expect(isPodWideToken(undefined)).toBe(false);
    expect(isPodWideToken(null)).toBe(false);
    expect(isPodWideToken("")).toBe(false);
  });
});
