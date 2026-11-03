/**
 * `held` on the device request (plan "Computer once, agents inside" rev 3,
 * pod document 31470fd5, flow 3 and §8): the keys THIS OS user keeps for a
 * pod, as ids only. The pod reads it as evidence: a seat that holds an
 * agent's newest key may reconnect that agent; a seat that does not gets
 * "Add" by default, never "Reconnect" (the 2 Nov incident: a second OS user's
 * approval re-keyed the first one's CRM worker).
 *
 * Never a secret: each entry is `{keyId, agentUserId?}`. A key saved before
 * the CLI recorded its id is looked up with `GET /auth/key-state`, which
 * answers for the key without stamping it as used; a pod without that door is
 * not asked (its fallback, `/auth/status`, would stamp the key, and such a pod
 * ignores `held` anyway). A key is only ever sent to the pod it was saved for.
 */

import os from "node:os";
import path from "node:path";
import { readJsonStrict } from "./atomic-file.js";

export interface HeldKey {
  keyId: string;
  agentUserId?: string;
}

/** One key this OS user keeps for the pod; `hubApiKey` only to look its id up. */
export interface HeldSource {
  keyId?: string;
  agentUserId?: string;
  hubApiKey?: string;
}

/** The pod's caps (`DeviceCreateBody`, synap-backend rest/device-body.ts). */
export const HELD_MAX = 32;
const KEY_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const AGENT_ID_MAX = 64;
/** At most this many keys are looked up per request (each is one GET). */
const LOOKUP_MAX = 16;

const norm = (u: string) => u.replace(/\/+$/, "");

interface RawConfig {
  pods?: Record<string, { podUrl?: string; keyId?: string; agentUserId?: string; hubApiKey?: string }>;
  agents?: Record<string, { podName?: string; podUrl?: string; keyId?: string; agentUserId?: string; apiKey?: string }>;
  agentKeys?: Record<string, { podUrl?: string; keyId?: string; agentUserId?: string; hubApiKey?: string }>;
  agentKeysByPod?: Record<string, Record<string, { keyId?: string; agentUserId?: string; hubApiKey?: string }>>;
  pendingAgentKeys?: Record<string, Record<string, { keyId?: string; agentUserId?: string }>>;
}

/**
 * Every key the config keeps for `podUrl`: the pod profiles (the computer's
 * key), the named agents (`agents add --as`, `agents create`), the client keys
 * (`agentKeys`, `agentKeysByPod`) and the requests still awaiting approval. A
 * key saved with no pod is left out: it might belong to another pod. Pure.
 */
export function heldKeySources(podUrl: string, cfg: RawConfig): HeldSource[] {
  const pod = norm(podUrl);
  const out: HeldSource[] = [];
  const podNames = new Set<string>();
  for (const [name, p] of Object.entries(cfg.pods ?? {})) {
    if (!p?.podUrl || norm(p.podUrl) !== pod) continue;
    podNames.add(name);
    out.push({ keyId: p.keyId, agentUserId: p.agentUserId, hubApiKey: p.hubApiKey });
  }
  for (const a of Object.values(cfg.agents ?? {})) {
    const onPod = a?.podUrl ? norm(a.podUrl) === pod : !!a?.podName && podNames.has(a.podName);
    if (onPod) out.push({ keyId: a.keyId, agentUserId: a.agentUserId, hubApiKey: a.apiKey });
  }
  for (const k of Object.values(cfg.agentKeys ?? {})) {
    if (k?.podUrl && norm(k.podUrl) === pod) out.push({ keyId: k.keyId, agentUserId: k.agentUserId, hubApiKey: k.hubApiKey });
  }
  for (const byPod of Object.values(cfg.agentKeysByPod ?? {})) {
    for (const [url, k] of Object.entries(byPod ?? {})) {
      if (norm(url) === pod && k) out.push({ keyId: k.keyId, agentUserId: k.agentUserId, hubApiKey: k.hubApiKey });
    }
  }
  for (const byPod of Object.values(cfg.pendingAgentKeys ?? {})) {
    for (const [url, k] of Object.entries(byPod ?? {})) {
      if (norm(url) === pod && k?.keyId) out.push({ keyId: k.keyId, agentUserId: k.agentUserId });
    }
  }
  return out;
}

/** The entries the pod accepts, deduped by key id, capped. Pure. */
export function toHeldKeys(found: ReadonlyArray<{ keyId?: string; agentUserId?: string }>): HeldKey[] {
  const byId = new Map<string, HeldKey>();
  for (const f of found) {
    if (!f.keyId || !KEY_ID.test(f.keyId)) continue;
    const prior = byId.get(f.keyId);
    const agentUserId =
      f.agentUserId && f.agentUserId.length <= AGENT_ID_MAX ? f.agentUserId : prior?.agentUserId;
    byId.set(f.keyId, agentUserId ? { keyId: f.keyId, agentUserId } : { keyId: f.keyId });
  }
  return [...byId.values()].slice(0, HELD_MAX);
}

/** A saved key's id, from `/auth/key-state` only (it never stamps the key). Null when the pod cannot say. */
export async function lookupKeyId(podUrl: string, hubApiKey: string): Promise<string | null> {
  try {
    const res = await fetch(`${norm(podUrl)}/api/hub/auth/key-state`, {
      headers: { Authorization: `Bearer ${hubApiKey}` },
      signal: AbortSignal.timeout(5_000),
    });
    if (!res.ok) return null;
    const body = (await res.json().catch(() => null)) as { keyId?: unknown } | null;
    return typeof body?.keyId === "string" ? body.keyId : null;
  } catch {
    return null;
  }
}

/**
 * The keys this OS user holds for `podUrl`, as the device request's `held`.
 * Never throws: evidence that cannot be gathered is left out, and the pod then
 * recommends "Add", the safe default.
 */
export async function collectHeldKeys(
  podUrl: string,
  deps: { readConfig?: () => RawConfig | null; lookup?: typeof lookupKeyId } = {}
): Promise<HeldKey[]> {
  let cfg: RawConfig | null;
  try {
    cfg = (deps.readConfig ?? (() => readJsonStrict<RawConfig>(path.join(os.homedir(), ".synap", "config.json"))))();
  } catch {
    return [];
  }
  if (!cfg) return [];
  const sources = heldKeySources(podUrl, cfg);
  const lookup = deps.lookup ?? lookupKeyId;
  const unknown = [...new Set(sources.filter((s) => !s.keyId && s.hubApiKey).map((s) => s.hubApiKey!))].slice(0, LOOKUP_MAX);
  const found = new Map<string, string>();
  await Promise.all(
    unknown.map(async (key) => {
      const id = await lookup(podUrl, key).catch(() => null);
      if (id) found.set(key, id);
    })
  );
  return toHeldKeys(
    sources.map((s) => ({ keyId: s.keyId ?? (s.hubApiKey ? found.get(s.hubApiKey) : undefined), agentUserId: s.agentUserId }))
  );
}
