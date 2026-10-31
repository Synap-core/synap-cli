/**
 * Connect THIS computer to a pod — the pod-side device flow (RFC 8628,
 * MACHINE-IDENTITY-PLAN §4). The only way `synap init` and `synap login` get a
 * credential for a pod, on self-hosted and managed pods alike.
 *
 *   1. POST {pod}/api/hub/setup/device        → a user code + where to enter it
 *   2. the person opens the link on any device, signs in to the pod, approves
 *      the computer and the agents it asked for (one decision)
 *   3. POST {pod}/api/hub/setup/device/token  → 400 RFC 8628 errors until then,
 *      then ONCE: the computer's key + one key per approved agent
 *
 * The computer gets its OWN governed principal ("devbox"); each agent is a
 * distinct agent on that computer ("Claude Code on devbox"). Nothing here needs
 * a Synap account session, a browser on this machine, or a loopback port.
 */

import os from "os";
import chalk from "chalk";
import { log } from "../utils/logger.js";
import "./machine-instance.js";

/**
 * The agent types the device door accepts (`SURFACE_AGENT_TYPES`,
 * synap-backend `routers/hub-protocol/rest/setup.ts`). A mirror: the CLI does
 * not depend on the backend package. A type outside it would 400 the whole
 * request, so it is filtered out before asking.
 */
export const DEVICE_AGENT_TYPES = [
  "claude-code",
  "claude-desktop",
  "cursor",
  "raycast",
  "codex",
  "openwebui",
  "discord",
  "proton",
  "generic",
] as const;
export type DeviceAgentType = (typeof DEVICE_AGENT_TYPES)[number];

/** The pod's cap on agents per request (`DEVICE_MAX_AGENTS`). */
export const DEVICE_MAX_AGENTS = 8;

/** The agents of `targets` the device door can approve, deduped, capped. */
export function deviceAgentsFor(targets: readonly string[]): DeviceAgentType[] {
  const ok = targets.filter((t): t is DeviceAgentType =>
    (DEVICE_AGENT_TYPES as readonly string[]).includes(t)
  );
  return [...new Set(ok)].slice(0, DEVICE_MAX_AGENTS);
}

export interface DeviceKey {
  apiKey: string;
  keyId: string;
  /** ISO time the key stops working, or null when it never expires. */
  expiresAt: string | null;
}

export interface DeviceGrant {
  computer: DeviceKey & { id: string; name: string };
  agents: Array<DeviceKey & { agentType: string; agentUserId: string; name: string; displayName: string }>;
}

export type DeviceConnectOutcome =
  | { status: "approved"; grant: DeviceGrant }
  | { status: "denied"; message: string }
  | { status: "expired"; message: string };

/** The pod could not start a request (an older pod has no device door: 404). */
export class DeviceStartError extends Error {
  constructor(
    readonly status: number | null,
    message: string
  ) {
    super(message);
    this.name = "DeviceStartError";
  }
}

interface DeviceAuthorization {
  device_code: string;
  user_code: string;
  verification_uri: string;
  verification_uri_complete?: string;
  expires_in: number;
  interval?: number;
}

export interface DeviceConnectDeps {
  /** Terminal QR renderer; default the one Relay pairing uses. */
  renderQr?: (text: string) => Promise<string>;
  /** Shared poll loop; injectable so a test can shrink the clock. */
  poll?: typeof import("./approval-poll.js").pollForApproval;
  /** Multiply every server interval/expiry (tests only). Default 1. */
  timeScale?: number;
}

const podHost = (podUrl: string): string => {
  try {
    return new URL(podUrl).host;
  } catch {
    return podUrl;
  }
};

/**
 * Ask the pod to connect this computer, show the person where to approve it,
 * and wait — honouring the pod's `interval` and `slow_down` — until it is
 * approved, denied, or the code expires. Throws `DeviceStartError` only when
 * the request could not be started at all.
 */
