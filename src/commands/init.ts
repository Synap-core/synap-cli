/**
 * synap init
 *
 * Laptop/desktop (the default): find or create a pod → connect the agents on
 * this machine (Claude Code, Codex, Cursor, OpenClaw — one row each) → pair
 * the phone → hand the person one real task to give their agent.
 *
 * Server (linux + docker) keeps its own paths:
 *   A: OpenClaw found → connect pod, then wire OpenClaw
 *   B: no OpenClaw → bundle mode (fresh setup)
 */

import prompts from "prompts";
import ora from "ora";
import chalk from "chalk";
import { execSync } from "child_process";
import fs from "fs";
import { log, banner } from "../utils/logger.js";
import {
  detectOpenClaw,
  readOpenClawConfig,
  writeOpenClawConfig,
  setConfigValue,
} from "../lib/openclaw.js";

import {
  checkPodHealth,
  setupAgentViaPod,
  provisionUserOnPod,
  installSynapSkill,
  saveLocalPodConfig,
  checkServerResources,
  startOpenClawOnServer,
  findSynapDeployDir,
  getLocalPodConfig,
  getActiveProjectId,
  listPodProfiles,
  addPodProfile,
  setActivePod,
  type LocalPodConfig,
} from "../lib/pod.js";
import { provisionAgentKey, configureAgentContext, installForTarget } from "../lib/targets.js";
import { seedAgentEntities } from "../lib/seed.js";
import { login, isLoggedIn, listPods, getStoredToken, waitForPodCallback } from "../lib/auth.js";
import { detectAgents, type DetectableAgent } from "../lib/agent-detect.js";
import { createPodInBrowser } from "../lib/init-pod.js";
import { buildPairLink, renderTerminalQr } from "../lib/pair-link.js";
import { buildHandoff } from "../lib/init-handoff.js";
import { approveAgentKeysAtOnce } from "../lib/batch-approval.js";
import { connectAgents } from "../lib/init-connect.js";
import { INIT_EXIT, InitExit } from "../lib/init-exit.js";
import { withHeldOutput, reserveStdoutForJson } from "../lib/init-output.js";

/** Where a phone without Relay gets it (synap-landing/app/download/relay). */
const RELAY_DOWNLOAD_URL = "https://synap.live/download/relay";

interface InitOptions {
  podUrl?: string;
  apiKey?: string;
  skipIs?: boolean;
  /** Accept the defaults: no prompt (the agents found here, "creates" approval). */
  yes?: boolean;
  /** Comma-separated agents to connect, e.g. "claude-code,codex". */
  agents?: string;
  /** Print a JSON summary on stdout (human lines go to stderr). */
  json?: boolean;
  /** Set by init: no prompt may run (no terminal, or --yes). */
  unattended?: boolean;
}

const AGENT_CHOICES: readonly DetectableAgent[] = ["claude-code", "codex", "cursor", "openclaw"];

/** What `--json` prints. Agent lists are target names, e.g. "codex". */
interface InitSummary {
  podUrl: string;
  connected: DetectableAgent[];
  notApproved: DetectableAgent[];
  failed: DetectableAgent[];
  pairLink: string | null;
}

export async function init(opts: InitOptions): Promise<void> {
  const emitJson = opts.json ? reserveStdoutForJson() : null;
  banner();

  let summary: InitSummary | null = null;
  let exitCode: number = INIT_EXIT.ok;
  let error: string | undefined;
  try {
    summary = await runInit(opts);
    if (summary && summary.connected.length === 0) exitCode = INIT_EXIT.noAgent;
  } catch (err) {
    if (!(err instanceof InitExit)) throw err;
    exitCode = err.code;
    error = err.message;
    if (!err.shown) log.error(error);
  }
  emitJson?.(JSON.stringify(summary ? { ...summary, exitCode } : { exitCode, error }) + "\n");
  if (exitCode !== INIT_EXIT.ok) process.exit(exitCode);
}

/** `--agents claude-code,codex` → the targets, or a usage error naming the bad one. */
function parseAgents(list: string): DetectableAgent[] {
  const names = list.split(",").map((a) => a.trim()).filter(Boolean);
  const bad = names.filter((a) => !(AGENT_CHOICES as readonly string[]).includes(a));
  if (bad.length > 0 || names.length === 0) {
    throw new InitExit(
      INIT_EXIT.usage,
      `Unknown agent${bad.length > 1 ? "s" : ""}: ${bad.join(", ") || "(none)"}. Use ${AGENT_CHOICES.join(", ")}.`
    );
  }
  return [...new Set(names)] as DetectableAgent[];
}

async function runInit(opts: InitOptions): Promise<InitSummary | null> {
  const tty = Boolean(process.stdin.isTTY);
  if (!tty && (!opts.podUrl || !opts.agents)) {
    throw new InitExit(INIT_EXIT.usage, "Not a terminal. Pass --pod-url and --agents claude-code,codex");
  }
  opts.unattended = !tty || Boolean(opts.yes);
  const agents = opts.agents ? parseAgents(opts.agents) : undefined;

  // An explicit --pod-url is probed before anything assumes reachability: a
  // typo'd URL fails loud with a checklist instead of silent 500s later.
  if (opts.podUrl) {
    const probe = await checkPodHealth(opts.podUrl);
    if (!probe.healthy) {
      printUnreachablePodInstructions(opts.podUrl);
      throw new InitExit(INIT_EXIT.noPod, `Pod at ${opts.podUrl} is not reachable.`, true);
    }
  }

  // `--agents` names agents on THIS machine: that is the desktop flow, even
  // on a linux box with docker (a CI runner).
  if (!detectServer() || agents) {
    return desktopFlow(opts, agents);
  }

  // ── Server (linux + docker) ─────────────────────────────────────────────
  // With no pod signal at all, a server gets the self-host instructions.
  if (!opts.podUrl && !(await hasAnyPodSignal())) {
    printNoPodInstructions();
    throw new InitExit(INIT_EXIT.noPod, "No Synap pod detected.", true);
  }

  const oc = detectOpenClaw();
  if (oc.found) {
    log.info(
      `OpenClaw detected${oc.version ? ` v${oc.version}` : ""}. It will be wired after pod setup.`
    );
  }

  // Before assuming fresh install, check if a pod is already running
  const spinner = ora("Scanning for existing Synap pod...").start();
  const existingPodUrl = opts.podUrl ?? (await detectLocalPod());
  spinner.stop();

  if (existingPodUrl) {
    log.success(`Found existing pod at ${existingPodUrl}`);
    if (oc.found) {
      log.info("Server with OpenClaw: connecting the pod, then wiring OpenClaw.");
      await pathA(opts, oc);
    } else {
      log.info("Server detected: connecting to the existing pod.");
      await pathBExisting(opts, existingPodUrl);
    }
  } else {
    log.info("Server detected: fresh setup.");
    await pathB(opts);
  }
  return null;
}

// =============================================================================
// DESKTOP: pod → agents → phone → first task
// =============================================================================

async function desktopFlow(opts: InitOptions, agents?: DetectableAgent[]): Promise<InitSummary> {
  log.heading("Your pod");
  const pod = await resolveDesktopPod(opts);
  const humanKey = await ensurePodKey(pod.podUrl, opts, pod.podId);

  const outcome = await connectAgentsStep(pod.podUrl, humanKey, opts, agents);
  const pairLink = await pairPhoneStep(pod.podUrl);
  printClosing(outcome.connectedLabels);
  return {
    podUrl: pod.podUrl,
    connected: outcome.connected,
    notApproved: outcome.notApproved,
    failed: outcome.failed,
    pairLink,
  };
}

