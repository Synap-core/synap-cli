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
 *   3. introspects the winner via BOTH `/auth/status` (who OWNS the key) and
 *      `/users/me` (who the pod ACTS AS, + server-derived `isAgent`), and
 *   4. when env and surface keys diverge, names the winner AND the ignored key,
 *      probing the loser too so the operator sees both states side by side.
 *
 * Step 3 used to show only `/auth/status`'s `userEmail`, labelled "Identity".
 * For an agent key that is the AGENT, never the human the pod attributes its
 * writes to — so the command answered a different question than it appeared to,
 * and an earlier analysis concluded from it that the CLI and the MCP connector
 * were different people. Key owner, effective user, and isAgent are now printed
 * together; any one of them alone is misleading.
 *
 * It never mutates state and never relies on resolveHubConfig's stderr swap
 * warning (hub-client.ts:398-400) — it reads the divergence itself.
 */

import chalk from "chalk";
import { log, banner } from "../utils/logger.js";
import { resolveHubConfig, HubError, type HubConfig } from "../lib/hub-client.js";
import { getSurfaceAgentKey } from "../lib/pod.js";
// `AuthStatus` + the `/auth/status` fetch moved to lib/credential-class.ts so
// the proposals surface classifies the calling key through the SAME door this
// command reports on, instead of re-deriving it.
import {
  fetchAuthStatus,
  fetchEffectiveIdentity,
  classifyReviewer,
  type AuthStatus,
  type EffectiveIdentity,
} from "../lib/credential-class.js";

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
    const status = await fetchAuthStatus(cfg, apiKey);
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

/**
 * The three identity lines, printed together because any ONE of them alone is
 * misleading.
 *
 * `Key owner` came from `/auth/status` and used to be the ONLY thing shown —
 * labelled just "Identity". For an agent key that is the AGENT, so `whoami`
 * silently answered a different question than the operator asked, and an
 * earlier analysis read the CLI and the MCP connector as different people on
 * the strength of it. The pod attributes an agent key's writes to the human it
 * is linked to (`userId = keyRecord.linkedUserId`, hub-protocol-rest.ts:407),
 * and `GET /users/me` is where that effective identity is visible.
 */
function renderIdentityTriple(s: AuthStatus, me: EffectiveIdentity | null): void {
  const owner = s.userEmail ?? s.userName ?? s.userId ?? "unknown";
  log.info(`Key owner  : ${owner} ${chalk.dim("(who owns this key)")}`);
  if (!me) {
    log.info(`Effective  : ${chalk.dim("could not resolve (GET /users/me failed)")}`);
    return;
  }
  const effective = me.id ?? "unknown";
  // Same id on both lines = a plain human key: the key owner IS the actor.
  const sameActor = Boolean(me.id) && me.id === s.userId;
  log.info(
    `Effective  : ${effective} ${chalk.dim(
      sameActor ? "(same — this key acts as its own owner)" : "(who the pod attributes writes to)"
    )}`
  );
  log.info(
    `Is agent   : ${
      me.isAgent === true
        ? `${chalk.yellow("yes")} ${chalk.dim("(server-derived — writes are attributed to the effective user)")}`
        : me.isAgent === false
          ? chalk.green("no")
          : chalk.dim("unknown")
    }`
  );
}

function renderAuthStatus(s: AuthStatus, me: EffectiveIdentity | null): void {
  log.info(`Key ID     : ${s.keyIdPrefix ?? "unknown"}`);
  log.info(`Key type   : ${s.keyType ?? chalk.dim("unknown")}`);
  renderIdentityTriple(s, me);
  if (s.name) log.info(`Key name   : ${s.name}`);
  log.info(`Workspace  : ${s.workspaceId ?? chalk.dim("unknown")}`);
  log.info(`Scopes     : ${s.scopes && s.scopes.length ? s.scopes.join(", ") : chalk.dim("(none)")}`);
  // Whether this key may perform a HUMAN review (proposal approve/revert). The
  // pod blocks agent self-review, so say it here rather than letting
  // `synap proposals approve` discover it as a 403.
  const reviewer = classifyReviewer(s);
  log.info(
    `Can approve: ${
      reviewer === "agent"
        ? `${chalk.red("no")} ${chalk.dim("(agent credential — approve is human review)")}`
        : reviewer === "human"
          ? chalk.green("yes")
          : chalk.dim("unknown")
    }`
  );
  const active = s.isActive === true ? chalk.green("active") : s.isActive === false ? chalk.red("revoked") : chalk.dim("unknown");
  log.info(`Status     : ${active}`);
  log.info(`Expires    : ${s.expiresAt ?? chalk.dim("never")}`);
}

export async function whoami(opts: { json?: boolean } = {}): Promise<void> {
  if (!opts.json) banner();

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

  // 3. Introspect the winning key — BOTH questions, because "who owns this
  //    key" and "who does the pod act as" have different answers for an agent
  //    key, and showing only the first is what made this command misleading.
  const winnerProbe = await probeKey(cfg, cfg.apiKey);
  const effective: EffectiveIdentity | null = await fetchEffectiveIdentity(cfg).catch(() => null);

  if (opts.json) {
    console.log(
      JSON.stringify(
        {
          podUrl: cfg.podUrl,
          keyOwner:
            winnerProbe.kind === "ok"
              ? {
                  userId: winnerProbe.status.userId,
                  email: winnerProbe.status.userEmail,
                  keyId: winnerProbe.status.keyIdPrefix,
                  keyType: winnerProbe.status.keyType,
                  isActive: winnerProbe.status.isActive,
                }
              : null,
          effectiveUser: effective ? { userId: effective.id, scopes: effective.scopes } : null,
          isAgent: effective?.isAgent ?? null,
          canApprove:
            winnerProbe.kind === "ok" ? classifyReviewer(winnerProbe.status) : "unknown",
          probe: winnerProbe.kind,
          divergence: diverges
            ? { winner, envKey: keyTail(envKey!), surfaceKey: keyTail(surfaceKey!.hubApiKey) }
            : null,
        },
        null,
        2
      )
    );
    return;
  }

  log.heading("Winning key (resolved)");
  log.info(`Pod        : ${cfg.podUrl}`);
  log.dim(`Secret     : ${keyTail(cfg.apiKey)}`);
  if (winnerProbe.kind === "ok") {
    renderAuthStatus(winnerProbe.status, effective);
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
