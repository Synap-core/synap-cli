import { existsSync, readFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import {
  getActivePodConfig,
  getActiveWorkspaceId,
  getActiveWorkspaceIdForPod,
  findPodNameByUrl,
  getActiveProjectBinding,
  getActiveProjectId,
  listPodProfiles,
  getPodOverride,
  getSurfaceAgentKey,
} from "./pod.js";
import { resolveAgentOverride } from "./agents-config.js";
import {
  resolveActiveLensForPod,
  getClaudeSessionId,
  writeLens,
  clearLensField,
} from "./session-lens.js";
import {
  resolveDirectoryLensForPod,
  writeDirectoryLens,
  clearDirectoryLensField,
} from "./directory-lens.js";
import { preferClaudeCodeSurfaceKey } from "./key-source.js";
import { samePodOrigin } from "./project-ref.js";
import { HubRestClient } from "@synap/hub-rest-client";
import { log } from "../utils/logger.js";
import chalk from "chalk";

/**
 * Resolve a projectId safe to send to `podUrl`.
 *
 * Order: pod-qualified lens → directory lens → env project when co-located with
 * this pod (trustEnvProject — same model as SYNAP_WORKSPACE_ID under env rung) →
 * ActiveProjectBinding for this pod → legacy activeProjectId only when the
 * active profile is this pod.
 *
 * Write paths should consume `resolveHubConfig().projectId` rather than bare
 * `getActiveProjectId()` / env.
 */
function resolveProjectIdForPod(
  podUrl: string,
  opts: {
    lensProjectId?: string;
    dirLensProjectId?: string;
    envProject?: string;
    /** True only on resolveHubConfig env rung — env is co-located with SYNAP_POD_URL. */
    trustEnvProject?: boolean;
  }
): string | undefined {
  if (opts.lensProjectId) return opts.lensProjectId;
  if (opts.dirLensProjectId) return opts.dirLensProjectId;

  // Env pin co-located with env pod (connect --pin-project, Claude settings.env).
  if (opts.trustEnvProject && opts.envProject) return opts.envProject;

  const profiles = listPodProfiles();
  const binding = getActiveProjectBinding();
  if (binding) {
    const boundPod = profiles.find((x) => x.name === binding.podName);
    if (boundPod && samePodOrigin(boundPod.config.podUrl, podUrl)) {
      return binding.projectId;
    }
    // Binding is for another pod — do not send it.
    return undefined;
  }

  // Legacy: activeProjectId with no binding — only when active profile is this pod.
  const active = getActivePodConfig();
  if (active && samePodOrigin(active.podUrl, podUrl)) {
    return getActiveProjectId() || undefined;
  }
  return undefined;
}

/**
 * A failed Hub call, carrying the structured facts callers need to branch on.
 *
 * `message` is HUMAN-READABLE and is what the many `log.error((err as Error).message)`
 * sites print. It keeps a literal `(HTTP <status>)` token: several call sites
 * classify errors by matching that substring, and the token is the contract they
 * depend on. The raw response body is kept on `rawBody` and never spliced into
 * `message` — a JSON blob truncated mid-object is unreadable and leaks internals.
 */
export class HubError extends Error {
  readonly status: number;
  readonly code?: string;
  readonly reason?: string;
  readonly body?: unknown;
  readonly rawBody: string;
  readonly path: string;
  readonly method: string;
  /** Origin of the pod this call actually hit — for cross-pod diagnostics. */
  readonly podUrl?: string;
  /** Workspace this call actually sent — for cross-pod 403 diagnostics. */
  readonly workspaceId?: string;

  constructor(init: {
    message: string;
    status: number;
    code?: string;
    reason?: string;
    body?: unknown;
    rawBody: string;
    path: string;
    method: string;
    podUrl?: string;
    workspaceId?: string;
  }) {
    super(init.message);
    this.name = "HubError";
    this.status = init.status;
    this.code = init.code;
    this.reason = init.reason;
    this.body = init.body;
    this.rawBody = init.rawBody;
    this.path = init.path;
    this.method = init.method;
    this.podUrl = init.podUrl;
    this.workspaceId = init.workspaceId;
  }
}

/**
 * A Hub call that never reached the pod — DNS, TCP, TLS or timeout.
 *
 * Peer of {@link HubError}: same rendering path, same `message`-is-human-readable
 * rule. It deliberately carries NO `(HTTP <status>)` token — there was no HTTP
 * response, and the call sites that classify on that substring must not match.
 * `podUrl` is the origin we failed to reach and `hint` is the next action.
 */
export class HubNetworkError extends Error {
  /** Transport code we classified on: ENOTFOUND, ECONNREFUSED, TIMEOUT, TLS… */
  readonly code: string;
  readonly podUrl: string;
  readonly path: string;
  readonly method: string;
  /** The one thing the user should do next. Rendered under the message. */
  readonly hint: string;

  constructor(init: {
    message: string;
    code: string;
    podUrl: string;
    path: string;
    method: string;
    hint: string;
    cause?: unknown;
  }) {
    super(init.message, { cause: init.cause });
    this.name = "HubNetworkError";
    this.code = init.code;
    this.podUrl = init.podUrl;
    this.path = init.path;
    this.method = init.method;
    this.hint = init.hint;
  }
}

/** Origin of a Hub URL, for messages. Falls back to the raw URL if unparseable. */
function originOf(url: string): string {
  try {
    return new URL(url).origin;
  } catch {
    return url;
  }
}

/**
 * Classify a transport-layer failure into a HubNetworkError.
 *
 * undici throws a bare `TypeError: fetch failed` and hangs the real cause off
 * `err.cause`, so a wrong DNS name, a pod that is down, an offline laptop and a
 * fired AbortSignal.timeout are otherwise indistinguishable at the call sites
 * that print `err.message`. This is the one place that taxonomy lives.
 */
function networkError(
  err: unknown,
  url: string,
  method: string,
  path: string,
  timeoutMs: number
): HubNetworkError {
  const podUrl = originOf(url);
  const name = err instanceof Error ? err.name : "";
  const cause = (err as { cause?: unknown } | null)?.cause;
  const rawCode =
    cause && typeof cause === "object" && typeof (cause as { code?: unknown }).code === "string"
      ? ((cause as { code: string }).code)
      : "";

  const fail = (code: string, detail: string, hint: string) =>
    new HubNetworkError({
      message: `Hub ${method} ${path} failed: ${detail}`,
      code,
      podUrl,
      path,
      method,
      hint,
      cause: err,
    });

  // AbortSignal.timeout() rejects with a TimeoutError; undici's own connect/header
  // timeouts surface as codes. Both mean the same thing to the user.
  if (
    name === "TimeoutError" ||
    name === "AbortError" ||
    rawCode === "ETIMEDOUT" ||
    rawCode === "UND_ERR_CONNECT_TIMEOUT" ||
    rawCode === "UND_ERR_HEADERS_TIMEOUT"
  ) {
    return fail(
      "TIMEOUT",
      `no response from the pod at ${podUrl} after ${Math.round(timeoutMs / 1000)}s`,
      "The pod accepted the connection but did not answer in time — it may be overloaded or mid-restart. Check it with: synap status",
    );
  }

  if (rawCode === "ENOTFOUND" || rawCode === "EAI_AGAIN") {
    return fail(
      rawCode,
      `could not resolve the pod host for ${podUrl}`,
      rawCode === "EAI_AGAIN"
        ? "DNS lookup failed temporarily — check this machine is online, then retry."
        : "That hostname does not resolve — check the pod URL is spelled right. See your saved pods with: synap pods list",
    );
  }

  if (rawCode === "ECONNREFUSED") {
    return fail(
      rawCode,
      `the pod at ${podUrl} refused the connection`,
      "Nothing is listening there — check the pod is up, or switch to another saved pod with: synap pods use <name>",
    );
  }

  if (rawCode === "ECONNRESET" || rawCode === "EPIPE") {
    return fail(
      rawCode,
      `the connection to ${podUrl} was dropped mid-request`,
      "The pod or a proxy in front of it closed the connection — retry, then check the pod with: synap status",
    );
  }

  if (rawCode === "ENETUNREACH" || rawCode === "EHOSTUNREACH") {
    return fail(
      rawCode,
      `no network route to ${podUrl}`,
      "This machine cannot reach that host — check you are online and on the right network/VPN.",
    );
  }

  if (rawCode.startsWith("CERT_") || rawCode.startsWith("ERR_TLS_") || rawCode.includes("SELF_SIGNED") || rawCode === "UNABLE_TO_VERIFY_LEAF_SIGNATURE" || rawCode === "DEPTH_ZERO_SELF_SIGNED_CERT") {
    return fail(
      rawCode,
      `the TLS certificate of ${podUrl} was rejected (${rawCode})`,
      "The pod's certificate is not trusted by this machine — check the pod URL and its TLS setup.",
    );
  }

  // Unknown transport failure: still name the pod and the underlying code rather
  // than letting a bare "fetch failed" through.
  const detail = rawCode
    ? `could not reach the pod at ${podUrl} (${rawCode})`
    : `could not reach the pod at ${podUrl}`;
  return fail(
    rawCode || "NETWORK",
    detail,
    "Check this machine is online and the pod URL is right: synap pods list",
  );
}

/** Fallback wording when the body carries no usable message of its own. */
function statusPhrase(status: number): string {
  if (status >= 500) return "the pod hit an internal error";
  switch (status) {
    case 400:
      return "the pod rejected the request as invalid";
    case 401:
      return "the pod did not accept these credentials";
    case 403:
      return "the pod refused this operation";
    case 404:
      return "the pod has no such endpoint or record";
    case 409:
      return "this conflicts with what the pod already has";
    case 429:
      return "the pod is rate limiting this key";
    default:
      return "the pod returned an unexpected status";
  }
}

/**
 * Turn a raw error body into { detail, code, reason, parsed }.
 * JSON bodies contribute only their `message`/`error` field; a JSON body with
 * neither falls back to the status phrase rather than dumping the object.
 */
function readErrorBody(
  status: number,
  rawBody: string
): { detail: string; code?: string; reason?: string; parsed?: unknown } {
  const trimmed = rawBody.trim();
  if (!trimmed) return { detail: statusPhrase(status) };

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    // Plain-text body (Hono default, a proxy page): safe to show inline — it is
    // not structured, so a length cap cannot cut it mid-object.
    const oneLine = trimmed.replace(/\s+/g, " ");
    return { detail: oneLine.length > 200 ? `${oneLine.slice(0, 200)}…` : oneLine };
  }

  // tRPC batch errors are array-shaped: `[{ error: { message, code, data: { httpStatus, ... } } }]`
  // (superjson may additionally nest the real payload one level deeper under
  // `error.json`). Unwrap to the first entry's error object before falling
  // through to the normal object-shaped handling below, so a tRPC failure
  // surfaces its real `message` instead of the generic status phrase.
  if (Array.isArray(parsed)) {
    const first = parsed[0] as Record<string, unknown> | undefined;
    const err = first?.error as Record<string, unknown> | undefined;
    if (err && typeof err === "object") {
      const json = err.json as Record<string, unknown> | undefined;
      parsed = json ?? err;
    }
  } else if (
    parsed &&
    typeof parsed === "object" &&
    "error" in (parsed as Record<string, unknown>)
  ) {
    // Single tRPC-shaped error body: `{ error: { message, ... } }` or
    // `{ error: { json: { message, ... } } }`. Only unwrap when `error` is an
    // OBJECT — a Hub-REST body's `error` is a plain string category
    // (`{ error: "...", detail: "..." }`) and must fall through unchanged.
    const errVal = (parsed as Record<string, unknown>).error;
    if (errVal && typeof errVal === "object") {
      const errObj = errVal as Record<string, unknown>;
      const json = errObj.json as Record<string, unknown> | undefined;
      parsed = json ?? errObj;
    }
  }

  if (parsed && typeof parsed === "object") {
    const o = parsed as Record<string, unknown>;
    const code = typeof o.code === "string" ? o.code : undefined;
    const reason = typeof o.reason === "string" ? o.reason : undefined;
    const str = (v: unknown): string | undefined =>
      typeof v === "string" && v ? v : undefined;
    // Backend error contract for the Hub package/workspace routes is
    // `{ error: <category>, detail: <the real underlying cause> }`. The specific
    // cause lives in `detail` — surfacing only `error` throws away the one thing
    // that makes a 500 actionable (e.g. "profile X targets unknown profile Y").
    // Precedence: message (tRPC-shaped) → error+detail combined → error → detail.
    const message = str(o.message);
    const errorField = str(o.error);
    const detailField = str(o.detail);
    const detail =
      message ??
      (errorField && detailField
        ? `${errorField}: ${detailField}`
        : errorField ?? detailField ?? statusPhrase(status));
    return { detail, code, reason, parsed };
  }
  return { detail: statusPhrase(status), parsed };
}

