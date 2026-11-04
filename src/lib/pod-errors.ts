/**
 * What a pod's refusal means, in one line, and the one next step. The ONE map
 * from the pod's error codes to the words a person reads: `credentialError`
 * (targets.ts), `renderHubError` (hub-client.ts) and `synap doctor` all read
 * it, so a code is explained once and the same way everywhere.
 *
 * Rules (plan f61a20a5, wave W1):
 * - "Reconnect" is advised ONLY on HTTP 401. A reconnect mints another
 *   computer key, which cannot fix a 400 or a 403.
 * - The pod's raw JSON is never printed: its `error` words, at most, when no
 *   code below explains the refusal.
 */
import { MANAGED_MCP_URL } from "./auth.js";
import { podAdminOrigin } from "./safe-open.js";

/** The pod's codes this map explains (synap-backend, the file:line in each entry). */
export const POD_ERROR_CODES = {
  /** setup.ts: a computer's key asked for an agent type the pod does not list. */
  surfaceAgentTypeRequired: "SURFACE_AGENT_TYPE_REQUIRED",
  /** access/grant-door-fence.ts: a door that refuses every limited key. */
  grantDoorUnsupported: "GRANT_DOOR_UNSUPPORTED",
  /** setup.ts: an AI's own key tried to connect another AI. */
  agentKeyCannotRegisterAgents: "AGENT_KEY_CANNOT_REGISTER_AGENTS",
} as const;

/** The pod's words for GRANT_DOOR_UNSUPPORTED, for a pod that sent them without the code. */
const SCOPED_KEYS_WORDS = /does not support scoped keys yet/i;

export interface PodRefusal {
  status: number;
  /** The pod's `code` (or `reasonCode`), when it sent one. */
  code?: string;
  /** The response body as received (JSON or text). Only its `error` words are ever shown. */
  body?: string;
  /** The AI client this was about (`grok`), when there is one. */
  client?: string;
  /** Its display name (`Grok`). */
  clientLabel?: string;
  /** True when `client` is one of the CLI's known clients (not a custom agent name). */
  knownClient?: boolean;
  /** The pod the call went to, to name pod admin's pages. */
  podUrl?: string;
}

export interface PodErrorText {
  /** What happened, in one sentence. */
  line: string;
  /** The one next step. */
  next: string;
}

/** The pod's `code` and `error` words from a response body (JSON or not). */
export function readPodErrorBody(body: string | undefined): { code?: string; words?: string } {
  const text = (body ?? "").trim();
  if (!text) return {};
  try {
    const parsed = JSON.parse(text) as Record<string, unknown>;
    if (parsed && typeof parsed === "object") {
      const code =
        typeof parsed.code === "string"
          ? parsed.code
          : typeof parsed.reasonCode === "string"
            ? parsed.reasonCode
            : undefined;
      const raw = typeof parsed.error === "string" ? parsed.error : typeof parsed.message === "string" ? parsed.message : undefined;
      return { code, words: raw ? oneLine(raw) : undefined };
    }
  } catch {
    /* not JSON: the words are the body itself */
  }
  return { words: oneLine(text) };
}

function oneLine(s: string): string {
  const flat = s.replace(/\s+/g, " ").trim();
  return flat.length > 200 ? `${flat.slice(0, 200)}…` : flat;
}

/** Pod admin's Agents page for this pod, or the words that find it. */
export function agentsPageOf(podUrl: string | undefined): string {
  const admin = podUrl ? podAdminOrigin(podUrl) : null;
  return admin ? `pod admin → Agents (${admin}/agents)` : "pod admin → Agents";
}

/**
 * The one line and the one next step for a pod's refusal. Always answers:
 * a code this map does not know falls back to the pod's own words, with no
 * "reconnect" unless the status is 401.
 */
export function explainPodError(r: PodRefusal): PodErrorText {
  const fromBody = readPodErrorBody(r.body);
  const code = r.code ?? fromBody.code;
  const who = r.clientLabel ?? r.client ?? "this AI";

  if (r.status === 401) {
    return {
      line: "The pod did not accept your saved key: it is invalid, expired or revoked.",
      next: "Run `synap login --reconnect` to sign this computer in again, then retry. (Plain `synap login` only checks; it does not replace a revoked key.)",
    };
  }

  if (code === POD_ERROR_CODES.surfaceAgentTypeRequired) {
    if (r.knownClient === false) {
      return {
        line: `This computer's key cannot create the custom agent "${r.client ?? "this agent"}": only you, signed in as yourself, can.`,
        next: `Create it in ${agentsPageOf(r.podUrl)}. The CLI cannot sign in as you yet.`,
      };
    }
    return {
      line: `Your pod does not know ${who} yet; it is added in the next pod release.`,
      next: `Meanwhile connect ${who} through your Synap account: add ${MANAGED_MCP_URL} as an MCP server (or connector) in ${who} and sign in there.`,
    };
  }

  if (code === POD_ERROR_CODES.grantDoorUnsupported || (!code && SCOPED_KEYS_WORDS.test(fromBody.words ?? ""))) {
    return {
      line: "This key is limited: it is this computer's key, and this action needs you signed in as yourself, which the CLI cannot do yet.",
      next: "Do it in the Synap app, signed in as yourself.",
    };
  }

  if (code === POD_ERROR_CODES.agentKeyCannotRegisterAgents) {
    return {
      line: "The CLI is using an AI's key, and an AI cannot connect another AI.",
      next: "Run this from your own terminal, not from inside an AI tool, so the CLI uses this computer's key.",
    };
  }

  const words = fromBody.words ? `: ${fromBody.words}` : ".";
  return {
    line: `The pod refused (HTTP ${r.status})${words}`,
    next: "Run `synap doctor` to check this pod and its key.",
  };
}
