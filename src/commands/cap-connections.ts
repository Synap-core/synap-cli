/**
 * synap cap connections (alias `conn`) — manage a capability's stored CONNECTIONS.
 *
 * A connection is a named, optionally-secret credential/context binding for an
 * installed capability (e.g. a vault key, an OAuth account, a per-context object
 * binding). Backend surface (base `${podUrl}/api/hub`):
 *   GET    /capabilities/:capabilityId/connections
 *   POST   /capabilities/:capabilityId/connections
 *   PATCH  /capabilities/:capabilityId/connections/:id
 *   DELETE /capabilities/:capabilityId/connections/:id
 *
 * Capability name→id is resolved LOCALLY against GET /capabilities/catalog (the
 * card's `id` is the installed container id; null means uninstalled).
 */

import chalk from "chalk";
import ora from "ora";
import prompts from "prompts";
import { resolveHubConfig, hubGet, hubPost, hubPatch, hubDelete, renderHubError } from "../lib/hub-client.js";
import { unwrapList } from "../lib/unwrapList.js";
import { log } from "../utils/logger.js";

type HubCfg = Awaited<ReturnType<typeof resolveHubConfig>>;

// Minimal catalog card shape needed to resolve name → installed container id.
interface CatalogCard {
  id: string | null;
  key: string;
  name: string;
}

interface Connection {
  id: string;
  label: string;
  contextType?: string | null;
  contextId?: string | null;
  isDefault?: boolean;
  accountHint?: string | null;
  kind?: string | null;
}

export interface CapConnectionsOpts {
  workspace?: string;
  label?: string;
  value?: string;
  contextType?: string;
  contextId?: string;
  accountHint?: string;
  default?: boolean;
  rotate?: boolean;
}

/**
 * Resolve a capability NAME (or key, case-insensitive) to its installed
 * container id via the catalog. Exits with a clear message when the pack is
 * unknown or not yet installed. Copied inline on purpose — capability.ts is
 * concurrent human WIP and must not be imported from here.
 */
async function resolveInstalledCapabilityId(
  cfg: HubCfg,
  name: string,
  workspace?: string
): Promise<string> {
  const workspaceId = workspace ?? cfg.workspaceId;
  if (!workspaceId) {
    log.error("A workspace is required. Set one with `synap use <workspace>` or pass --workspace <id>.");
    process.exit(1);
  }

  let cards: CatalogCard[];
  try {
    const res = await hubGet("/capabilities/catalog", { workspaceId }, cfg);
    cards = unwrapList<CatalogCard>(res, ["capabilities"]);
  } catch (err) {
    log.error(`Failed to fetch capability catalog: ${(err as Error).message}`);
    process.exit(1);
  }

  const q = name.trim().toLowerCase();
  const card =
    cards.find((c) => c.name?.toLowerCase() === q) ??
    cards.find((c) => c.key?.toLowerCase() === q);

  if (!card) {
    log.error(`No capability named "${name}" in the catalog.`);
    log.dim("Run `synap cap list` to see what's available.");
    process.exit(1);
  }
  if (card.id == null) {
    log.error(`"${card.name}" isn't installed yet.`);
    log.dim(`Install it first:  synap cap add "${card.name}"`);
    process.exit(1);
  }
  return card.id;
}

/** Human-readable context cell for the list table. */
function contextCell(c: Connection): string {
  if (c.contextType && c.contextId) return `${c.contextType}:${c.contextId}`;
  if (c.contextType) return c.contextType;
  return chalk.dim("—");
}

// ── list ─────────────────────────────────────────────────────────────────────

export async function capabilityConnectionsList(
  name: string,
  opts: CapConnectionsOpts
): Promise<void> {
  const cfg = await resolveHubConfig();
  const capId = await resolveInstalledCapabilityId(cfg, name, opts.workspace);

  const spinner = ora({ text: `Fetching connections for ${chalk.bold(name)}…`, color: "cyan" }).start();
  let connections: Connection[];
  try {
    const res = await hubGet(`/capabilities/${capId}/connections`, {}, cfg);
    connections = unwrapList<Connection>(res, ["connections"]);
    spinner.stop();
  } catch (err) {
    spinner.fail(chalk.red("Failed to fetch connections"));
    renderHubError(err);
    process.exit(1);
  }

  if (connections.length === 0) {
    log.heading(`${name} — no connections yet`);
    log.dim(`Add one:  synap cap connections add "${name}" --label <label>`);
    return;
  }

  log.heading(`${name} — ${connections.length} connection${connections.length === 1 ? "" : "s"}`);
  console.log();
  for (const c of connections) {
    const mark = c.isDefault ? chalk.green("★") : " ";
    const def = c.isDefault ? chalk.green(" DEFAULT") : "";
    const kind = c.kind ? chalk.dim(` [${c.kind}]`) : "";
    const acct = c.accountHint ? chalk.dim(` · ${c.accountHint}`) : "";
    console.log(`  ${mark} ${chalk.bold(c.label)}${kind}${def}`);
    console.log(
      `      ${chalk.dim("context")} ${contextCell(c)}${acct}`
    );
    console.log(`      ${chalk.dim("id")} ${chalk.cyan(c.id)}`);
  }
  console.log();
  log.dim(
    `Use an id:  synap cap connections update "${name}" <id> …  ·  synap cap run <verb> --connection <id>`
  );
}

