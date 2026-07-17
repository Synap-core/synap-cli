/**
 * synap capability (alias `cap`) — the ONE capability-first root.
 *
 * A Capability is a named, installable PACK of what you (and your AI) can do
 * (e.g. "Google Workspace", "Discord Bot"). Tools = its connection; skills = its
 * verbs; templates = the catalog. The user only ever lists, adds, and enables a
 * PACK — never a bare tool or skill (CAPABILITIES-NORTH-STAR.md).
 *
 * A capability VERB is a runnable action backed by a skill (verbId = skill name).
 * `run` is the launcher: it parses arbitrary `--key value` flags into the skill's
 * `parameters` and POSTs to /capabilities/execute (the agnostic capability door).
 *
 * Subcommands: list, add, enable, connect, show, run, test
 */

import chalk from "chalk";
import ora from "ora";
import prompts from "prompts";
import { exec } from "child_process";
import { readFileSync } from "node:fs";
import { resolveHubConfig, hubGet, hubPost, hubDelete, HubError, renderHubError } from "../lib/hub-client.js";
import { unwrapList } from "../lib/unwrapList.js";
import { log } from "../utils/logger.js";

// ── Types ─────────────────────────────────────────────────────────────────────

type HubCfg = Awaited<ReturnType<typeof resolveHubConfig>>;

interface CapVerb {
  id: string;
  label: string;
  kind: string;
  granted?: boolean;
  effectiveExecMode?: string;
  govDefault?: string;
  argsSchema?: Record<string, unknown>;
}

interface Capability {
  kind: string;
  id: string;
  name: string;
  description?: string | null;
  governance?: "auto" | "propose";
  approved?: boolean;
  inputSchema?: Record<string, unknown>;
  verbs?: CapVerb[];
}

interface SkillRow {
  id: string;
  name: string;
  approved?: boolean;
  parameters?: unknown;
  kind?: string;
}

// The pack-grouped read-model from GET /capabilities/catalog (the spine).
type CardStatus =
  | "available"
  | "needs_connection"
  | "connected"
  | "draft"
  | "ready"
  | "partial"
  /** The pod can't offer this connection at all (provider not configured server-side). */
  | "unavailable";

interface CardVerb {
  verbId: string;
  skillId?: string | null;
  label: string;
  // Matches synap-backend's verbType() (capability-catalog.ts), which can emit
  // "action" (e.g. linkedin_send_invite) — NOT just read/write. Kept widened on
  // purpose so `v.type === "write"` looks type-safe but is WRONG (misses
  // "action"); every approval-gating site below deliberately uses `!== "read"`.
  type: "read" | "write" | "action";
  enabled: boolean;
  governance: "auto" | "propose";
  runnable: boolean;
  params?: string[];
}

interface CardConnection {
  required: boolean;
  kind: "provider" | "vault" | null;
  provider?: string;
  /**
   * `unavailable` = the pod itself can't offer this provider (not declared /
   * unreachable / misconfigured). NOT the user's fault, and NOT fixable by
   * running connect — never route it into an OAuth attempt.
   */
  state: "connected" | "missing" | "expired" | "unavailable";
  account?: string;
}

/** A template's INSTALL parameter — supplied to `apply` (e.g. a vault key). */
interface CardInstallParam {
  name: string;
  label?: string;
  type?: string;
  required?: boolean;
  description?: string;
  secret?: boolean;
}

interface CapabilityCard {
  id: string | null;
  key: string;
  name: string;
  description?: string | null;
  source: "installed" | "available";
  status: CardStatus;
  connection?: CardConnection;
  verbs: CardVerb[];
  /** Install params the caller must supply (vault key, baseUrl, …). May be absent on older pods. */
  installParams?: CardInstallParam[];
  nextAction: { kind: "add" | "connect" | "enable" | "run" | "none"; hint: string };
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * GET /capabilities requires a workspaceId (uuid) — resolve it the way tools.ts
 * does, and bail with a clear message when none is configured.
 */
function requireWorkspace(opts: { workspace?: string }, cfg: HubCfg): string {
  const workspaceId = opts.workspace ?? cfg.workspaceId;
  if (!workspaceId) {
    log.error("A workspace is required. Set one with `synap use <workspace>` or pass --workspace <id>.");
    process.exit(1);
  }
  return workspaceId;
}

async function fetchCapabilities(cfg: HubCfg, workspaceId: string): Promise<Capability[]> {
  const res = await hubGet("/capabilities", { workspaceId }, cfg);
  return unwrapList<Capability>(res, ["capabilities"]);
}

async function fetchSkills(cfg: HubCfg, workspaceId: string): Promise<SkillRow[]> {
  const res = await hubGet("/skills", { workspaceId }, cfg);
  return unwrapList<SkillRow>(res, ["skills"]);
}

/**
 * Resolve a verb/skill NAME (or label) to its skill UUID. A verb's `id` is the
 * backing skill's NAME, so name→id needs the skills list. Order: skill name →
 * verb label → skill-kind capability name.
 */
async function resolveSkillId(
  cfg: HubCfg,
  workspaceId: string,
  input: string
): Promise<string | undefined> {
  const [caps, skills] = await Promise.all([
    fetchCapabilities(cfg, workspaceId),
    fetchSkills(cfg, workspaceId),
  ]);
  const byName = new Map(skills.map((s) => [s.name, s.id]));

  // 1. Direct skill name (covers verb ids — a verb id IS a skill name).
  if (byName.has(input)) return byName.get(input);

  // 2. A verb's human label → its id (skill name) → skill row.
  for (const cap of caps) {
    for (const v of cap.verbs ?? []) {
      if (v.label === input) {
        const id = byName.get(v.id);
        if (id) return id;
      }
    }
  }

  // 3. A skill-kind capability matched by name — its id IS the skill uuid.
  const skillCap = caps.find((c) => c.kind === "skill" && c.name === input);
  if (skillCap) return skillCap.id;

  return undefined;
}

/**
 * Turn a variadic token array into a parameters object. Accepts both
 * `--key value` flags AND bare positional args. Positionals map onto the verb's
 * declared params (in declaration order), skipping any already set by a flag —
 * so `gmail_search enzo 5` ≡ `gmail_search --query enzo --maxResults 5`.
 * Values stay strings; the IS coerces them to the skill's declared types.
 */
function parseParams(
  tokens: string[],
  paramNames?: string[]
): Record<string, unknown> {
  const params: Record<string, unknown> = {};
  const positionals: string[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i];
    if (!tok.startsWith("--")) {
      positionals.push(tok);
      continue;
    }
    const key = tok.slice(2);
    const next = tokens[i + 1];
    if (next === undefined || next.startsWith("--")) {
      params[key] = true; // bare flag → boolean
    } else {
      params[key] = next;
      i++;
    }
  }
  // Fill the verb's still-unset params from positionals, in declared order.
  if (paramNames?.length && positionals.length) {
    const unset = paramNames.filter((n) => !(n in params));
    positionals.forEach((val, idx) => {
      if (idx < unset.length) params[unset[idx]] = val;
    });
  }
  return params;
}

/**
 * Bare positional tokens — those NOT consumed as a `--flag value` pair. Used to
 * decide whether `cap run` must resolve the verb's param names (a catalog
 * round-trip) at all: with only flags there's nothing to map, so skip it.
 */
function barePositionals(tokens: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i];
    if (!tok.startsWith("--")) {
      out.push(tok);
      continue;
    }
    const next = tokens[i + 1];
    if (next !== undefined && !next.startsWith("--")) i++; // skip the flag's value
  }
  return out;
}

// ── Catalog (the pack-grouped spine) ─────────────────────────────────────────

/**
 * GET /capabilities/catalog — one CapabilityCard per pack. Throws on transport
 * errors; the 404 ("endpoint not deployed yet") is surfaced by the caller.
 */
