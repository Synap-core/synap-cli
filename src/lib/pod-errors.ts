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
 *   code below explains the refusal, and nothing of a 5xx's body.
 */
import { podAdminOrigin } from "./safe-open.js";

/** The pod's codes this map explains (synap-backend, the file:line in each entry). */
export const POD_ERROR_CODES = {
  /** setup.ts: a computer's key asked for an agent type the pod does not list. */
  surfaceAgentTypeRequired: "SURFACE_AGENT_TYPE_REQUIRED",
  /** access/grant-door-fence.ts: a door that refuses every limited key. */
  grantDoorUnsupported: "GRANT_DOOR_UNSUPPORTED",
  /** setup.ts: an AI's own key tried to connect another AI. */
  agentKeyCannotRegisterAgents: "AGENT_KEY_CANNOT_REGISTER_AGENTS",
  /**
   * services/presence/gate.ts: a sensitive act (a key, an app key, how an
   * agent's changes land) needs the PERSON to confirm it is them; a key cannot.
   */
  presenceRequired: "PRESENCE_REQUIRED",
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
  /** True when the request asked for the agent as the person (`asPerson`, W3). */
  asPerson?: boolean;
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

/** Pod admin's home page for this pod (where it says how the pod is), or the words that find it. */
export function podAdminHomeOf(podUrl: string | undefined): string {
  const admin = podUrl ? podAdminOrigin(podUrl) : null;
  return admin ? `pod admin (${admin})` : "pod admin";
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

  // A 5xx says nothing a person can act on, and its body may be a proxy's page
  // or a stack: never shown.
  if (r.status >= 500) {
    return {
      line: `The pod is not answering right now (HTTP ${r.status}).`,
      next: `Try again in a minute, or check ${podAdminHomeOf(r.podUrl)}.`,
    };
  }

  if (code === POD_ERROR_CODES.surfaceAgentTypeRequired) {
    if (r.knownClient === false) {
      const name = r.client ?? "this agent";
      // Asked as the person and still refused: this pod predates that request
      // (an older pod ignores `asPerson`). Plainly that, and where else to do it.
      if (r.asPerson) {
        return {
          line: `Your pod does not accept a request for the custom agent "${name}" from this computer yet: it needs a newer pod.`,
          next: `Update the pod from ${podAdminHomeOf(r.podUrl)}, then run this again. Or create the agent in ${agentsPageOf(r.podUrl)}.`,
        };
      }
      return {
        line: `This computer's key cannot create the custom agent "${name}" by itself: you approve it.`,
        next: `Run \`synap agents add --name ${name} --type ${name}\`: it asks for your approval on Relay or in ${agentsPageOf(r.podUrl)}.`,
      };
    }
    // No release promise, and no Synap-account route: a client that connects
    // only with a key has none. A generic key works with every client.
    return {
      line: `Your pod does not list ${who} yet.`,
      next: `Connect it with a generic key instead: synap mcp url --client generic prints a URL and a key to paste into ${who}.`,
    };
  }

  if (code === POD_ERROR_CODES.grantDoorUnsupported || (!code && SCOPED_KEYS_WORDS.test(fromBody.words ?? ""))) {
    return {
      line: "This key is limited (this computer's or an AI's key), and this action needs you signed in as yourself, which the CLI cannot do yet.",
      next: `Do it in the Synap desktop app or in ${podAdminHomeOf(r.podUrl)}, signed in as yourself.`,
    };
  }

  if (code === POD_ERROR_CODES.agentKeyCannotRegisterAgents) {
    return {
      line: "The CLI is using an AI's key, and an AI cannot connect another AI.",
      next: "Run this from your own terminal, not from inside an AI tool, so the CLI uses this computer's key.",
    };
  }

  if (code === POD_ERROR_CODES.presenceRequired) {
    return {
      line: "This needs you: the pod asks the person to confirm it is them (Face ID, Touch ID or a passkey), and a key cannot.",
      next: `Do it in ${podAdminHomeOf(r.podUrl)}.`,
    };
  }

  const words = fromBody.words ? `: ${fromBody.words}` : ".";
  return {
    line: `The pod refused (HTTP ${r.status})${words}`,
    next: "Run `synap doctor` to check this pod and its key.",
  };
}
