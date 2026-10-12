/**
 * What the pod says about ONE key — asked by its holder.
 *
 * `GET /api/hub/auth/key-state` answers for a key whether or not it
 * authenticates: active, awaiting approval (+ the approval page), revoked (+
 * why, and when/where a replacing connection was made), expired, or unknown.
 * A pod older than that door answers 404; we then fall back to `/auth/status`,
 * which can only say "works" or "does not work" — reported as `inactive`, never
 * guessed into "revoked" (that guess is what sent the 2026-10-12 incident down
 * the wrong path: the key was only awaiting approval).
 *
 * Also the ONE write gate: a key is persisted into a config only when the pod
 * has not positively said it is unusable (`writeGate`).
 */

export type KeyStateName =
  | "active"
  | "awaiting_approval"
  | "revoked"
  | "expired"
  | "unknown"
  /** Older pod: the key does not authenticate, and the pod cannot say why. */
  | "inactive"
  /** The pod could not be asked (network, 5xx). Not evidence either way. */
  | "unreachable";

export interface KeyState {
  state: KeyStateName;
  keyIdPrefix?: string;
  keyId?: string;
  agentType?: string | null;
  instanceId?: string | null;
  /** The computer's name this key was made on; null = unlabelled (older CLI). */
  instanceLabel?: string | null;
  createdAt?: string;
  expiresAt?: string | null;
  approvalUrl?: string;
  revokedAt?: string | null;
  revokedReason?: string | null;
  replacedBy?: { createdAt: string; instanceId: string | null; instanceLabel?: string | null } | null;
  /** True when the answer came from the `/auth/status` fallback (older pod). */
  legacy?: boolean;
  /** `unreachable`, or the HTTP refusal behind an `inactive`. */
  error?: string;
}

const STATES = new Set(["active", "awaiting_approval", "revoked", "expired", "unknown"]);

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

/** Ask the pod about `key`. Never throws. */
export async function fetchKeyState(
  podUrl: string,
  key: string,
  deps: { fetch?: FetchLike; timeoutMs?: number } = {}
): Promise<KeyState> {
  const f = deps.fetch ?? fetch;
  const base = podUrl.replace(/\/+$/, "");
  const init = (): RequestInit => ({
    headers: { Authorization: `Bearer ${key}` },
    signal: AbortSignal.timeout(deps.timeoutMs ?? 15_000),
  });
  let res: Response;
  try {
    res = await f(`${base}/api/hub/auth/key-state`, init());
  } catch (err) {
    return { state: "unreachable", error: (err as Error).message };
  }
  if (res.ok) {
    const body = (await res.json().catch(() => null)) as Record<string, unknown> | null;
    if (body && typeof body.state === "string" && STATES.has(body.state)) return body as unknown as KeyState;
    return { state: "unreachable", error: "the pod answered key-state with an unreadable body" };
  }
  if (res.status !== 404) return nonOkState(res.status, "/auth/key-state");

  // Older pod: no key-state door. `/auth/status` says works / does not work.
  let legacy: Response;
  try {
    legacy = await f(`${base}/api/hub/auth/status`, init());
  } catch (err) {
    return { state: "unreachable", error: (err as Error).message, legacy: true };
  }
  if (legacy.ok) {
    const s = (await legacy.json().catch(() => ({}))) as { keyId?: string; keyIdPrefix?: string; expiresAt?: string | null };
    return { state: "active", legacy: true, keyId: s.keyId, keyIdPrefix: s.keyIdPrefix, expiresAt: s.expiresAt ?? null };
  }
  if (legacy.status === 401) {
    const env = (await legacy.json().catch(() => ({}))) as { reason?: string; keyIdPrefix?: string };
    if (env.reason === "expired") return { state: "expired", legacy: true, keyIdPrefix: env.keyIdPrefix };
    return { state: "inactive", legacy: true, keyIdPrefix: env.keyIdPrefix };
  }
  return { ...nonOkState(legacy.status, "/auth/status"), legacy: true };
}

/**
 * A non-OK answer that is not the older-pod 404. Only a 5xx (or a rate-limit /
 * request timeout, which says nothing about the key) is `unreachable`. Any
 * other refusal — 401, 403 (a guest's key), 400… — is the pod saying NO to
 * this key: `inactive`, which `writeGate` refuses. Reading a 403 as
 * "unreachable" let the gate write a key the pod refuses.
 */
function nonOkState(status: number, door: string): KeyState {
  if (status >= 500 || status === 408 || status === 429)
    return { state: "unreachable", error: `HTTP ${status} from ${door}` };
  return { state: "inactive", error: `HTTP ${status} from ${door}` };
}

export type WriteGate = { allow: true; warning?: string } | { allow: false; reason: string };

/**
 * May this key be written into a config? Only a POSITIVE "unusable" refuses:
 * pending, revoked, expired, unknown to the pod, or (older pod) rejected. An
 * unreachable pod is not evidence — it allows, with a warning.
 */
export function writeGate(s: KeyState): WriteGate {
  switch (s.state) {
    case "active":
      return { allow: true };
    case "unreachable":
      return { allow: true, warning: `could not confirm the key with the pod (${s.error ?? "unreachable"})` };
    case "awaiting_approval":
      return { allow: false, reason: "the key is still awaiting approval" };
    case "revoked":
      return { allow: false, reason: `the key was revoked${s.revokedReason ? ` (${s.revokedReason})` : ""}` };
    case "expired":
      return { allow: false, reason: "the key has expired" };
    case "unknown":
      return { allow: false, reason: "the pod does not know this key" };
    case "inactive":
      return { allow: false, reason: "the pod refuses this key" };
  }
}

/** Thrown when a caller tries to persist a key the pod says is unusable. */
export class KeyNotLiveError extends Error {
  constructor(
    readonly keyState: KeyState,
    reason: string
  ) {
    super(`Refusing to save this key: ${reason}.`);
    this.name = "KeyNotLiveError";
  }
}

/** Ask the pod, then refuse (throw) unless the key may be written. */
export async function assertKeyWritable(
  podUrl: string,
  key: string,
  deps: { fetch?: FetchLike } = {}
): Promise<KeyState> {
  const s = await fetchKeyState(podUrl, key, deps);
  const gate = writeGate(s);
  if (!gate.allow) throw new KeyNotLiveError(s, gate.reason);
  return s;
}
