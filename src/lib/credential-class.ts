/**
 * Credential class — "what is this key allowed to DO?"
 *
 * The ONE door for introspecting the calling key (`GET /api/hub/auth/status`)
 * and for the single question the proposals surface needs to answer honestly:
 * *can this credential perform a human review?*
 *
 * Why this exists: `synap proposals approve <id>` advertised a capability the
 * agent key running the CLI does not have. The pod hard-rejects it with
 * HTTP 403 "An agent credential cannot approve proposals" — see
 * `synap-backend/.../hub-protocol/rest/_shared.ts:144-161` (`rejectAgentReviewer`).
 * A surface that offers a verb it can never execute is the same defect class as
 * a renderer that fails open into a plausible-looking label.
 *
 * ── What the server actually gates on ────────────────────────────────────────
 * The server's predicate is `c.get("agentUserId")`, set iff the api-key row
 * carries `linkedUserId` (hub-protocol-rest.ts:403-408) — i.e. an AGENT key
 * whose writes are attributed to the human who created the agent.
 * `GET /auth/status` does NOT expose `linkedUserId` or `agentUserId`
 * (auth.ts:140-157 returns keyId/userId/userEmail/keyType/scopes/…), so the CLI
 * CANNOT reproduce the server's predicate exactly. What it CAN see is the
 * identity the key resolves to: an agent user is provisioned with a synthetic
 * `agent-<type>-<short>@synap.agent` email (agent-users.ts:222,
 * provision-agent.ts:472, intelligence.ts:1313). That domain is the proxy
 * signal used here.
 *
 * Because the proxy can be wrong in the FUTURE (a human key must never be
 * blocked), classification is deliberately three-valued and the guard is
 * belt-and-braces:
 *   • `agent`   — positive agent signal → refuse locally, before the network call.
 *   • `human`   — positive human signal (`user_pat`) → never blocked.
 *   • `unknown` — no signal → PROCEED, and translate the server's 403 after the
 *                 fact (`isAgentReviewRejection`). The server stays authoritative.
 *
 * ── Scope: approve, not reject ───────────────────────────────────────────────
 * `rejectAgentReviewer` is called for "approve" and "revert" ONLY. `POST
 * /proposals/:id/reject` is INTENTIONALLY ungated (proposals.ts:437-441:
 * "rejection only prevents a pending change from landing, so it carries no
 * self-approval / undo risk"). So `synap proposals reject` genuinely WORKS for
 * an agent credential and must NOT be guarded here.
 */

import chalk from "chalk";
import { log } from "../utils/logger.js";
import { hubGet, HubError, type HubConfig } from "./hub-client.js";

/**
 * Shape of `GET /api/hub/auth/status`. Mirrors the fields the route returns
 * (`rest/auth.ts:140-157`). `keyType` and `workspaceId` are optional because
 * older pods predate them and render as "unknown" rather than crashing.
 */
export interface AuthStatus {
  keyId?: string;
  keyIdPrefix?: string;
  userId?: string;
  userEmail?: string | null;
  userName?: string | null;
  name?: string | null;
  scopes?: string[];
  createdAt?: string;
  expiresAt?: string | null;
  isActive?: boolean;
  keyType?: string | null;
  workspaceId?: string | null;
}

/** Introspect a key. `apiKey` overrides `cfg.apiKey` (used by `whoami` to probe both sides of a divergence). */
export async function fetchAuthStatus(cfg: HubConfig, apiKey?: string): Promise<AuthStatus> {
  return (await hubGet("/auth/status", {}, apiKey ? { ...cfg, apiKey } : cfg)) as AuthStatus;
}

/**
 * Shape of `GET /api/hub/users/me` (`hub-protocol/rest/users.ts:36-46`).
 *
 * `id` is the EFFECTIVE user — the identity the pod attributes writes to. For
 * an agent key the Hub middleware sets `userId = keyRecord.linkedUserId` ("human
 * owns the entities") and `agentUserId = keyRecord.userId` ("agent performed the
 * action") — hub-protocol-rest.ts:407-408. So `/auth/status` and `/users/me`
 * answer DIFFERENT questions, and conflating them is what made an earlier
 * analysis conclude the CLI and MCP were different people:
 *
 *   /auth/status → who OWNS this key      (the agent)
 *   /users/me    → who the pod ACTS AS    (the human behind it)
 *
 * `isAgent` is server-derived from `agentUserId` and is never accepted from the
 * caller, so it is the authoritative posture signal — stronger than the
 * synthetic-email heuristic `classifyReviewer` has to fall back on.
 */