async function fetchCatalog(
  cfg: HubCfg,
  workspaceId: string,
  extraKey?: string
): Promise<CapabilityCard[]> {
  const res = await hubGet(
    "/capabilities/catalog",
    extraKey ? { workspaceId, extraKey } : { workspaceId },
    cfg
  );
  return unwrapList<CapabilityCard>(res, ["capabilities"]);
}

/** True when the thrown hub error is the "catalog door not deployed" 404. */
function isCatalogMissing(err: unknown): boolean {
  return err instanceof HubError && err.status === 404;
}

function catalogNeedsDeploy(): void {
  log.warn("This pod doesn't expose the capability catalog yet.");
  log.dim("`synap cap` needs the latest pod deploy (GET /capabilities/catalog).");
  log.dim("Update the pod, then retry — or use `synap tools list` in the meantime.");
}

/** Resolve a name/key (case-insensitive) to its catalog card. */
function findCard(cards: CapabilityCard[], name: string): CapabilityCard | undefined {
  const q = name.trim().toLowerCase();
  return (
    cards.find((c) => c.name.toLowerCase() === q) ??
    cards.find((c) => c.key.toLowerCase() === q)
  );
}

/** Status → badge glyph (●/◑/○) per §6. */
function statusBadge(status: CardStatus): string {
  switch (status) {
    case "ready":
    case "connected":
      return chalk.green("●");
    case "needs_connection":
    case "draft":
    case "partial":
      return chalk.yellow("◑");
    default:
      return chalk.dim("○");
  }
}

/** A one-line summary for the pack row (right of the name). */
function statusSummary(card: CapabilityCard): string {
  const n = card.verbs.length;
  switch (card.status) {
    case "ready":
    case "connected": {
      const acct = card.connection?.account ? `${card.connection.account} · ` : "";
      return `${acct}connected · ${n} verb${n === 1 ? "" : "s"}`;
    }
    case "needs_connection":
      return "needs connection";
    case "unavailable":
      // Not "needs connection" — connecting cannot fix it. The pod can't offer
      // this provider at all; the fix is server-side, not a user action.
      return "unavailable on this pod";
    case "partial":
      return `partial · ${n} verb${n === 1 ? "" : "s"}`;
    case "draft":
      return `${n} verb${n === 1 ? "" : "s"} · not enabled`;
    default:
      return "in catalog";
  }
}

/** Which display group a card belongs to. */
function statusGroup(
  card: CapabilityCard
): "usable" | "setup" | "available" | "unavailable" {
  if (card.status === "available") return "available";
  if (card.verbs.some((v) => v.runnable)) return "usable";
  // Never "setup": that heading promises a step, and for an unavailable pack
  // there is none — the pod can't offer the provider at all.
  if (card.status === "unavailable") return "unavailable";
  return "setup";
}

/** Strip un-interpolated template placeholders ({{name}}) for display. */
function cleanLabel(s: string): string {
  return s.replace(/\{\{[^}]+\}\}/g, "").replace(/\s+/g, " ").trim() || s;
}

/** The copy-pasteable run command for a verb, with its params as placeholders. */
function runCommand(v: CardVerb): string {
  const flags = (v.params ?? []).map((p) => `--${p} <${p}>`).join(" ");
  return `synap cap run ${v.verbId}${flags ? " " + flags : ""}`;
}

/** A USABLE pack: name + each runnable verb as a ready-to-run command. */
function renderUsable(card: CapabilityCard): void {
  const acct = card.connection?.account
    ? chalk.dim(` · ${card.connection.account}`)
    : card.connection?.provider
      ? chalk.dim(` · ${card.connection.provider} connected`)
      : "";
  console.log(`  ${chalk.green("●")} ${chalk.bold(card.name)}${acct}`);
  for (const v of card.verbs.filter((x) => x.runnable)) {
    const mark = v.type !== "read" ? chalk.yellow("✋") : chalk.green("▸");
    const note =
      v.type !== "read"
        ? chalk.yellow(" — asks approval")
        : chalk.dim(" — instant");
    console.log(`      ${mark} ${chalk.cyan(runCommand(v))}${note}`);
  }
  const off = card.verbs.filter((v) => !v.runnable);
  if (off.length > 0) {
    console.log(
      chalk.dim(
        `      ○ off: ${off.map((v) => cleanLabel(v.label)).join(", ")}  ` +
          `→ synap cap enable "${card.name}"`
      )
    );
  }
}

/** A SETUP pack: name + why + the single next action. */
function renderSetup(card: CapabilityCard): void {
  console.log(
    `  ${chalk.yellow("◌")} ${chalk.bold(card.name)}  ${chalk.dim(statusSummary(card))}`
  );
  console.log(
    `      ${chalk.cyan("→")} ${card.nextAction.hint || `synap cap enable "${card.name}"`}`
  );
}

/** An AVAILABLE pack: one line — name · what it offers · add command. */
function renderAvailable(card: CapabilityCard): void {
  const n = card.verbs.length;
  const offers = chalk.dim(
    n > 0 ? `${n} verb${n === 1 ? "" : "s"}` : "no verbs yet"
  );
  console.log(
    `  ${chalk.dim("○")} ${card.name}  ${offers}  ${chalk.dim(`→ synap cap add "${card.name}"`)}`
  );
}

/** Render a single card by whichever group it belongs to. */
function renderCardAny(card: CapabilityCard): void {
  const g = statusGroup(card);
  if (g === "usable") renderUsable(card);
  else if (g === "setup") renderSetup(card);
  else renderAvailable(card);
}

// ── Public: capabilityList ──────────────────────────────────────────────────

export interface CapListOpts {
  json?: boolean;
  workspace?: string;
}

export async function capabilityList(opts: CapListOpts): Promise<void> {
  let cfg: HubCfg;
  try {
    cfg = await resolveHubConfig();
  } catch (err) {
    log.error((err as Error).message);
    process.exit(1);
  }

  const workspaceId = requireWorkspace(opts, cfg);

  const spinner = opts.json ? null : ora({ text: "Fetching capabilities…", color: "cyan" }).start();

  let cards: CapabilityCard[];
  try {
    cards = await fetchCatalog(cfg, workspaceId);
    spinner?.stop();
  } catch (err) {
    spinner?.stop();
    if (isCatalogMissing(err)) {
      catalogNeedsDeploy();
      return;
    }
    spinner?.fail(chalk.red("Failed to fetch capabilities"));
    log.error((err as Error).message);
    process.exit(1);
  }

  if (opts.json) {
    console.log(JSON.stringify({ capabilities: cards }, null, 2));
    return;
  }

  if (cards.length === 0) {
    log.warn("No capabilities available in this workspace.");
    log.dim("Add one from the catalog:  synap cap add <name>");
    return;
  }

  const usable = cards.filter((c) => statusGroup(c) === "usable");
  const setup = cards.filter((c) => statusGroup(c) === "setup");
  const available = cards.filter((c) => statusGroup(c) === "available");
  const unavailable = cards.filter((c) => statusGroup(c) === "unavailable");

  log.heading(
    `Capabilities — ${usable.length} ready · ${setup.length} need a step · ${available.length} available` +
      (unavailable.length > 0 ? ` · ${unavailable.length} unavailable` : "")
  );

  if (usable.length > 0) {
    console.log();
    console.log(chalk.green.bold("  READY — run these now"));
    for (const card of usable) {
      console.log();
      renderUsable(card);
    }
  }

  if (setup.length > 0) {
    console.log();
    console.log(chalk.yellow.bold("  NEEDS A STEP"));
    for (const card of setup) renderSetup(card);
  }

  if (available.length > 0) {
    console.log();
    console.log(chalk.dim.bold("  AVAILABLE — add to install"));
    for (const card of available) renderAvailable(card);
  }

  // Last, and dim: nothing here is actionable, so it has the weakest claim on
  // attention. Never under "NEEDS A STEP" — that heading promises a step.
  if (unavailable.length > 0) {
    console.log();
    console.log(chalk.dim.bold("  NOT AVAILABLE HERE — this pod can't offer these"));
    for (const card of unavailable) renderSetup(card);
  }

  console.log();
  log.dim(
    "Details:  synap cap show <name>   ·   Run a verb:  synap cap run <verb> --<param> <value>"
  );
}

