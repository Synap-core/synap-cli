/**
 * `synap app init` / `synap app connect` — the App Connect flow (APP-CONNECT-SPEC §1/§5).
 *
 * An app repo carries a `synap.app.json` manifest at its root. `init` writes it
 * (asks name, pod, requests) and registers the app on the pod, writing the pod's
 * assigned `public_id` back into the file. `connect` files ONE proposal naming
 * the app and its requested reach, waits for the human to approve it, mints the
 * app's key, and drops it into the deploy target declared by `deploy`.
 *
 * Naming (locked by the spec): the object is an Application, the authorization a
 * grant, the bearer an API key. Never "connection".
 *
 * Auth: the SAME pod key every other command uses (`ensurePodKey` / `login()`).
 * The manifest names its pod, so we first look for a saved profile for THAT pod
 * (the rule `ensurePodKey` uses), then fall back to the active pod's key when it
 * is the same pod. No second auth mechanism is invented.
 */

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import * as readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import chalk from "chalk";
import { HubRestClient } from "@synap-core/hub-rest-client";
import { log } from "../utils/logger.js";
import { renderHubError, resolveHubConfig, type HubConfig } from "../lib/hub-client.js";
import { pollForApproval } from "../lib/approval-poll.js";
import { listPodProfiles } from "../lib/pod.js";
import { samePodOrigin } from "../lib/project-ref.js";
import { classifyProposalStatus, statusOf } from "./proposals-await.js";

// ─── Manifest (APP-CONNECT-SPEC §1) ────────────────────────────────────────────

export const MANIFEST_FILENAME = "synap.app.json";

/** v1 supports ONLY "specific" mode (spec §8 puts global/OAuth out of scope). */
export type AppMode = "specific";

export interface AppRequest {
  /** W1 grant grammar: `entity.<qualifier>.<action>`, `entity.*.create`, `*`. */
  permission: string;
  /** A workspace NAME — the pod resolves it to an id (unknown ⇒ register/connect fails loud). */
  workspace: string;
}

export type DeployTarget = "vercel" | "env";

export interface DeploySpec {
  /** `vercel` → `vercel env add …`; `env` → write `.env.local`. */
  target: DeployTarget;
  /** Which env var receives which value. `key` is required. */
  env: {
    key?: string;
    podUrl?: string;
    workspaceId?: string;
  };
}

export interface AppManifest {
  version: 1;
  /** Pod-assigned `public_id` (`app_<uuid>`) — the app's `client_id`. ABSENT until first register. */
  id?: string;
  name: string;
  description?: string;
  logoUrl: string | null;
  mode: AppMode;
  pod: string;
  requests: AppRequest[];
  deploy: DeploySpec;
}

function optionalString(v: unknown): string | undefined {
  return typeof v === "string" && v.trim() ? v.trim() : undefined;
}

/**
 * Parse + validate a manifest. Every failure names the field and the fix —
 * a malformed manifest is a visible error, never a silent default.
 */
