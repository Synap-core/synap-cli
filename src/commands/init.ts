/**
 * synap init
 *
 * Three paths based on environment detection:
 *   A: OpenClaw found → connect mode (primary funnel, 250K users)
 *   B: Server, no OpenClaw → bundle mode (fresh setup)
 *   C: Laptop/desktop → need hosting
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
import { runSecurityChecks, computeScore } from "../lib/hardening.js";
import {
  checkPodHealth,
  setupAgent,
  setupAgentViaCp,
  provisionUserOnPod,
  installSynapSkill,
  enableOpenClawAddonManaged,
  saveLocalPodConfig,
  checkServerResources,
  startOpenClawOnServer,
  getLocalPodConfig,
} from "../lib/pod.js";
import { seedAgentEntities } from "../lib/seed.js";
import { login, isLoggedIn, listPods, getStoredToken, waitForPodCallback } from "../lib/auth.js";

interface InitOptions {
  podUrl?: string;
  apiKey?: string;
  skipSecurity?: boolean;
  skipIs?: boolean;
}

export async function init(opts: InitOptions): Promise<void> {
  banner();

  // ── Auto-detect environment ─────────────────────────────────────────────
  const oc = detectOpenClaw();
  const isServer = detectServer();

  if (oc.found) {
    log.info(
      `OpenClaw detected${oc.version ? ` v${oc.version}` : ""} — connect mode`
    );
    await pathA(opts, oc);
    return;
  }

  if (isServer) {
    // Before assuming fresh install, check if a pod is already running
    const spinner = ora("Scanning for existing Synap pod...").start();
    const existingPodUrl = opts.podUrl ?? (await detectLocalPod());
    spinner.stop();

    if (existingPodUrl) {
      log.success(`Found existing pod at ${existingPodUrl}`);
      log.info("Server detected, no OpenClaw — connecting to existing pod");
      await pathBExisting(opts, existingPodUrl);
    } else {
      log.info("Server detected, no OpenClaw — fresh setup mode");
      await pathB(opts);
    }
    return;
  }

  log.info("Running on desktop — hosting mode");
  await pathC(opts);
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

  // ── Security ────────────────────────────────────────────────────────────
  if (!opts.skipSecurity) {
    await securityStep(oc.version);
  }

  // ── Pod ─────────────────────────────────────────────────────────────────
  const podUrl = await podChoiceStep(opts);
  if (!podUrl) return;

  // ── Connect ─────────────────────────────────────────────────────────────
  const apiKey = await connectStep(podUrl, opts, true);
  if (!apiKey) return;

  // ── Skill ───────────────────────────────────────────────────────────────
  await skillStep(true);

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

  // OpenClaw
  log.heading("Step 2: OpenClaw");
  log.info("No OpenClaw detected — choose how to add it:");
  const { ocChoice } = await prompts({
    type: "select",
    name: "ocChoice",
    message: "How would you like to run OpenClaw?",
    choices: [
      {
        title: "Docker container on this server (recommended)",
        description: "Adds openclaw profile to your existing docker-compose stack",
        value: "docker",
      },
      {
        title: "npm install -g openclaw (native process)",
        description: "Runs as a Node.js process, no Docker needed",
        value: "npm",
      },
      {
        title: "Skip — I'll install OpenClaw separately",
        value: "skip",
      },
    ],
  });

  if (ocChoice === "docker") {
    const localConfig = getLocalPodConfig();
    const startSpinner = ora("Starting OpenClaw container...").start();
    try {
      startOpenClawOnServer(
        apiKey,
        localConfig?.agentUserId ?? "",
        localConfig?.workspaceId ?? "",
        podUrl
      );
      startSpinner.succeed("OpenClaw container started");
    } catch (err) {
      startSpinner.fail(err instanceof Error ? err.message : String(err));
      log.dim("Start manually: docker compose --profile openclaw up -d openclaw");
      log.dim("Then run: synap finish");
    }
  } else if (ocChoice === "npm") {
    log.blank();
    log.info("Install OpenClaw:");
    console.log(chalk.cyan("  npm install -g openclaw"));
    console.log(chalk.cyan("  openclaw start"));
    log.blank();
    log.info("Then run: synap finish");
    return;
  } else {
    log.info("Skipped. Run `synap finish` once OpenClaw is running.");
    return;
  }

  // Rest of setup
  await skillStep(true);
  const oc = detectOpenClaw();
  await seedStep(podUrl, apiKey, oc);
  if (!opts.skipIs) {
    await isStep(podUrl, apiKey, oc.found);
  }
  printSummary(podUrl, oc.found);
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
    log.success(`Found a running pod at ${existingUrl} — switching to connect mode`);
    await pathBExisting(opts, existingUrl);
    return;
  }

  // Resource check
  const resources = checkServerResources();
  log.info(`RAM: ${resources.ramTotal}MB total, ${resources.ramFree}MB free`);
  log.info(`Disk: ${resources.diskFree} free`);

  if (resources.ramFree < 1500) {
    log.warn(
      "Low RAM — Synap + OpenClaw need ~1.5GB. Performance may be affected."
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
        description: "Recommended — everything on this server",
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

  // If bundle mode, start the OpenClaw Docker container using the key we just got
  if (installChoice === "bundle") {
    const spinner = ora("Starting OpenClaw container...").start();
    try {
      const localConfig = getLocalPodConfig();
      startOpenClawOnServer(
        apiKey,
        localConfig?.agentUserId ?? "",
        localConfig?.workspaceId ?? "",
        podUrl
      );
      spinner.succeed("OpenClaw started and healthy");
    } catch (err) {
      spinner.fail(err instanceof Error ? err.message : String(err));
      log.dim("Start manually: docker compose --profile openclaw up -d openclaw");
    }
  }

  await skillStep(installChoice === "bundle");

  // Detect OpenClaw after potential install
  const oc = detectOpenClaw();
  await seedStep(podUrl, apiKey, oc);

  if (!opts.skipIs) {
    await isStep(podUrl, apiKey, oc.found);
  }

  printSummary(podUrl, installChoice === "bundle");
}

// =============================================================================
// PATH C: Laptop/desktop user
// =============================================================================

async function pathC(opts: InitOptions): Promise<void> {
  log.heading("Step 1: Connect to Your Pod");

  const { hostChoice } = await prompts({
    type: "select",
    name: "hostChoice",
    message: "How do you want to connect?",
    choices: [
      {
        title: "Login to Synap (managed pods)",
        description: "Sign in via browser — auto-detect your pods",
        value: "login",
      },
      {
        title: "Connect to an existing pod (enter URL)",
        description: "Self-hosted or managed — enter the URL directly",
        value: "existing",
      },
      {
        title: "I don't have a pod yet",
        value: "none",
      },
    ],
  });

  if (hostChoice === "login") {
    const podResult = await loginAndSelectPod();
    if (!podResult) return;
    await connectExistingPod(podResult.url, opts, "managed", podResult.podId);
    return;
  }

  if (hostChoice === "none") {
    const { createChoice } = await prompts({
      type: "select",
      name: "createChoice",
      message: "Create a pod:",
      choices: [
        {
          title: "Managed by Synap — €15/mo",
          description: "We host it, zero ops",
          value: "managed",
        },
        {
          title: "Self-hosted on my VPS — FREE",
          value: "vps",
        },
      ],
    });

    if (createChoice === "managed") {
      log.blank();
      log.info("Opening synap.live to provision your pod...");
      log.info(chalk.dim("(Waiting up to 5 minutes for provisioning to complete)"));
      log.blank();

      const spinner = ora("Waiting for pod provisioning...").start();
      const result = await waitForPodCallback();

      if (result) {
        spinner.succeed(`Pod provisioned at ${chalk.cyan(result.podUrl)}`);
        await connectExistingPod(result.podUrl, opts, "managed");
      } else {
        spinner.fail("Pod provisioning timed out or was cancelled.");
        log.blank();
        log.info("You can resume at any time by running: " + chalk.cyan("synap init"));
        log.info("Or connect manually: " + chalk.cyan(`synap connect --pod-url <your-pod-url>`));
      }
    } else if (createChoice === "vps") {
      log.blank();
      log.info("SSH into your server and run:");
      console.log(
        chalk.cyan(
          "\n  curl -fsSL https://raw.githubusercontent.com/Synap-core/backend/main/install.sh | bash\n"
        )
      );
      log.info("Then on that server: npx @synap/cli init");
    }
    return;
  }

  if (hostChoice === "existing") {
    const { url } = await prompts({
      type: "text",
      name: "url",
      message: "Pod URL:",
      initial: "https://pod.synap.live",
    });
    if (!url) return;

    const spinner = ora("Checking pod health...").start();
    const status = await checkPodHealth(url);
    if (!status.healthy) {
      spinner.fail(`Pod not reachable at ${url}`);
      return;
    }
    spinner.succeed(`Pod healthy at ${url}`);

    // Detect if self-hosted or managed by checking URL
    const isSynapLive = url.includes("synap.live");
    await connectExistingPod(url, opts, isSynapLive ? "managed" : "self-hosted");
  }
}

/**
 * Connect to an existing pod — handles both self-hosted and managed.
 */
