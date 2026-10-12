/**
 * The key-health classifier: ONE diagnosis per problem, with the one right
 * action. One row per state the pod can report — and rows chosen to rule OUT
 * the wrong rule that shipped: a key awaiting approval must never read as
 * revoked (2026-10-12), and a key replaced by ANOTHER computer must ask for
 * this computer's own connection, not a plain re-login.
 */

import { describe, it, expect } from "vitest";
import { diagnoseKeys, describeKeyState, type Diagnosis } from "../src/lib/key-diagnosis.js";
import { writeGate, type KeyState } from "../src/lib/key-state.js";
import type { KeyLocation } from "../src/lib/key-locations.js";

const THIS = "m-thiscomputer0000";
const loc = (kind: KeyLocation["kind"], key: string, extra: Partial<KeyLocation> = {}): KeyLocation => ({
  kind,
  label: `${kind}`,
  role: kind === "profile" ? "person" : "agent",
  surface: kind === "profile" || kind === "shell-rc" || kind === "process-env" ? undefined : "claude-code",
  key,
  rewritable: kind !== "profile" && kind !== "shell-rc" && kind !== "process-env",
  ...extra,
});

function run(locations: KeyLocation[], states: Record<string, KeyState>, envKey?: string): Diagnosis[] {
  return diagnoseKeys({
    locations,
    states: new Map(Object.entries(states)),
    instanceIdFor: () => THIS,
    envKey,
  });
}
const only = (ds: Diagnosis[], surface = "claude-code") => {
  const d = ds.filter((x) => x.surface === surface);
  expect(d).toHaveLength(1);
  return d[0]!;
};

const ACTIVE: KeyState = { state: "active" };
const PENDING: KeyState = {
  state: "awaiting_approval",
  createdAt: "2026-10-12T09:00:00.000Z",
  approvalUrl: "https://pod-admin.x/approve-agent/k2?agentType=claude-code",
  agentType: "claude-code",
};