// ── Connection sub-flow (shared by enable + connect) ────────────────────────

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

function openBrowser(url: string): void {
  const platform = process.platform;
  const cmd =
    platform === "darwin"
      ? `open "${url}"`
      : platform === "win32"
        ? `start "" "${url}"`
        : `xdg-open "${url}"`;
  try {
    exec(cmd);
  } catch {
    // silently ignore — caller already prints the URL
  }
}

/** Short host label for a pod (for picker headers: "→ pod.perso…"). */
function podHostLabel(cfg: HubCfg): string {
  try {
    return new URL(cfg.podUrl).host;
  } catch {
    return cfg.podUrl;
  }
}

/**
 * Poll /connectors/connect until the provider flips to `connected` (the user
 * finished OAuth in the browser). Same self-completing door + bounded loop as
 * toolsConnect in tools.ts. Returns the connected response or null on timeout.
 */
async function pollUntilConnected(
  cfg: HubCfg,
  provider: string,
  workspaceId: string | undefined,
  timeoutMs = 180_000,
  intervalMs = 3_000
): Promise<Record<string, unknown> | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await sleep(intervalMs);
    try {
      const body: Record<string, unknown> = { provider };
      if (workspaceId) body.workspaceId = workspaceId;
      const res = (await hubPost("/connectors/connect", body, cfg)) as Record<string, unknown>;
      if (String(res.status) === "connected") return res;
    } catch {
      // transient — keep polling until the deadline
    }
  }
  return null;
}

/**
 * Ensure a capability's required connection is satisfied. Provider (nango://) →
 * OAuth open + poll. Vault (vault://) → prompt for the key, POST /vault/secrets.
 * Returns true when the connection is (now) satisfied, false otherwise.
 */
async function ensureConnection(
  cfg: HubCfg,
  workspaceId: string,
  card: CapabilityCard
): Promise<boolean> {
  const conn = card.connection;
  if (!conn || !conn.required || conn.state === "connected") return true;

  // NOTE: `state === "unavailable"` is deliberately NOT short-circuited here.
  // Resolving the door is not an OAuth attempt — it returns 200 with the pod's
  // own diagnosis (which of not_declared / unauthenticated / unreachable, and
  // the remedy). Only OPENING A BROWSER is doomed, and that is already guarded
  // below. Short-circuiting on the card's cached state costs the real message.

  // ── Vault credential — prompt + re-apply WITH params ──────────────────────
  // The correct wiring: apply the template with the credential as a param, so the
  // governed applier stores the secret AND links it into the connection tool's
  // credentialRef (pod-wide, for a pod-scoped cap). A bare /vault/secrets write
  // creates an orphan secret that is NOT linked to the tool — the old bug.
  if (conn.kind === "vault") {
    const hasParams = (card.installParams ?? []).some((p) => p.required);
    if (hasParams) {
      const collected = await collectInstallParams(card);
      if (!collected) return false;
      return applyTemplateWithParams(cfg, card, workspaceId, collected, "Connecting");
    }
    // Fallback (older pod without install-params on the card): store the secret
    // directly. May need manual linking if the tool's credentialRef doesn't match.
    const service = conn.provider ?? card.key;
    const answer = await prompts({
      type: "password",
      name: "value",
      message: `Paste the ${chalk.bold(card.name)} credential (${service})`,
    });
    const value = answer.value as string | undefined;
    if (!value) {
      log.dim("Cancelled — no credential entered.");
      return false;
    }
    const spinner = ora({ text: "Storing credential in the vault…", color: "cyan" }).start();
    try {
      await hubPost(
        "/vault/secrets",
        { name: `${card.name} credential`, value, service, type: "credential", workspaceId },
        cfg
      );
      spinner.succeed(chalk.green(`Stored ${chalk.bold(service)} credential.`));
      return true;
    } catch (err) {
      spinner.fail(chalk.red("Failed to store credential"));
      log.error((err as Error).message);
      return false;
    }
  }

  // ── Provider OAuth (nango://) — open + poll ───────────────────────────────
  const provider = conn.provider ?? card.key;
  const spinner = ora({ text: `Resolving ${chalk.bold(provider)} connection…`, color: "cyan" }).start();
  let res: Record<string, unknown>;
  try {
    res = (await hubPost("/connectors/connect", { provider, workspaceId }, cfg)) as Record<string, unknown>;
    spinner.stop();
  } catch (err) {
    spinner.fail(chalk.red("Failed to resolve connection"));
    log.error((err as Error).message);
    return false;
  }

  const status = String(res.status);
  if (status === "connected") {
    log.success(`${res.displayName ?? provider} is already connected.`);
    return true;
  }
  if (status === "provider_required") {
    log.warn(`Couldn't resolve a single provider for ${card.name}.`);
    log.dim(`Connect it directly:  synap cap connect "${card.name}"`);
    return false;
  }
  if (status === "provider_unavailable") {
    // The pod can't offer this provider (not declared / unreachable / malformed).
    // The server message already names the real cause + remedy — print it as-is.
    // No browser, and no "re-run connect": re-running cannot fix a server-side gap.
    log.warn(`${card.name} is unavailable on this pod.`);
    if (res.message) log.dim(String(res.message));
    return false;
  }

  // setup_required (or any status this CLI doesn't know) → only ever open a
  // browser when the server actually handed us a URL. An older/newer pod that
  // returns a status we don't handle must NOT send the user to "undefined".
  const redirectUrl = typeof res.redirectUrl === "string" && res.redirectUrl.length > 0 ? res.redirectUrl : null;
  if (!redirectUrl) {
    log.warn(`Couldn't start a connection for ${res.displayName ?? provider}.`);
    if (res.message) log.dim(String(res.message));
    else log.dim(`The pod returned status "${status}" with no connect URL. Check the pod's connector configuration.`);
    return false;
  }
  log.heading(`Connect ${res.displayName ?? provider}`);
  console.log();
  console.log(`  Opening OAuth flow in your browser…`);
  console.log(`  ${chalk.dim("If it didn't open, paste this URL:")}`);
  console.log(`  ${chalk.underline(chalk.cyan(redirectUrl))}`);
  console.log();
  openBrowser(redirectUrl);

  const waitSpinner = ora({ text: "Waiting for you to finish in the browser…", color: "cyan" }).start();
  const connected = await pollUntilConnected(cfg, provider, workspaceId);
  if (connected) {
    waitSpinner.succeed(chalk.green(`Connected ${chalk.bold(String(connected.displayName ?? provider))}!`));
    return true;
  }
  waitSpinner.stop();
  log.dim(`Didn't detect a connection yet — finish the browser flow, then re-run \`synap cap enable "${card.name}"\`.`);
  return false;
}

/**
 * Prompt for a template's REQUIRED install params (masked for secrets). Returns
 * the params map, or null if the user cancelled. Empty map when nothing required.
 */
async function collectInstallParams(
  card: CapabilityCard
): Promise<Record<string, unknown> | null> {
  const required = (card.installParams ?? []).filter((p) => p.required);
  const out: Record<string, unknown> = {};
  for (const p of required) {
    const answer = await prompts({
      type: p.secret ? "password" : "text",
      name: "value",
      message: p.label
        ? `${p.label}${p.secret ? "" : ""}`
        : `Enter ${p.name}`,
    });
    const value = answer.value as string | undefined;
    if (value === undefined || value === "") {
      log.dim("Cancelled — no value entered.");
      return null;
    }
    out[p.name] = value;
  }
  return out;
}

/** Shape of the bits of `/capabilities/apply`'s response this command reads. */
interface ApplyCapabilityResponse {
  created?: {
    tools?: { name: string; status: "created" | "proposed"; toolId: string | null }[];
  };
}