/**
 * The pod this machine talks to. In order: --pod-url, a saved profile that
 * answers, a pod running on this machine — and when there is none, create one
 * instead of exiting.
 */
async function resolveDesktopPod(opts: InitOptions): Promise<{ podUrl: string; podId?: string }> {
  if (opts.podUrl) return { podUrl: opts.podUrl };

  const saved = getLocalPodConfig();
  if (saved?.podUrl) {
    const spinner = ora(`Checking ${saved.podUrl}…`).start();
    if ((await checkPodHealth(saved.podUrl)).healthy) {
      spinner.succeed(`Pod: ${saved.podUrl}`);
      return { podUrl: saved.podUrl, podId: saved.podId };
    }
    spinner.warn(`Your saved pod at ${saved.podUrl} is not answering.`);
  }

  const local = await detectLocalPod();
  if (local) {
    log.success(`Pod running on this machine: ${local}`);
    return { podUrl: local };
  }

  if (opts.unattended) throw new InitExit(INIT_EXIT.noPod, "No pod found. Pass --pod-url <url>.");
  return noPodStep();
}

async function noPodStep(): Promise<{ podUrl: string; podId?: string }> {
  log.blank();
  const { choice } = await prompts({
    type: "select",
    name: "choice",
    message: "No Synap pod yet. Create one, or point me at yours?",
    choices: [
      { title: "Create in browser", value: "create" },
      { title: "I have one on synap.live (sign in)", value: "login" },
      { title: "I have a URL", value: "url" },
      { title: "Self-host", value: "self-host" },
    ],
  });
  if (!choice) throw new InitExit(INIT_EXIT.cancelled, "Cancelled.");

  if (choice === "create") return createPodStep();

  if (choice === "login") {
    const picked = await loginAndSelectPod();
    if (!picked) throw new InitExit(INIT_EXIT.noPod, "No pod selected.");
    return { podUrl: picked.url, podId: picked.podId || undefined };
  }

  if (choice === "url") {
    const { url } = await prompts({ type: "text", name: "url", message: "Pod URL:" });
    if (!url) throw new InitExit(INIT_EXIT.cancelled, "Cancelled.");
    const spinner = ora("Checking pod health...").start();
    if ((await checkPodHealth(url)).healthy) {
      spinner.succeed(`Pod: ${url}`);
      return { podUrl: url };
    }
    spinner.fail(`Pod not reachable at ${url}`);
    throw new InitExit(INIT_EXIT.noPod, `Pod not reachable at ${url}`, true);
  }

  log.blank();
  log.info("On your server, run:");
  console.log(chalk.cyan("\n  curl -fsSL https://synap.live/install.sh | bash\n"));
  log.info("Then here: " + chalk.cyan("npx @synap-core/cli init --pod-url <your-pod-url>"));
  throw new InitExit(INIT_EXIT.noPod, "No pod yet: self-host one, then run init with --pod-url.", true);
}

/** Open synap.live to create a pod, then continue here once it answers. */
async function createPodStep(): Promise<{ podUrl: string }> {
  log.info("Opening synap.live to create your pod…");
  const spinner = ora("Waiting for you in the browser…").start();
  const result = await createPodInBrowser({
    waitForPodCallback: async () => {
      const created = await waitForPodCallback();
      if (created) spinner.text = "Your pod is starting (usually ~2 min). I'll continue here.";
      return created;
    },
    checkPodHealth,
  });

  if (result.ok) {
    spinner.succeed(`Pod ready: ${result.podUrl}`);
    return { podUrl: result.podUrl };
  }
  if (result.reason === "not-reachable") {
    spinner.warn(`Your pod at ${result.podUrl} is still starting.`);
    log.info("Pick up where you left off: " + chalk.cyan(`synap init --pod-url ${result.podUrl}`));
    throw new InitExit(INIT_EXIT.noPod, `Your pod at ${result.podUrl} is still starting.`, true);
  }
  spinner.fail("No pod was created (the browser window timed out or was closed).");
  log.info("Try again any time: " + chalk.cyan("synap init"));
  throw new InitExit(INIT_EXIT.noPod, "No pod was created.", true);
}

/**
 * The person's own key for this pod — the one `/setup/agent` accepts to mint
 * each agent's key. Reuses a saved profile for this pod; otherwise mints one
 * (CP login when available, else a pasted key).
 */
async function ensurePodKey(podUrl: string, opts: InitOptions, podId?: string): Promise<string> {
  if (opts.apiKey) return opts.apiKey;

  const norm = (u: string) => u.replace(/\/+$/, "");
  const saved = listPodProfiles().find((p) => norm(p.config.podUrl) === norm(podUrl));
  if (saved?.config.hubApiKey) {
    const res = await fetch(`${norm(podUrl)}/api/hub/auth/status`, {
      headers: { Authorization: `Bearer ${saved.config.hubApiKey}` },
      signal: AbortSignal.timeout(15_000),
    }).catch(() => null);
    if (res?.ok) {
      if (!saved.active) setActivePod(saved.name);
      return saved.config.hubApiKey;
    }
    if (res && (res.status === 401 || res.status === 403)) {
      log.warn("Your saved key for this pod no longer works. Issuing a new one.");
    } else {
      throw new InitExit(
        INIT_EXIT.noKey,
        `Could not check your saved key for this pod (${res ? `HTTP ${res.status}` : "unreachable"}).`
      );
    }
  }

  // A synap.live pod needs a CP login to mint the key; sign in now rather than
  // falling through to the self-host PROVISIONING_TOKEN prompt. Without a
  // terminal nobody is there to finish a browser sign-in.
  const creds = getStoredToken();
  const loggedIn = creds && new Date(creds.expiresAt) > new Date();
  if (!loggedIn && isManagedPod(podUrl) && process.stdin.isTTY) {
    const spinner = ora("Sign in to Synap in your browser…").start();
    const fresh = await login();
    if (fresh) spinner.succeed(`Signed in as ${fresh.email}`);
    else spinner.fail("Sign-in timed out.");
  }

  const key = await connectStep(podUrl, opts, false, podId, "cli");
  if (key) return key;
  throw new InitExit(
    INIT_EXIT.noKey,
    opts.unattended
      ? "Could not issue your key for this pod. Pass --api-key <key>."
      : "No key for this pod, so no agent can connect yet."
  );
}

function isManagedPod(podUrl: string): boolean {
  try {
    const host = new URL(podUrl).hostname;
    return host === "synap.live" || host.endsWith(".synap.live");
  } catch {
    return false;
  }
}

/** Save the pod as a named profile (host name) and make it active. Never overwrite another pod's profile. */
function rememberPod(config: LocalPodConfig): void {
  let name: string;
  try {
    name = new URL(config.podUrl).hostname;
  } catch {
    name = "default";
  }
  addPodProfile(name, config);
  setActivePod(name);
}

