/**
 * Ask the person for a key — `synap keys create` (keys plan §3.6, Decision 4).
 *
 * The CLI holds a computer key, an agent principal, and never mints a key
 * itself. It FILES a request and its person decides on pod-admin:
 *
 *   1. POST {pod}/api/hub/keys/requests        {template, name?, expiresInDays?, workspaceId?}
 *        → {request_code, request_id, review_url, expires_in, interval}
 *   2. the person opens `review_url` (pod-admin), may narrow the key, never
 *      widen it past the template, and presses "Create key"
 *   3. POST {pod}/api/hub/keys/requests/token  {request_code}
 *        → 400 RFC 8628 errors until then, then ONCE: the key
 *
 * The same shape as the device flow (`device-connect.ts`), on the same poll
 * loop. `GET /keys/requested` and `DELETE /keys/requested/{id}` cover only the
 * keys this computer requested; every other key is the person's page.
 */

import { hubDelete, hubGet, hubPost, type HubConfig } from "./hub-client.js";

export interface KeyTemplate {
  id: string;
  name: string;
  description: string;
  /** A role the person saved, as opposed to a built-in template. */
  stored: boolean;
  uses: string[];
  permissions: string[];
  workspaceIds: string[] | null;
  projectIds: string[] | null;
  entityIds: string[] | null;
  /** Days; null = never expires; absent = the pod's default. */
  expiresInDays?: number | null;
}

export interface KeyRequestInput {
  template: string;
  name?: string;
  /** Days, or null = never; omitted = the template's lifetime. */
  expiresInDays?: number | null;
  workspaceId?: string;
}

export interface KeyRequestStart {
  request_code: string;
  request_id: string;
  review_url: string;
  expires_in: number;
  interval: number;
}

/** The key, as the pod hands it over exactly once. */
export interface RequestedKeySecret {
  apiKey: string;
  keyId: string;
  keyPrefix: string;
  name: string;
  scopes: string[];
  expiresAt: string | null;
}

export interface RequestedKey {
  keyId: string;
  name: string;
  keyPrefix: string;
  templateId: string;
  scopes: string[];
  createdAt: string;
  expiresAt: string | null;
  lastUsedAt: string | null;
  revokedAt: string | null;
}

export type KeyRequestOutcome =
  | { status: "approved"; key: RequestedKeySecret }
  | { status: "denied" }
  | { status: "expired" };

/** The pod's lifetime bounds for a requested key (`KeyRequestInput`). */
export const KEY_TTL_MAX_DAYS = 36_500;

/**
 * `--ttl`: whole days (1-36500) or `never`. Undefined = the template's.
 * Throws with the words to show on anything else.
 */
export function parseKeyTtl(raw: string | undefined): number | null | undefined {
  if (raw === undefined) return undefined;
  const v = raw.trim().toLowerCase();
  if (v === "never") return null;
  if (!/^\d+$/.test(v) || Number(v) < 1 || Number(v) > KEY_TTL_MAX_DAYS) {
    throw new Error(`--ttl takes a number of days (1-${KEY_TTL_MAX_DAYS}) or "never", not "${raw}".`);
  }
  return Number(v);
}

export async function listKeyTemplates(cfg: HubConfig): Promise<KeyTemplate[]> {
  const res = (await hubGet("/keys/templates", {}, cfg)) as { templates: KeyTemplate[] };
  return res.templates;
}

export async function startKeyRequest(cfg: HubConfig, input: KeyRequestInput): Promise<KeyRequestStart> {
  return (await hubPost("/keys/requests", input, cfg)) as KeyRequestStart;
}

export interface CollectKeyDeps {
  /** Shared poll loop; injectable so a test can shrink the clock. */
  poll?: typeof import("./approval-poll.js").pollForApproval;
  /** Multiply every server interval/expiry (tests only). Default 1. */
  timeScale?: number;
}

/**
 * Poll until the person decides, honouring the pod's `interval` and
 * `slow_down`. Only the key that filed the request may collect it.
 */
export async function collectRequestedKey(
  cfg: HubConfig,
  start: KeyRequestStart,
  deps: CollectKeyDeps = {}
): Promise<KeyRequestOutcome> {
  const scale = deps.timeScale ?? 1;
  const poll = deps.poll ?? (await import("./approval-poll.js")).pollForApproval;
  let lastError: string | undefined;
  try {
    const key = await poll<RequestedKeySecret>({
      url: `${cfg.podUrl}/api/hub/keys/requests/token`,
      method: "POST",
      headers: { Authorization: `Bearer ${cfg.apiKey}` },
      body: JSON.stringify({ request_code: start.request_code }),
      readErrorBodies: true,
      intervalMs: start.interval * 1000 * scale,
      timeoutMs: start.expires_in * 1000 * scale,
      isApproved: (d) => typeof (d as { apiKey?: unknown }).apiKey === "string",
      isRejected: (d) => {
        const e = (d as { error?: string }).error;
        if (e === "access_denied" || e === "expired_token" || e === "invalid_grant") {
          lastError = e;
          return true;
        }
        return false;
      },
      // RFC 8628 §3.5: slow_down adds to the interval for the rest of the wait.
      nextIntervalMs: (d, current) => {
        const body = d as { error?: string; interval?: number };
        if (body.error !== "slow_down") return current;
        return typeof body.interval === "number" ? body.interval * 1000 * scale : current + 5000 * scale;
      },
      onApproved: (d) => d as RequestedKeySecret,
    });
    return { status: "approved", key };
  } catch {
    return lastError === "access_denied" ? { status: "denied" } : { status: "expired" };
  }
}

export async function listRequestedKeys(cfg: HubConfig): Promise<RequestedKey[]> {
  const res = (await hubGet("/keys/requested", {}, cfg)) as { keys: RequestedKey[] };
  return res.keys;
}

export async function revokeRequestedKey(cfg: HubConfig, keyId: string): Promise<void> {
  await hubDelete(`/keys/requested/${encodeURIComponent(keyId)}`, cfg);
}