/**
 * Apply a template WITH its params through the governed applier — which creates
 * the vault secret AND wires it into the connection tool (pod-wide, for a
 * pod-scoped cap). This is the ONE correct way to attach a vault credential;
 * a post-hoc /vault/secrets write is NOT linked to the tool's credentialRef.
 *
 * Typing in a real credential here IS the user's explicit consent for that
 * connection to be used — so auto-approve any tool the applier just created
 * (status "created", not "proposed" — a proposed one still needs its own
 * review). Without this, the tool stays a silent, undiscoverable "draft" that
 * every run rejects with "Capability is not approved" even after `cap enable`
 * has approved its verbs — a real gap this dogfooded (fal.ai capability, 2026-07-12).
 */
async function applyTemplateWithParams(
  cfg: HubCfg,
  card: CapabilityCard,
  workspaceId: string,
  params: Record<string, unknown>,
  verb: "Adding" | "Connecting"
): Promise<boolean> {
  const spinner = ora({ text: `${verb} ${chalk.bold(card.name)}…`, color: "cyan" }).start();
  try {
    const res = (await hubPost(
      "/capabilities/apply",
      { templateKey: card.key, params, workspaceId },
      cfg
    )) as ApplyCapabilityResponse;
    const newlyCreatedTools = (res.created?.tools ?? []).filter(
      (t) => t.status === "created" && t.toolId
    );
    for (const t of newlyCreatedTools) {
      try {
        await hubPost(`/tools/${t.toolId}/approve`, { approved: true }, cfg);
      } catch (err) {
        // Non-fatal — the connection itself succeeded; surface so it isn't
        // silently stuck in the old "not approved" trap.
        log.warn(`Connected, but couldn't auto-approve tool "${t.name}": ${(err as Error).message}`);
        log.dim(`Approve it manually if runs fail with "Capability is not approved".`);
      }
    }
    spinner.succeed(chalk.green(`${verb === "Adding" ? "Added" : "Connected"} ${chalk.bold(card.name)}.`));
    return true;
  } catch (err) {
    spinner.fail(chalk.red(`Failed to ${verb.toLowerCase()} ${card.name}`));
    log.error((err as Error).message);
    return false;
  }
}

/**
 * Connect a RAW provider chosen from the discovery picker (not tied to a
 * capability card): start OAuth via `/connectors/connect`, open the browser, and
 * poll until it flips to connected. Same door + poll the card flow uses.
 */
async function connectProviderFlow(
  cfg: HubCfg,
  provider: string,
  displayName: string,
  workspaceId: string | undefined
): Promise<boolean> {
  const spinner = ora({ text: `Connecting ${chalk.bold(displayName)}…`, color: "cyan" }).start();
  let res: Record<string, unknown>;
  try {
    const body: Record<string, unknown> = { provider };
    if (workspaceId) body.workspaceId = workspaceId;
    res = (await hubPost("/connectors/connect", body, cfg)) as Record<string, unknown>;
    spinner.stop();
  } catch (err) {
    spinner.stop();
    renderHubError(err);
    return false;
  }

  if (String(res.status) === "connected") {
    log.success(`${res.displayName ?? displayName} is already connected.`);
    return true;
  }
  const redirectUrl =
    typeof res.redirectUrl === "string" && res.redirectUrl.length > 0 ? res.redirectUrl : null;
  if (!redirectUrl) {
    log.warn(`Couldn't start a connection for ${displayName}.`);
    // Covers provider_unavailable too — the server message names the real cause.
    if (res.message) log.dim(String(res.message));
    return false;
  }
  log.heading(`Connect ${displayName}`);
  console.log();
  console.log(`  Opening OAuth flow in your browser…`);
  console.log(`  ${chalk.dim("If it didn't open, paste this URL:")}`);
  console.log(`  ${chalk.underline(chalk.cyan(redirectUrl))}`);
  console.log();
  openBrowser(redirectUrl);

  const waitSpinner = ora({ text: "Waiting for you to finish in the browser…", color: "cyan" }).start();
  const connected = await pollUntilConnected(cfg, provider, workspaceId);
  if (connected) {
    waitSpinner.succeed(chalk.green(`Connected ${chalk.bold(displayName)}!`));
    return true;
  }
  waitSpinner.stop();
  log.dim(`Didn't detect a connection yet — finish the browser flow, then re-run.`);
  return false;
}

// ── Public: capabilityAdd ────────────────────────────────────────────────────

export interface CapAddOpts {
  workspace?: string;
}

export async function capabilityAdd(
  name: string | undefined,
  opts: CapAddOpts
): Promise<void> {
  let cfg: HubCfg;
  try {
    cfg = await resolveHubConfig();
  } catch (err) {
    log.error((err as Error).message);
    process.exit(1);
  }

  const workspaceId = requireWorkspace(opts, cfg);

  const spinner = ora({
    text: name ? `Resolving ${chalk.bold(name)}…` : "Fetching catalog…",
    color: "cyan",
  }).start();
  let cards: CapabilityCard[];
  try {
    cards = await fetchCatalog(cfg, workspaceId);
    spinner.stop();
  } catch (err) {
    spinner.stop();
    if (isCatalogMissing(err)) {
      catalogNeedsDeploy();
      return;
    }
    spinner.fail(chalk.red("Failed to fetch catalog"));
    log.error((err as Error).message);
    process.exit(1);
  }

  // No name given → open an interactive picker over the AVAILABLE (not-yet-
  // installed) catalog, so the user can browse + choose instead of having to
  // know the exact name. A name still resolves directly (scripts, muscle memory).
  let card: CapabilityCard | undefined;
  if (!name || !name.trim()) {
    // Hide the generic demo connector — it's a template-shape DEMONSTRATION, not a
    // real service — from the browse list. It stays installable by name for experts.
    const available = cards.filter(
      (c) => statusGroup(c) === "available" && c.key !== "generic-apikey"
    );
    const installed = cards.filter((c) => c.source === "installed");

    if (available.length === 0) {
      // available=0 can mean "all installed" OR "the pod's marketplace catalog is
      // empty" (e.g. CONTROL_PLANE_URL unset → nothing ever synced). Don't claim
      // everything is installed — say what's true and hint at the catalog.
      log.heading("No capabilities available to add on this pod.");
      if (installed.length > 0) {
        log.dim("Installed here:");
        for (const c of installed) log.dim(`  ${chalk.green("✓")} ${c.name}`);
      }
      log.dim(
        "If you expected a catalog, this pod's marketplace sync may not be configured yet."
      );
      log.dim("See what you have:  synap cap list");
      return;
    }

    const answer = await prompts({
      type: "select",
      name: "key",
      // Header shows which pod we're adding to (respects --pod; else active pod).
      message: `Add a capability ${chalk.dim(`→ ${podHostLabel(cfg)}`)}`,
      choices: [
        ...available.map((c) => ({
          title: c.name,
          description:
            (c.description ? `${c.description.slice(0, 64)} · ` : "") +
            `${c.verbs.length} verb${c.verbs.length === 1 ? "" : "s"}`,
          value: c.key,
        })),
        // Already-installed capabilities, shown (disabled) at the end so you can
        // see what you already have without them cluttering the choices.
        ...installed.map((c) => ({
          title: `${c.name} ${chalk.green("✓ installed")}`,
          description: "already added",
          value: c.key,
          disabled: true,
        })),
      ],
    });
    if (!answer.key) {
      log.dim("Cancelled.");
      return;
    }
    card = available.find((c) => c.key === answer.key);
    if (!card) {
      log.dim("That one's already installed.");
      return;
    }
  } else {
    card = findCard(cards, name);
    // Not in the default catalog — it may still be a real, installable
    // template that's just excluded from the default sync (e.g. a paid
    // third-party connector like Unipile). One extra lookup by the exact
    // name before giving up.
    if (!card) {
      const augmented = await fetchCatalog(cfg, workspaceId, name).catch(
        () => cards
      );
      card = findCard(augmented, name);
    }
  }

  if (!card) {
    log.error(`No capability named "${name}" in the catalog.`);
    log.dim("Run `synap cap list` to see what's available.");
    process.exit(1);
  }

  if (card.source === "installed") {
    log.heading(`${card.name} is already installed`);
    renderCardAny(card);
    console.log();
    log.dim("Bad or expired credential? Fix it in place — no need to remove/re-add:");
    log.dim(`  synap cap connections list "${card.name}"`);
    log.dim(`  synap cap connections update "${card.name}" <id> --rotate`);
    return;
  }

  // A template with REQUIRED install params (a vault-generic connector needs its
  // key) must be applied WITH them — the applier stores the secret AND wires it
  // into the connection tool. Prompt (masked for secrets) before applying.
  const requiredParams = (card.installParams ?? []).filter((p) => p.required);
  let params: Record<string, unknown> = {};
  if (requiredParams.length > 0) {
    log.dim(`${card.name} needs a credential to connect.`);
    const collected = await collectInstallParams(card);
    if (!collected) return; // cancelled
    params = collected;
    const ok = await applyTemplateWithParams(cfg, card, workspaceId, params, "Adding");
    if (!ok) process.exit(1);
  } else {
    const addSpinner = ora({ text: `Adding ${chalk.bold(card.name)}…`, color: "cyan" }).start();
    try {
      await hubPost("/capabilities/apply", { templateKey: card.key, workspaceId }, cfg);
      addSpinner.succeed(chalk.green(`Added ${chalk.bold(card.name)}.`));
    } catch (err) {
      addSpinner.fail(chalk.red(`Failed to add ${card.name}`));
      log.error((err as Error).message);
      process.exit(1);
    }
  }

  // Re-fetch to show the resulting (installed) status.
  try {
    const after = findCard(await fetchCatalog(cfg, workspaceId), card.name);
    if (after) {
      console.log();
      renderCardAny(after);
    }
  } catch {
    // best-effort — the add already succeeded
  }
  console.log();
  log.dim(`Turn it on:  synap cap enable "${card.name}"`);
}