export async function deviceConnect(
  podUrl: string,
  opts: { agents: readonly string[]; clientName?: string; hostname?: string; platform?: string },
  deps: DeviceConnectDeps = {}
): Promise<DeviceConnectOutcome> {
  const base = podUrl.replace(/\/+$/, "");
  const scale = deps.timeScale ?? 1;
  const host = podHost(base);

  let res: Response;
  try {
    res = await fetch(`${base}/api/hub/setup/device`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        clientName: opts.clientName ?? "Synap CLI",
        // The name every agent key of this computer is labelled with (no `.local`,
        // `SYNAP_COMPUTER_NAME` honoured), so the approval page and the keys agree.
        hostname: (opts.hostname ?? os.hostname()).slice(0, 253) || "computer",
        platform: opts.platform ?? process.platform,
        agents: deviceAgentsFor(opts.agents),
      }),
      signal: AbortSignal.timeout(15_000),
    });
  } catch (err) {
    throw new DeviceStartError(null, `Could not reach ${host}: ${(err as Error).message}`);
  }
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { error_description?: string } | null;
    throw new DeviceStartError(
      res.status,
      res.status === 404
        ? `${host} cannot connect a computer yet (it needs an update).`
        : `${host} could not start the request (HTTP ${res.status})${body?.error_description ? `: ${body.error_description}` : "."}`
    );
  }
  const auth = (await res.json()) as DeviceAuthorization;

  // The instruction comes FIRST and stays on screen: on a headless box (SSH)
  // there is no browser to open — the person uses their phone or laptop.
  log.blank();
  console.log(
    `  Open ${chalk.cyan.bold(auth.verification_uri)} on any device and enter ${chalk.bold(auth.user_code)}`
  );
  if (auth.verification_uri_complete) {
    log.dim(`Or open: ${auth.verification_uri_complete}`);
    try {
      const qr = await (deps.renderQr ?? (await import("./pair-link.js")).renderTerminalQr)(
        auth.verification_uri_complete
      );
      console.log("\n" + qr);
    } catch {
      // The link above is enough; a QR is a convenience.
    }
  }
  const minutes = Math.max(1, Math.round(auth.expires_in / 60));
  log.dim(`Waiting for you to approve this computer on ${host} (the code lasts ${minutes} min)…`);

  const poll = deps.poll ?? (await import("./approval-poll.js")).pollForApproval;
  let lastError: string | undefined;
  try {
    const grant = await poll<DeviceGrant>({
      url: `${base}/api/hub/setup/device/token`,
      method: "POST",
      body: JSON.stringify({ device_code: auth.device_code }),
      readErrorBodies: true,
      intervalMs: (auth.interval ?? 5) * 1000 * scale,
      timeoutMs: auth.expires_in * 1000 * scale,
      isApproved: (d) => typeof (d as { access_token?: unknown }).access_token === "string",
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
      onApproved: (d) => {
        const b = d as { computer: DeviceGrant["computer"]; agents?: DeviceGrant["agents"] };
        return { computer: b.computer, agents: b.agents ?? [] };
      },
    });
    return { status: "approved", grant };
  } catch {
    if (lastError === "access_denied") return { status: "denied", message: `Denied on ${host}.` };
    return { status: "expired", message: "Code expired — run again." };
  }
}

/** Renew a computer key this close to (or past) its expiry. */
export const COMPUTER_KEY_RENEW_DAYS = 7;

/**
 * True when a saved computer key expires within `COMPUTER_KEY_RENEW_DAYS`, or
 * already has. A credential with no recorded expiry (a pasted key, an old
 * operator key) is never "due": nothing says it expires.
 */
export function computerKeyNeedsRenewal(
  config: { keyExpiresAt?: string | null },
  now: number = Date.now()
): boolean {
  if (!config.keyExpiresAt) return false;
  const at = Date.parse(config.keyExpiresAt);
  if (Number.isNaN(at)) return false;
  return at - now < COMPUTER_KEY_RENEW_DAYS * 24 * 60 * 60 * 1000;
}