async function connectExistingPod(
  podUrl: string,
  opts: InitOptions,
  podType: "self-hosted" | "managed",
  podId?: string
): Promise<void> {
  // Check for local OpenClaw
  const oc = detectOpenClaw();
  if (oc.found) {
    log.success(`OpenClaw detected${oc.version ? ` v${oc.version}` : ""}`);
    if (!opts.skipSecurity) await securityStep(oc.version);
  }

  // Get API key
  const apiKey = await connectStep(podUrl, opts, oc.found, podId);
  if (!apiKey) return;

  // OpenClaw handling
  if (!oc.found) {
    log.heading("OpenClaw");
    const { ocChoice } = await prompts({
      type: "select",
      name: "ocChoice",
      message: "OpenClaw not detected locally. What would you like to do?",
      choices: [
        {
          title: "Enable OpenClaw on my pod server (free addon)",
          description: "Runs alongside your pod via Docker — zero extra cost",
          value: "addon",
        },
        {
          title: "Install OpenClaw on this computer",
          description: "npm i -g openclaw",
          value: "local",
        },
        { title: "Skip OpenClaw for now", value: "skip" },
      ],
    });

    if (ocChoice === "addon") {
      if (podType === "self-hosted") {
        log.blank();
        log.info("SSH into your pod server and run:");
        log.blank();
        console.log(chalk.cyan("  cd /srv/synap && ./deploy/setup-openclaw.sh"));
        log.blank();
        log.info("This will start OpenClaw as a Docker addon on your pod.");
        log.info("Then re-run: synap init --pod-url " + podUrl);
      } else {
        // Managed pod — activate via CP (requires user session, not PROVISIONING_TOKEN)
        log.info("Activating OpenClaw addon on your managed pod...");
        const creds = getStoredToken();
        try {
          if (!creds) throw new Error("Not logged in to CP");
          await enableOpenClawAddonManaged(creds.token, podUrl);
          log.success("OpenClaw addon provisioning started — may take a minute");
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          if (msg.includes("422") || msg.includes("provisioned pod server")) {
            // Pod doesn't have a managed server — OpenClaw can't run server-side
            log.blank();
            log.info("Your pod doesn't have a managed server for addons.");
            log.info("Install OpenClaw locally instead:");
            log.dim("  npm i -g openclaw && openclaw onboard");
            log.info("Then re-run: " + chalk.cyan(`synap init --pod-url ${podUrl}`));
          } else {
            log.warn("Could not activate OpenClaw automatically.");
            log.dim(msg);
            log.info("Enable it from: https://synap.live/account/pods");
          }
        }
      }
    } else if (ocChoice === "local") {
      log.blank();
      log.info("Install OpenClaw:");
      log.dim("  npm i -g openclaw && openclaw onboard");
      log.info("Then re-run: synap init --pod-url " + podUrl);
      return;
    }
  }

  // Install skill + seed (if OpenClaw available)
  const ocAfter = detectOpenClaw();
  if (ocAfter.found) {
    await skillStep(true);
    await seedStep(podUrl, apiKey, ocAfter);
    if (!opts.skipIs) await isStep(podUrl, apiKey, true);
  } else {
    log.blank();
    log.info("Pod connected. Once OpenClaw is running, install the skill:");
    log.dim("  openclaw skills install synap");
  }

  printSummary(podUrl, ocAfter.found);
}

