import { describe, it, expect } from "vitest";
import { readIntelligenceHealth, intelligenceCheck } from "../src/commands/doctor.js";

/**
 * Payloads mirror the pod's real contract —
 * synap-backend/packages/api/src/routers/hub-protocol/rest/health-dependencies.ts
 * (`HealthDependenciesSchema`): always 200, `dependencies` is an ARRAY, and the
 * IS entry carries a THREE-valued `state`, not a boolean.
 */
const report = (dep: Record<string, unknown>) => ({
  status: dep.state === "reachable" ? "ok" : "degraded",
  service: "hub-protocol",
  checkedAt: "2026-08-01T00:00:00.000Z",
  resolution: { workspaceId: null, capability: "default" },
  dependencies: [{ name: "intelligence-service", ...dep }],
});

describe("readIntelligenceHealth", () => {
  it("reads a reachable IS", () => {
    const v = readIntelligenceHealth(
      report({ state: "reachable", reachable: true, endpoint: "http://10.0.0.5:3001", latencyMs: 12 })
    );
    expect(v.state).toBe("up");
    expect(v.detail).toContain("10.0.0.5:3001");
  });

  it("reads an unreachable IS and keeps the pod's reason", () => {
    const v = readIntelligenceHealth(
      report({
        state: "unreachable",
        reachable: false,
        endpoint: "http://10.0.0.5:3001",
        httpStatus: 502,
        reason: "health probe returned 502 Bad Gateway",
      })
    );
    expect(v.state).toBe("down");
    expect(v.detail).toContain("502 Bad Gateway");
  });

  // The pod deliberately keeps these apart; flattening them to one "down"
  // would tell the user to restart a service that was never configured.
  it("keeps `unresolved` DISTINCT from `unreachable`", () => {
    const v = readIntelligenceHealth(
      report({
        state: "unresolved",
        reachable: false,
        reason: "intelligence service resolution failed: no service configured",
      })
    );
    expect(v.state).toBe("unresolved");
    expect(v.state).not.toBe("down");
    expect(v.detail).toContain("could not determine which Intelligence Service");
    expect(v.detail).toContain("no service configured");
  });

  it("reports WHICH lens the pod resolved under", () => {
    const podLevel = readIntelligenceHealth(report({ state: "reachable", reachable: true }));
    expect(podLevel.detail).toContain("checked pod-level");

    const scoped = readIntelligenceHealth({
      ...report({ state: "reachable", reachable: true }),
      resolution: { workspaceId: "ws-1", capability: "default" },
    });
    expect(scoped.detail).toContain("checked as workspace ws-1");
  });

  it("stays silent about the lens when the pod did not echo one", () => {
    const v = readIntelligenceHealth({
      dependencies: [{ name: "intelligence-service", state: "reachable", reachable: true }],
    });
    expect(v.state).toBe("up");
    expect(v.detail).not.toContain("checked");
  });

  it("falls back to the boolean mirror when `state` is unreadable", () => {
    expect(readIntelligenceHealth(report({ reachable: true }) as unknown).state).toBe("up");
    expect(readIntelligenceHealth(report({ reachable: false }) as unknown).state).toBe("down");
  });

  // The honesty core: anything not positively recognised must NOT read healthy.
  it("returns unknown when no intelligence-service entry is present", () => {
    expect(
      readIntelligenceHealth({ dependencies: [{ name: "postgres", state: "reachable" }] }).state
    ).toBe("unknown");
  });

  it("returns unknown when `dependencies` is absent or not an array", () => {
    expect(readIntelligenceHealth({ status: "ok" }).state).toBe("unknown");
    expect(readIntelligenceHealth({ dependencies: { intelligence: true } }).state).toBe("unknown");
  });

  it("returns unknown for a non-object payload", () => {
    expect(readIntelligenceHealth(undefined).state).toBe("unknown");
    expect(readIntelligenceHealth("ok").state).toBe("unknown");
  });

  it("returns unknown when the entry carries neither a readable state nor a boolean", () => {
    expect(
      readIntelligenceHealth({ dependencies: [{ name: "intelligence-service", latencyMs: 12 }] })
        .state
    ).toBe("unknown");
  });

  it("never reads a MISSING field as healthy", () => {
    expect(readIntelligenceHealth({ dependencies: [] }).state).toBe("unknown");
    expect(readIntelligenceHealth({}).state).toBe("unknown");
  });
});

describe("intelligenceCheck", () => {
  it("passes only when the IS is verified up", () => {
    const c = intelligenceCheck({ state: "up", detail: "intelligence-service answered" });
    expect(c.ok).toBe(true);
    expect(c.unknown).toBeUndefined();
  });

  it("a dead IS is a hard failure that names the CONSEQUENCE, not just the dependency", () => {
    const c = intelligenceCheck({ state: "down", detail: "did not answer" });
    expect(c.ok).toBe(false);
    expect(c.unknown).toBeUndefined();
    expect(c.detail).toMatch(/capture \/ import \/ AI structuring WILL FAIL/);
    expect(c.fix).toMatch(/Restart\/redeploy the IS/);
  });

  it("an unresolved IS fails too, but points at CONFIG rather than a restart", () => {
    const c = intelligenceCheck({ state: "unresolved", detail: "could not resolve" });
    expect(c.ok).toBe(false);
    expect(c.unknown).toBeUndefined();
    expect(c.detail).toMatch(/WILL FAIL/);
    expect(c.fix).not.toMatch(/Restart/);
    expect(c.fix).toMatch(/configured/);
  });

  // The whole point of the fix: an unknown is not a pass.
  it("an UNKNOWN is not ok, is flagged unknown, and says 'could not determine'", () => {
    const c = intelligenceCheck({ state: "unknown", detail: "older build" });
    expect(c.ok).toBe(false);
    expect(c.unknown).toBe(true);
    expect(c.detail).toMatch(/could not determine/);
  });

  it("no verdict except `up` ever produces a passing check", () => {
    for (const state of ["down", "unresolved", "unknown"] as const) {
      expect(intelligenceCheck({ state, detail: "x" }).ok).toBe(false);
    }
  });
});