/** Build the HubError for a non-ok response body. */
function hubError(
  method: string,
  path: string,
  status: number,
  rawBody: string,
  suffix?: string,
  ctx?: { podUrl?: string; workspaceId?: string }
): HubError {
  const { detail, code, reason, parsed } = readErrorBody(status, rawBody);
  return new HubError({
    message: `Hub ${method} ${path} failed (HTTP ${status})${suffix ? ` ${suffix}` : ""}: ${detail}`,
    status,
    code,
    reason,
    body: parsed,
    rawBody,
    path,
    method,
    podUrl: ctx?.podUrl ? originOf(ctx.podUrl) : undefined,
    workspaceId: ctx?.workspaceId,
  });
}

/** Where to send users who hit a wall. */
const DISCORD_INVITE_URL = "https://discord.gg/xhRdQ7hG5h";

/** Wrap a URL in an OSC-8 terminal hyperlink so `label` is clickable. */
function osc8Link(url: string, label: string): string {
  return `\x1b]8;;${url}\x1b\\${label}\x1b]8;;\x1b\\`;
}

/**
 * Once-per-process guard for the Discord help footer. A single CLI invocation
 * runs one command; printing the footer at most once keeps it a footer, not a
 * per-error/per-line spam.
 */
let _discordHelpShown = false;

