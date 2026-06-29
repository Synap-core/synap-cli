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
import { resolveHubConfig, hubGet, hubPost } from "../lib/hub-client.js";
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
  | "partial";

interface CardVerb {
  verbId: string;
  skillId?: string | null;
  label: string;
  type: "read" | "write";
  enabled: boolean;
  governance: "auto" | "propose";
  runnable: boolean;
  params?: string[];
}

interface CardConnection {
  required: boolean;
  kind: "provider" | "vault" | null;
  provider?: string;
  state: "connected" | "missing" | "expired";
  account?: string;
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
  return ((res as Record<string, unknown>).capabilities ?? []) as Capability[];
}

async function fetchSkills(cfg: HubCfg, workspaceId: string): Promise<SkillRow[]> {
  const res = await hubGet("/skills", { workspaceId }, cfg);
  return ((res as Record<string, unknown>).skills ?? []) as SkillRow[];
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
async function fetchCatalog(cfg: HubCfg, workspaceId: string): Promise<CapabilityCard[]> {
  const res = await hubGet("/capabilities/catalog", { workspaceId }, cfg);
  return ((res as Record<string, unknown>).capabilities ?? []) as CapabilityCard[];
}

/** True when the thrown hub error is the "catalog door not deployed" 404. */
function isCatalogMissing(err: unknown): boolean {
  return err instanceof Error && err.message.includes("HTTP 404");
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
    case "partial":
      return `partial · ${n} verb${n === 1 ? "" : "s"}`;
    case "draft":
      return `${n} verb${n === 1 ? "" : "s"} · not enabled`;
    default:
      return "in catalog";
  }
}

/** Which display group a card belongs to. */
function statusGroup(card: CapabilityCard): "usable" | "setup" | "available" {
  if (card.status === "available") return "available";
  if (card.verbs.some((v) => v.runnable)) return "usable";
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
    const mark = v.type === "write" ? chalk.yellow("✋") : chalk.green("▸");
    const note =
      v.type === "write"
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

  log.heading(
    `Capabilities — ${usable.length} ready · ${setup.length} need a step · ${available.length} available`
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

  // ── Vault credential — prompt + store server-side ─────────────────────────
  if (conn.kind === "vault") {
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
      // NOTE: the catalog computes connection.state from the tool's credentialRef.
      // If a verb still won't run after this, the ref may need manual linking.
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

  // setup_required → open OAuth, then poll.
  const redirectUrl = String(res.redirectUrl);
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

// ── Public: capabilityAdd ────────────────────────────────────────────────────

export interface CapAddOpts {
  workspace?: string;
}

export async function capabilityAdd(name: string, opts: CapAddOpts): Promise<void> {
  let cfg: HubCfg;
  try {
    cfg = await resolveHubConfig();
  } catch (err) {
    log.error((err as Error).message);
    process.exit(1);
  }

  const workspaceId = requireWorkspace(opts, cfg);

  const spinner = ora({ text: `Resolving ${chalk.bold(name)}…`, color: "cyan" }).start();
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

  const card = findCard(cards, name);
  if (!card) {
    log.error(`No capability named "${name}" in the catalog.`);
    log.dim("Run `synap cap list` to see what's available.");
    process.exit(1);
  }

  if (card.source === "installed") {
    log.heading(`${card.name} is already installed`);
    renderCardAny(card);
    return;
  }

  const addSpinner = ora({ text: `Adding ${chalk.bold(card.name)}…`, color: "cyan" }).start();
  try {
    await hubPost("/capabilities/apply", { templateKey: card.key, workspaceId }, cfg);
    addSpinner.succeed(chalk.green(`Added ${chalk.bold(card.name)}.`));
  } catch (err) {
    addSpinner.fail(chalk.red(`Failed to add ${card.name}`));
    log.error((err as Error).message);
    process.exit(1);
  }

  // Re-fetch to show the resulting (installed) status.
  try {
    const after = findCard(await fetchCatalog(cfg, workspaceId), name);
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

export async function capabilityEnable(name: string, opts: CapEnableOpts): Promise<void> {
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
        v.type === "write"
          ? `${v.label} (write · asks approval each run)`
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

export async function capabilityConnect(name: string, opts: CapConnectOpts): Promise<void> {
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
  if (ok) {
    log.dim(`Now enable its verbs:  synap cap enable "${card.name}"`);
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
    const stateColor =
      c.state === "connected" ? chalk.green : c.state === "expired" ? chalk.yellow : chalk.red;
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
      v.type === "write" ? chalk.dim("write · asks approval") : chalk.dim("read");
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
      { verbId: verb, parameters, workspaceId },
      cfg,
      90_000 // provider-backed skills run several external calls — give them room
    )) as Record<string, unknown>;
    spinner.stop();
  } catch (err) {
    spinner.stop();
    const msg = (err as Error).message;
    if (msg.includes("HTTP 404")) {
      log.error(`Capability not found: ${chalk.bold(verb)}`);
      log.dim("Run `synap capability list` to see available verbs.");
      process.exit(1);
    }
    if (msg.includes("HTTP 403")) {
      log.error(`Refused: ${chalk.bold(verb)} is not runnable yet.`);
      log.dim(`Enable it first:  synap capability enable ${verb}`);
      process.exit(1);
    }
    log.error(msg);
    process.exit(1);
  }

  // 202 → a reviewable proposal was created instead of running.
  if (res.proposed === true) {
    log.heading(`⏳ Queued for approval`);
    log.dim(`Approve in Synap (proposalId: ${String(res.proposalId)})`);
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