// ── Public: capabilityEnable (the orchestrator) ──────────────────────────────

export interface CapEnableOpts {
  workspace?: string;
}

export async function capabilityEnable(
  name: string | undefined,
  opts: CapEnableOpts
): Promise<void> {
  let cfg: HubCfg;
  try {
    cfg = await resolveHubConfig();
  } catch (err) {
    log.error((err as Error).message);
    process.exit(1);
  }

  const workspaceId = requireWorkspace(opts, cfg);

  // No name → discovery picker: list the capabilities and let the user choose the
  // one to enable (better UX + discoverability than erroring on a missing arg).
  // `cap enable <name>` still targets a specific one.
  if (!name || !name.trim()) {
    const spin = ora({ text: "Fetching capabilities…", color: "cyan" }).start();
    let cards: CapabilityCard[];
    try {
      cards = await fetchCatalog(cfg, workspaceId);
      spin.stop();
    } catch (err) {
      spin.stop();
      if (isCatalogMissing(err)) {
        catalogNeedsDeploy();
        return;
      }
      log.error((err as Error).message);
      process.exit(1);
    }
    if (cards.length === 0) {
      log.warn("No capabilities available on this pod.");
      log.dim("Deploy the Control Plane catalog, then retry.");
      return;
    }
    const statusLabel = (c: CapabilityCard): string => {
      switch (c.status) {
        case "ready":
          return chalk.green("✓ on");
        case "partial":
          return chalk.yellow("partially on");
        case "needs_connection":
          return chalk.yellow("needs connection");
        case "connected":
          return chalk.cyan("connected · pick verbs");
        case "draft":
          return chalk.dim("draft");
        case "available":
          return chalk.dim("not installed");
        default:
          return "";
      }
    };
    // Actionable (not fully on) first; already-on ones last — a re-enable still
    // lets you adjust which verbs are active, so keep them selectable.
    const ordered = [...cards].sort(
      (a, b) => (a.status === "ready" ? 1 : 0) - (b.status === "ready" ? 1 : 0)
    );
    const answer = await prompts({
      type: "select",
      name: "name",
      message: `Enable a capability ${chalk.dim(`→ ${podHostLabel(cfg)}`)}`,
      choices: ordered.map((c) => ({
        title: `${c.name}  ${statusLabel(c)}`,
        description: c.description ?? undefined,
        value: c.name,
      })),
    });
    if (!answer.name) {
      log.dim("Cancelled.");
      return;
    }
    name = answer.name as string;
  }

  const spinner = ora({ text: `Resolving ${chalk.bold(name)}…`, color: "cyan" }).start();
  let card: CapabilityCard | undefined;
  try {
    card = findCard(await fetchCatalog(cfg, workspaceId), name);
    spinner.stop();
  } catch (err) {
    spinner.stop();
    if (isCatalogMissing(err)) {
      catalogNeedsDeploy();
      return;
    }
    spinner.fail(chalk.red("Failed to fetch catalog"));
    log.error((err as Error).message);
    process.exit(1);
  }

  if (!card) {
    log.error(`No capability named "${name}".`);
    log.dim("Run `synap cap list` to see what's available, or `synap cap add <name>` first.");
    process.exit(1);
  }

  // Not installed yet — add it first so it has verbs to enable.
  if (card.source === "available") {
    log.dim(`${card.name} isn't installed yet — adding it first…`);
    await capabilityAdd(name, opts);
    card = findCard(await fetchCatalog(cfg, workspaceId), name);
    if (!card) return;
  }

  // (a) Ensure the connection FIRST when one is required and missing.
  if (card.connection?.required && card.connection.state !== "connected") {
    const ok = await ensureConnection(cfg, workspaceId, card);
    if (!ok) return;
    // Re-fetch so verb runnability reflects the new connection.
    const after = findCard(await fetchCatalog(cfg, workspaceId), name);
    if (after) card = after;
  }

  if (card.verbs.length === 0) {
    log.heading(`${card.name} is on`);
    log.dim("This capability has no selectable verbs yet.");
    return;
  }

  // (b) Verb selection — reads pre-checked, writes unchecked; enabled stay checked.
  const response = await prompts({
    type: "multiselect",
    name: "verbs",
    message: `Select what ${chalk.bold(card.name)} can do`,
    instructions: false,
    hint: "↑/↓ move · space toggle · enter confirm",
    choices: card.verbs.map((v) => ({
      title:
        v.type !== "read"
          ? `${v.label} (asks approval each run)`
          : `${v.label} (read)`,
      value: v.verbId,
      selected: v.enabled || v.type === "read",
    })),
  });

  // prompts returns undefined on ctrl-c.
  if (response.verbs === undefined) {
    log.dim("Cancelled.");
    return;
  }
  const selected = new Set(response.verbs as string[]);

  // (c) Approve newly-selected verbs; disable previously-enabled ones now unchecked
  //     (so `enable` doubles as edit/heal). The explicit confirm IS the gate.
  const toEnable = card.verbs.filter((v) => selected.has(v.verbId) && !v.enabled);
  const toDisable = card.verbs.filter((v) => !selected.has(v.verbId) && v.enabled);

  if (toEnable.length === 0 && toDisable.length === 0) {
    log.success(`Nothing changed — ${card.name} is already set up that way.`);
    return;
  }

  const work = ora({ text: "Applying your selection…", color: "cyan" }).start();
  const enabledNames: string[] = [];
  const disabledNames: string[] = [];
  try {
    // The catalog card already carries each verb's skillId — use it directly so we
    // never touch the slow GET /skills. Resolve by name only as a fallback (older
    // pods without skillId in the catalog) — and then fetch /skills ONCE, not per
    // verb (per-verb resolution made `enable` look like it hangs).
    const needsLookup = [...toEnable, ...toDisable].some((v) => !v.skillId);
    const idByName = needsLookup
      ? new Map(
          (await fetchSkills(cfg, workspaceId)).map((s) => [s.name, s.id])
        )
      : new Map<string, string>();
    const resolve = (v: CardVerb) => v.skillId ?? idByName.get(v.verbId);

    for (const v of toEnable) {
      const skillId = resolve(v);
      if (!skillId) continue;
      await hubPost(`/skills/${skillId}/approve`, { approved: true }, cfg);
      enabledNames.push(v.label);
    }
    for (const v of toDisable) {
      const skillId = resolve(v);
      if (!skillId) continue;
      await hubPost(`/skills/${skillId}/approve`, { approved: false }, cfg);
      disabledNames.push(v.label);
    }
    work.stop();
  } catch (err) {
    work.fail(chalk.red("Failed while applying your selection"));
    log.error((err as Error).message);
    process.exit(1);
  }

  // (d) Report what changed + an example run.
  if (enabledNames.length > 0) {
    log.success(`Enabled ${enabledNames.length} verb${enabledNames.length === 1 ? "" : "s"}: ${enabledNames.join(", ")}`);
  }
  if (disabledNames.length > 0) {
    log.dim(`Turned off: ${disabledNames.join(", ")}`);
  }
  const example = toEnable[0] ?? card.verbs.find((v) => selected.has(v.verbId));
  if (example) {
    log.dim(`Run it:  synap cap run ${example.verbId} --<param> <value>`);
  }
}