/**
 * Append a one-line "need help?" footer with a clickable Discord invite. Prints
 * to stderr (same stream as the error it follows, so `2>/dev/null` hides both)
 * and only once per process. The invite is an OSC-8 hyperlink on an interactive
 * terminal, a plain URL when the stream is redirected/piped.
 */
export function discordHelpLine(): void {
  if (_discordHelpShown) return;
  _discordHelpShown = true;
  const link = process.stderr.isTTY
    ? osc8Link(DISCORD_INVITE_URL, DISCORD_INVITE_URL)
    : DISCORD_INVITE_URL;
  console.error(chalk.dim(`    Need help? Join our Discord: ${link}`));
}

/**
 * Print a failed Hub call: its humanized message plus a hint for the classes
 * where the cause is not obvious from the message alone. Lives here rather than
 * in utils/logger so the logger stays domain-agnostic and the taxonomy and its
 * presentation sit in one file. Always closes with the one-time Discord footer.
 */
export function renderHubError(err: unknown): void {
  renderHubErrorBody(err);
  // ONE central place every failed Hub command flows through — append the help
  // footer here so it prints once per failed command (guarded), not per line.
  discordHelpLine();
}

function renderHubErrorBody(err: unknown): void {
  // Hints use log.hint (stderr), not log.dim (stdout): a hint belongs to the
  // error it explains, and splitting one message across two streams means
  // `2>/dev/null` shows a bare hint with no error above it.
  if (err instanceof HubNetworkError) {
    log.error(err.message);
    log.hint(err.hint);
    return;
  }
  if (!(err instanceof HubError)) {
    log.error(err instanceof Error ? err.message : String(err));
    return;
  }
  // Connection-class failure — the execute door returns 424 with a machine
  // `errorClass` (+ `providerRef`) precisely so it SURVIVES the pod's 5xx egress
  // sanitizer. This is client-ACTIONABLE (reconnect), not a server fault, so name
  // the cause + the exact fix instead of the generic status hint. Mirrors the
  // browser's P1 self-heal reconnect chip.
  const errBody = err.body as
    | { errorClass?: string; providerRef?: string }
    | undefined;
  const errorClass = errBody?.errorClass;
  if (errorClass === "auth" || errorClass === "no_connection") {
    const provider = errBody?.providerRef
      ? chalk.bold(errBody.providerRef)
      : "this capability's";
    log.error(
      `The ${provider} connection needs reconnecting — its access has expired or was revoked.`
    );
    log.hint('Reconnect it:  synap cap connect "<capability>" --reconnect');
    log.hint("Find the capability name with:  synap cap list");
    return;
  }
  if (errorClass === "target_missing") {
    log.error(err.message);
    log.hint(
      "The workspace or target this run needs no longer exists on this pod. Run: synap orient"
    );
    return;
  }
  log.error(err.message);
  // A 500 carries an `errorId` (the egress sanitizer logs the real cause under
  // it server-side) — surface it so "quote errorId when reporting it" is
  // actionable rather than a dead end.
  const errorId =
    typeof (err.body as { errorId?: unknown } | undefined)?.errorId === "string"
      ? (err.body as { errorId: string }).errorId
      : undefined;
  if (err.status >= 500 && errorId) {
    log.hint(`errorId: ${errorId}`);
  }
  // A 500 whose body carried a specific cause (detail/message) is already in
  // `err.message` above — do NOT then claim "internal error, not in this
  // command": a workspace/template creation failure is often an actionable
  // template or data problem. Only add the generic pod-fault hint when the body
  // gave nothing better than the status phrase.
  const hasSpecificCause =
    !!err.rawBody && !err.message.endsWith("the pod hit an internal error");
  // A 403/message naming a workspace: the real cause is almost always "that
  // workspace doesn't exist or isn't accessible ON THIS POD" (a stale saved
  // workspace id after a pod switch), not a scopes problem — name it + the
  // exact next command instead of the generic "credentials" hint.
  const namesWorkspace = /workspace/i.test(err.message);
  if (err.status >= 500) {
    if (!hasSpecificCause) {
      log.hint("The pod hit an internal error — check the pod logs for the stack trace.");
    }
  } else if (err.status === 403 && namesWorkspace) {
    // Name the exact workspace + pod this call used: the usual cause is a global
    // active workspace left over from ANOTHER pod (a stale `synap use` after a
    // pod switch) being sent to a pod it doesn't belong to.
    if (err.workspaceId && err.podUrl) {
      // State the FACT (what was sent where), then the two causes WITHOUT
      // picking one — this code cannot tell them apart, and asserting the
      // cross-pod story is wrong whenever the saved workspace simply no longer
      // exists on its own pod (dogfood: `pods.team.workspaceId` pointed at a
      // deleted workspace; the hint blamed a pod mix-up that had not happened).
      // `synap doctor` is the only thing here that actually CHECKS, so it leads.
      log.hint(`Sent workspace ${err.workspaceId} to ${err.podUrl}.`);
      log.hint("That workspace is not accessible on this pod — either it lives on a different pod, or it no longer exists here.");
      log.hint("Run: synap doctor   (checks which of the two it is), then: synap orient   (see valid workspaces) and synap use <id>.");
    } else {
      log.hint("Workspace not found or not accessible on this pod — run: synap orient   (see valid workspaces), or: synap doctor");
    }
  } else if (err.status === 401 || err.status === 403) {
    log.hint("The pod rejected this key's credentials or its scopes for this operation. Run: synap doctor");
  } else if (err.status === 404) {
    // A structured JSON body (err.body set) means THIS app answered — the
    // endpoint just doesn't exist here (older build / wrong record). A body
    // that failed to parse as JSON (readErrorBody's plain-text fallback — a
    // proxy default page, an HTML error, a completely different service)
    // means the request never reached this app at all: the classic
    // stale/migrated-domain failure, not an old build.
    if (err.body === undefined && err.rawBody.trim()) {
      log.hint("This host doesn't look like a Synap pod — your saved pod URL may be stale. Run: synap doctor");
    } else {
      log.hint("The pod has no such endpoint or record — it may be running an older build, or the id doesn't exist. Run: synap doctor");
    }
  }
}