// ── add ──────────────────────────────────────────────────────────────────────

export async function capabilityConnectionsAdd(
  name: string,
  opts: CapConnectionsOpts
): Promise<void> {
  const cfg = await resolveHubConfig();
  const capId = await resolveInstalledCapabilityId(cfg, name, opts.workspace);

  // Label — from --label or prompt.
  let label = opts.label;
  if (!label) {
    const answer = await prompts({ type: "text", name: "label", message: "Connection label" });
    label = (answer.label as string | undefined)?.trim();
    if (!label) {
      log.dim("Cancelled — no label entered.");
      return;
    }
  }

  // Secret value — from --value, or masked prompt. Leaving it blank is valid for
  // OAuth-less connections that carry no secret (just a context binding).
  let value = opts.value;
  if (value === undefined) {
    const answer = await prompts({
      type: "password",
      name: "value",
      message: `Secret / credential value for ${chalk.bold(label)} (blank if none)`,
    });
    value = (answer.value as string | undefined) || undefined;
  }

  const body: Record<string, unknown> = { label };
  if (value !== undefined) body.value = value;
  if (opts.contextType !== undefined) body.contextType = opts.contextType;
  if (opts.contextId !== undefined) body.contextId = opts.contextId;
  if (opts.accountHint !== undefined) body.accountHint = opts.accountHint;
  if (opts.default) body.isDefault = true;

  const spinner = ora({ text: `Adding connection to ${chalk.bold(name)}…`, color: "cyan" }).start();
  let res: Record<string, unknown>;
  try {
    res = (await hubPost(`/capabilities/${capId}/connections`, body, cfg)) as Record<string, unknown>;
    spinner.stop();
  } catch (err) {
    spinner.fail(chalk.red("Failed to add connection"));
    renderHubError(err);
    process.exit(1);
  }

  const created = (res.connection ?? res) as Record<string, unknown>;
  const newId = String(created.id ?? "");
  log.success(`Added connection ${chalk.bold(label)}.`);
  if (newId) log.dim(`id: ${chalk.cyan(newId)}`);
}

// ── update ───────────────────────────────────────────────────────────────────

export async function capabilityConnectionsUpdate(
  name: string,
  connectionId: string,
  opts: CapConnectionsOpts
): Promise<void> {
  const cfg = await resolveHubConfig();
  const capId = await resolveInstalledCapabilityId(cfg, name, opts.workspace);

  const body: Record<string, unknown> = {};
  if (opts.label !== undefined) body.label = opts.label;
  if (opts.default) body.isDefault = true;
  if (opts.contextType !== undefined) body.contextType = opts.contextType;
  if (opts.contextId !== undefined) body.contextId = opts.contextId;
  if (opts.accountHint !== undefined) body.accountHint = opts.accountHint;

  // Secret rotation — explicit --value, or --rotate prompts (masked).
  let value = opts.value;
  if (value === undefined && opts.rotate) {
    const answer = await prompts({
      type: "password",
      name: "value",
      message: `New secret / credential value for ${chalk.cyan(connectionId)}`,
    });
    value = (answer.value as string | undefined) || undefined;
    if (value === undefined) {
      log.dim("Cancelled — no value entered.");
      return;
    }
  }
  if (value !== undefined) body.value = value;

  if (Object.keys(body).length === 0) {
    log.warn("Nothing to update — pass --label/--default/--context-type/--context-id/--account-hint, or --rotate/--value.");
    return;
  }

  const spinner = ora({ text: `Updating connection…`, color: "cyan" }).start();
  try {
    await hubPatch(`/capabilities/${capId}/connections/${connectionId}`, body, cfg);
    spinner.succeed(chalk.green(`Updated connection ${chalk.cyan(connectionId)}.`));
  } catch (err) {
    spinner.fail(chalk.red("Failed to update connection"));
    renderHubError(err);
    process.exit(1);
  }
}

// ── rm ───────────────────────────────────────────────────────────────────────

export async function capabilityConnectionsRemove(
  name: string,
  connectionId: string,
  opts: CapConnectionsOpts
): Promise<void> {
  const cfg = await resolveHubConfig();
  const capId = await resolveInstalledCapabilityId(cfg, name, opts.workspace);

  const { yes } = await prompts({
    type: "confirm",
    name: "yes",
    message: `Remove connection ${connectionId} from ${name}?`,
    initial: false,
  });
  if (!yes) {
    log.dim("Cancelled.");
    return;
  }

  const spinner = ora({ text: `Removing connection…`, color: "cyan" }).start();
  try {
    await hubDelete(`/capabilities/${capId}/connections/${connectionId}`, cfg);
    spinner.succeed(chalk.green(`Removed connection ${chalk.cyan(connectionId)}.`));
  } catch (err) {
    spinner.fail(chalk.red("Failed to remove connection"));
    renderHubError(err);
    process.exit(1);
  }
}