// ── Public: capabilityConnect (connection sub-flow only) ─────────────────────

export interface CapConnectOpts {
  workspace?: string;
}

export async function capabilityConnect(
  name: string | undefined,
  opts: CapConnectOpts
): Promise<void> {
  let cfg: HubCfg;
  try {
    cfg = await resolveHubConfig();
  } catch (err) {
    log.error((err as Error).message);
    process.exit(1);
  }

  const workspaceId = requireWorkspace(opts, cfg);

  // No name → discovery picker: list connectable services (Nango providers) with
  // their status, pick one, run the OAuth flow. `connect <name>` still connects a
  // specific capability's provider.
  if (!name || !name.trim()) {
    const spin = ora({ text: "Fetching connectable services…", color: "cyan" }).start();
    let providers: Array<{ id: string; provider: string; displayName?: string; connected: boolean }>;
    try {
      const res = (await hubGet("/connectors/providers", {}, cfg)) as {
        providers?: typeof providers;
      };
      providers = res.providers ?? [];
      spin.stop();
    } catch (err) {
      spin.stop();
      log.error((err as Error).message);
      log.dim("Nango may not be configured on this pod.");
      return;
    }
    if (providers.length === 0) {
      log.warn("No connectable services available on this pod.");
      log.dim("Nango may not be configured on this pod.");
      return;
    }
    const connectable = providers.filter((p) => !p.connected);
    const connected = providers.filter((p) => p.connected);
    if (connectable.length === 0) {
      log.heading("Everything connectable here is already connected.");
      for (const p of connected) log.dim(`  ${chalk.green("✓")} ${p.displayName ?? p.provider}`);
      return;
    }
    const answer = await prompts({
      type: "select",
      name: "id",
      message: `Connect a service ${chalk.dim(`→ ${podHostLabel(cfg)}`)}`,
      // Connectable first; already-connected (disabled) grouped at the end —
      // mirrors the `cap add` picker so the disabled rows don't scatter.
      choices: [
        ...connectable.map((p) => ({
          title: p.displayName ?? p.provider,
          value: p.id,
        })),
        ...connected.map((p) => ({
          title: `${p.displayName ?? p.provider} ${chalk.green("✓ connected")}`,
          description: "already connected",
          value: p.id,
          disabled: true,
        })),
      ],
    });
    if (!answer.id) {
      log.dim("Cancelled.");
      return;
    }
    const chosen = providers.find((p) => p.id === answer.id)!;
    const ok = await connectProviderFlow(
      cfg,
      chosen.id,
      chosen.displayName ?? chosen.provider,
      workspaceId
    );
    // A connect that did not connect must not report success to a caller/script.
    if (!ok) process.exit(1);
    return;
  }

  const spinner = ora({ text: `Resolving ${chalk.bold(name)}…`, color: "cyan" }).start();
  let card: CapabilityCard | undefined;
  try {
    card = findCard(await fetchCatalog(cfg, workspaceId), name);
    spinner.stop();
  } catch (err) {
    spinner.stop();
    if (isCatalogMissing(err)) {
      catalogNeedsDeploy();
      return;
    }
    spinner.fail(chalk.red("Failed to fetch catalog"));
    log.error((err as Error).message);
    process.exit(1);
  }

  if (!card) {
    log.error(`No capability named "${name}".`);
    log.dim("Run `synap cap list` to see what's available.");
    process.exit(1);
  }

  if (!card.connection?.required) {
    log.heading(`${card.name} needs no connection`);
    log.dim(`Enable its verbs:  synap cap enable "${card.name}"`);
    return;
  }

  const ok = await ensureConnection(cfg, workspaceId, card);
  if (!ok) process.exit(1);
  log.dim(`Now enable its verbs:  synap cap enable "${card.name}"`);
}

// ── Public: capabilityDisconnect ─────────────────────────────────────────────

export interface CapDisconnectOpts {
  workspace?: string;
  force?: boolean;
}

interface ConnectorProviderRow {
  id: string;
  provider: string;
  displayName?: string;
  connected: boolean;
  connectionId?: string;
}

async function fetchConnectorProviders(
  cfg: HubCfg,
  workspaceId?: string
): Promise<ConnectorProviderRow[]> {
  const params: Record<string, string> = {};
  if (workspaceId) params.workspaceId = workspaceId;
  const res = (await hubGet("/connectors/providers", params, cfg)) as {
    providers?: ConnectorProviderRow[];
  };
  return res.providers ?? [];
}

/**
 * Undo `cap connect`. Accepts a capability name/key OR a raw provider id — the
 * deprecated `tools disconnect <provider>` forwards here and must keep working
 * with the provider ids it has always taken.
 */
export async function capabilityDisconnect(
  name: string,
  opts: CapDisconnectOpts
): Promise<void> {
  let cfg: HubCfg;
  try {
    cfg = await resolveHubConfig();
  } catch (err) {
    log.error((err as Error).message);
    process.exit(1);
  }

  const workspaceId = requireWorkspace(opts, cfg);

  const spinner = ora({ text: `Resolving ${chalk.bold(name)}…`, color: "cyan" }).start();
  let card: CapabilityCard | undefined;
  try {
    card = findCard(await fetchCatalog(cfg, workspaceId), name);
    spinner.stop();
  } catch (err) {
    spinner.stop();
    if (isCatalogMissing(err)) {
      catalogNeedsDeploy();
      return;
    }
    spinner.fail(chalk.red("Failed to fetch catalog"));
    renderHubError(err);
    process.exit(1);
  }

  // Resolve the provider to disconnect. No card → `name` is a raw provider id.
  let provider = name;
  if (card) {
    if (!card.connection?.required) {
      log.heading(`${card.name} has no connection to disconnect`);
      log.dim(`Turn its verbs off instead:  synap cap enable "${card.name}"`);
      return;
    }
    if (card.connection.kind === "vault") {
      // A stored credential, not an OAuth connection — the provider door would
      // not touch it. Point at the door that owns vault-backed connections.
      log.warn(`${card.name} uses a stored credential, not a provider connection.`);
      log.dim(`See it:     synap cap connections list "${card.name}"`);
      log.dim(`Remove it:  synap cap connections rm "${card.name}" <id>`);
      return;
    }
    provider = card.connection.provider ?? card.key;
  }

  const label = card?.name ?? provider;

  let connectionId: string | undefined;
  try {
    const providers = await fetchConnectorProviders(cfg, workspaceId);
    const match = providers.find(
      (p) =>
        p.provider === provider ||
        p.id === provider ||
        (p.displayName ?? "").toLowerCase() === provider.toLowerCase()
    );
    if (!match || !match.connected) {
      log.error(`${chalk.bold(label)} is not connected.`);
      process.exit(1);
    }
    connectionId = match.connectionId;
  } catch (err) {
    renderHubError(err);
    process.exit(1);
  }

  if (!opts.force) {
    const response = await prompts({
      type: "confirm",
      name: "confirmed",
      message: `Disconnect ${label}? This will stop syncing but won't delete imported entities.`,
      initial: false,
    });
    if (!response.confirmed) {
      log.dim("Cancelled.");
      return;
    }
  }

  const work = ora({ text: `Disconnecting ${label}…`, color: "cyan" }).start();
  try {
    await hubPost("/connectors/disconnect", { connectionId, provider }, cfg);
    work.succeed(
      chalk.green(`Disconnected ${chalk.bold(label)}. Your imported entities remain intact.`)
    );
  } catch (err) {
    work.fail(chalk.red(`Failed to disconnect ${label}`));
    renderHubError(err);
    process.exit(1);
  }
}