export interface HubConfig {
  podUrl: string;
  apiKey: string;
  userId: string;
  /** Active workspace — from `synap use`, pod default, or env var. Undefined if none configured. */
  workspaceId?: string;
  /** Active project — from `synap project use`, pod default, or env var. Peer of workspaceId; independent. */
  projectId?: string;
  scopes?: string[];
}

const userIdCache = new Map<string, string>();

export async function resolveUserId(cfg: HubConfig): Promise<string> {
  if (cfg.userId && cfg.userId !== "cli") return cfg.userId;
  const cached = userIdCache.get(cfg.apiKey);
  if (cached) return cached;
  const me = await hubGet("/users/me", {}, cfg);
  const id = String((me as Record<string, unknown>).id ?? cfg.userId);
  userIdCache.set(cfg.apiKey, id);
  return id;
}

export function assertScope(cfg: HubConfig, required: string): void {
  // scopes are on the HubConfig only if we fetched them; skip check if unknown
  if (!cfg.scopes) return;
  if (!cfg.scopes.includes(required)) {
    throw new Error(
      `API key is missing required scope: ${required}\n` +
      `Re-run: synap connect --target=<surface>  to get a key with the right scopes.`
    );
  }
}

export async function resolveHubConfig(opts?: { podUrl?: string; apiKey?: string }): Promise<HubConfig> {
  // 0. Per-invocation `--pod <name>` override (highest precedence): a single
  //    command targets another saved pod while other agents keep their default.
  //    Beats the env vars deliberately — that is the whole point of the flag.
  const podOverride = getPodOverride();
  if (podOverride) {
    // Prefer cross-pod-safe resolution (binding + "not another pod's default")
    // over the profile's baked `workspaceId`, which can drift to a foreign UUID
    // after dual-pod work (dogfood: perso profile held team CRM ws → 403).
    const overrideName = findPodNameByUrl(podOverride.podUrl);
    const safeWs =
      getActiveWorkspaceIdForPod(overrideName) ||
      // Only fall back to profile default when it isn't known to belong elsewhere
      // (getActiveWorkspaceIdForPod already applied that rule against the profile).
      undefined;
    return {
      podUrl: podOverride.podUrl,
      apiKey: podOverride.hubApiKey,
      // A profile's agentUserId may be empty; "cli" makes resolveUserId fetch /users/me.
      userId: podOverride.agentUserId || "cli",
      workspaceId: safeWs,
      projectId: resolveProjectIdForPod(podOverride.podUrl, {}),
    };
  }
  // 1. Explicit flags (escape hatch)
  if (opts?.podUrl && opts?.apiKey) {
    return {
      podUrl: opts.podUrl,
      apiKey: opts.apiKey,
      userId: process.env.SYNAP_USER_ID ?? "cli",
    };
  }
  // 2. Agent override: SYNAP_AGENT env var selects a named identity
  const agentOverride = resolveAgentOverride();
  if (agentOverride) {
    const profiles = listPodProfiles();
    const podProfile = profiles.find(p => p.name === agentOverride.podName);
    const podUrl = podProfile?.config.podUrl ?? getActivePodConfig()?.podUrl ?? "";
    const envScopes = process.env.SYNAP_KEY_SCOPES;
    return {
      podUrl,
      apiKey: agentOverride.apiKey,
      userId: agentOverride.podName ?? "agent",
      scopes: envScopes ? envScopes.split(",") : undefined,
    };
  }
  // 3. Env vars — set by `synap connect --target=claude-code`
  const envPod = process.env.SYNAP_POD_URL;
  const envKey = process.env.SYNAP_HUB_API_KEY;
  const envUser = process.env.SYNAP_USER_ID;
  const envScopes = process.env.SYNAP_KEY_SCOPES;
  const envWorkspace = process.env.SYNAP_WORKSPACE_ID;
  const envProject = process.env.SYNAP_PROJECT_ID;
  if (envPod && envKey && envUser) {
    // Surface-bound resolution guard: if this pod has a `claude-code` surface
    // key pinned to it (via `synap connect --target=claude-code`) and the
    // ambient SYNAP_HUB_API_KEY doesn't match it, the session inherited a
    // FOREIGN key (e.g. another agent's, like the Discord bridge's) — prefer
    // the pinned key so a leaked/inherited env var can't silently redefine
    // which agent this session acts as. Conservative: only applies here, in
    // step 3 — steps 0-2 (--pod, explicit flags, SYNAP_AGENT) still win
    // outright, untouched. Preference logic lives in key-source.ts so whoami
    // reports the same rule (no drift).
    const preferred = preferClaudeCodeSurfaceKey({
      envPod,
      envKey,
      envUser,
      surface: getSurfaceAgentKey("claude-code", envPod),
    });
    if (preferred.usedSurface) {
      process.stderr.write(
        `[synap] warning: ambient SYNAP_HUB_API_KEY does not match the claude-code surface key pinned to ${envPod} — using the pinned key instead of the inherited one.\n`
      );
    }
    const apiKey = preferred.apiKey;
    const userId = preferred.userId;
    // Per-Claude-session lens wins over the global env var, so concurrent
    // sessions can each be scoped to a different workspace — but ONLY when the
    // lens belongs to THIS pod. A lens stamped with another pod is ignored so
    // the pod-qualified fallback below applies (the "Access denied to
    // workspace" 403 after `synap pods use`).
    const lens = resolveActiveLensForPod(envPod);
    // …and the per-DIRECTORY lens sits directly beneath it: the durable default
    // for this working tree, overridden by the session lens when one is set.
    // Pod-qualified through the same door, for the same reason — a directory
    // lens outlives many `synap pods use` switches, so it is MORE exposed to
    // the cross-pod 403 than the session lens is.
    const dirLens = resolveDirectoryLensForPod(envPod)?.lens;
    return {
      podUrl: envPod,
      apiKey,
      userId,
      // The global-config fallback is resolved AGAINST THIS POD (envPod) —
      // never send a workspace that belongs to a different pod.
      workspaceId:
        lens?.workspaceId ||
        dirLens?.workspaceId ||
        envWorkspace ||
        getActiveWorkspaceIdForPod(findPodNameByUrl(envPod)),
      // Project is a peer lens. Lens/dir-lens are already pod-qualified;
      // env/global active project only when ActiveProjectBinding matches this pod.
      // Write paths must use this resolveHubConfig output — never bare
      // getActiveProjectId() / SYNAP_PROJECT_ID without the pod check.
      projectId: resolveProjectIdForPod(envPod, {
        lensProjectId: lens?.projectId,
        dirLensProjectId: dirLens?.projectId,
        envProject,
        trustEnvProject: true,
      }),
      scopes: envScopes ? envScopes.split(",") : undefined,
    };
  }
  // 4. Active CLI pod profile
  const config = getActivePodConfig();
  if (!config) throw new Error("No pod configured. Run: synap pods add");
  // Same pod-qualification as step 3: a lens stamped with another pod must not
  // short-circuit `getActiveWorkspaceId()`, which IS cross-pod-safe.
  const activeLens = resolveActiveLensForPod(config.podUrl);
  const activeDirLens = resolveDirectoryLensForPod(config.podUrl)?.lens;
  return {
    podUrl: config.podUrl,
    apiKey: config.hubApiKey,
    userId: config.agentUserId,
    // session lens › directory lens › global config. (No env rung here: this
    // branch is only reached when SYNAP_POD_URL is unset.)
    workspaceId:
      activeLens?.workspaceId || activeDirLens?.workspaceId || getActiveWorkspaceId(),
    // Project: same pod-qualification as step 3 (no bare getActiveProjectId).
    projectId: resolveProjectIdForPod(config.podUrl, {
      lensProjectId: activeLens?.projectId,
      dirLensProjectId: activeDirLens?.projectId,
    }),
  };
}

