/**
 * synap init
 *
 * Laptop/desktop (the default): find or create a pod → connect the agents on
 * this machine (Claude Code, Codex, Cursor — one row each) → pair
 * the phone → hand the person one real task to give their agent.
 *
 * One flow for every machine, a server running a pod included: Synap is
 * agent-agnostic, so init connects the agents found here and installs none.
 */

import prompts from "prompts";
import ora from "ora";
import chalk from "chalk";
import { execSync } from "child_process";
import fs from "fs";
import { log, banner } from "../utils/logger.js";
import {
  checkPodHealth,
  getLocalPodConfig,
  listPodProfiles,
  addPodProfile,
  setActivePod,
  type LocalPodConfig,
} from "../lib/pod.js";
import { CP_URL, login, isLoggedIn, listPods, podUrlOf, getStoredToken, waitForPodCallback } from "../lib/auth.js";
import { detectAgents, type DetectableAgent } from "../lib/agent-detect.js";
import { createPodInBrowser } from "../lib/init-pod.js";
import { buildPairLink, renderTerminalQr } from "../lib/pair-link.js";
import { buildHandoff } from "../lib/init-handoff.js";
import { connectAgentsBatch } from "../lib/agent-door.js";
import { INIT_EXIT, InitExit } from "../lib/init-exit.js";
import { askControlPlaneWherePodIs, podMovedMessage } from "../lib/pod-moved.js";
import { reserveStdoutForJson } from "../lib/init-output.js";
import { isManagedPod, keyChoices, type KeyChoice } from "../lib/init-flow.js";
import { installWakeHookForProject } from "./hooks.js";
import {
  computerKeyNeedsRenewal,
  deviceConnect,
  DeviceStartError,
  saveDeviceGrant,
  wireApprovedAgents,
  type DeviceGrant,
} from "../lib/device-connect.js";

/** Where a phone without Relay gets it (synap-landing/app/download/relay). */
const RELAY_DOWNLOAD_URL = "https://synap.live/download/relay";

interface InitOptions {
  podUrl?: string;
  apiKey?: string;
  /** Accept the defaults: no prompt (the agents found here, "creates" approval). */
  yes?: boolean;
  /** Comma-separated agents to connect, e.g. "claude-code,codex". */
  agents?: string;
  /** Print a JSON summary on stdout (human lines go to stderr). */
  json?: boolean;
  /** Set by init: no prompt may run (no terminal, or --yes). */
  unattended?: boolean;
}

const AGENT_CHOICES: readonly DetectableAgent[] = ["claude-code", "codex", "cursor"];

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

/**
 * The one line for a pod address that redirects to another host: the new
 * address when the Control Plane knows it (never the redirect's), else what
 * to run to find it.
 */
async function movedPodLine(
  podUrl: string,
  next: (newUrl: string) => string,
  saved = false
): Promise<string> {
  const answer = await askControlPlaneWherePodIs({
    podUrl,
    cpUrl: CP_URL,
    cpToken: getStoredToken()?.token,
  });
  if (answer.kind === "moved") return `The pod at ${podUrl} moved to ${answer.podUrl}. ${next(answer.podUrl)}`;
  if (saved) return podMovedMessage(podUrl);
  return answer.kind === "signed-out"
    ? `The pod at ${podUrl} has a new address. Run: synap login — then run init again to look it up.`
    : `The pod at ${podUrl} has a new address. Use the address shown in your account.`;
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
    if (probe.moved) {
      throw new InitExit(
        INIT_EXIT.noPod,
        await movedPodLine(opts.podUrl, (to) => `Run: synap init --pod-url ${to}`)
      );
    }
    if (!probe.healthy) {
      printUnreachablePodInstructions(opts.podUrl);
      throw new InitExit(INIT_EXIT.noPod, `Pod at ${opts.podUrl} is not reachable.`, true);
    }
  }

  return desktopFlow(opts, agents);
}

// =============================================================================
// DESKTOP: pod → agents → phone → first task
// =============================================================================

