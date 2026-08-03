/**
 * The CLI must not advertise a capability it does not have.
 *
 * `synap proposals approve <id>` is structurally dead for the agent credential
 * the CLI runs as: the pod hard-rejects it with HTTP 403 "An agent credential
 * cannot approve proposals" (`rejectAgentReviewer`,
 * synap-backend/.../hub-protocol/rest/_shared.ts:144-161). These tests pin the
 * guard that makes the surface honest, and — just as important — pin the two
 * ways it must NOT overreach:
 *
 *   • `reject` is INTENTIONALLY ungated server-side (proposals.ts:437-441), so
 *     an agent credential CAN reject. The guard must never block it.
 *   • an unclassifiable key must PROCEED, not be refused locally. The local
 *     signal is a proxy for the server's `linkedUserId` predicate, and a proxy
 *     that fails closed would break a future human key.
 */

import { describe, it, expect } from "vitest";
import {
  classifyReviewer,
  isAgentReviewRejection,
  proposalDeepLink,
  proposalWebLink,
  type AuthStatus,
} from "../src/lib/credential-class.js";
import { HubError } from "../src/lib/hub-client.js";

/** The real key this CLI authenticates with — `synap whoami` output, verbatim. */
const AGENT_KEY: AuthStatus = {
  keyIdPrefix: "0e0403a8",
  keyType: "hub_inbound",
  userEmail: "agent-claude-code-0e0403a8@synap.agent",
  isActive: true,
  scopes: ["hub-protocol.read", "hub-protocol.write"],
};

describe("classifyReviewer — who may perform a human review", () => {
  it("the CLI's own agent credential is classified 'agent'", () => {
    expect(classifyReviewer(AGENT_KEY)).toBe("agent");
  });

  it("a user_pat is 'human' — a future human key must never be blocked", () => {
    expect(
      classifyReviewer({ keyType: "user_pat", userEmail: "samirt@etik.com" })
    ).toBe("human");
  });

  it("user_pat wins even if the identity looks agent-shaped", () => {
    // keyType is the positive human signal and is checked FIRST, so the email
    // heuristic can never demote a real PAT.
    expect(
      classifyReviewer({ keyType: "user_pat", userEmail: "agent-x-1@synap.agent" })
    ).toBe("human");
  });

  it("an unrecognised key is 'unknown' — proceed, let the server decide", () => {
    expect(classifyReviewer({ keyType: "service", userEmail: "ops@example.com" })).toBe("unknown");
    expect(classifyReviewer({})).toBe("unknown");
    expect(classifyReviewer(null)).toBe("unknown");
    expect(classifyReviewer(undefined)).toBe("unknown");
  });

  it("a pod too old to return keyType/userEmail degrades to 'unknown', not 'agent'", () => {
    expect(classifyReviewer({ keyIdPrefix: "abc", isActive: true })).toBe("unknown");
  });

  it("the agent domain match is case-insensitive", () => {
    expect(classifyReviewer({ userEmail: "Agent-Claude-Code-1@SYNAP.AGENT" })).toBe("agent");
  });

  it("a lookalike domain is NOT an agent credential", () => {
    // Substring-matching "synap.agent" anywhere would misfire here.
    expect(classifyReviewer({ userEmail: "person@synap.agentcorp.com" })).toBe("unknown");
  });
});

describe("isAgentReviewRejection — translate the server's 403, don't guess", () => {
  const hubError = (status: number, message: string) =>
    new HubError({
      message,
      status,
      rawBody: JSON.stringify({ error: message }),
      path: "/proposals/x/approve",
      method: "POST",
    });

  it("matches the exact envelope rejectAgentReviewer emits", () => {
    expect(
      isAgentReviewRejection(
        hubError(
          403,
          "An agent credential cannot approve proposals — approve is human review. Approve from a human session."
        )
      )
    ).toBe(true);
  });

  it("matches the revert wording too", () => {
    expect(
      isAgentReviewRejection(
        hubError(
          403,
          "An agent credential cannot revert proposals — revert is human review. Revert from a human session."
        )
      )
    ).toBe(true);
  });

  it("an unrelated 403 stays its own error", () => {
    expect(isAgentReviewRejection(hubError(403, "Insufficient scope: hub-protocol.write"))).toBe(false);
    // Same guard family, different resource — must not be swallowed by the
    // proposals message (capabilities.ts:713).
    expect(
      isAgentReviewRejection(
        hubError(403, "An agent credential cannot trigger a pod-wide capability reconcile.")
      )
    ).toBe(false);
  });

  it("a non-403, and a non-HubError, are not this rejection", () => {
    expect(isAgentReviewRejection(hubError(404, "An agent credential cannot approve proposals"))).toBe(false);
    expect(isAgentReviewRejection(new Error("An agent credential cannot approve proposals"))).toBe(false);
    expect(isAgentReviewRejection(undefined)).toBe(false);
  });
});

describe("the door that actually works — deep links", () => {
  const id = "1ec13e8d-d92c-4446-a909-1f433b2ed368";

  it("emits the synap:// route the desktop app registers", () => {
    // Must stay byte-identical to buildDeepLink in commands/open.ts:36-38.
    expect(proposalDeepLink(id)).toBe(`synap://open/proposal/${id}`);
  });

  it("emits the pod's web review page for a bare id", () => {
    expect(proposalWebLink("https://pod.perso.thearchitech.xyz", id)).toBe(
      `https://pod.perso.thearchitech.xyz/open/${id}`
    );
  });

  it("does not double the slash when podUrl has a trailing one", () => {
    expect(proposalWebLink("https://pod.example.com/", id)).toBe(`https://pod.example.com/open/${id}`);
  });
});