// ─── Active focus session ─────────────────────────────────────────────────────
//
// ONE store, two rungs of the SAME lens mechanism:
//
//   env SYNAP_SESSION_ID  ›  session lens (per Claude tab)  ›  directory lens
//
// The retired legacy store was a per-CWD `.synap-session` file that the session
// lens already silently shadowed — two concurrent "current session" stores for
// one concept. It is now read exactly once, to migrate (below).

/** Legacy per-CWD session file — RETIRED as a store; read once to migrate. */
const LEGACY_SESSION_FILE = ".synap-session";

let legacySessionMigrationChecked = false;

/**
 * One-time migration of a pre-existing `.synap-session` into the DIRECTORY lens.
 *
 * COMPAT DECISION — read-and-migrate, not a permanent read-only fallback. A
 * fallback would keep two stores alive indefinitely, which is exactly the
 * divergence being removed. Migrating is faithful: `.synap-session` was
 * per-working-tree and durable, and the directory lens has precisely that
 * lifetime and scope — so an already-attached session survives the upgrade for
 * every terminal in that tree. The file is deleted afterwards so it can never
 * shadow (or be shadowed by) the lens again.
 *
 * No `podUrl` is stamped: the legacy file carried no pod, and stamping one here
 * would falsely pod-qualify whatever workspace/project the lens already holds.
 */