export function parseManifest(raw: string): AppManifest {
  let obj: unknown;
  try {
    obj = JSON.parse(raw);
  } catch (err) {
    throw new Error(`${MANIFEST_FILENAME} is not valid JSON: ${(err as Error).message}`);
  }
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) {
    throw new Error(`${MANIFEST_FILENAME} must be a JSON object.`);
  }
  const m = obj as Record<string, unknown>;

  if (m.version !== 1) {
    throw new Error(
      `Unsupported ${MANIFEST_FILENAME} version ${JSON.stringify(m.version)} — expected 1.`
    );
  }
  const name = optionalString(m.name);
  if (!name) throw new Error(`${MANIFEST_FILENAME} is missing a "name".`);

  if (m.mode !== undefined && m.mode !== "specific") {
    throw new Error(
      `Unsupported mode ${JSON.stringify(m.mode)} — v1 supports only "specific".`
    );
  }

  const pod = optionalString(m.pod);
  if (!pod) throw new Error(`${MANIFEST_FILENAME} is missing a "pod" URL.`);
  try {
    new URL(pod);
  } catch {
    throw new Error(`${MANIFEST_FILENAME} "pod" is not a valid URL: ${pod}`);
  }

  if (!Array.isArray(m.requests) || m.requests.length === 0) {
    throw new Error(`${MANIFEST_FILENAME} must list at least one entry in "requests".`);
  }
  const requests: AppRequest[] = m.requests.map((r, i) => {
    if (!r || typeof r !== "object" || Array.isArray(r)) {
      throw new Error(`requests[${i}] must be an object like { "permission": …, "workspace": … }.`);
    }
    const rr = r as Record<string, unknown>;
    const permission = optionalString(rr.permission);
    if (!permission) throw new Error(`requests[${i}].permission is required.`);
    const workspace = optionalString(rr.workspace);
    if (!workspace) throw new Error(`requests[${i}].workspace is required (a workspace name).`);
    return { permission, workspace };
  });

  const deployRaw = m.deploy;
  if (!deployRaw || typeof deployRaw !== "object" || Array.isArray(deployRaw)) {
    throw new Error(`${MANIFEST_FILENAME} is missing a "deploy" block.`);
  }
  const d = deployRaw as Record<string, unknown>;
  if (d.target !== "vercel" && d.target !== "env") {
    throw new Error(`deploy.target must be "vercel" or "env" (got ${JSON.stringify(d.target)}).`);
  }
  const envRaw = d.env;
  if (!envRaw || typeof envRaw !== "object" || Array.isArray(envRaw)) {
    throw new Error(`deploy.env is required (which var receives the key, pod URL, workspace id).`);
  }
  const e = envRaw as Record<string, unknown>;
  const env = {
    key: optionalString(e.key),
    podUrl: optionalString(e.podUrl),
    workspaceId: optionalString(e.workspaceId),
  };
  if (!env.key) {
    throw new Error(`deploy.env.key is required — the env var that receives the API key.`);
  }

  return {
    version: 1,
    id: optionalString(m.id),
    name,
    description: optionalString(m.description),
    logoUrl: optionalString(m.logoUrl) ?? null,
    mode: "specific",
    pod,
    requests,
    deploy: { target: d.target, env },
  };
}

/** Serialize in the spec's field order, omitting absent optionals. Round-trips through parseManifest. */
export function serializeManifest(m: AppManifest): string {
  const env: Record<string, string> = {};
  if (m.deploy.env.key) env.key = m.deploy.env.key;
  if (m.deploy.env.podUrl) env.podUrl = m.deploy.env.podUrl;
  if (m.deploy.env.workspaceId) env.workspaceId = m.deploy.env.workspaceId;

  const out: Record<string, unknown> = { version: m.version };
  if (m.id) out.id = m.id;
  out.name = m.name;
  if (m.description) out.description = m.description;
  if (m.logoUrl) out.logoUrl = m.logoUrl;
  out.mode = m.mode;
  out.pod = m.pod;
  out.requests = m.requests.map((r) => ({ permission: r.permission, workspace: r.workspace }));
  out.deploy = { target: m.deploy.target, env };
  return JSON.stringify(out, null, 2) + "\n";
}

export function manifestPath(root: string = process.cwd()): string {
  return path.join(root, MANIFEST_FILENAME);
}

/** Read + parse the manifest. A missing file names `synap app init`; a broken one names the field. */
export function readManifest(file: string = manifestPath()): AppManifest {
  let raw: string;
  try {
    raw = fs.readFileSync(file, "utf-8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      throw new Error(`No ${MANIFEST_FILENAME} at ${file}. Create it with: synap app init`);
    }
    throw new Error(`Could not read ${file}: ${(err as Error).message}`);
  }
  return parseManifest(raw);
}

export function writeManifest(file: string, m: AppManifest): void {
  fs.writeFileSync(file, serializeManifest(m), { mode: 0o600 });
}

// ─── deploy.env → target mapping (pure) ────────────────────────────────────────

export interface DeployEnvValues {
  apiKey: string;
  podUrl: string;
  workspaceId?: string;
}

/**
 * Map the minted values onto the env vars the manifest declares. Pure: the
 * single place that decides which var receives which value. Only declared vars
 * are written; a declared `workspaceId` with no resolved id is a visible error
 * (never a silent half-write).
 */