async function desktopFlow(opts: InitOptions, agents?: DetectableAgent[]): Promise<InitSummary> {
  log.heading("Your pod");
  const pod = await resolveDesktopPod(opts);
  // The agents asked for WITH the computer: --agents, else the ones found here.
  const wanted = agents ?? detectAgents().filter((r) => r.found).map((r) => r.target);
  const { key: humanKey, grant } = await ensurePodKey(pod.podUrl, opts, pod.podId, wanted);

  // Connected just now: the person already chose the agents on the approval
  // page, so connect exactly those.
  const picked = grant
    ? grant.agents.map((a) => a.agentType).filter((t): t is DetectableAgent => (AGENT_CHOICES as readonly string[]).includes(t))
    : agents;
  const outcome = await connectAgentsStep(pod.podUrl, humanKey, opts, picked);
  // Claude Code connected: let another session's agent (or the person, in the
  // room) wake this project's terminals — the asyncRewake Stop hook.
  if (outcome.connected.includes("claude-code")) installWakeHookForProject();
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
    const health = await checkPodHealth(saved.podUrl);
    if (health.healthy) {
      spinner.succeed(`Pod: ${saved.podUrl}`);
      return { podUrl: saved.podUrl, podId: saved.podId };
    }
    if (health.moved) {
      spinner.fail();
      throw new InitExit(
        INIT_EXIT.noPod,
        await movedPodLine(saved.podUrl, () => "Run: synap doctor --fix", true)
      );
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

/** Sign-in first (and the default): a person with a pod on synap.live must not land on "Create". */
export const NO_POD_CHOICES = [
  { title: "I have one on synap.live (sign in)", value: "login" },
  { title: "Create in browser", value: "create" },
  { title: "I have a URL", value: "url" },
  { title: "Self-host", value: "self-host" },
] as const;

async function noPodStep(): Promise<{ podUrl: string; podId?: string }> {
  log.blank();
  const { choice } = await prompts({
    type: "select",
    name: "choice",
    message: "No Synap pod yet. Create one, or point me at yours?",
    choices: [...NO_POD_CHOICES],
    initial: 0,
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
    const health = await checkPodHealth(url);
    if (health.healthy) {
      spinner.succeed(`Pod: ${url}`);
      return { podUrl: url };
    }
    if (health.moved) {
      spinner.fail();
      throw new InitExit(
        INIT_EXIT.noPod,
        await movedPodLine(url, (to) => `Run: synap init --pod-url ${to}`)
      );
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
 * This computer's key for this pod — the one `/setup/agent` accepts to mint an
 * agent's key, and the CLI's own identity there. Reuses a saved profile for
 * this pod while it works and is not about to expire; otherwise connects this
 * computer through the pod's device flow (never without a person at the
 * terminal: unattended runs pass --api-key).
 *
 * `grant` is set when the device flow ran now: its agents were approved with
 * the computer, and their keys are already saved for their installers.
 */
async function ensurePodKey(
  podUrl: string,
  opts: InitOptions,
  podId?: string,
  agents: readonly DetectableAgent[] = []
): Promise<{ key: string; grant: DeviceGrant | null }> {
  if (opts.apiKey) return { key: opts.apiKey, grant: null };

  const norm = (u: string) => u.replace(/\/+$/, "");
  const saved = listPodProfiles().find((p) => norm(p.config.podUrl) === norm(podUrl));
  if (saved?.config.hubApiKey) {
    const res = await fetch(`${norm(podUrl)}/api/hub/auth/status`, {
      headers: { Authorization: `Bearer ${saved.config.hubApiKey}` },
      signal: AbortSignal.timeout(15_000),
    }).catch(() => null);
    const renew = computerKeyNeedsRenewal(saved.config);
    if (res?.ok && (!renew || opts.unattended)) {
      if (renew) {
        log.warn(`This computer's key for this pod expires ${saved.config.keyExpiresAt}. Renew it: ${chalk.cyan("synap login")}`);
      }
      if (!saved.active) setActivePod(saved.name);
      return { key: saved.config.hubApiKey, grant: null };
    }
    if (res?.ok) {
      log.info(`This computer's key for this pod expires ${saved.config.keyExpiresAt}. Renewing it.`);
    } else if (res && (res.status === 401 || res.status === 403)) {
      log.warn("Your saved key for this pod no longer works. Connecting this computer again.");
    } else {
      throw new InitExit(
        INIT_EXIT.noKey,
        `Could not check your saved key for this pod (${res ? `HTTP ${res.status}` : "unreachable"}).`
      );
    }
  }

  const { key, grant } = await connectStep(podUrl, opts, podId, agents);
  if (key) return { key, grant };
  throw new InitExit(
    INIT_EXIT.noKey,
    opts.unattended
      ? "No key for this pod. Pass --api-key <key>: without a person at the terminal, nobody can approve this computer."
      : "No key for this pod, so no agent can connect yet."
  );
}

/** A pod's profile name: its host name. Never another pod's profile. */
function podProfileName(podUrl: string): string {
  try {
    return new URL(podUrl).hostname;
  } catch {
    return "default";
  }
}

/** Save the pod as a named profile (host name) and make it active. */
function rememberPod(config: LocalPodConfig): void {
  const name = podProfileName(config.podUrl);
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
  // open ONE review page, then install with the approved keys. The same batch
  // door `synap agents add` uses — pod-wide, no scope.
  const result = await connectAgentsBatch({ podUrl, apiKey: humanKey }, picked, {}, {
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

/**
 * This computer's own key for this pod: it mints each agent's key and is
 * saved as a named profile.
 */
async function connectStep(
  podUrl: string,
  opts: InitOptions,
  podId?: string,
  /** Agents to ask the pod for along with this computer. */
  agents: readonly string[] = []
): Promise<{ key: string | null; grant: DeviceGrant | null }> {
  let apiKey = opts.apiKey;
  let grant: DeviceGrant | null = null;

  // Nobody at the terminal to approve a code or paste a key.
  if (!apiKey && opts.unattended) return { key: null, grant: null };

  // The pod's device flow: a code the person approves on any device. This
  // computer gets its own key; the agents asked for get theirs in the same step.
  let deviceTried = false;
  let deviceAvailable = true;
  const connectComputer = async (): Promise<void> => {
    deviceTried = true;
    let outcome;
    try {
      outcome = await deviceConnect(podUrl, { agents });
    } catch (err) {
      if (err instanceof DeviceStartError && err.status === 404) deviceAvailable = false;
      log.error(err instanceof Error ? err.message : String(err));
      return;
    }
    if (outcome.status !== "approved") {
      log.error(outcome.message);
      return;
    }
    grant = outcome.grant;
    apiKey = grant.computer.apiKey;
    opts.apiKey = apiKey;
    await saveDeviceGrant(podUrl, grant, { name: podProfileName(podUrl), podId });
    setActivePod(podProfileName(podUrl));
    log.success(`${grant.computer.name} connected`);
  };

  if (!apiKey) await connectComputer();

  // No key yet: connecting this computer again first, the advanced ways after.
  const managed = isManagedPod(podUrl);
  while (!apiKey) {
    const { keyChoice } = (await prompts({
      type: "select",
      name: "keyChoice",
      message: "How do you want to connect to this pod?",
      choices: keyChoices({ managed, deviceTried, deviceAvailable }),
    })) as { keyChoice?: KeyChoice };

    if (keyChoice === "device") {
      await connectComputer();
    } else if (keyChoice === "paste") {
      apiKey = await pasteKey(podUrl, podId);
      break;
    } else {
      break;
    }
  }

  return { key: apiKey ?? null, grant };
}

/** Ask for a key the person copies from their pod; saved as this pod's profile. */
async function pasteKey(
  podUrl: string,
  podId: string | undefined
): Promise<string | undefined> {
  const { key } = await prompts({
    type: "password",
    name: "key",
    message: "API key:",
  });
  if (key) {
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

/**
 * `synap login` with no pod saved: sign in to the Synap account, pick one of
 * its pods, issue this machine's key and save the profile — the same steps as
 * init's "sign in" path. Returns the pod URL, or null when no pod came of it.
 */
export async function signInAndSavePod(): Promise<string | null> {
  try {
    const pod = await loginAndSelectPod();
    if (!pod) return null;
    const wanted = detectAgents().filter((r) => r.found).map((r) => r.target);
    const { key, grant } = await ensurePodKey(pod.url, {}, pod.podId || undefined, wanted);
    // Approved with the computer: write each agent's own key into its config.
    if (grant) await wireApprovedAgents(pod.url, key, grant);
    return pod.url;
  } catch (err) {
    if (!(err instanceof InitExit)) throw err;
    if (!err.shown) log.error(err.message);
    return null;
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
    log.info("Sign in to Synap and pick your pod.");
    const creds = await login();

    if (!creds) {
      log.error("Sign-in timed out or failed.");
      log.dim("Try again or use --pod-url to connect directly");
      return null;
    }

    log.success(`Signed in as ${creds.email}`);

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
      const podUrl = podUrlOf(pod);
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
        const podUrl = podUrlOf(pod);
        return {
          title: `${pod.subdomain} · ${new URL(podUrl).host} (${pod.status})`,
          value: podUrl,
        };
      }),
    });

    if (!selectedPodUrl) return null;

    const selectedPod = pods.find((p) => podUrlOf(p) === selectedPodUrl);

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
  return probeThisMachineForPod();
}

/**
 * Steps 2-4 of detectLocalPod: a pod actually running on this machine. The
 * env var is left out on purpose: it points at a pod, often a remote one.
 */
async function probeThisMachineForPod(): Promise<string | null> {
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