function migrateLegacySessionFile(): void {
  if (legacySessionMigrationChecked) return;
  legacySessionMigrationChecked = true;
  const filePath = join(process.cwd(), LEGACY_SESSION_FILE);
  if (!existsSync(filePath)) return;
  let id: string | undefined;
  try {
    id = readFileSync(filePath, "utf8").trim() || undefined;
  } catch {
    return;
  }
  try {
    if (id) writeDirectoryLens({ focusSessionId: id });
    unlinkSync(filePath);
  } catch {
    return; // best-effort — a read-only tree simply keeps the stale file
  }
  process.stderr.write(
    `[synap] .synap-session is deprecated${id ? ` — session ${id.slice(0, 8)}… migrated into .synap/lens.json` : " — removed (empty)"}.\n`
  );
}

/**
 * The focus session every hub call should be tagged with.
 *
 * Both lens rungs are pod-qualified: a focus-session id is POD-LOCAL, so a lens
 * stamped with another pod must not leak into `X-Session-Id`. (Lenses written
 * before the stamp existed have no `podUrl` and match leniently — see
 * `lensMatchesPod`.)
 */
export function resolveActiveSessionId(podUrl?: string): string | undefined {
  const fromEnv = process.env.SYNAP_SESSION_ID;
  if (fromEnv) return fromEnv;
  migrateLegacySessionFile();
  return (
    resolveActiveLensForPod(podUrl)?.focusSessionId ||
    resolveDirectoryLensForPod(podUrl)?.lens.focusSessionId
  );
}

/** Where an attach landed — reported so the user knows what owns their scope. */
export type SessionAttachTarget = "session-lens" | "directory-lens";

/**
 * Attach a focus session to this terminal.
 *
 * Inside Claude Code the SESSION lens wins — per-tab isolation is the point
 * (tab A on session X, tab B on session Y, same directory). Outside it there is
 * no `CLAUDE_CODE_SESSION_ID` to key on, so the DIRECTORY lens is the
 * legitimate fallback: the same per-working-tree scope the retired
 * `.synap-session` had. `attach` therefore never silently no-ops.
 */
export function attachActiveSessionId(sessionId: string): SessionAttachTarget {
  const claudeSession = getClaudeSessionId();
  if (claudeSession) {
    writeLens(claudeSession, { focusSessionId: sessionId });
    return "session-lens";
  }
  writeDirectoryLens({ focusSessionId: sessionId });
  return "directory-lens";
}

/**
 * Detach — clear the focus session from BOTH lens rungs, and return whatever
 * was active. Clearing only the top rung would "detach" into the lower one,
 * which reads as the command failing.
 */
export function detachActiveSessionId(podUrl?: string): string | undefined {
  const previous = resolveActiveSessionId(podUrl);
  const claudeSession = getClaudeSessionId();
  if (claudeSession) clearLensField(claudeSession, "focusSessionId");
  clearDirectoryLensField("focusSessionId");
  return previous;
}

function sessionHeaders(cfg?: HubConfig): Record<string, string> {
  const id = resolveActiveSessionId(cfg?.podUrl);
  return id ? { "X-Session-Id": id } : {};
}