/**
 * Keep what the device flow returned, once, where each reader already looks:
 *   - the computer's key → the pod profile `name` (it IS the CLI's identity
 *     for this pod now), with its expiry so it can be renewed in time;
 *   - each agent's key → the surface key store (`agentKeys`) AND the
 *     pre-approved slot its installer takes from, so `synap connect`'s own
 *     installer writes it into Claude Code / Codex / Cursor instead of minting.
 * Fields of an existing profile (label, podId) are kept.
 */
export async function saveDeviceGrant(
  podUrl: string,
  grant: DeviceGrant,
  profile: { name: string; podId?: string }
): Promise<import("./pod.js").LocalPodConfig> {
  const pod = await import("./pod.js");
  const { presetApprovedKey } = await import("./batch-approval.js");
  const prior = pod.listPodProfiles().find((p) => p.name === profile.name)?.config;
  const podId = profile.podId ?? prior?.podId;
  const config: import("./pod.js").LocalPodConfig = {
    ...prior,
    podUrl,
    ...(podId ? { podId } : {}),
    workspaceId: prior?.workspaceId ?? "",
    agentUserId: grant.computer.id,
    hubApiKey: grant.computer.apiKey,
    credential: "computer",
    computerName: grant.computer.name,
    savedAt: new Date().toISOString(),
  };
  if (grant.computer.expiresAt) config.keyExpiresAt = grant.computer.expiresAt;
  else delete config.keyExpiresAt;
  pod.addPodProfile(profile.name, config);

  for (const a of grant.agents) {
    if ((pod.SURFACE_NAMES as readonly string[]).includes(a.agentType)) {
      pod.setSurfaceAgentKey(a.agentType as import("./pod.js").SurfaceName, {
        hubApiKey: a.apiKey,
        agentUserId: a.agentUserId,
        podUrl,
      });
    }
    presetApprovedKey(a.agentType, { hubApiKey: a.apiKey, agentUserId: a.agentUserId });
  }
  return config;
}

/** The approved agents this CLI has an installer for, as `synap connect` targets. */
export async function approvedTargets(grant: DeviceGrant): Promise<import("./targets.js").TargetName[]> {
  const { isTargetName } = await import("./targets.js");
  return grant.agents.map((a) => a.agentType).filter(isTargetName);
}

/**
 * Write each approved agent's own key into its client config — the same
 * installers (`connectAgentsBatch` → `installForTarget`) `synap init` uses —
 * for the callers that have no agents step of their own (`synap login`,
 * reconnect, renewal).
 */
export async function wireApprovedAgents(
  podUrl: string,
  computerKey: string,
  grant: DeviceGrant
): Promise<void> {
  const targets = await approvedTargets(grant);
  if (targets.length === 0) return;
  const { connectAgentsBatch } = await import("./agent-door.js");
  await connectAgentsBatch({ podUrl, apiKey: computerKey }, targets, {});
}

/**
 * Connect this computer to `podUrl` and save the result under profile `name`:
 * the device flow, then `saveDeviceGrant`, then the agents' configs. The agents
 * asked for are the ones found on this machine. Returns the saved profile, or
 * null after printing why (denied, expired, or the pod can't do it).
 */
export async function connectThisComputer(
  podUrl: string,
  profile: { name: string; podId?: string },
  opts: { agents?: readonly string[]; wireAgents?: boolean } = {}
): Promise<import("./pod.js").LocalPodConfig | null> {
  let agents = opts.agents;
  if (!agents) {
    const { detectAgents } = await import("./agent-detect.js");
    agents = detectAgents()
      .filter((r) => r.found)
      .map((r) => r.target);
  }
  let outcome: DeviceConnectOutcome;
  try {
    outcome = await deviceConnect(podUrl, { agents });
  } catch (err) {
    log.error(err instanceof Error ? err.message : String(err));
    return null;
  }
  if (outcome.status !== "approved") {
    log.error(outcome.message);
    return null;
  }
  const config = await saveDeviceGrant(podUrl, outcome.grant, profile);
  log.success(`${outcome.grant.computer.name} connected to ${podHost(podUrl)}`);
  if (opts.wireAgents !== false) await wireApprovedAgents(podUrl, config.hubApiKey, outcome.grant);
  return config;
}