async function connectAgentsStep(
  podUrl: string,
  humanKey: string,
  opts: InitOptions,
  requested?: DetectableAgent[]
): Promise<{
  connected: DetectableAgent[];
  notApproved: DetectableAgent[];
  failed: DetectableAgent[];
  connectedLabels: string[];
}> {
  log.heading("Your agents");
  const rows = detectAgents();
  const found = rows.filter((r) => r.found);
  const labelOf = (t: DetectableAgent) => rows.find((r) => r.target === t)?.label ?? t;

  let picked: DetectableAgent[];
  if (requested) {
    picked = requested;
  } else if (opts.unattended) {
    picked = found.map((r) => r.target);
    if (picked.length === 0) log.info("No agent found on this machine.");
  } else {
    log.info(
      found.length > 0
        ? `Found: ${found.map((r) => r.label).join(", ")}.`
        : "No agent found on this machine. Pick one to set up anyway, or skip."
    );
    const { targets } = await prompts({
      type: "multiselect",
      name: "targets",
      message: found.length > 1 ? `Connect ${found.length === 2 ? "both" : "them"}?` : "Connect:",
      choices: rows.map((r) => ({
        title: r.label,
        description: r.found ? r.evidence : "not found on this machine",
        value: r.target,
        selected: r.found,
      })),
      hint: "space to toggle, enter to confirm",
      instructions: false,
    });
    picked = (targets ?? []) as DetectableAgent[];
  }

  // One click for every key that needs approval (V1 D5): mint them all first,
  // open ONE review page, then install with the approved keys.
  const result = await connectAgents(picked, {
    approve: (targets) => approveAgentKeysAtOnce(podUrl, humanKey, targets),
    install: async (target) => {
      const run = await withHeldOutput(() =>
        installForTarget(target, { podUrl, apiKey: humanKey, unattended: true })
      );
      return {
        ok: run.value === true,
        output: run.held,
        error: run.error === undefined ? undefined : run.error instanceof Error ? run.error.message : String(run.error),
      };
    },
    after: async (target) => {
      if (target !== "openclaw") return;
      const oc = detectOpenClaw();
      await skillStep(true, oc);
      await seedStep(podUrl, humanKey, oc);
      if (opts.skipIs) return;
      if (opts.unattended) log.dim("Set up the AI provider later: " + chalk.cyan("synap update"));
      else await isStep(podUrl, humanKey, true);
    },
    labelOf,
  });
  return { ...result, connectedLabels: result.connected.map(labelOf) };
}

/** Prints the QR for Relay; returns the link, or null when a phone can't use this pod. */
async function pairPhoneStep(podUrl: string): Promise<string | null> {
  log.heading("Your phone");
  const pair = buildPairLink({ podUrl, email: getStoredToken()?.email });
  if (!pair.ok) {
    if (pair.reason === "loopback") {
      log.info(
        "Pair later, once the pod has a public URL: " + chalk.cyan("synap init --pod-url https://…")
      );
    } else if (pair.reason === "insecure") {
      log.info("Pair later, once the pod is served over https: " + chalk.cyan("synap init --pod-url https://…"));
    } else {
      log.info(`Can't make a pairing link for ${podUrl}.`);
    }
    return null;
  }
  log.info("Scan with Relay so your agents can reach you. That's where their questions arrive.");
  log.dim(`No Relay yet? ${RELAY_DOWNLOAD_URL}`);
  console.log("\n" + (await renderTerminalQr(pair.link)));
  log.dim(pair.link);
  return pair.link;
}

function printClosing(connected: string[]): void {
  log.blank();
  if (connected.length === 0) {
    console.log("  No agent connected yet. When you're ready: " + chalk.cyan("synap connect --target=claude-code"));
    log.blank();
    return;
  }
  const h = buildHandoff(connected);
  console.log(chalk.green.bold("  ✓ Done.") + ` Try it now. In ${h.agentLabel}, say:`);
  log.blank();
  console.log(chalk.bold(`  "${h.prompt}"`));
  log.blank();
  log.dim("More:");
  for (const m of h.more) log.dim(`  "${m}"`);
  log.blank();
}

// =============================================================================
// PATH A: Existing OpenClaw (primary funnel)
// =============================================================================

async function pathA(
  opts: InitOptions,
  oc: ReturnType<typeof detectOpenClaw>
): Promise<void> {
  // ── Report ──────────────────────────────────────────────────────────────
  log.heading("Step 1: OpenClaw Detected");
  log.success(`Version: ${oc.version ?? "unknown"}`);
  log.success(
    `Gateway: ${oc.gatewayRunning ? "running" : "stopped"} (port ${oc.gatewayPort ?? 18789})`
  );



  // ── Pod ─────────────────────────────────────────────────────────────────
  const podUrl = await podChoiceStep(opts);
  if (!podUrl) return;

  // ── Connect ─────────────────────────────────────────────────────────────
  const apiKey = await connectStep(podUrl, opts, true);
  if (!apiKey) return;

  // ── Skill ───────────────────────────────────────────────────────────────
  await skillStep(true, oc);

  // ── Seed ────────────────────────────────────────────────────────────────
  await seedStep(podUrl, apiKey, oc);

  // ── IS ──────────────────────────────────────────────────────────────────
  if (!opts.skipIs) {
    await isStep(podUrl, apiKey, true);
  }

  printSummary(podUrl, true);
}

// =============================================================================
// PATH B-EXISTING: Server with pod already running, just needs OpenClaw
// =============================================================================

async function pathBExisting(opts: InitOptions, detectedUrl: string): Promise<void> {
  log.heading("Step 1: Verify Pod");

  // Confirm URL with the user — let them override if detection was wrong
  const { podUrl } = await prompts({
    type: "text",
    name: "podUrl",
    message: "Pod URL:",
    initial: detectedUrl,
  });
  if (!podUrl) return;

  const spinner = ora("Checking pod health...").start();
  const health = await checkPodHealth(podUrl);
  if (!health.healthy) {
    spinner.fail(`Pod not reachable at ${podUrl}`);
    log.dim("Check docker compose logs, or provide the correct URL.");
    return;
  }
  spinner.succeed(`Pod healthy${health.version ? ` (v${health.version})` : ""}`);

  // Connect (generate Hub API key)
  const apiKey = await connectStep(podUrl, opts, false);
  if (!apiKey) return;

  // OpenClaw — always Docker on a server with an existing compose stack
  log.heading("Step 2: OpenClaw");

  const deployDir = findSynapDeployDir();
  if (!deployDir) {
    log.warn("Could not find your Synap deploy directory automatically.");
    log.dim("Start OpenClaw manually on the pod host (the pod's CLI pins the compose project):");
    log.dim("  <synap-backend>/synap profiles enable openclaw");
    log.dim("Then run: synap update");
    return;
  }

  log.info(`Deploy dir: ${deployDir}`);
  log.blank();

  const localConfig = getLocalPodConfig();

  // Stop any spinner before running the pod's CLI — its output goes to stdout
  // and will conflict with ora. We print progress directly.
  log.info("Running: synap config set (OpenClaw keys) + synap profiles enable openclaw");
  log.dim("(The first run pulls a ~1GB image and may take a few minutes.)");
  log.blank();

  let ocStarted = false;
  try {
    startOpenClawOnServer(
      apiKey,
      localConfig?.agentUserId ?? "",
      localConfig?.workspaceId ?? "",
      podUrl,
      getActiveProjectId()
    );
    ocStarted = true;
    log.success("OpenClaw container started");
  } catch (err) {
    log.warn(err instanceof Error ? err.message : String(err));
  }

  log.blank();
  if (ocStarted) {
    log.info("OpenClaw is initializing (first boot takes 1-2 min).");
    log.info("Once it's ready, run:");
    console.log(chalk.cyan("\n  synap update\n"));
    log.dim("This will install the skill, seed your workspace, and configure AI routing.");
    log.dim("Check progress at any time: synap status");
  } else {
    log.info("Start OpenClaw manually:");
    console.log(chalk.cyan(`\n  ${deployDir}/../synap profiles enable openclaw\n`));
    log.dim("Then run: synap update");
  }
}