/** Max 429 retries for bulk import (each waits up to the rate-limit window). */
const HUB_429_MAX_RETRIES = 12;
/** Default wait when server gives no Retry-After (API-key window is 60s). */
const HUB_429_DEFAULT_WAIT_MS = 62_000;
/** Never sleep more than this on a single 429 (proxies sometimes send 180+). */
const HUB_429_MAX_WAIT_MS = 75_000;

/**
 * Client-side request budget — stay UNDER the server limit so we rarely 429.
 * Default 80/min is safe for pods still on the old 100/min auth limit.
 * After deploying 1200/min server budget: `export SYNAP_HUB_RPM=1000`.
 */
function hubRpmBudget(): number {
  const raw = process.env.SYNAP_HUB_RPM;
  if (raw) {
    const n = parseInt(raw, 10);
    if (Number.isFinite(n) && n >= 10) return Math.min(n, 5000);
  }
  return 80;
}

const hubRequestTimestamps: number[] = [];

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Pace Hub calls so we never burst past hubRpmBudget() in any 60s window.
 * This is the primary bulk-import fix — reactive 429 sleep is the backup.
 */
async function acquireHubSlot(): Promise<void> {
  const rpm = hubRpmBudget();
  for (;;) {
    const now = Date.now();
    while (
      hubRequestTimestamps.length > 0 &&
      hubRequestTimestamps[0]! < now - 60_000
    ) {
      hubRequestTimestamps.shift();
    }
    if (hubRequestTimestamps.length < rpm) {
      hubRequestTimestamps.push(now);
      return;
    }
    const wait = hubRequestTimestamps[0]! + 60_000 - now + 25;
    if (wait > 500) {
      console.error(
        `[hub] pacing: ${hubRequestTimestamps.length}/${rpm} req in last 60s — wait ${Math.ceil(wait / 1000)}s`
      );
    }
    await sleep(Math.max(wait, 50));
  }
}

/**
 * Parse Retry-After from headers or a Hub 429 body. Caps at 75s so a bad
 * proxy header never parks the importer for 3 minutes.
 */
function retryAfterMs(res: Response, bodyText: string): number {
  const h = res.headers.get("retry-after");
  if (h) {
    const sec = parseInt(h, 10);
    if (Number.isFinite(sec) && sec > 0) {
      return Math.min(Math.max(sec * 1000, 1_000), HUB_429_MAX_WAIT_MS);
    }
  }
  const m = bodyText.match(/retry after\s+(\d+)\s*s/i);
  if (m) {
    const sec = parseInt(m[1], 10);
    if (Number.isFinite(sec) && sec > 0) {
      return Math.min(Math.max(sec * 1000, 1_000), HUB_429_MAX_WAIT_MS);
    }
  }
  return HUB_429_DEFAULT_WAIT_MS;
}

/**
 * fetch with client pacing + automatic 429 backoff.
 *
 * `timeoutMs` mirrors the AbortSignal.timeout() the caller put on `init` — it is
 * only used to say how long we waited when the signal fires.
 */
async function hubFetchWithRetry(
  url: string,
  init: RequestInit,
  label: string,
  timeoutMs: number
): Promise<Response> {
  const [labelMethod, ...labelRest] = label.split(" ");
  const labelPath = labelRest.join(" ");
  let attempt = 0;
  for (;;) {
    await acquireHubSlot();
    let res: Response;
    try {
      res = await fetch(url, init);
    } catch (err) {
      throw networkError(err, url, labelMethod, labelPath, timeoutMs);
    }
    if (res.status !== 429) return res;
    attempt++;
    if (attempt > HUB_429_MAX_RETRIES) {
      const bodyText = await res.text().catch(() => "");
      throw hubError(
        labelMethod,
        labelPath,
        429,
        bodyText,
        `after ${HUB_429_MAX_RETRIES} retries`
      );
    }
    const bodyText = await res.text().catch(() => "");
    const wait = retryAfterMs(res, bodyText);
    console.error(
      `[hub] 429 rate limit on ${label} — waiting ${Math.ceil(wait / 1000)}s (retry ${attempt}/${HUB_429_MAX_RETRIES})`
    );
    await sleep(wait);
  }
}

export async function hubGet(
  path: string,
  params: Record<string, string | number | undefined>,
  cfg: HubConfig
): Promise<unknown> {
  const url = new URL(`${cfg.podUrl}/api/hub${path}`);
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined) url.searchParams.set(k, String(v));
  }
  const res = await hubFetchWithRetry(
    url.toString(),
    {
      headers: { Authorization: `Bearer ${cfg.apiKey}`, ...sessionHeaders(cfg) },
      signal: AbortSignal.timeout(15_000),
    },
    `GET ${path}`,
    15_000
  );
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw hubError("GET", path, res.status, body, undefined, cfg);
  }
  return res.json();
}

/**
 * The workspace a failing request ACTUALLY carried. A caller may override the
 * configured lens per-command (e.g. `--workspace <id>`), and naming the config's
 * workspace in that error sends the reader chasing the wrong id.
 */
function errorWorkspace(body: unknown, cfg: HubConfig): string | undefined {
  const sent =
    body && typeof body === "object" && "workspaceId" in body
      ? (body as { workspaceId?: unknown }).workspaceId
      : undefined;
  return typeof sent === "string" && sent.length > 0 ? sent : cfg.workspaceId;
}

