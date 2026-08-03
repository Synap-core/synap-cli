import { describe, it, expect } from "vitest";
import {
  installedStatusLabel,
  attachmentStatusLabel,
  computeUpdates,
} from "../src/commands/market.js";
import type { UpdateCheck } from "../src/commands/market.js";

// Drop chalk color codes so assertions match on plain text.
// eslint-disable-next-line no-control-regex
const strip = (s: string) => s.replace(/\[[0-9;]*m/g, "");

describe("cache-cold honesty — never claim 'up to date' we didn't verify", () => {
  it("installedStatusLabel: stamped + no drift BUT latest unknown → 'can't check', not 'up to date'", () => {
    const c: UpdateCheck = {
      slug: "crm",
      installedVersion: "h-aaa",
      latestVersion: undefined,
      updateAvailable: false,
      noVersionInfo: false,
    };
    const label = strip(installedStatusLabel(c, false, true));
    expect(label).toContain("can't check");
    expect(label).not.toContain("up to date");
  });

  it("installedStatusLabel: verified current (latest present, equal) → 'up to date'", () => {
    const c: UpdateCheck = {
      slug: "crm",
      installedVersion: "h-aaa",
      latestVersion: "h-aaa",
      updateAvailable: false,
      noVersionInfo: false,
    };
    expect(strip(installedStatusLabel(c, false, true))).toContain("up to date");
  });

  it("attachmentStatusLabel: attached + no drift + unknown latest → 'can't check', not green check", () => {
    const label = strip(
      attachmentStatusLabel({
        kind: "attached",
        slug: "crm",
        version: "h-aaa",
        updateAvailable: false,
        latestVersion: undefined,
      })
    );
    expect(label).toContain("can't check");
    expect(label).not.toContain("✓");
  });

  it("computeUpdates: server drifted:false + latest undefined → updateAvailable:false, latest undefined (feeds the honest label)", () => {
    const [c] = computeUpdates(
      [
        {
          slug: "crm",
          version: "h-aaa",
          workspaceId: "w1",
          workspaceName: "CRM",
          latestVersion: undefined,
          drifted: false,
        },
      ],
      { entries: [], remoteVersionBySlug: new Map() } as never
    );
    expect(c.updateAvailable).toBe(false);
    expect(c.latestVersion).toBeUndefined();
  });
});