describe("diagnoseKeys — one diagnosis per state", () => {
  it("all copies on a live key → ok, no action", () => {
    const d = only(run([loc("agent-key-by-pod", "k1"), loc("claude-settings-env", "k1")], { k1: ACTIVE }));
    expect(d.code).toBe("ok");
    expect(d.action).toBe("none");
  });

  it("a pending key is AWAITING APPROVAL — approve and wait, never 'revoked', never re-provision", () => {
    const d = only(run([loc("agent-key-by-pod", "k2"), loc("claude-mcp-header", "k2")], { k2: PENDING }));
    expect(d.code).toBe("awaiting_approval");
    expect(d.action).toBe("approve_and_wait");
    expect(d.key).toBe("k2");
    expect(d.approvalUrl).toBe(PENDING.approvalUrl);
    expect(d.lines.join(" ")).toContain("never revoked");
    expect(d.title).not.toMatch(/revoked|expired/i);
  });

  it("several unapproved requests: the recorded one wins, the rest are named as leftovers", () => {
    const older = { ...PENDING, createdAt: "2026-10-12T08:00:00.000Z" };
    const d = only(
      run([loc("agent-key-by-pod", "kA"), loc("pending", "kB"), loc("claude-settings-env", "kC")], { kA: older, kB: older, kC: PENDING })
    );
    expect(d.key).toBe("kB");
    expect(d.lines.join(" ")).toMatch(/2 other unapproved requests/);
  });

  it("replaced by an approval with NO computer label (older CLI) → this computer gets its own connection", () => {
    const s: KeyState = { state: "revoked", revokedAt: "2026-10-12T10:00:00Z", revokedReason: "Replaced by a newly approved connection", replacedBy: { createdAt: "2026-10-12T09:58:00Z", instanceId: null } };
    const d = only(run([loc("agent-key-by-pod", "k1")], { k1: s }));
    expect(d.code).toBe("replaced_by_other_computer");
    expect(d.action).toBe("reprovision");
    expect(d.lines.join(" ")).toMatch(/no computer label/);
  });

  it("replaced by ANOTHER computer's labelled connection → replaced_by_other_computer", () => {
    const s: KeyState = { state: "revoked", revokedAt: "x", revokedReason: "Replaced by a newly approved connection", replacedBy: { createdAt: "y", instanceId: "m-devbox" } };
    const d = only(run([loc("agent-key-by-pod", "k1")], { k1: s }));
    expect(d.code).toBe("replaced_by_other_computer");
    expect(d.lines.join(" ")).toContain("m-devbox");
  });

  it("replaced by a connection from THIS computer → replaced_on_this_computer", () => {
    const s: KeyState = { state: "revoked", revokedAt: "x", revokedReason: "Replaced by a newly approved connection", replacedBy: { createdAt: "y", instanceId: THIS } };
    expect(only(run([loc("agent-key-by-pod", "k1")], { k1: s })).code).toBe("replaced_on_this_computer");
  });

  it("revoked for another reason → revoked, re-provision", () => {
    const d = only(run([loc("agent-key-by-pod", "k1")], { k1: { state: "revoked", revokedReason: "Disconnected by owner", revokedAt: "x" } }));
    expect(d.code).toBe("revoked");
    expect(d.action).toBe("reprovision");
  });

  it("expired → expired, re-provision", () => {
    expect(only(run([loc("agent-key-by-pod", "k1")], { k1: { state: "expired" } })).code).toBe("expired");
  });

  it("a key the pod does not know → unknown_key", () => {
    expect(only(run([loc("agent-key-by-pod", "k1")], { k1: { state: "unknown" } })).code).toBe("unknown_key");
  });

  it("older pod (inactive, no reason): resume a recorded request rather than file another", () => {
    const withPending = only(run([loc("agent-key-by-pod", "k1"), loc("pending", "k9")], { k1: { state: "inactive", legacy: true }, k9: { state: "inactive", legacy: true } }));
    expect(withPending.code).toBe("refused");
    expect(withPending.action).toBe("approve_and_wait");
    expect(withPending.key).toBe("k9");
    const without = only(run([loc("agent-key-by-pod", "k1")], { k1: { state: "inactive", legacy: true } }));
    expect(without.action).toBe("reprovision");
  });

  it("pod unreachable → unverifiable, NO action (an unknown is not a failure to fix)", () => {
    const d = only(run([loc("agent-key-by-pod", "k1")], { k1: { state: "unreachable", error: "ECONNREFUSED" } }));
    expect(d.code).toBe("unverifiable");
    expect(d.action).toBe("none");
  });

  it("a live key plus copies of an old one → stale_copies, rewrite exactly the stale ones", () => {
    const d = only(run([loc("agent-key-by-pod", "live"), loc("claude-settings-env", "old"), loc("claude-mcp-header", "old")], { live: ACTIVE, old: PENDING }));
    expect(d.code).toBe("stale_copies");
    expect(d.action).toBe("rewrite");
    expect(d.key).toBe("live");
    expect(d.locations.map((l) => l.kind)).toEqual(["claude-settings-env", "claude-mcp-header"]);
  });

  it("the person's own CLI key failing → log in again (not an agent re-provision)", () => {
    const ds = run([loc("profile", "p1", { ref: "default" })], { p1: { state: "revoked", revokedAt: "x" } });
    expect(ds).toHaveLength(1);
    expect(ds[0]!.code).toBe("person_key_dead");
    expect(ds[0]!.command).toBe("synap login --reconnect default");
  });

  it("an env var holding a dead key names the FILE that sets it", () => {
    const ds = run(
      [loc("profile", "p1"), loc("claude-settings-env", "k2", { label: "~/.claude/settings.json → env.SYNAP_HUB_API_KEY" }), loc("process-env", "k2")],
      { p1: ACTIVE, k2: PENDING },
      "k2"
    );
    const env = ds.find((d) => d.code === "env_shadow")!;
    expect(env.severity).toBe("error");
    expect(env.lines[0]).toContain("~/.claude/settings.json");
  });

  it("an env var from a shell rc → edit that file (the doctor never edits rc files)", () => {
    const ds = run([loc("profile", "p1"), loc("shell-rc", "kx", { label: "~/.zshrc:12" }), loc("process-env", "kx")], { p1: ACTIVE, kx: { state: "revoked", revokedAt: "x" } }, "kx");
    const env = ds.find((d) => d.code === "env_shadow")!;
    expect(env.action).toBe("edit_shell_rc");
    expect(env.command).toBe("edit ~/.zshrc:12");
  });

  it("an env var holding the working agent key is by design → no env diagnosis", () => {
    const ds = run([loc("profile", "p1"), loc("agent-key-by-pod", "k1"), loc("claude-settings-env", "k1"), loc("process-env", "k1")], { p1: ACTIVE, k1: ACTIVE }, "k1");
    expect(ds.filter((d) => d.code === "env_shadow")).toEqual([]);
  });
});

describe("describeKeyState never calls a pending key revoked", () => {
  it("awaiting approval reads as waiting, and says it was never revoked", () => {
    expect(describeKeyState(PENDING)).toBe("is waiting for your approval (it was never revoked)");
  });
});

describe("writeGate — the one rule for persisting a key", () => {
  it.each([
    ["awaiting_approval", false],
    ["revoked", false],
    ["expired", false],
    ["unknown", false],
    ["inactive", false],
    ["active", true],
    ["unreachable", true],
  ] as const)("%s → allow=%s", (state, allow) => {
    expect(writeGate({ state } as KeyState).allow).toBe(allow);
  });
});