export async function hubPost(
  path: string,
  body: unknown,
  cfg: HubConfig,
  // Default 15s suits CRUD doors. Capability runs invoke external provider APIs
  // (often several sequential calls) and legitimately take longer — callers
  // override (e.g. `cap run` passes 90s).
  timeoutMs = 15_000
): Promise<unknown> {
  const res = await hubFetchWithRetry(
    `${cfg.podUrl}/api/hub${path}`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${cfg.apiKey}`,
        "Content-Type": "application/json",
        ...sessionHeaders(cfg),
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    },
    `POST ${path}`,
    timeoutMs
  );
  if (!res.ok) {
    const bodyText = await res.text().catch(() => "");
    throw hubError("POST", path, res.status, bodyText, undefined, {
      podUrl: cfg.podUrl,
      workspaceId: errorWorkspace(body, cfg),
    });
  }
  return res.json();
}

/**
 * Multipart POST for Hub doors that accept file uploads (e.g. source-file).
 * Do NOT set Content-Type — fetch sets the boundary for FormData.
 *
 * Note: on 429 retry we cannot re-use a consumed FormData body in all runtimes.
 * Callers that hit 429 mid-bulk should rebuild FormData — see hubPostMultipartRetryable.
 */
export async function hubPostMultipart(
  path: string,
  form: FormData,
  cfg: HubConfig,
  timeoutMs = 120_000
): Promise<unknown> {
  const res = await hubFetchWithRetry(
    `${cfg.podUrl}/api/hub${path}`,
    {
      method: "POST",
      headers: { Authorization: `Bearer ${cfg.apiKey}`, ...sessionHeaders(cfg) },
      body: form,
      signal: AbortSignal.timeout(timeoutMs),
    },
    `POST multipart ${path}`,
    timeoutMs
  );
  if (!res.ok) {
    const bodyText = await res.text().catch(() => "");
    throw hubError("POST multipart", path, res.status, bodyText, undefined, cfg);
  }
  return res.json();
}

/**
 * Multipart POST that rebuilds the body on each 429 retry (FormData streams
 * can only be read once).
 */
export async function hubPostMultipartRetryable(
  path: string,
  buildForm: () => FormData,
  cfg: HubConfig,
  timeoutMs = 120_000
): Promise<unknown> {
  let attempt = 0;
  for (;;) {
    await acquireHubSlot();
    const form = buildForm();
    const url = `${cfg.podUrl}/api/hub${path}`;
    let res: Response;
    try {
      res = await fetch(url, {
        method: "POST",
        headers: { Authorization: `Bearer ${cfg.apiKey}`, ...sessionHeaders(cfg) },
        body: form,
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      throw networkError(err, url, "POST multipart", path, timeoutMs);
    }
    if (res.status !== 429) {
      if (!res.ok) {
        const bodyText = await res.text().catch(() => "");
        throw hubError("POST multipart", path, res.status, bodyText, undefined, cfg);
      }
      return res.json();
    }
    attempt++;
    if (attempt > HUB_429_MAX_RETRIES) {
      const bodyText = await res.text().catch(() => "");
      throw hubError(
        "POST multipart",
        path,
        429,
        bodyText,
        `after ${HUB_429_MAX_RETRIES} retries`
      );
    }
    const bodyText = await res.text().catch(() => "");
    const wait = retryAfterMs(res, bodyText);
    console.error(
      `[hub] 429 rate limit on POST multipart ${path} — waiting ${Math.ceil(wait / 1000)}s (retry ${attempt}/${HUB_429_MAX_RETRIES})`
    );
    await sleep(wait);
  }
}

export async function hubPatch(path: string, body: unknown, cfg: HubConfig): Promise<unknown> {
  const url = `${cfg.podUrl}/api/hub${path}`;
  let res: Response;
  try {
    res = await fetch(url, {
      method: "PATCH",
      headers: { Authorization: `Bearer ${cfg.apiKey}`, "Content-Type": "application/json", ...sessionHeaders(cfg) },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(15_000),
    });
  } catch (err) {
    throw networkError(err, url, "PATCH", path, 15_000);
  }
  if (!res.ok) {
    const bodyText = await res.text().catch(() => "");
    throw hubError("PATCH", path, res.status, bodyText, undefined, {
      podUrl: cfg.podUrl,
      workspaceId: errorWorkspace(body, cfg),
    });
  }
  return res.json();
}

export async function hubDelete(path: string, cfg: HubConfig): Promise<unknown> {
  const url = `${cfg.podUrl}/api/hub${path}`;
  let res: Response;
  try {
    res = await fetch(url, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${cfg.apiKey}`, ...sessionHeaders(cfg) },
      signal: AbortSignal.timeout(15_000),
    });
  } catch (err) {
    throw networkError(err, url, "DELETE", path, 15_000);
  }
  if (!res.ok) {
    const bodyText = await res.text().catch(() => "");
    throw hubError("DELETE", path, res.status, bodyText, undefined, cfg);
  }
  return res.json().catch(() => ({}));
}

/**
 * Create a typed HubRestClient from a resolved HubConfig.
 * Use this in new code and shared surfaces (e.g. Raycast) to get full
 * Hub Protocol coverage with a shared client contract — eliminating drift.
 */
export function makeHubClient(cfg: HubConfig): HubRestClient {
  return new HubRestClient({
    podUrl: cfg.podUrl,
    apiKey: cfg.apiKey,
    workspaceId: cfg.workspaceId,
  });
}

export { HubRestClient } from "@synap/hub-rest-client";