export interface EffectiveIdentity {
  id?: string;
  scopes?: string[];
  isAgent?: boolean;
}

/** Resolve the effective identity. `apiKey` overrides `cfg.apiKey`, mirroring `fetchAuthStatus`. */
export async function fetchEffectiveIdentity(
  cfg: HubConfig,
  apiKey?: string
): Promise<EffectiveIdentity> {
  return (await hubGet("/users/me", {}, apiKey ? { ...cfg, apiKey } : cfg)) as EffectiveIdentity;
}

/**
 * Can this credential perform a human review (approve / revert)?
 *
 * Three-valued ON PURPOSE — see the module header. `unknown` means "no signal",
 * and the caller must proceed and let the server decide. Never widen this to a
 * two-valued boolean: that turns a missing field into a false accusation.
 */
export type ReviewClass = "human" | "agent" | "unknown";

/** The synthetic email domain every provisioned agent user carries. */
const AGENT_EMAIL_DOMAIN = "@synap.agent";

export function classifyReviewer(status: AuthStatus | null | undefined): ReviewClass {
  if (!status) return "unknown";
  // A personal access token is a HUMAN session by construction — it carries no
  // linkedUserId, so `rejectAgentReviewer` never fires for it. Check this FIRST
  // so a human key can never be caught by the email heuristic below.
  if (status.keyType === "user_pat") return "human";
  const email = (status.userEmail ?? "").toLowerCase();
  if (email.endsWith(AGENT_EMAIL_DOMAIN)) return "agent";
  return "unknown";
}

/** Best-effort classification. A pod that is down/older must not block the command — it degrades to `unknown`. */
export async function classifyActiveCredential(cfg: HubConfig): Promise<ReviewClass> {
  try {
    return classifyReviewer(await fetchAuthStatus(cfg));
  } catch {
    return "unknown";
  }
}

/**
 * Did the pod reject this call with the agent-reviewer guard?
 *
 * Matches `rejectAgentReviewer`'s 403 envelope (`_shared.ts:155-159`):
 *   "An agent credential cannot approve proposals — approve is human review. …"
 * Kept narrow (403 + the distinctive phrase) so an unrelated 403 still renders
 * as its own error.
 */
export function isAgentReviewRejection(err: unknown): boolean {
  if (!(err instanceof HubError) || err.status !== 403) return false;
  const haystack = `${err.message} ${err.rawBody}`.toLowerCase();
  return haystack.includes("agent credential") && haystack.includes("proposal");
}

/** The `synap://` deep link the desktop app registers — `synap open proposal <id>` sends exactly this (open.ts:36-38). */
export function proposalDeepLink(id: string): string {
  return `synap://open/proposal/${encodeURIComponent(id)}`;
}

/** The pod's web review page for a bare id — the same route `bridge-setup.ts:894` and `statusline.ts:425` print. */
export function proposalWebLink(podUrl: string, id: string): string {
  return `${podUrl.replace(/\/+$/, "")}/open/${encodeURIComponent(id)}`;
}

/**
 * Explain why this credential cannot approve, and point at the door that works.
 * Used both by the pre-flight guard and by the post-hoc 403 translation, so the
 * operator sees ONE message regardless of which path caught it.
 */
export function renderCannotReview(id: string, cfg: HubConfig, action: "approve" | "revert" = "approve"): void {
  log.error(`This credential cannot ${action} proposals — ${action} is human review.`);
  log.dim(
    "  The active key is an agent credential. The pod blocks agent self-review so an\n" +
    "  agent cannot create-then-approve its own writes (including destructive ones)."
  );
  log.blank();
  log.info("  Review it as a human instead:");
  log.dim(`    synap open proposal ${id}        ${chalk.dim(`(${proposalDeepLink(id)})`)}`);
  log.dim(`    ${proposalWebLink(cfg.podUrl, id)}`);
  log.blank();
  log.dim("  Run `synap whoami` to see which key is active.");
}