// =============================================================================
// PATH B: Fresh server (no OpenClaw)
// =============================================================================

async function pathB(opts: InitOptions): Promise<void> {
  log.heading("Step 1: Server Setup");

  // Last-chance check: probe localhost ports in case detection missed something
  // (e.g. pod on a non-standard port or started after init was launched)
  const existingUrl = await detectLocalPod();
  if (existingUrl) {
    log.success(`Found a running pod at ${existingUrl}. Switching to connect mode.`);
    await pathBExisting(opts, existingUrl);
    return;
  }

  // Resource check
  const resources = checkServerResources();
  log.info(`RAM: ${resources.ramTotal}MB total, ${resources.ramFree}MB free`);
  log.info(`Disk: ${resources.diskFree} free`);

  if (resources.ramFree < 1500) {
    log.warn(
      "Low RAM: Synap + OpenClaw need ~1.5GB. Performance may be affected."
    );
  }

  // What to install
  const { installChoice } = await prompts({
    type: "select",
    name: "installChoice",
    message: "What would you like to set up?",
    choices: [
      {
        title: "Synap pod + OpenClaw (full stack)",
        description: "Recommended: everything on this server",
        value: "bundle",
      },
      {
        title: "Synap pod only",
        description: "Add OpenClaw later",
        value: "pod-only",
      },
    ],
  });

  if (!installChoice) return;

  // Install pod
  const podUrl = await podInstallLocalStep(opts);
  if (!podUrl) return;

  // Get the API key once
  const apiKey = await connectStep(podUrl, opts, false);
  if (!apiKey) return;

  if (installChoice === "bundle") {
    log.blank();
    log.info("Running: synap config set (OpenClaw keys) + synap profiles enable openclaw");
    log.dim("(The first run pulls a ~1GB image and may take a few minutes.)");
    log.blank();
    try {
      const localConfig = getLocalPodConfig();
      startOpenClawOnServer(apiKey, localConfig?.agentUserId ?? "", localConfig?.workspaceId ?? "", podUrl, getActiveProjectId());
      log.success("OpenClaw container started");
    } catch (err) {
      log.warn(err instanceof Error ? err.message : String(err));
    }
    log.blank();
    log.info("OpenClaw is initializing. Once it's ready, run:");
    console.log(chalk.cyan("\n  synap update\n"));
    log.dim("Check progress: synap status");
    return;
  }

  printSummary(podUrl, false);
}

async function podChoiceStep(opts: InitOptions): Promise<string | null> {
  log.heading("Synap Pod");

  if (opts.podUrl) {
    const status = await checkPodHealth(opts.podUrl);
    if (status.healthy) {
      log.success(`Pod healthy at ${opts.podUrl}`);
      return opts.podUrl;
    }
    log.error(`Pod not reachable at ${opts.podUrl}`);
    return null;
  }

  // Check if pod already running locally
  const localStatus = await checkPodHealth("http://localhost:4000");
  if (localStatus.healthy) {
    log.success("Pod already running at http://localhost:4000");
    return "http://localhost:4000";
  }

  const { podChoice } = await prompts({
    type: "select",
    name: "podChoice",
    message: "Where should your Synap pod run?",
    choices: [
      {
        title: "Log in to Synap: connect to your existing pod",
        description: "Sign in via browser and find your pod automatically",
        value: "login",
      },
      {
        title: "This machine (docker-compose), free",
        description: "Runs alongside OpenClaw, ~1.5GB RAM",
        value: "local",
      },
      {
        title: "Managed by Synap",
        description: "We host it, you connect",
        value: "managed",
      },
      {
        title: "I already have a pod (enter URL)",
        value: "existing",
      },
    ],
  });

  if (podChoice === "login") {
    const podResult = await loginAndSelectPod();
    return podResult?.url ?? null;
  }

  if (podChoice === "local") {
    return await podInstallLocalStep(opts);
  }

  if (podChoice === "managed") {
    log.blank();
    log.info("Sign up at: " + chalk.cyan("https://synap.live"));
    log.info("After provisioning, re-run:");
    log.dim("  synap init --pod-url https://your-pod.synap.live");
    return null;
  }

  if (podChoice === "existing") {
    const { url } = await prompts({
      type: "text",
      name: "url",
      message: "Pod URL:",
    });
    if (!url) return null;

    const spinner = ora("Checking pod health...").start();
    const status = await checkPodHealth(url);
    if (status.healthy) {
      spinner.succeed(`Pod healthy at ${url}`);
      return url;
    }
    spinner.fail(`Pod not reachable at ${url}`);
    return null;
  }

  return null;
}

