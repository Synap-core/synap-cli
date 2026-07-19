/**
 * synap whoami
 *
 * Answers the one question `synap status` can't: WHICH key is this session
 * actually authenticating with, and does the ambient `SYNAP_HUB_API_KEY`
 * silently disagree with the pinned `claude-code` surface key?
 *
 * `synap status` probes via `resolveHubConfig()` and prints a single "Valid"
 * off whichever key wins — which HIDES the case where the env key is revoked
 * but a valid surface key is pinned (or vice-versa). This command:
 *   1. resolves the winning cfg (the key every command uses),
 *   2. independently reads env key + `claude-code` surface key and reproduces
 *      the surface-over-env preference rule from hub-client.ts:394-403,
 *   3. introspects the winner via `/auth/status`, and
 *   4. when env and surface keys diverge, names the winner AND the ignored key,
 *      probing the loser too so the operator sees both states side by side.
 *
 * It never mutates state and never relies on resolveHubConfig's stderr swap
 * warning (hub-client.ts:398-400) — it reads the divergence itself.
 */

import chalk from "chalk";
import { log, banner } from "../utils/logger.js";
import { resolveHubConfig, hubGet, HubError, type HubConfig } from "../lib/hub-client.js";
import { getSurfaceAgentKey } from "../lib/pod.js";

/**
 * Shape of `GET /api/hub/auth/status`. `keyType` and `workspaceId` are NEW
 * fields being added by a parallel backend change — they may be absent until
 * that lands, so both are optional and rendered as "unknown" when missing.
 */
interface AuthStatus {
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

/** Last 6+ chars of a key, for eyeballing which secret is in play without leaking it. */
function keyTail(apiKey: string): string {
  return apiKey.length <= 8 ? "…" : `…${apiKey.slice(-6)}`;
}

type ProbeResult =
  | { kind: "ok"; status: AuthStatus }
  | { kind: "revoked" }
  | { kind: "error"; message: string };

/** Introspect a specific key by cloning the winning cfg and swapping the secret. */
async function probeKey(cfg: HubConfig, apiKey: string): Promise<ProbeResult> {
  try {
    const status = (await hubGet("/auth/status", {}, { ...cfg, apiKey })) as AuthStatus;
    return { kind: "ok", status };
  } catch (err: unknown) {
    const is401 =
      err instanceof HubError
        ? err.status === 401
        : String(err instanceof Error ? err.message : err).toLowerCase().includes("unauthorized");
    if (is401) return { kind: "revoked" };
    return { kind: "error", message: err instanceof Error ? err.message : String(err) };
  }
}

function renderAuthStatus(s: AuthStatus): void {
  log.info(`Key ID     : ${s.keyIdPrefix ?? "unknown"}`);
  log.info(`Key type   : ${s.keyType ?? chalk.dim("unknown")}`);
  log.info(`Identity   : ${s.userEmail ?? s.userName ?? s.userId ?? "unknown"}`);
  if (s.name) log.info(`Key name   : ${s.name}`);
  log.info(`Workspace  : ${s.workspaceId ?? chalk.dim("unknown")}`);
  log.info(`Scopes     : ${s.scopes && s.scopes.length ? s.scopes.join(", ") : chalk.dim("(none)")}`);
  const active = s.isActive === true ? chalk.green("active") : s.isActive === false ? chalk.red("revoked") : chalk.dim("unknown");
  log.info(`Status     : ${active}`);
  log.info(`Expires    : ${s.expiresAt ?? chalk.dim("never")}`);
}

export async function whoami(): Promise<void> {
  banner();

  // 1. The key that actually authenticates every command.
  let cfg: HubConfig;
  try {
    cfg = await resolveHubConfig();
  } catch (err: unknown) {
    log.error(err instanceof Error ? err.message : String(err));
    return;
  }

  // 2. Independently read the two candidate keys and reproduce the preference
  //    rule from hub-client.ts:394-403 — do NOT depend on resolveHubConfig's
  //    stderr swap warning, read the state ourselves.
  const envKey = process.env.SYNAP_HUB_API_KEY;
  const envPod = process.env.SYNAP_POD_URL;
  const surfaceKey = getSurfaceAgentKey("claude-code");
  const surfacePinnedHere =
    !!surfaceKey && !!surfaceKey.hubApiKey && surfaceKey.podUrl === envPod;
  const diverges =
    !!envKey &&
    surfacePinnedHere &&
    surfaceKey!.hubApiKey !== envKey;
  // Which candidate did resolveHubConfig actually pick?
  const winner: "surface" | "env" | "other" = diverges
    ? cfg.apiKey === surfaceKey!.hubApiKey
      ? "surface"
      : "env"
    : "other";

  // 3. Introspect the winning key.
  log.heading("Winning key (resolved)");
  log.info(`Pod        : ${cfg.podUrl}`);
  log.dim(`Secret     : ${keyTail(cfg.apiKey)}`);
  const winnerProbe = await probeKey(cfg, cfg.apiKey);
  if (winnerProbe.kind === "ok") {
    renderAuthStatus(winnerProbe.status);
  } else if (winnerProbe.kind === "revoked") {
    log.error("This key is revoked or expired — /auth/status returned 401.");
    log.hint("Refresh it with: synap login --reconnect");
  } else {
    log.warn(`Could not introspect key: ${winnerProbe.message}`);
  }

  // 4. Divergence report — the whole point of the command.
  if (!diverges) {
    if (envKey && surfacePinnedHere) {
      log.dim("\nEnv key and claude-code surface key agree — no divergence.");
    }
    log.blank();
    return;
  }

  log.heading("⚠ Key divergence detected");
  const winnerLabel = winner === "surface" ? "claude-code surface key" : "ambient SYNAP_HUB_API_KEY";
  const loserLabel = winner === "surface" ? "ambient SYNAP_HUB_API_KEY" : "claude-code surface key";
  const loserSecret = winner === "surface" ? envKey! : surfaceKey!.hubApiKey;
  // Mirror the surface-key warning wording at hub-client.ts:398-400.
  log.warn(
    `ambient SYNAP_HUB_API_KEY does not match the claude-code surface key pinned to ${envPod}.`
  );
  log.info(`Winner  (used)    : ${chalk.bold(winnerLabel)}  ${chalk.dim(keyTail(cfg.apiKey))}`);
  log.info(`Ignored (in play) : ${loserLabel}  ${chalk.dim(keyTail(loserSecret))}`);

  // Probe the LOSING key so both states are visible side by side.
  const loserProbe = await probeKey(cfg, loserSecret);
  if (loserProbe.kind === "ok") {
    const s = loserProbe.status;
    const active = s.isActive === false ? chalk.red("revoked") : chalk.green("valid");
    log.info(`  ${loserLabel} → ${active} (${s.keyIdPrefix ?? "?"}, ${s.userEmail ?? s.userId ?? "?"})`);
  } else if (loserProbe.kind === "revoked") {
    log.warn(`  ${loserLabel} → ${chalk.red("revoked")} (401 from /auth/status)`);
  } else {
    log.dim(`  ${loserLabel} → could not verify: ${loserProbe.message}`);
  }

  log.blank();
}