// ── Public: capabilityShow ───────────────────────────────────────────────────

export interface CapShowOpts {
  json?: boolean;
  workspace?: string;
}

export async function capabilityShow(name: string, opts: CapShowOpts): Promise<void> {
  let cfg: HubCfg;
  try {
    cfg = await resolveHubConfig();
  } catch (err) {
    log.error((err as Error).message);
    process.exit(1);
  }

  const workspaceId = requireWorkspace(opts, cfg);

  const spinner = opts.json ? null : ora({ text: `Fetching ${chalk.bold(name)}…`, color: "cyan" }).start();
  let card: CapabilityCard | undefined;
  try {
    card = findCard(await fetchCatalog(cfg, workspaceId), name);
    spinner?.stop();
  } catch (err) {
    spinner?.stop();
    if (isCatalogMissing(err)) {
      catalogNeedsDeploy();
      return;
    }
    spinner?.fail(chalk.red("Failed to fetch catalog"));
    log.error((err as Error).message);
    process.exit(1);
  }

  if (!card) {
    log.error(`No capability named "${name}".`);
    log.dim("Run `synap cap list` to see what's available.");
    process.exit(1);
  }

  if (opts.json) {
    console.log(JSON.stringify(card, null, 2));
    return;
  }

  log.heading(`${statusBadge(card.status)}  ${card.name}  ${chalk.dim(`[${card.status}]`)}`);
  if (card.description) log.dim(card.description);
  console.log();

  // Connection
  if (card.connection?.required) {
    const c = card.connection;
    // `unavailable` is dim, not red: it isn't the user's fault and isn't fixable
    // by connecting — red reads as "you have a missing credential to go fix".
    const stateColor =
      c.state === "connected"
        ? chalk.green
        : c.state === "expired"
          ? chalk.yellow
          : c.state === "unavailable"
            ? chalk.dim
            : chalk.red;
    const parts = [
      c.kind ?? "connection",
      c.provider ? chalk.dim(`(${c.provider})`) : "",
      c.account ? chalk.dim(c.account) : "",
      stateColor(c.state),
    ].filter(Boolean);
    console.log(`  ${chalk.bold("Connection")}  ${parts.join(" ")}`);
  } else {
    console.log(`  ${chalk.bold("Connection")}  ${chalk.dim("none required")}`);
  }
  console.log();

  // Verbs
  console.log(`  ${chalk.bold("Verbs")} (${card.verbs.length})`);
  for (const v of card.verbs) {
    const mark = v.runnable
      ? chalk.green("▸")
      : v.enabled
        ? chalk.yellow("◑")
        : chalk.dim("·");
    const kind =
      v.type !== "read" ? chalk.dim("asks approval") : chalk.dim("read");
    console.log(`    ${mark} ${chalk.bold(cleanLabel(v.label))}  ${kind}`);
    // For a runnable verb, show the exact command; otherwise show what unblocks it.
    if (v.runnable) {
      console.log(`        ${chalk.cyan(runCommand(v))}`);
    } else {
      console.log(
        chalk.dim(
          `        ${v.enabled ? "needs the connection" : "draft — enable this capability first"}`
        )
      );
    }
  }
  console.log();

  if (card.nextAction.hint) {
    log.dim(`Next:  ${card.nextAction.hint}`);
  }
}

// ── Public: capabilityRun (the launcher) ────────────────────────────────────

export interface CapRunOpts {
  workspace?: string;
  connection?: string;
  for?: string;
}

export async function capabilityRun(
  verb: string,
  params: string[],
  opts: CapRunOpts
): Promise<void> {
  let cfg: HubCfg;
  try {
    cfg = await resolveHubConfig();
  } catch (err) {
    log.error((err as Error).message);
    process.exit(1);
  }

  const workspaceId = requireWorkspace(opts, cfg);

  // Resolve the verb's declared param names ONLY when positional args are
  // present (so the common `--flag value` form pays no extra round-trip). Lets
  // `cap run gmail_search enzo 5` map onto query/maxResults positionally.
  let paramNames: string[] | undefined;
  if (barePositionals(params).length > 0) {
    try {
      const cards = await fetchCatalog(cfg, workspaceId);
      paramNames = cards
        .flatMap((c) => c.verbs)
        .find((v) => v.verbId === verb)?.params;
    } catch {
      // Catalog unavailable (e.g. 404 on an older pod) — fall back to flags-only.
    }
  }
  const parameters = parseParams(params, paramNames);

  const spinner = ora({ text: `Running ${chalk.bold(verb)}…`, color: "cyan" }).start();

  let res: Record<string, unknown>;
  try {
    res = (await hubPost(
      "/capabilities/execute",
      {
        verbId: verb,
        parameters,
        workspaceId,
        connectionSelector:
          opts.connection || opts.for
            ? { connectionId: opts.connection, contextObjectId: opts.for }
            : undefined,
      },
      cfg,
      90_000 // provider-backed skills run several external calls — give them room
    )) as Record<string, unknown>;
    spinner.stop();
  } catch (err) {
    spinner.stop();
    if (err instanceof HubError && err.status === 404) {
      log.error(`Capability not found: ${chalk.bold(verb)}`);
      log.dim("Run `synap capability list` to see available verbs.");
      process.exit(1);
    }
    if (err instanceof HubError && err.status === 403) {
      log.error(`Refused: ${chalk.bold(verb)} is not runnable yet.`);
      log.dim(`Enable it first:  synap capability enable ${verb}`);
      process.exit(1);
    }
    renderHubError(err);
    process.exit(1);
  }

  // 202 → a reviewable proposal was created instead of running.
  if (res.proposed === true) {
    const proposalId = String(res.proposalId);
    log.heading(`⏳ Queued for approval`);
    log.dim(`Verb: ${verb}`);
    if (Object.keys(parameters).length > 0) {
      for (const [key, value] of Object.entries(parameters)) {
        log.dim(`  ${key}: ${typeof value === "string" ? value : JSON.stringify(value)}`);
      }
    }
    console.log();
    log.dim(`Approve:  synap proposals approve ${proposalId}`);
    log.dim(`Reject:   synap proposals reject ${proposalId}`);
    log.dim(`(Approving prints the actual outcome — success + returned data, or the exact failure reason.)`);
    return;
  }

  // 200 → ran (or dry-run preview).
  log.success(`${chalk.bold(verb)} ran.`);
  if (res.result !== undefined) {
    console.log();
    console.log(JSON.stringify(res.result, null, 2));
  }
}

// ── Public: capabilityTest (dry-run preview) ────────────────────────────────

export interface CapTestOpts {
  workspace?: string;
}

