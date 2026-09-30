import { describe, it, expect } from "vitest";
import {
  brokerCheck,
  readBrokerDiagnostics,
  readProvidersEnvelope,
  type BrokerDiagnosticsRead,
  type BrokerTrustReport,
} from "../src/commands/doctor.js";

/**
 * Payloads mirror the pod's real contracts —
 * synap-backend `routers/hub-protocol/rest/connectors.ts`:
 *   GET /connectors/providers        → { providers, nangoStatus, nangoError? } (503 when unconfigured)
 *   GET /connectors/broker-diagnostics → BrokerTrustDiagnostics (non-secret)
 */
const trusted: BrokerTrustReport = {
  cpIssuer: { present: true, status: "approved", hasSourceConfigWrite: true },
  ownerIdentityLink: { present: true },
  relayCredential: { present: true, validUntil: "2026-10-01T00:00:00.000Z" },
  broker: { kind: "control-plane", reason: null },
};

const read = (over: Partial<BrokerTrustReport> = {}): BrokerDiagnosticsRead => ({
  state: "read",
  report: { ...trusted, ...over },
});

const missing = readProvidersEnvelope({
  providers: [],
  nangoStatus: "error",
  nangoError: { reason: "broker-credential-missing", message: "no relay credential" },
});

describe("readProvidersEnvelope", () => {
  it("reads ok / error, and anything else as unknown", () => {
    expect(readProvidersEnvelope({ providers: [], nangoStatus: "ok" })).toEqual({ state: "ok" });
    expect(missing).toEqual({
      state: "error",
      reason: "broker-credential-missing",
      message: "no relay credential",
    });
    expect(readProvidersEnvelope({ providers: [] }).state).toBe("unknown");
    expect(readProvidersEnvelope(null).state).toBe("unknown");
  });
});

describe("readBrokerDiagnostics", () => {
  it("reads the contract shape and refuses a malformed one", () => {
    expect(readBrokerDiagnostics(trusted)).toEqual({ state: "read", report: trusted });
    expect(readBrokerDiagnostics({ cpIssuer: { present: true } }).state).toBe("unknown");
  });
});

describe("brokerCheck", () => {
  it("a working broker is green and prints kind, credential expiry, issuer and link", () => {
    const c = brokerCheck({ state: "ok" }, read());
    expect(c.ok).toBe(true);
    expect(c.detail).toContain("broker control-plane");
    expect(c.detail).toContain("valid until 2026-10-01T00:00:00.000Z");
    expect(c.detail).toContain("CP issuer ok");
    expect(c.detail).toContain("owner link ok");
  });

  it("an unreadable providers door is unknown — never ok", () => {
    const c = brokerCheck({ state: "unknown", detail: "HTTP 500" }, read());
    expect(c.ok).toBe(false);
    expect(c.unknown).toBe(true);
    expect(c.detail).toContain("could not determine");
  });

  it("unreadable diagnostics print 'unknown' for every trust fact", () => {
    const c = brokerCheck({ state: "ok" }, { state: "unknown", detail: "older build" });
    expect(c.detail).toContain("credential unknown");
    expect(c.detail).toContain("issuer unknown");
    expect(c.detail).toContain("owner link unknown");
    expect(c.detail).not.toContain(" ok;");
  });

  it("an unconfigured broker is a verified fact, not a failure", () => {
    const c = brokerCheck({ state: "not-configured" }, read({ broker: { kind: "local", reason: "not-configured" } }));
    expect(c.ok).toBe(true);
    expect(c.detail).toContain("no connection broker is configured");
  });

  // One row per cause of broker-credential-missing. Each input differs from the
  // next in exactly the fact its hint names, so a hint keyed on the wrong fact
  // (or checked in the wrong order) fails a row.
  it.each([
    ["no issuer", read({ cpIssuer: { present: false, status: null, hasSourceConfigWrite: false } }), "CONTROL_PLANE_URL"],
    ["issuer pending", read({ cpIssuer: { present: true, status: "pending", hasSourceConfigWrite: true } }), "Trusted issuers"],
    ["issuer approved without scope", read({ cpIssuer: { present: true, status: "approved", hasSourceConfigWrite: false } }), "source-config:write"],
    ["owner not linked", read({ ownerIdentityLink: { present: false } }), "identity is not linked"],
    ["trust fine, no key", read({ relayCredential: { present: false, validUntil: null } }), "Trust is in place"],
  ])("broker-credential-missing with %s → its one fix", (_label, diag, hint) => {
    const c = brokerCheck(missing, diag);
    expect(c.ok).toBe(false);
    expect(c.unknown).toBeUndefined();
    expect(c.fix).toContain(hint);
  });

  it("broker-credential-missing with unreadable diagnostics still names the relay-key fix and says trust is unreadable", () => {
    const c = brokerCheck(missing, { state: "unknown", detail: "403" });
    expect(c.ok).toBe(false);
    expect(c.fix).toContain("unreadable");
    expect(c.fix).toContain("rotate the pod's relay key");
  });

  it("a delivered key the vault cannot read names the re-delivery fix, not the database", () => {
    const c = brokerCheck(
      { state: "error", reason: "vault-unresolved" },
      read({ relayCredential: { present: true, resolvable: false, validUntil: null } })
    );
    expect(c.ok).toBe(false);
    expect(c.fix).toContain("re-delivers a readable key");
    expect(c.fix).not.toContain("database");
    expect(c.detail).toContain("credential present but unreadable");
  });

  it("other faults get their own fix", () => {
    const c = brokerCheck({ state: "error", reason: "vault-unreadable" }, read());
    expect(c.fix).toContain("VAULT_SERVER_KEY");
  });
});