async function podInstallLocalStep(opts: InitOptions): Promise<string | null> {
  // Check resources first
  const resources = checkServerResources();
  if (resources.ramFree < 1500) {
    log.warn(
      `Low RAM (${resources.ramFree}MB free). Synap needs ~1.5GB. Consider managed hosting.`
    );
  }

  const { installDomain } = await prompts({
    type: "text",
    name: "installDomain",
    message: "Domain for this pod (use localhost for local setup):",
    initial: "localhost",
  });
  if (!installDomain) return null;

  let installEmail = "";
  if (installDomain !== "localhost") {
    const emailPrompt = await prompts({
      type: "text",
      name: "installEmail",
      message: "Email for Let's Encrypt SSL certificates:",
    });
    installEmail = emailPrompt.installEmail ?? "";
    if (!installEmail) {
      log.error("Email is required for non-localhost domains.");
      return null;
    }
  }

  const escapedDomain = String(installDomain).replace(/'/g, "'\\''");
  const escapedEmail = String(installEmail).replace(/'/g, "'\\''");
  const installCmd =
    installDomain === "localhost"
      ? `curl -fsSL https://raw.githubusercontent.com/Synap-core/backend/main/install.sh | bash -s -- --domain '${escapedDomain}'`
      : `curl -fsSL https://raw.githubusercontent.com/Synap-core/backend/main/install.sh | bash -s -- --domain '${escapedDomain}' --email '${escapedEmail}'`;

  log.blank();
  log.info("Install Synap pod with:");
  log.blank();
  console.log(chalk.cyan(`  ${installCmd}`));
  log.blank();

  const { proceed } = await prompts({
    type: "confirm",
    name: "proceed",
    message: "Run the installer now?",
    initial: true,
  });

  if (proceed) {
    try {
      execSync(installCmd, { stdio: "inherit" });
      return "http://localhost:4000";
    } catch {
      log.error("Installation failed. Check the output above.");
      return null;
    }
  }

  log.dim("Run the command above manually, then: synap init");
  return null;
}

async function connectStep(
  podUrl: string,
  opts: InitOptions,
  openclawFound: boolean,
  podId?: string,
  // "cli" = the person's own key for this pod (desktop init: it mints each
  // agent's key and is saved as a named profile). "openclaw" = the server paths.
  integration: "cli" | "openclaw" = "openclaw"
): Promise<string | null> {
  // The desktop flow already opened with "Your pod".
  if (integration !== "cli") log.heading("Connect to Pod");

  let apiKey = opts.apiKey;
  let keySaved = false;

  // User is logged in to Synap: the pod trusts that session to issue a key.
  const autoMint = async (): Promise<void> => {
    const creds = getStoredToken();
    if (!creds || new Date(creds.expiresAt) <= new Date()) return;
    const spinner = ora(
      integration === "cli" ? "Issuing your key for this pod..." : "Generating API key for OpenClaw agent..."
    ).start();
    try {
      // Provision the user on the pod (creates Kratos identity + pod user
      // account) AND capture the Kratos session the handshake mints. This is
      // idempotent — safe to call on every init.
      let sessionToken: string | null = null;
      try {
        ({ sessionToken } = await provisionUserOnPod(podUrl, creds.token));
      } catch (err) {
        // Non-fatal here — the missing-session guard below decides what to do.
        log.warn(`Could not provision user on pod: ${err instanceof Error ? err.message : String(err)}`);
      }

      if (!sessionToken) {
        throw new Error("Could not establish a pod session to issue an agent key.");
      }

      // Canonical key issuance: mint a scoped Hub Protocol key via the pod's
      // apiKeys.connectIntegration tRPC procedure — the same path the pod-admin
      // /connect page and the browser use (replaces the removed CP relay).
      const result = await setupAgentViaPod(podUrl, sessionToken, integration);
      apiKey = result.hubApiKey;
      opts.apiKey = apiKey;
      spinner.succeed(integration === "cli" ? "Key issued" : "API key generated");
      const podConfig: LocalPodConfig = {
        podUrl,
        podId: podId ?? undefined,
        workspaceId: result.workspaceId,
        agentUserId: result.agentUserId,
        hubApiKey: result.hubApiKey,
        savedAt: new Date().toISOString(),
      };
      if (integration === "cli") {
        rememberPod(podConfig);
      } else {
        if (result.agentUserId) {
          log.dim(`Agent user: ${result.agentUserId}`);
        }
        log.dim(`Workspace: ${result.workspaceId}`);
        log.blank();
        log.info("This key lets OpenClaw read/write your knowledge graph.");
        log.info("It's scoped to Hub Protocol operations only.");

        // Always save to ~/.synap/pod-config.json (works even without OpenClaw)
        saveLocalPodConfig(podConfig);
      }
      keySaved = true;

      if (openclawFound) {
        const config = readOpenClawConfig() ?? {};
        setConfigValue(config, "synap.podUrl", podUrl);
        setConfigValue(config, "synap.workspaceId", result.workspaceId);
        setConfigValue(config, "synap.agentUserId", result.agentUserId);
        writeOpenClawConfig(config);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      spinner.fail(
        integration === "cli" ? `Couldn't issue your key for this pod: ${msg}` : `Auto-generation failed: ${msg}`
      );
    }
  };

  if (!apiKey) await autoMint();

  // Nobody at the terminal to paste a key or sign in again.
  if (!apiKey && integration === "cli" && opts.unattended) return null;

  if (!apiKey && integration === "cli" && isManagedPod(podUrl)) {
    // A synap.live pod has no .env to read a PROVISIONING_TOKEN from: the way
    // back is signing in again (the usual cause is an expired session).
    const { next } = await prompts({
      type: "select",
      name: "next",
      message: "Sign in again to issue your key?",
      choices: [
        { title: "Sign in again", value: "signin" },
        { title: "Paste a key from your pod (Settings, API keys)", value: "paste" },
      ],
    });
    if (next === "signin") {
      const spinner = ora("Sign in to Synap in your browser…").start();
      const fresh = await login();
      if (fresh) {
        spinner.succeed(`Signed in as ${fresh.email}`);
        await autoMint();
      } else {
        spinner.fail("Sign-in timed out.");
      }
    } else if (next === "paste") {
      apiKey = await pasteKey(podUrl, podId, integration);
    }
  } else if (!apiKey) {
    // Manual path — not authenticated or auto-gen failed
    const { keyChoice } = await prompts({
      type: "select",
      name: "keyChoice",
      message: "How to get an API key?",
      choices: [
        {
          title: "Generate via PROVISIONING_TOKEN",
          description: "Use the token from your pod's .env file",
          value: "generate",
        },
        {
          title: "Paste an existing API key",
          description: "From pod Settings → API Keys",
          value: "paste",
        },
      ],
    });

    if (keyChoice === "paste") {
      apiKey = await pasteKey(podUrl, podId, integration);
    } else if (keyChoice === "generate") {
      const { token } = await prompts({
        type: "password",
        name: "token",
        message: "PROVISIONING_TOKEN (from pod .env):",
      });

      if (token) {
        const spinner = ora("Creating agent credentials...").start();
        try {
          // Agents are pod-wide singletons now — setupAgent() never passed a
          // workspaceId in its request either, so the response's workspaceId
          // was already always null/"" in practice. Provision via the shared
          // wrapper (no enrollAgentIfNeeded: a PROVISIONING_TOKEN can't
          // authorize /workspaces/enroll-agent, same as before).
          const result = await provisionAgentKey(podUrl, token, integration);
          apiKey = result.hubApiKey;
          opts.apiKey = apiKey;
          spinner.succeed("Credentials created");
          log.dim(`Agent: ${result.agentUserId}`);

          const podConfig: LocalPodConfig = {
            podUrl,
            podId: podId ?? undefined,
            workspaceId: "",
            agentUserId: result.agentUserId,
            hubApiKey: result.hubApiKey,
            savedAt: new Date().toISOString(),
          };
          if (integration === "cli") rememberPod(podConfig);
          else saveLocalPodConfig(podConfig);
          keySaved = true;

          if (openclawFound) {
            const config = readOpenClawConfig() ?? {};
            setConfigValue(config, "synap.podUrl", podUrl);
            setConfigValue(config, "synap.agentUserId", result.agentUserId);
            writeOpenClawConfig(config);
          }

          if (result.agentUserId) {
            try {
              await configureAgentContext(podUrl, apiKey, integration, result.agentUserId);
            } catch (err) {
              log.warn(`Agent context wizard failed: ${err instanceof Error ? err.message : String(err)}`);
            }
          }
        } catch (err) {
          spinner.fail(err instanceof Error ? err.message : String(err));
          return null;
        }
      }
    }
  }

  // Never print the key itself: it lives in the config file only.
  if (apiKey && integration === "openclaw" && keySaved) {
    log.success(`API key …${apiKey.slice(-4)} saved to your Synap config (~/.synap).`);
  }

  return apiKey ?? null;
}

/** Ask for a key the person copies from their pod; the desktop flow saves it as this pod's profile. */
async function pasteKey(
  podUrl: string,
  podId: string | undefined,
  integration: "cli" | "openclaw"
): Promise<string | undefined> {
  const { key } = await prompts({
    type: "password",
    name: "key",
    message: "API key:",
  });
  if (key && integration === "cli") {
    rememberPod({
      podUrl,
      podId: podId ?? undefined,
      workspaceId: "",
      agentUserId: "",
      hubApiKey: key,
      savedAt: new Date().toISOString(),
    });
  }
  return key || undefined;
}

export async function skillStep(
  openclawFound: boolean,
  oc?: ReturnType<typeof detectOpenClaw>
): Promise<void> {
  if (!openclawFound) return;

  log.heading("Install Skill");

  const isDocker = oc?.runtime === "docker";
  const containerName = oc?.containerName;

  if (isDocker) {
    log.dim(`Installing via docker exec ${containerName ?? "openclaw"}...`);
  }

  const spinner = ora("Installing synap skill...").start();
  try {
    installSynapSkill(isDocker ? (containerName ?? "openclaw") : undefined);
    spinner.succeed("Synap skill installed");
  } catch (err) {
    spinner.fail(err instanceof Error ? err.message : "Failed");
    if (isDocker) {
      log.dim(`Install manually: docker exec ${containerName ?? "openclaw"} openclaw skills install synap`);
    } else {
      log.dim("Install manually: openclaw skills install synap");
    }
  }
}

export async function seedStep(
  podUrl: string,
  apiKey: string,
  oc: ReturnType<typeof detectOpenClaw>
): Promise<void> {
  log.heading("Seed Workspace");

  const spinner = ora("Creating entities from OpenClaw config...").start();
  try {
    const count = await seedAgentEntities(podUrl, apiKey, oc);
    spinner.succeed(`${count} entities created`);
  } catch (err) {
    spinner.fail(err instanceof Error ? err.message : "Seed failed");
  }
}

export async function isStep(
  podUrl: string,
  apiKey: string,
  openclawFound: boolean
): Promise<void> {
  log.heading("Intelligence Service");

  // 1. Check current IS status on the pod
  const spinner = ora("Checking Intelligence Service status...").start();
  let isActive = false;
  let isUrl: string | undefined;

  try {
    const statusRes = await fetch(`${podUrl}/api/provision/status`, {
      signal: AbortSignal.timeout(5000),
    }).catch(() => null);

    if (statusRes?.ok) {
      const data = (await statusRes.json()) as {
        intelligenceService?: { status: string; url?: string } | null;
      };
      const svc = data?.intelligenceService;
      isActive = svc?.status === "active";
      isUrl = svc?.url;
    }
  } catch {
    // Pod may not support this endpoint — continue
  }

  if (isActive) {
    spinner.succeed(`Intelligence Service active${isUrl ? ` (${isUrl})` : ""}`);
  } else {
    spinner.stop();
  }

  // 2. If IS is not active, try to provision via CP (if user is logged in)
  if (!isActive) {
    const creds = getStoredToken();
    if (creds) {
      const cpUrl = process.env.SYNAP_CP_URL ?? "https://api.synap.live";
      try {
        const pods = await listPods(creds.token);
        const matchingPod = pods.find((p: { podUrl?: string; url?: string }) =>
          (p.podUrl ?? p.url ?? "").replace(/\/+$/, "") === podUrl.replace(/\/+$/, "")
        );

        if (matchingPod) {
          const podId = (matchingPod as { id: string }).id;

          const provStatus = await fetch(
            `${cpUrl}/intelligence/provision/status/${podId}`,
            { headers: { Authorization: `Bearer ${creds.token}` } }
          ).catch(() => null);

          const provData = provStatus?.ok
            ? ((await provStatus.json()) as { subscribed?: boolean; cpProvisioned?: boolean })
            : null;

          if (provData?.subscribed && !provData?.cpProvisioned) {
            const { provision } = await prompts({
              type: "confirm",
              name: "provision",
              message: "Your subscription includes AI. Provision Intelligence Service on this pod?",
              initial: true,
            });

            if (provision) {
              const provSpinner = ora("Provisioning Intelligence Service...").start();
              try {
                const res = await fetch(`${cpUrl}/intelligence/provision/${podId}`, {
                  method: "POST",
                  headers: {
                    Authorization: `Bearer ${creds.token}`,
                    "Content-Type": "application/json",
                  },
                });
                if (res.ok) {
                  provSpinner.succeed("Intelligence Service provisioned successfully");
                  isActive = true;
                } else {
                  const err = (await res.json().catch(() => null)) as { error?: string } | null;
                  provSpinner.fail(`Provisioning failed: ${err?.error ?? res.status}`);
                }
              } catch (e) {
                provSpinner.fail(`Provisioning error: ${e instanceof Error ? e.message : "unknown"}`);
              }
            }
          } else if (!provData?.subscribed) {
            log.dim("No AI subscription. Subscribe at https://synap.live/pricing");
            log.dim("Skip this step with: synap update --skip-is");
          } else if (provData?.cpProvisioned) {
            log.dim("IS provisioned on CP but not yet confirmed on pod.");
            log.dim("Re-run 'synap update' in a minute, or reprovision from Browser Settings.");
          }
        } else {
          // Logged in but pod not found on CP account — self-hosted pod
          log.dim("Intelligence Service not configured on this pod.");
          log.dim("To enable: connect this pod to your Synap account at https://synap.live/account/pods");
          log.dim("Then subscribe to a plan with AI and provision from Browser Settings > Add-ons.");
        }
      } catch {
        log.dim("Could not reach Synap to check the Intelligence Service. Skipping.");
      }
    } else {
      // No CP login — common on servers. Give clear actionable paths.
      log.dim("Intelligence Service not active on this pod.");
      log.blank();
      log.dim("To enable AI routing via Synap:");
      log.dim("  1. Log in:  synap login --token <token>  (get token at synap.live/account/tokens)");
      log.dim("  2. Re-run:  synap update");
      log.blank();
      log.dim("Or skip AI for now: synap update --skip-is");
    }
  }

  // 3. Configure OpenClaw provider (if found and IS is active)
  if (openclawFound && isActive) {
    const ocRuntime = detectOpenClaw();

    const { configureOc } = await prompts({
      type: "confirm",
      name: "configureOc",
      message: "Configure Synap IS as OpenClaw AI provider?",
      initial: true,
    });

    if (configureOc) {
      // Fetch real model IDs from the pod so OpenClaw shows actual provider names
      const { fetchPodProviders } = await import("./providers.js");
      const podProviders = await fetchPodProviders(podUrl, apiKey);

      const models: Array<{ id: string; name: string; contextWindow?: number }> =
        podProviders.flatMap((p) =>
          p.models.map((m) => ({
            id: `${p.providerId}/${m.id}`,
            name: `${p.name}: ${m.id}`,
            ...(m.contextWindow ? { contextWindow: m.contextWindow } : {}),
          }))
        );

      if (models.length === 0) {
        log.warn("No model IDs found. Configure models in pod admin → Intelligence → Providers.");
        log.dim("Skipping OpenClaw AI provider setup. Re-run: synap update");
        return;
      }

      const synapProvider = {
        baseUrl: `${podUrl}/v1`,
        api: "openai-completions",
        apiKey,
        models,
      };

      if (ocRuntime.runtime === "docker") {
        const containerName = ocRuntime.containerName ?? "openclaw";
        const spinner = ora("Writing Synap IS provider to OpenClaw config...").start();
        try {
          execSync(
            `docker exec ${containerName} openclaw config set models.providers.synap ${JSON.stringify(JSON.stringify(synapProvider))}`,
            { stdio: "pipe", timeout: 15000 }
          );
          spinner.succeed("Synap IS registered as OpenClaw provider");
          log.dim(`Models: ${models.slice(0, 3).map((m) => m.id).join(", ")}${models.length > 3 ? ` +${models.length - 3} more` : ""}`);
          try {
            execSync(`docker restart ${containerName}`, { stdio: "pipe", timeout: 30000 });
            log.dim("Container restarted to pick up new config");
          } catch {
            log.warn("Restart failed. Run manually: docker restart openclaw");
          }
        } catch (err) {
          const stderr = (err as { stderr?: Buffer }).stderr?.toString().trim();
          spinner.fail("Failed to set Synap IS provider");
          if (stderr) log.dim(stderr);
          log.dim(`  docker exec ${containerName} openclaw config set models.providers.synap.baseUrl ${podUrl}/v1`);
        }
      } else {
        const config = readOpenClawConfig() ?? {};
        setConfigValue(config, "models.providers.synap", synapProvider);
        writeOpenClawConfig(config);
        log.success("Synap IS configured as OpenClaw provider. Restart OpenClaw to apply.");
        log.dim(`Models: ${models.slice(0, 3).map((m) => m.id).join(", ")}${models.length > 3 ? ` +${models.length - 3} more` : ""}`);
      }
    }
  }
}

function printSummary(podUrl: string, openclawConnected: boolean): void {
  log.blank();
  console.log(chalk.green("═══════════════════════════════════════════"));
  console.log(chalk.green.bold("  Synap Setup Complete"));
  console.log(chalk.green("═══════════════════════════════════════════"));
  log.blank();
  log.info(`Pod: ${podUrl}`);
  if (openclawConnected) log.info("Skill: synap (knowledge graph + relay)");
  log.blank();
  if (openclawConnected) {
    log.info("Try it now:");
    log.dim('  Ask your agent: "remember that Marc prefers email"');
    log.dim('  Then later: "what do I know about Marc?"');
  }
  log.blank();
  log.dim("  synap status: health check");
  log.blank();
  if (!openclawConnected) {
    log.info("OpenClaw is provisioning on your pod server (2-5 min).");
    log.info("Once it's ready, run:");
    log.blank();
    console.log(chalk.cyan("  synap update"));
    log.blank();
    log.dim("This will install the skill, seed your workspace, and configure AI routing.");
    log.dim("Check progress: synap status");
  }
}

async function loginAndSelectPod(): Promise<{ url: string; podId: string } | null> {
  // Check if already logged in
  const authStatus = await isLoggedIn();

  if (authStatus.valid) {
    log.success(`Already logged in as ${authStatus.email}`);
  } else {
    log.info("You are not currently logged in to Synap.");
  }

  let storedToken = getStoredToken();
  if (!storedToken || !authStatus.valid) {
    // No token or not valid — need to login
    log.info("Opening browser to sign in and select your pod...");
    const spinner = ora("Waiting for browser authentication...").start();

    const creds = await login();

    if (!creds) {
      spinner.fail("Authentication timed out or failed");
      log.dim("Try again or use --pod-url to connect directly");
      return null;
    }

    spinner.succeed(`Authenticated as ${creds.email}`);

    // If the web flow already performed pod selection, use that result directly.
    if (creds.podUrl && creds.podId) {
      const healthSpinner = ora("Checking pod health...").start();
      const status = await checkPodHealth(creds.podUrl);
      if (status.healthy) {
        healthSpinner.succeed(`Pod ready at ${creds.podUrl}`);
        return { url: creds.podUrl, podId: creds.podId };
      }
      healthSpinner.warn(`Pod selected (${creds.podUrl}) but not yet reachable. It may still be provisioning.`);
      return { url: creds.podUrl, podId: creds.podId };
    }

    // After login, re-fetch stored token (login() writes credentials)
    storedToken = getStoredToken();
  }

  // We have a valid token
  if (!storedToken) {
    log.warn("No stored credentials found. Please sign in.");
    return null;
  }

  // Short-circuit if credentials already carry a pod from a previous web-based selection.
  if (storedToken.podUrl && storedToken.podId) {
    log.info(`You have a previously selected pod: ${storedToken.podUrl}`);
    const { useExisting } = await prompts({
      type: "confirm",
      name: "useExisting",
      message: "Use this pod?",
      initial: true,
    });

    if (useExisting) {
      const healthSpinner = ora("Checking pod health...").start();
      const status = await checkPodHealth(storedToken.podUrl);
      if (status.healthy) {
        healthSpinner.succeed(`Pod healthy at ${storedToken.podUrl}`);
        return { url: storedToken.podUrl, podId: storedToken.podId };
      }
      healthSpinner.fail(`Pod not reachable at ${storedToken.podUrl}`);
      log.blank();
    }
    // Fall through to pod selection if user doesn't want to use existing pod or pod is unreachable
  }

  // List pods
  const podsSpinner = ora("Fetching your pods...").start();
  try {
    const pods = await listPods(storedToken.token);

    if (pods.length === 0) {
      podsSpinner.info("No pods on your account yet");
      const created = await createPodStep();
      return created ? { url: created.podUrl, podId: "" } : null;
    }

    podsSpinner.succeed(`Found ${pods.length} pod(s)`);
    log.blank();
    log.info("Your available pods:");

    if (pods.length === 1) {
      const pod = pods[0];
      const podUrl = pod.url || `https://${pod.subdomain}.synap.live`;
      log.dim(`  • ${podUrl} (${pod.status})`);

      const { connect } = await prompts({
        type: "confirm",
        name: "connect",
        message: `Connect to this pod?`,
        initial: true,
      });

      if (!connect) return null;

      const healthSpinner = ora("Checking pod health...").start();
      const status = await checkPodHealth(podUrl);
      if (status.healthy) {
        healthSpinner.succeed(`Pod healthy at ${podUrl}`);
        return { url: podUrl, podId: pod.id };
      }
      healthSpinner.fail(`Pod not reachable at ${podUrl}`);
      return null;
    }

    // Multiple pods — let user choose
    const { selectedPodUrl } = await prompts({
      type: "select",
      name: "selectedPodUrl",
      message: "Which pod do you want to connect to?",
      choices: pods.map((pod) => {
        const podUrl = pod.url || `https://${pod.subdomain}.synap.live`;
        return {
          title: `${pod.subdomain} (${pod.status}), ${pod.region}`,
          description: podUrl,
          value: podUrl,
        };
      }),
    });

    if (!selectedPodUrl) return null;

    const selectedPod = pods.find((p) => (p.url || `https://${p.subdomain}.synap.live`) === selectedPodUrl);

    const healthSpinner = ora("Checking pod health...").start();
    const status = await checkPodHealth(selectedPodUrl);
    if (status.healthy) {
      healthSpinner.succeed(`Pod healthy at ${selectedPodUrl}`);
      return { url: selectedPodUrl, podId: selectedPod?.id ?? "" };
    }
    healthSpinner.fail(`Pod not reachable at ${selectedPodUrl}`);
    return null;
  } catch (err) {
    podsSpinner.fail(err instanceof Error ? err.message : "Failed to fetch pods");
    return null;
  }
}

// =============================================================================
// HELPERS
// =============================================================================

function detectServer(): boolean {
  try {
    const platform = process.platform;
    if (platform !== "linux") return false;
    execSync("docker info >/dev/null 2>&1", { timeout: 5000 });
    return true;
  } catch {
    return false;
  }
}

/**
 * Does the environment carry ANY signal that a Synap pod exists somewhere?
 * Used by `init` to decide whether to run the full flow or short-circuit
 * with a "no pod detected" instruction message.
 *
 * Treat these as signals (in cheap-to-expensive order):
 *   1. SYNAP_POD_URL env var
 *   2. A stored ~/.synap/pod-config.json from a previous run
 *   3. A running pod detected on this machine
 *   4. An OpenClaw install that already has synap.podUrl configured
 */
async function hasAnyPodSignal(): Promise<boolean> {
  if (process.env.SYNAP_POD_URL) return true;
  if (getLocalPodConfig()?.podUrl) return true;

  // OpenClaw may already carry a pod URL in its config — respect that.
  try {
    const oc = detectOpenClaw();
    const ocSynap = (oc.config as Record<string, unknown> | undefined)?.synap as
      | Record<string, unknown>
      | undefined;
    if (typeof ocSynap?.podUrl === "string" && ocSynap.podUrl.length > 0) return true;
  } catch {
    // ignore — detection is best-effort
  }

  // Last: probe the local machine. This is the expensive step.
  const local = await detectLocalPod();
  return Boolean(local);
}

function printNoPodInstructions(): void {
  const line = "─".repeat(64);
  console.log(`
┌${line}┐
│ No Synap pod detected.                                         │
│                                                                │
│ You need a running pod before using @synap-core/cli init.      │
│                                                                │
│ Options:                                                       │
│                                                                │
│   1. Self-host on a server (free):                             │
│      On your server, run:                                      │
│        curl -fsSL https://synap.live/install.sh | bash         │
│      Then come back and run:                                   │
│        npx @synap-core/cli init --pod-url https://your-pod...  │
│                                                                │
│   2. Use a hosted pod ($):                                     │
│      Sign up at https://synap.live                             │
│      Then run:                                                 │
│        npx @synap-core/cli init --pod-url <your-pod-url>       │
│                                                                │
│   3. Already running locally? Pass --pod-url:                  │
│        npx @synap-core/cli init --pod-url http://localhost:4000│
└${line}┘
`);
}

function printUnreachablePodInstructions(podUrl: string): void {
  console.log("");
  log.error(`Pod at ${podUrl} is not reachable.`);
  log.blank();
  log.info("Checklist:");
  log.dim("  - Is the pod URL correct? (scheme + host + port)");
  log.dim("  - Is the pod container running? On the server: ./synap health");
  log.dim("  - Is there a firewall or reverse proxy in the way?");
  log.dim("  - For localhost setups, did you start the stack? ./synap start");
  log.blank();
  log.info("Once the pod is reachable, re-run:");
  log.dim(`  npx @synap-core/cli init --pod-url ${podUrl}`);
  log.blank();
}

/**
 * Probe the local machine for a running Synap pod.
 * Returns the best URL candidate if found, null otherwise.
 *
 * Detection order (cheapest → most reliable):
 *   1. SYNAP_POD_URL env var
 *   2. Deploy dir scan — read PUBLIC_URL / DOMAIN from .env, Caddyfile
 *   3. Docker — inspect synap-backend containers for the Caddy proxy port
 *   4. HTTP health probe — /health fingerprint confirms it's really Synap
 */
async function detectLocalPod(): Promise<string | null> {
  // ── 1. Env var ──────────────────────────────────────────────────────────
  if (process.env.SYNAP_POD_URL) return process.env.SYNAP_POD_URL;

  const candidates: string[] = [];

  // ── 2. Deploy dir scan ──────────────────────────────────────────────────
  // Look for a .env that has PUBLIC_URL or DOMAIN, which tells us the
  // canonical URL Caddy is serving on.
  const deployDirs = [
    process.cwd(),
    `${process.env.HOME}/pkm_stacks/synap-backend/deploy`,
    `${process.env.HOME}/pkm_stacks/synap-backend`,
    `${process.env.HOME}/synap-backend/deploy`,
    `${process.env.HOME}/synap-backend`,
    `${process.env.HOME}/synap/deploy`,
    `${process.env.HOME}/synap`,
    "/srv/synap/deploy",
    "/srv/synap",
    "/opt/synap/deploy",
    "/opt/synap",
  ];

  for (const dir of deployDirs) {
    try {
      // Read .env for PUBLIC_URL or DOMAIN
      const envFile = `${dir}/.env`;
      if (fs.existsSync(envFile)) {
        const env = fs.readFileSync(envFile, "utf-8");
        const publicUrl = env.match(/^PUBLIC_URL=(.+)$/m)?.[1]?.trim().replace(/['"]/g, "");
        if (publicUrl && !publicUrl.includes("backend:4000")) {
          candidates.push(publicUrl);
        }
        const domain = env.match(/^DOMAIN=(.+)$/m)?.[1]?.trim().replace(/['"]/g, "");
        if (domain && !domain.includes("localhost") && !domain.includes("example")) {
          candidates.push(`https://${domain}`);
          candidates.push(`http://${domain}`);
        }
      }

      // Check compose file exists — confirms this is a Synap deploy dir
      const composeFile = [
        `${dir}/docker-compose.standalone.yml`,
        `${dir}/docker-compose.yml`,
      ].find((f) => fs.existsSync(f));

      if (composeFile) {
        const content = fs.readFileSync(composeFile, "utf-8");
        if (/ghcr\.io\/synap-core\/backend|synap-backend/i.test(content)) {
          // Synap compose stack found — Caddy always binds to port 80
          candidates.push("http://localhost:80");
          candidates.push("http://localhost");
        }
      }
    } catch {
      // skip unreadable dirs
    }
  }

  // ── 3. Docker ps — look for the Caddy container port ───────────────────
  try {
    const out = execSync(
      "docker ps --format '{{.Names}}\\t{{.Image}}\\t{{.Ports}}' 2>/dev/null",
      { timeout: 4000 }
    ).toString();

    for (const line of out.split("\n")) {
      // Caddy proxy container
      if (/caddy/i.test(line)) {
        const portMatch = line.match(/0\.0\.0\.0:(\d+)->80/);
        if (portMatch) {
          candidates.push(`http://localhost:${portMatch[1]}`);
        } else if (/->80\/tcp/.test(line)) {
          candidates.push("http://localhost");
        }
      }
      // Backend container exposed directly (non-standard setups)
      if (/synap.*backend|backend.*synap/i.test(line)) {
        const portMatch = line.match(/0\.0\.0\.0:(\d+)->4000/);
        if (portMatch) candidates.push(`http://localhost:${portMatch[1]}`);
      }
    }
  } catch {
    // docker not available
  }

  // ── 4. HTTP probe — confirm with Synap fingerprint ──────────────────────
  // Add fallback ports to check directly
  candidates.push("http://localhost:4000", "http://localhost:80", "http://localhost");

  // Deduplicate while preserving order
  const seen = new Set<string>();
  const deduped = candidates.filter((u) => {
    const key = u.replace(/\/$/, "");
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  for (const baseUrl of deduped) {
    try {
      const url = `${baseUrl.replace(/\/$/, "")}/health`;
      const res = await fetch(url, { signal: AbortSignal.timeout(2000) });
      if (!res.ok) continue;
      const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
      // Fingerprint: Synap /health returns { status: "ok", service: "hub-protocol" }
      // or { status: "ok|ready|degraded" } from the tRPC healthRouter
      const isSynap =
        (data.service === "hub-protocol") ||
        (typeof data.status === "string" && ["ok", "ready", "degraded"].includes(data.status as string));
      if (isSynap) return baseUrl.replace(/\/$/, "");
    } catch {
      // not reachable — try next
    }
  }

  return null;
}