// ─── enrolment: an agent belongs on an enrolled computer ──────────────────────

const normPodUrl = (u: string) => u.replace(/\/+$/, "");

/**
 * Whether THIS computer is enrolled on `podUrl`: a saved profile for that pod
 * holds the computer's own key from the device flow (`credential: "computer"`,
 * `saveDeviceGrant`). The pod cannot tell a computer that never enrolled from
 * a person's key (decision 59c75aab: it never trusts a client-claimed machine
 * id), so the CLI asks first.
 */
export function computerEnrolled(podUrl: string, profiles: Array<{ config: { podUrl: string; credential?: string } }>): boolean {
  return !!computerProfileFor(podUrl, profiles);
}

/** The saved profile holding this computer's own key for `podUrl`, if any. */
export function computerProfileFor<P extends { config: { podUrl: string; credential?: string } }>(podUrl: string, profiles: P[]): P | undefined {
  return profiles.find((p) => normPodUrl(p.config.podUrl) === normPodUrl(podUrl) && p.config.credential === "computer");
}

/** What the person runs to enrol this computer on `podUrl`. */
export function enrolCommand(podUrl: string, profiles: Array<{ name: string; config: { podUrl: string } }>): string {
  const saved = profiles.find((p) => normPodUrl(p.config.podUrl) === normPodUrl(podUrl));
  // `synap init` keeps a saved key that still works, so a saved pod is enrolled by reconnecting it.
  return saved ? `synap login --reconnect ${saved.name}` : "synap init";
}

/** The stop line for an agent asked for on a computer that never enrolled. */
export function notEnrolledMessage(podUrl: string, then: string, command: string): string {
  return `This computer is not enrolled on ${podHost(podUrl)}: run \`${command}\` to connect it, then ${then}. An agent made from a computer that never enrolled belongs to no computer.`;
}

/**
 * The enrol-first door (founder, 2026-10-31, Q3): `synap agents add` and
 * `synap worker --agent` on a computer that never enrolled on `podUrl` stop
 * here with what to run, and, with a person at the terminal, offer to connect
 * it now (the device flow, `connectThisComputer`). Enrolled: the computer's
 * own key, the one an agent is minted with so it belongs to this computer. The
 * pod's own rule does not change.
 */
export async function ensureComputerEnrolled(
  podUrl: string,
  then: string,
  deps: {
    profiles?: () => Array<{ name: string; config: import("./pod.js").LocalPodConfig }>;
    interactive?: boolean;
    confirm?: (message: string) => Promise<boolean>;
    connect?: typeof connectThisComputer;
  } = {}
): Promise<{ enrolled: true; computerKey: string } | { enrolled: false; message: string }> {
  const profiles = deps.profiles ?? (await import("./pod.js")).listPodProfiles;
  const enrolled = computerProfileFor(podUrl, profiles());
  if (enrolled) return { enrolled: true, computerKey: enrolled.config.hubApiKey };
  const command = enrolCommand(podUrl, profiles());
  const message = notEnrolledMessage(podUrl, then, command);
  const saved = profiles().find((p) => normPodUrl(p.config.podUrl) === normPodUrl(podUrl));
  const interactive = deps.interactive ?? (!!process.stdin.isTTY && !!process.stdout.isTTY);
  // No saved pod (a key from the environment): `synap init` is the person's to run.
  if (!interactive || !saved) return { enrolled: false, message };
  log.warn(message);
  const confirm =
    deps.confirm ??
    (async (m: string) => {
      const prompts = (await import("prompts")).default;
      const { ok } = await prompts({ type: "confirm", name: "ok", message: m, initial: true });
      return ok === true;
    });
  if (!(await confirm(`Connect this computer to ${podHost(podUrl)} now?`))) return { enrolled: false, message };
  const connected = await (deps.connect ?? connectThisComputer)(podUrl, { name: saved.name });
  return connected?.credential === "computer"
    ? { enrolled: true, computerKey: connected.hubApiKey }
    : { enrolled: false, message };
}