export function buildEnvAssignments(
  deploy: DeploySpec,
  values: DeployEnvValues
): Array<{ name: string; value: string }> {
  const out: Array<{ name: string; value: string }> = [];
  if (deploy.env.key) out.push({ name: deploy.env.key, value: values.apiKey });
  if (deploy.env.podUrl) out.push({ name: deploy.env.podUrl, value: values.podUrl });
  if (deploy.env.workspaceId) {
    if (!values.workspaceId) {
      throw new Error(
        `deploy.env.workspaceId is declared ("${deploy.env.workspaceId}") but no workspace id was resolved.`
      );
    }
    out.push({ name: deploy.env.workspaceId, value: values.workspaceId });
  }
  return out;
}

/** Quote an env value only when it would otherwise be mis-read (whitespace, #, quotes). */
export function quoteEnvValue(value: string): string {
  if (/[\s#"']/.test(value)) return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
  return value;
}

/**
 * Apply assignments to `.env.local` content, pure. An existing `NAME=…` line
 * (optionally `export NAME=…`) is replaced in place; otherwise the var is
 * appended. Idempotent: running twice leaves one line per var.
 */
export function applyEnvContent(
  existing: string,
  assignments: Array<{ name: string; value: string }>
): string {
  const lines = existing.length ? existing.replace(/\r\n/g, "\n").split("\n") : [];
  while (lines.length && lines[lines.length - 1] === "") lines.pop();

  for (const { name, value } of assignments) {
    const re = new RegExp(`^\\s*(?:export\\s+)?${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*=`);
    const idx = lines.findIndex((l) => re.test(l));
    const line = `${name}=${quoteEnvValue(value)}`;
    if (idx >= 0) lines[idx] = line;
    else lines.push(line);
  }

  return lines.length ? lines.join("\n") + "\n" : "";
}

/**
 * Write one var into a Vercel project (production) idempotently: remove any
 * existing value first (`vercel env add` refuses a duplicate name), then add.
 */
export function writeVercelEnv(name: string, value: string): void {
  try {
    execFileSync("vercel", ["env", "rm", name, "production", "-y"], { stdio: "ignore" });
  } catch {
    /* no existing var — add below */
  }
  try {
    execFileSync("vercel", ["env", "add", name, "production"], {
      input: value + "\n",
      stdio: ["pipe", "pipe", "pipe"],
    });
  } catch (err) {
    throw new Error(
      `\`vercel env add ${name} production\` failed: ${(err as Error).message}\n` +
        `Run it by hand:  echo "${value}" | vercel env add ${name} production`
    );
  }
}

/** Write the assignments into the target the manifest declares. Idempotent. */
export function writeDeployTarget(
  deploy: DeploySpec,
  assignments: Array<{ name: string; value: string }>,
  root: string = process.cwd()
): string {
  if (deploy.target === "vercel") {
    for (const { name, value } of assignments) writeVercelEnv(name, value);
    return "vercel (production)";
  }
  const envFile = path.join(root, ".env.local");
  let existing = "";
  try {
    existing = fs.readFileSync(envFile, "utf-8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      throw new Error(`Could not read ${envFile}: ${(err as Error).message}`);
    }
  }
  fs.writeFileSync(envFile, applyEnvContent(existing, assignments), { mode: 0o600 });
  return path.relative(root, envFile) || ".env.local";
}

// ─── Pod client (App Connect routes, APP-CONNECT-SPEC §3) ──────────────────────

/** The `apps` record the pod returns. `public_id` is the manifest's `id` (client_id). */
export interface RegisteredApp {
  id: string;
  public_id: string;
  name: string;
  description?: string | null;
  logo_url?: string | null;
  mode?: string;
}

export interface RegisterAppInput {
  name: string;
  description?: string;
  logoUrl?: string | null;
  mode: AppMode;
}

export interface ConnectResult {
  proposalId: string;
  reviewUrl: string;
}

export interface AppKeyResult {
  apiKey: string;
  keyId?: string;
}

/**
 * The App Connect Hub routes. A thin subclass of `HubRestClient` — it reuses
 * the shared request loop (retries, timeouts, Idempotency-Key) through the
 * protected `request()` door rather than hand-rolling fetch.
 */
export class AppConnectClient extends HubRestClient {
  /** POST /api/hub/apps — register/upsert, idempotent by name+owner. Returns the app. */
  async registerApp(app: RegisterAppInput): Promise<RegisteredApp> {
    const res = await this.request<{ app: RegisteredApp }>("POST", "/api/hub/apps", app);
    if (!res?.app?.public_id) {
      throw new Error("POST /api/hub/apps returned no app.public_id — check the pod logs.");
    }
    return res.app;
  }

  /** POST /api/hub/apps/:id/connect — files ONE proposal naming the app and its reach. */
  async connectApp(publicId: string, requests: AppRequest[]): Promise<ConnectResult> {
    const res = await this.request<ConnectResult>(
      "POST",
      `/api/hub/apps/${encodeURIComponent(publicId)}/connect`,
      { requests }
    );
    if (!res?.proposalId) {
      throw new Error("POST /apps/:id/connect returned no proposalId — check the pod logs.");
    }
    return res;
  }

  /** POST /api/hub/apps/:id/key — after approval; mints (rotates) the app key, plaintext ONCE. */
  async mintAppKey(publicId: string): Promise<AppKeyResult> {
    const res = await this.request<{ apiKey?: string; keyId?: string }>(
      "POST",
      `/api/hub/apps/${encodeURIComponent(publicId)}/key`,
      {}
    );
    if (!res?.apiKey) {
      throw new Error("POST /apps/:id/key returned no apiKey — check the pod logs.");
    }
    return { apiKey: res.apiKey, keyId: res.keyId };
  }
}

// ─── Auth: the existing pod key, for the manifest's pod ────────────────────────

/**
 * The user's pod key for the manifest's pod. Same mechanism `ensurePodKey` uses:
 * a saved profile for that exact pod, verified against `/auth/status`; otherwise
 * the active pod's key when it is the same pod. Never invents a credential.
 */
async function resolveAppCredentials(podUrl: string): Promise<HubConfig> {
  const norm = (u: string) => u.replace(/\/+$/, "");
  const target = norm(podUrl);

  const saved = listPodProfiles().find((p) => norm(p.config.podUrl) === target);
  if (saved?.config.hubApiKey) {
    const res = await fetch(`${target}/api/hub/auth/status`, {
      headers: { Authorization: `Bearer ${saved.config.hubApiKey}` },
      signal: AbortSignal.timeout(15_000),
    }).catch(() => null);
    if (res?.ok) {
      return { podUrl: target, apiKey: saved.config.hubApiKey, userId: saved.config.agentUserId || "cli" };
    }
    if (res && (res.status === 401 || res.status === 403)) {
      log.warn(`Your saved key for ${target} no longer works.`);
    } else {
      // A failed read is not an empty result — surface it.
      throw new Error(
        `Could not verify your saved key for ${target} (${res ? `HTTP ${res.status}` : "unreachable"}).`
      );
    }
  }

  // Fall back to the active pod's key when the manifest's pod IS the active pod
  // (covers env-pinned sessions) — still the one auth mechanism.
  const cfg = await resolveHubConfig();
  if (samePodOrigin(cfg.podUrl, target)) return { ...cfg, podUrl: target };

  throw new Error(
    `No pod key for ${target}. Add it with:  synap pods add ${new URL(target).hostname} ${target}`
  );
}

// ─── shared step: register (and write the id back) ─────────────────────────────

async function registerIfNeeded(
  client: AppConnectClient,
  manifest: AppManifest,
  file: string
): Promise<AppManifest> {
  if (manifest.id) return manifest;
  const app = await client.registerApp({
    name: manifest.name,
    description: manifest.description,
    logoUrl: manifest.logoUrl,
    mode: manifest.mode,
  });
  const updated: AppManifest = { ...manifest, id: app.public_id };
  writeManifest(file, updated);
  log.success(`Registered "${manifest.name}" — id ${app.public_id} written to ${MANIFEST_FILENAME}`);
  return updated;
}

// ─── prompt helpers (node:readline — @clack/prompts hangs on this pod) ─────────

async function ask(
  rl: readline.Interface,
  question: string,
  def = ""
): Promise<string> {
  const suffix = def ? chalk.dim(` [${def}]`) : "";
  const answer = (await rl.question(`  ${question}${suffix}: `)).trim();
  return answer || def;
}

// ─── `synap app init` ──────────────────────────────────────────────────────────

/**
 * Write `synap.app.json` at the repo root and register the app on the pod,
 * writing the pod-assigned id back into the file.
 */
export async function appInit(): Promise<void> {
  if (!process.stdin.isTTY) {
    throw new Error(
      "`synap app init` needs an interactive terminal (it asks for your app's name, pod, and permissions).\n" +
        `For a non-interactive setup, write ${MANIFEST_FILENAME} by hand and run: synap app connect`
    );
  }

  const root = process.cwd();
  const file = manifestPath(root);

  let existing: AppManifest | undefined;
  if (fs.existsSync(file)) {
    existing = readManifest(file);
    log.info(`Updating the existing ${MANIFEST_FILENAME}.`);
  }

  // A default pod URL for the prompt only. resolveHubConfig is entirely local
  // (no network); its ONLY failure here is "No pod configured" — a legitimate
  // state for a first app, so the prompt simply starts empty.
  const cfg = await resolveHubConfig().catch(() => undefined);

  const rl = readline.createInterface({ input, output });
  let manifest: AppManifest;
  try {
    const name = await ask(rl, "App name", existing?.name ?? path.basename(root));
    if (!name) throw new Error("An app name is required.");

    const pod = await ask(rl, "Pod URL", existing?.pod ?? cfg?.podUrl ?? "");
    if (!pod) throw new Error("A pod URL is required.");
    try {
      new URL(pod);
    } catch {
      throw new Error(`That pod URL is not valid: ${pod}`);
    }

    log.blank();
    log.info("What should this app be allowed to do?");
    log.dim('Grant grammar: entity.<qualifier>.<action>, entity.*.create, or "*".');
    const requests: AppRequest[] = [];
    for (let i = 0; i < 20; i++) {
      const def = existing?.requests[i];
      const permission = await ask(
        rl,
        i === 0 ? "Requested permission" : "Another permission (leave blank to finish)",
        def?.permission ?? ""
      );
      if (!permission) break;
      const workspace = await ask(rl, `Workspace name for "${permission}"`, def?.workspace ?? "");
      if (!workspace) throw new Error(`A workspace name is required for "${permission}".`);
      requests.push({ permission, workspace });
    }
    if (requests.length === 0) throw new Error("At least one request is required.");

    manifest = {
      version: 1,
      id: existing?.id,
      name,
      description: existing?.description,
      logoUrl: existing?.logoUrl ?? null,
      mode: "specific",
      pod,
      requests,
      deploy: existing?.deploy ?? {
        target: "env",
        env: { key: "SYNAP_API_KEY", podUrl: "SYNAP_POD_URL", workspaceId: "SYNAP_WORKSPACE_ID" },
      },
    };
  } finally {
    rl.close();
  }

  // Write first (so nothing is lost if the pod is unreachable), then register
  // and rewrite with the assigned id.
  writeManifest(file, manifest);
  log.success(`Wrote ${MANIFEST_FILENAME}`);
  log.dim(`Edit deploy (target + env var names) in ${MANIFEST_FILENAME} before connecting.`);

  const creds = await resolveAppCredentials(manifest.pod);
  const client = new AppConnectClient({ podUrl: creds.podUrl, apiKey: creds.apiKey });
  const registered = await registerIfNeeded(client, manifest, file);

  log.blank();
  log.success(`App "${registered.name}" is registered (${registered.id}).`);
  log.info("Next: " + chalk.cyan("synap app connect") + " to request access and receive the key.");
}

// ─── `synap app connect` ───────────────────────────────────────────────────────

async function resolveWorkspaceIdFor(
  client: AppConnectClient,
  requests: AppRequest[]
): Promise<string> {
  const names = [...new Set(requests.map((r) => r.workspace.trim()))];
  const workspaces = await client.getWorkspaces();
  const byName = new Map(workspaces.map((w) => [w.name.trim().toLowerCase(), w.id]));
  const missing = names.filter((n) => !byName.get(n.toLowerCase()));
  if (missing.length) {
    throw new Error(
      `Workspace not found on this pod: ${missing.join(", ")}. ` +
        `Check the name in ${MANIFEST_FILENAME} (run \`synap orient\` to list workspaces).`
    );
  }
  if (names.length > 1) {
    log.warn(
      `This app requests ${names.length} workspaces — writing the first ("${names[0]}") to the workspace-id env var.`
    );
  }
  return byName.get(names[0].toLowerCase())!;
}

/** File the proposal, print the review URL, wait for approval, mint + deploy the key. */
export async function appConnect(): Promise<void> {
  const root = process.cwd();
  const file = manifestPath(root);
  let manifest = readManifest(file);

  const creds = await resolveAppCredentials(manifest.pod);
  const client = new AppConnectClient({ podUrl: creds.podUrl, apiKey: creds.apiKey });

  // Register first if the manifest has no id yet (spec §5).
  manifest = await registerIfNeeded(client, manifest, file);

  // ── 1. File ONE proposal naming the app and its requested reach ─────────────
  const { proposalId, reviewUrl } = await client.connectApp(manifest.id!, manifest.requests);
  log.blank();
  log.heading(`Access request filed for "${manifest.name}"`);
  log.info("Approve it on your phone: " + chalk.cyan(reviewUrl));
  log.dim(`Proposal ${proposalId}`);

  // ── 2. Poll until the human approves ────────────────────────────────────────
  process.stdout.write(chalk.dim("  Waiting for approval"));
  const ticker = setInterval(() => process.stdout.write(chalk.dim(".")), 2000);
  try {
    await pollForApproval<Record<string, unknown>>({
      url: `${creds.podUrl.replace(/\/+$/, "")}/api/hub/proposals/${proposalId}`,
      headers: { Authorization: `Bearer ${creds.apiKey}` },
      isApproved: (d) => classifyProposalStatus(statusOf(d)) === "approved",
      isRejected: (d) => classifyProposalStatus(statusOf(d)) === "rejected",
      onApproved: (d) => d as Record<string, unknown>,
      // `classifyProposalStatus` maps rejected / expired / withdrawn /
      // approval_failed to one "rejected" — say "not approved", never assert a
      // rejection we cannot prove.
      rejectedError: `The access request for "${manifest.name}" was not approved (rejected, expired or withdrawn). Re-run \`synap app connect\` to ask again.`,
      // A timeout is NOT proof the human declined: the pod may have been
      // unreachable while polling. Name both causes.
      timeoutError:
        `Timed out waiting for approval (120s). If the pod was unreachable, check your connection; otherwise open ${reviewUrl} and approve, then re-run \`synap app connect\`.`,
    });
  } finally {
    clearInterval(ticker);
    process.stdout.write("\n");
  }
  log.success("Approved.");

  // ── 3. Mint the app key (rotates any existing — `connect` is re-runnable) ────
  const { apiKey } = await client.mintAppKey(manifest.id!);

  // ── 4. Deploy: write the declared env vars into the target ──────────────────
  const workspaceId = manifest.deploy.env.workspaceId
    ? await resolveWorkspaceIdFor(client, manifest.requests)
    : undefined;
  const assignments = buildEnvAssignments(manifest.deploy, {
    apiKey,
    podUrl: creds.podUrl,
    workspaceId,
  });
  const where = writeDeployTarget(manifest.deploy, assignments, root);

  log.blank();
  log.success(`Key written to ${where}`);
  for (const { name } of assignments) log.dim(`${name}=…`);
  log.dim("See or revoke this app in Pod Admin → My connections.");
  log.dim(
    manifest.deploy.target === "vercel"
      ? "Deploy with `vercel --prod` to pick up the new env vars."
      : "Restart your app (or `vercel --prod`) to pick up the new env vars."
  );
}

/** Entry points used by the commander registration — surface pod failures through the one door. */
export async function appInitCommand(): Promise<void> {
  try {
    await appInit();
  } catch (err) {
    renderHubError(err);
    process.exit(1);
  }
}

export async function appConnectCommand(): Promise<void> {
  try {
    await appConnect();
  } catch (err) {
    renderHubError(err);
    process.exit(1);
  }
}