// =============================================================================
// SHARED STEPS
// =============================================================================

export async function securityStep(version?: string): Promise<void> {
  log.heading("Security Audit");

  const checks = runSecurityChecks(version);
  const failed = checks.filter((c) => !c.passed);
  const score = computeScore(checks);
  const passed = checks.filter((c) => c.passed).length;

  console.log(
    `  ${passed}/${checks.length} passed — Score: ${score === "A" ? chalk.green.bold("A") : score === "B" ? chalk.yellow.bold("B") : chalk.red.bold(score)}`
  );

  if (failed.length > 0) {
    const fixable = failed.filter((c) => c.fixable && c.fix);
    if (fixable.length > 0) {
      const { doFix } = await prompts({
        type: "confirm",
        name: "doFix",
        message: `Auto-fix ${fixable.length} issue(s)?`,
        initial: true,
      });
      if (doFix) {
        for (const check of fixable) {
          check.fix!();
          log.success(`Fixed: ${check.name}`);
        }
      }
    }
    for (const check of failed.filter((c) => !c.fixable)) {
      log.warn(`${check.name} — ${check.message}`);
    }
  } else {
    log.success("All checks passed");
  }
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
        title: "Login to Synap — connect to your existing pod",
        description: "Sign in via browser and find your pod automatically",
        value: "login",
      },
      {
        title: "This machine (docker-compose) — FREE",
        description: "Runs alongside OpenClaw, ~1.5GB RAM",
        value: "local",
      },
      {
        title: "Managed by Synap — €15/mo",
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

  log.blank();
  log.info("Install Synap pod with:");
  log.blank();
  console.log(
    chalk.cyan(
      "  curl -fsSL https://raw.githubusercontent.com/Synap-core/backend/main/install.sh | bash"
    )
  );
  log.blank();

  const { proceed } = await prompts({
    type: "confirm",
    name: "proceed",
    message: "Run the installer now?",
    initial: true,
  });

  if (proceed) {
    try {
      execSync(
        "curl -fsSL https://raw.githubusercontent.com/Synap-core/backend/main/install.sh | bash",
        { stdio: "inherit" }
      );
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
  podId?: string
): Promise<string | null> {
  log.heading("Connect to Pod");

  let apiKey = opts.apiKey;

  if (!apiKey) {
    // Check if user is authenticated via CP — if so, auto-generate key
    const creds = getStoredToken();
    const isAuthenticated = creds && new Date(creds.expiresAt) > new Date();

    if (isAuthenticated) {
      // User is logged in — generate API key automatically via CP session
      // The pod trusts the user's session to create agent credentials
      const spinner = ora("Generating API key for OpenClaw agent...").start();
      try {
        // Provision the user on the pod (creates Kratos identity + pod user account)
        // This is idempotent — safe to call on every init
        try {
          await provisionUserOnPod(podUrl, creds!.token);
        } catch (err) {
          // Non-fatal: log warning, proceed anyway (user may already exist from Browser/Relay login)
          log.warn(`Could not provision user on pod: ${err instanceof Error ? err.message : String(err)}`);
        }

        // Try using the user's CP session token to call the pod directly
        // The pod's setup/agent endpoint accepts PROVISIONING_TOKEN,
        // but for managed pods we can also use the CP to relay the request
        const result = await setupAgentViaCp(podUrl, creds!.token, "openclaw");
        apiKey = result.hubApiKey;
        opts.apiKey = apiKey;
        spinner.succeed("API key generated");
        log.dim(`Agent user: ${result.agentUserId}`);
        log.dim(`Workspace: ${result.workspaceId}`);
        log.blank();
        log.info("This key lets OpenClaw read/write your knowledge graph.");
        log.info("It's scoped to Hub Protocol operations only.");

        // Always save to ~/.synap/pod-config.json (works even without OpenClaw)
        saveLocalPodConfig({
          podUrl,
          podId: podId ?? undefined,
          workspaceId: result.workspaceId,
          agentUserId: result.agentUserId,
          hubApiKey: result.hubApiKey,
          savedAt: new Date().toISOString(),
        });

        if (openclawFound) {
          const config = readOpenClawConfig() ?? {};
          setConfigValue(config, "synap.podUrl", podUrl);
          setConfigValue(config, "synap.workspaceId", result.workspaceId);
          setConfigValue(config, "synap.agentUserId", result.agentUserId);
          writeOpenClawConfig(config);
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        spinner.fail(`Auto-generation failed: ${msg}`);
        // Fall through to manual options below
      }
    }

    if (!apiKey) {
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
        const { key } = await prompts({
          type: "password",
          name: "key",
          message: "Hub Protocol API key:",
        });
        apiKey = key;
      } else {
        const { token } = await prompts({
          type: "password",
          name: "token",
          message: "PROVISIONING_TOKEN (from pod .env):",
        });

        if (token) {
          const spinner = ora("Creating agent credentials...").start();
          try {
            const result = await setupAgent(podUrl, token, "openclaw");
            apiKey = result.hubApiKey;
            opts.apiKey = apiKey;
            spinner.succeed("Credentials created");
            log.dim(`Agent: ${result.agentUserId}`);
            log.dim(`Workspace: ${result.workspaceId}`);

            saveLocalPodConfig({
              podUrl,
              podId: podId ?? undefined,
              workspaceId: result.workspaceId,
              agentUserId: result.agentUserId,
              hubApiKey: result.hubApiKey,
              savedAt: new Date().toISOString(),
            });

            if (openclawFound) {
              const config = readOpenClawConfig() ?? {};
              setConfigValue(config, "synap.podUrl", podUrl);
              setConfigValue(config, "synap.workspaceId", result.workspaceId);
              setConfigValue(config, "synap.agentUserId", result.agentUserId);
              writeOpenClawConfig(config);
            }
          } catch (err) {
            spinner.fail(err instanceof Error ? err.message : String(err));
            return null;
          }
        }
      }
    }
  }

  if (apiKey) {
    log.success(`API Key: ${apiKey}`);
    log.warn("Save this key — it will not be shown again.");
  }

  return apiKey ?? null;
}

export async function skillStep(openclawFound: boolean): Promise<void> {
  if (!openclawFound) return;

  log.heading("Install Skill");

  const spinner = ora("Installing synap skill...").start();
  try {
    installSynapSkill();
    spinner.succeed("Synap skill installed");
  } catch (err) {
    spinner.fail(err instanceof Error ? err.message : "Failed");
    log.dim("Install manually: openclaw skills install synap");
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
  log.dim("Route AI through Synap — 90% on free models, save 50-80%");

  // 1. Check current IS status on the pod
  const spinner = ora("Checking Intelligence Service status...").start();
  let isActive = false;
  let needsProvision = false;

  try {
    const statusRes = await fetch(`${podUrl}/api/provision/status`, {
      signal: AbortSignal.timeout(5000),
    }).catch(() => null);

    if (statusRes?.ok) {
      const data = (await statusRes.json()) as {
        intelligenceService?: { status: string } | null;
      };
      isActive = data?.intelligenceService?.status === "active";
    }
  } catch {
    // Pod may not support this endpoint — continue
  }

  if (isActive) {
    spinner.succeed("Intelligence Service is already active on this pod");
  } else {
    spinner.info("Intelligence Service is not active on this pod");
    needsProvision = true;
  }

  // 2. If IS is not active, try to provision via CP (if user is logged in)
  if (needsProvision) {
    const creds = getStoredToken();
    if (creds) {
      // Check CP subscription status
      const cpUrl = process.env.SYNAP_CP_URL ?? "https://api.synap.live";
      try {
        // Find the pod ID from CP
        const pods = await listPods(creds.token);
        const matchingPod = pods.find((p: { podUrl?: string; url?: string }) =>
          (p.podUrl ?? p.url ?? "").replace(/\/+$/, "") === podUrl.replace(/\/+$/, "")
        );

        if (matchingPod) {
          const podId = (matchingPod as { id: string }).id;

          // Check IS provision status on CP
          const provStatus = await fetch(
            `${cpUrl}/intelligence/provision/status/${podId}`,
            { headers: { Authorization: `Bearer ${creds.token}` } }
          ).catch(() => null);

          const provData = provStatus?.ok
            ? ((await provStatus.json()) as { subscribed?: boolean; cpProvisioned?: boolean })
            : null;

          if (provData?.subscribed && !provData?.cpProvisioned) {
            // User has subscription but IS not provisioned — offer to provision
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
            log.dim("No AI subscription found. Subscribe at https://synap.live/pricing");
            log.dim("Or use --skip-is to skip this step");
          } else if (provData?.cpProvisioned) {
            log.dim("IS is provisioned on CP but pod may need reconnection.");
            log.dim("Try reprovisioning from the Browser app: Settings > Add-ons > Intelligence");
          }
        }
      } catch {
        log.dim("Could not check CP subscription status");
      }
    } else {
      log.dim("Sign in with 'synap login' to check your AI subscription and auto-provision IS");
    }
  }

  // 3. Configure OpenClaw provider (if found and IS is active)
  if (openclawFound && isActive) {
    const { configureOc } = await prompts({
      type: "confirm",
      name: "configureOc",
      message: "Configure Synap IS as OpenClaw AI provider?",
      initial: true,
    });

    if (configureOc) {
      const config = readOpenClawConfig() ?? {};
      setConfigValue(config, "models.providers.synap", {
        baseUrl: `${podUrl}/v1`,
        api: "openai-completions",
        apiKey,
        models: [
          { id: "synap/auto", name: "Synap Auto", contextWindow: 200000, maxTokens: 8192 },
          { id: "synap/balanced", name: "Synap Balanced", contextWindow: 131072, maxTokens: 8192 },
          { id: "synap/advanced", name: "Synap Advanced", contextWindow: 200000, maxTokens: 8192 },
        ],
      });
      writeOpenClawConfig(config);
      log.success("Synap IS configured as OpenClaw provider — restart OpenClaw to apply");
    }
  } else if (openclawFound && !isActive) {
    log.dim("Skipping OpenClaw provider configuration (IS not active)");
    log.dim("Once IS is provisioned, run 'synap init' again to configure the provider");
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
  log.dim("  synap status         — health check");
  log.dim("  synap security-audit — verify security");
  log.blank();
  if (!openclawConnected) {
    log.info("OpenClaw is provisioning on your pod server (2-5 min).");
    log.info("Once it's ready, run:");
    log.blank();
    console.log(chalk.cyan("  synap finish"));
    log.blank();
    log.dim("This will install the skill, seed your workspace, and configure AI routing.");
    log.dim("Check progress: synap status");
  }
}

async function loginAndSelectPod(): Promise<{ url: string; podId: string } | null> {
  // Check if already logged in
  const authStatus = await isLoggedIn();

  if (!authStatus.valid) {
    log.info("Opening browser to sign in...");
    const spinner = ora("Waiting for browser authentication...").start();

    const creds = await login();

    if (!creds) {
      spinner.fail("Authentication timed out or failed");
      log.dim("Try again or use --pod-url to connect directly");
      return null;
    }

    spinner.succeed(`Authenticated as ${creds.email}`);
  } else {
    log.success(`Already logged in as ${authStatus.email}`);
  }

  const token = getStoredToken();
  if (!token) return null;

  // List pods
  const podsSpinner = ora("Fetching your pods...").start();
  try {
    const pods = await listPods(token.token);

    if (pods.length === 0) {
      podsSpinner.info("No pods found on your account");
      log.blank();
      log.info("Create a pod at: " + chalk.cyan("https://synap.live"));
      log.info("Then re-run: " + chalk.dim("synap init"));
      return null;
    }

    podsSpinner.succeed(`Found ${pods.length} pod(s)`);

    if (pods.length === 1) {
      const pod = pods[0];
      const podUrl = pod.url || `https://${pod.subdomain}.synap.live`;
      const { connect } = await prompts({
        type: "confirm",
        name: "connect",
        message: `Connect to ${podUrl}?`,
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
          title: `${pod.subdomain} (${pod.status}) — ${pod.region}`,
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
