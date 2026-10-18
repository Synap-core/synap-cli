import { describe, it, expect } from "vitest";
import { profileCredentialCheck } from "../src/commands/doctor.js";

/**
 * Pure: takes profile objects, never reads ~/.synap. The marker
 * (`credential: "computer"`) is what `saveDeviceGrant` stamps on a device-flow
 * key; a profile without it holds a pasted / legacy human key.
 */
const computer = { name: "perso", config: { hubApiKey: "k1", credential: "computer" } };
const legacy = { name: "team", config: { hubApiKey: "k2" } };
const keyless = { name: "empty", config: { hubApiKey: "" } };

describe("profileCredentialCheck", () => {
  it("passes when every keyed profile is a computer key", () => {
    expect(profileCredentialCheck([computer, keyless]).ok).toBe(true);
    expect(profileCredentialCheck([]).ok).toBe(true);
  });

  it("fails on a profile without the computer marker, naming the profile and the fix", () => {
    const c = profileCredentialCheck([computer, legacy]);
    expect(c.ok).toBe(false);
    expect(c.unknown).toBeUndefined();
    expect(c.detail).toContain("'team'");
    expect(c.detail).not.toContain("'perso'");
    expect(c.fix).toContain("synap login --reconnect team");
  });

  it("never prints the key", () => {
    const c = profileCredentialCheck([{ name: "team", config: { hubApiKey: "SECRET-VALUE-123" } }]);
    expect(JSON.stringify(c)).not.toContain("SECRET-VALUE-123");
  });

  it("lists every offending profile, one fix each", () => {
    const c = profileCredentialCheck([legacy, { name: "b", config: { hubApiKey: "x" } }]);
    expect(c.detail).toContain("'team', 'b'");
    expect(c.fix).toContain("--reconnect team");
    expect(c.fix).toContain("--reconnect b");
  });
});