export async function capabilityTest(verb: string, opts: CapTestOpts): Promise<void> {
  let cfg: HubCfg;
  try {
    cfg = await resolveHubConfig();
  } catch (err) {
    log.error((err as Error).message);
    process.exit(1);
  }

  const workspaceId = requireWorkspace(opts, cfg);

  const spinner = ora({ text: `Resolving ${chalk.bold(verb)}…`, color: "cyan" }).start();

  let skillId: string | undefined;
  try {
    skillId = await resolveSkillId(cfg, workspaceId, verb);
  } catch (err) {
    spinner.fail(chalk.red("Failed to resolve capability"));
    log.error((err as Error).message);
    process.exit(1);
  }

  if (!skillId) {
    spinner.fail(chalk.red(`No skill found for "${verb}"`));
    log.dim("Run `synap capability list` to see available verbs and skills.");
    process.exit(1);
  }

  spinner.text = `Dry-running ${chalk.bold(verb)}…`;
  let res: Record<string, unknown>;
  try {
    res = (await hubPost(`/skills/${skillId}/dry-run`, {}, cfg)) as Record<string, unknown>;
    spinner.stop();
  } catch (err) {
    spinner.fail(chalk.red(`Dry-run failed for ${verb}`));
    log.error((err as Error).message);
    process.exit(1);
  }

  log.heading(`Dry-run preview — ${chalk.bold(verb)}`);
  if (res.result !== undefined) {
    console.log();
    console.log(JSON.stringify(res.result, null, 2));
  }
  const effects = (res.dryRunEffects ?? []) as unknown[];
  console.log();
  log.dim(`Intended side effects: ${effects.length}`);
  if (effects.length > 0) {
    console.log(JSON.stringify(effects, null, 2));
  }
}

// ── Public: capabilityCreate (author a pack from a JSON definition) ──────────

export interface CapCreateOpts {
  workspace?: string;
}

/** Read the definition JSON from a file path, or from stdin when none is given. */
async function readDefinitionInput(file?: string): Promise<string> {
  if (file) return readFileSync(file, "utf-8");
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf-8");
}

/**
 * Create a full capability from a CapabilityDefinition JSON — a file path OR
 * piped stdin text. The same `definition` door `POST /capabilities/apply`
 * accepts, so an authored pack lands with its tools + skills (+ container) just
 * like a catalog template. The shape mirrors templates/capabilities/*.json.
 */
export async function capabilityCreate(
  file: string | undefined,
  opts: CapCreateOpts
): Promise<void> {
  let cfg: HubCfg;
  try {
    cfg = await resolveHubConfig();
  } catch (err) {
    log.error((err as Error).message);
    process.exit(1);
  }
  const workspaceId = requireWorkspace(opts, cfg);

  let raw: string;
  try {
    raw = (await readDefinitionInput(file)).trim();
  } catch (err) {
    log.error(
      `Could not read ${file ? `file ${file}` : "stdin"}: ${(err as Error).message}`
    );
    process.exit(1);
  }
  if (!raw) {
    log.error("No definition provided. Pass a JSON file path or pipe JSON via stdin.");
    log.dim("e.g.  synap cap create ./my-capability.json");
    process.exit(1);
  }

  let definition: Record<string, unknown>;
  try {
    definition = JSON.parse(raw) as Record<string, unknown>;
  } catch (err) {
    log.error(`Invalid JSON: ${(err as Error).message}`);
    process.exit(1);
  }

  // Minimal CapabilityDefinition shape — fail early with a helpful message.
  if (
    typeof definition.key !== "string" ||
    typeof definition.name !== "string" ||
    !Array.isArray(definition.tools) ||
    !Array.isArray(definition.skills)
  ) {
    log.error(
      "Not a capability definition. Expected JSON with: key (string), name (string), tools[], skills[]."
    );
    log.dim("See templates/capabilities/*.capability.json for the shape.");
    process.exit(1);
  }

  const name = String(definition.name);
  const spinner = ora({ text: `Creating ${chalk.bold(name)}…`, color: "cyan" }).start();
  let res: Record<string, unknown>;
  try {
    res = (await hubPost(
      "/capabilities/apply",
      { definition, workspaceId },
      cfg
    )) as Record<string, unknown>;
    spinner.stop();
  } catch (err) {
    spinner.fail(chalk.red("Failed to create capability"));
    log.error((err as Error).message);
    process.exit(1);
  }

  const created = (res.created ?? {}) as Record<string, unknown>;
  const tools = (created.tools ?? []) as unknown[];
  const skills = (created.skills ?? []) as unknown[];
  log.success(
    `Created ${chalk.bold(name)} — ${tools.length} tool${tools.length === 1 ? "" : "s"}, ${skills.length} skill${skills.length === 1 ? "" : "s"}.`
  );
  const proposals = (res.proposals ?? []) as unknown[];
  if (proposals.length > 0) {
    log.dim(`${proposals.length} part(s) await approval (proposals).`);
  }
  log.dim(`Enable it:  synap cap enable "${name}"`);
}

// ── rm ──────────────────────────────────────────────────────────────────────

interface CapRemoveOpts {
  podUrl?: string;
  apiKey?: string;
  workspace?: string;
  force?: boolean;
}

/**
 * synap cap rm <id-or-name...> — delete one or more capability CONTAINERS.
 *
 * Removes the container + its member_of links only — the underlying tools and
 * skills are untouched (they may belong to other capabilities). Use this to
 * clean up stale or duplicate containers (e.g. workspace-scoped leftovers from
 * an older seed). Accepts either a raw container id (from `synap cap list
 * --json`) or the capability's display name/key (resolved against the
 * installed catalog, like every other `cap` subcommand) — consistent with
 * `add`/`show`/`enable`/`connect`, which all take a friendly name.
 *
 * Destructive — prompts for confirmation (like `cap disconnect`) unless
 * --force is passed, since resolving by name (not just an opaque UUID pasted
 * from `cap list --json`) makes this much easier to fire off by accident.
 */
export async function capabilityRemove(
  ids: string[],
  opts: CapRemoveOpts
): Promise<void> {
  const cfg = await resolveHubConfig(opts);
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

  // Resolve every arg to a {id, label} target FIRST (no deletes yet) so we can
  // show one clear confirmation for the whole batch, and so a bad/ambiguous
  // name is reported without having already deleted the good ones before it.
  let cards: CapabilityCard[] | undefined;
  const targets: { id: string; label: string }[] = [];
  let failed = 0;
  for (const rawId of ids) {
    if (uuid.test(rawId)) {
      targets.push({ id: rawId, label: rawId.slice(0, 8) });
      continue;
    }
    if (!cards) {
      const workspaceId = requireWorkspace(opts, cfg);
      cards = await fetchCatalog(cfg, workspaceId).catch(() => [] as CapabilityCard[]);
    }
    const card = findCard(cards, rawId);
    if (!card || card.source !== "installed" || !card.id) {
      log.warn(
        `  ${chalk.yellow("skip")} ${rawId} — no installed capability matches this name (pass a container id from \`synap cap list --json\`, or check \`synap cap list\`)`
      );
      failed++;
      continue;
    }
    targets.push({ id: card.id, label: card.name });
  }

  if (targets.length === 0) {
    log.warn(`Removed 0 container(s), ${failed} failed. Nothing to do.`);
    return;
  }

  if (!opts.force) {
    const list = targets.map((t) => `  · ${t.label}`).join("\n");
    const response = await prompts({
      type: "confirm",
      name: "confirmed",
      message: `Remove ${targets.length} capability container(s)?\n${list}\nThis deletes the container(s); orphaned tools/skills are cleaned up too (shared members kept).`,
      initial: false,
    });
    if (!response.confirmed) {
      log.dim("Cancelled.");
      return;
    }
  }

  let removed = 0;
  let tools = 0;
  let skills = 0;
  for (const { id, label } of targets) {
    try {
      const res = (await hubDelete(`/capabilities/containers/${id}`, cfg)) as {
        deleted?: { tools?: number; skills?: number };
      };
      tools += res?.deleted?.tools ?? 0;
      skills += res?.deleted?.skills ?? 0;
      log.dim(`  ${chalk.green("✓")} removed ${label}`);
      removed++;
    } catch (err) {
      log.warn(`  ${chalk.red("✗")} ${label} — ${(err as Error).message}`);
      failed++;
    }
  }
  log.success(
    `Removed ${removed} container(s)${failed ? chalk.red(`, ${failed} failed`) : ""}. ` +
      `Cleaned up ${tools} orphaned tool(s) + ${skills} skill(s) (shared members kept).`
  );
}
