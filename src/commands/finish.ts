/**
 * synap finish
 *
 * Complete setup after OpenClaw has been provisioned. One-shot: after this
 * command, everything the user needs is ready — AI key, skill, IS, and public
 * dashboard URL.
 *
 * Steps:
 *  1. Verify pod connection (~/.synap/pod-config.json)
 *  2. Check pod health
 *  3. Check OpenClaw is running
 *  4. Security audit (local-install only)
 *  5. Install synap skill (via openclaw skills install)
 *  6. Seed workspace entities
 *  7. Configure AI provider — prompt if missing (via openclaw config set)
 *  8. Expose dashboard — offer if managed pod + OPENCLAW_DOMAIN unset
 *  9. Configure Synap IS as AI provider (optional)
 */

import chalk from "chalk";
import prompts from "prompts";
import fs from "node:fs";
import { execSync } from "child_process";
import { log, banner } from "../utils/logger.js";
import { detectOpenClaw } from "../lib/openclaw.js";
import { checkPodHealth, getLocalPodConfig, findSynapDeployDir } from "../lib/pod.js";
import { securityStep, skillStep, seedStep, isStep } from "./init.js";
import {
  openclawConfigure,
  openclawSetupDomain,
} from "./openclaw.js";

interface FinishOpts {
  skipIs?: boolean;
  skipAiKey?: boolean;
  skipDomain?: boolean;
}

export async function finish(opts: FinishOpts = {}): Promise<void> {
  banner();

  // ── Step 1: Verify pod config ──────────────────────────────────────────────
  const localConfig = getLocalPodConfig();
  if (!localConfig) {
    log.error("Not connected to a pod.");
    log.dim("Run: synap init");
    process.exit(1);
  }

  const { podUrl, hubApiKey } = localConfig;

  // ── Step 2: Check pod health ───────────────────────────────────────────────
  log.heading("Synap Pod");
  const pod = await checkPodHealth(podUrl);
  log.info(`URL: ${podUrl}`);
  if (!pod.healthy) {
    log.error("Pod is unreachable.");
    log.dim("Check your network connection and pod status.");
    log.dim("  synap status");
    process.exit(1);
  }
  log.success(`Health: ${chalk.green("healthy")}${pod.version ? ` (v${pod.version})` : ""}`);

  // ── Step 3: Check OpenClaw ─────────────────────────────────────────────────
  log.heading("OpenClaw");
  const oc = detectOpenClaw();

  if (!oc.found) {
    log.warn("OpenClaw is not running yet.");
    log.blank();
    log.dim("If you just ran `synap init`, the container may still be initializing (1-2 min).");
    log.dim("Check container status: synap status");
    log.dim("Check container logs:   docker logs openclaw --tail 30");
    log.blank();
    log.info("Run `synap finish` again once it's up.");
    return;
  }

  if (oc.runtime === "docker") {
    log.success(`Running in Docker container: ${chalk.cyan(oc.containerName ?? "openclaw")}`);
  } else {
    log.success(`Local install — version: ${oc.version ?? "unknown"}`);
  }
  log.info(
    `Gateway: ${oc.gatewayRunning ? chalk.green("running") : chalk.yellow("not responding")} (port ${oc.gatewayPort ?? 18789})`
  );

  if (!oc.gatewayRunning) {
    log.warn("Gateway not responding on port 18789 — OpenClaw may still be starting.");
    log.dim("Check: docker logs openclaw --tail 20");
    log.dim("Retry in a minute: synap finish");
    return;
  }

  // ── Step 4: Security audit (local only — can't inspect Docker config from host) ──
  if (oc.runtime !== "docker") {
    await securityStep(oc.version);
  }

  // ── Step 5: Install skill ──────────────────────────────────────────────────
  await skillStep(true, oc);

  // ── Step 6: Seed workspace ─────────────────────────────────────────────────
  await seedStep(podUrl, hubApiKey, oc);

  // ── Step 7: AI provider key ────────────────────────────────────────────────
  if (!opts.skipAiKey) {
    await aiKeyStep(oc);
  }

  // ── Step 8: Expose dashboard (managed pods) ────────────────────────────────
  if (!opts.skipDomain) {
    await domainStep(oc, podUrl);
  }

  // ── Step 9: Configure IS ───────────────────────────────────────────────────
  if (!opts.skipIs) {
    await isStep(podUrl, hubApiKey, true);
  }

  // ── Summary ────────────────────────────────────────────────────────────────
  printSummary(oc);
}

// ─── AI key step ─────────────────────────────────────────────────────────────

async function aiKeyStep(oc: ReturnType<typeof detectOpenClaw>): Promise<void> {
  log.heading("AI Provider");

  // Make sure the openclaw CLI inside the container is actually callable.
  // If not, skip the step entirely — the user can run `synap openclaw configure` later.
  if (oc.runtime === "docker") {
    const containerName = oc.containerName ?? "openclaw";
    try {
      execSync(`docker exec ${containerName} openclaw --version`, {
        stdio: "pipe",
        timeout: 8000,
      });
    } catch {
      log.warn("OpenClaw CLI not responding inside the container yet.");
      log.dim("Skipping AI key setup — run `synap openclaw configure` once it's fully up.");
      return;
    }
  }

  // Check if an AI key is already configured via OpenClaw's config
  const hasKey = openclawHasAiKey(oc);
  if (hasKey) {
    log.success("AI provider already configured");
    return;
  }

  log.info("OpenClaw needs an AI provider to process requests.");
  log.blank();

  const { setup } = await prompts({
    type: "select",
    name: "setup",
    message: "Set up AI provider now?",
    choices: [
      { title: "Yes — scripted (pick provider + paste key)", value: "scripted" },
      { title: "Yes — run OpenClaw's own wizard (interactive)", value: "wizard" },
      { title: "Skip for now", value: "skip" },
    ],
  });

  if (setup === "skip" || !setup) {
    log.dim("Set it later with: synap openclaw configure");
    return;
  }

  if (setup === "wizard") {
    await openclawConfigure({ interactive: true });
    return;
  }

  await openclawConfigure({});
}

function openclawHasAiKey(oc: ReturnType<typeof detectOpenClaw>): boolean {
  if (!oc.found || oc.runtime !== "docker") return false;
  const containerName = oc.containerName ?? "openclaw";
  for (const key of ["env.ANTHROPIC_API_KEY", "env.OPENAI_API_KEY", "env.GEMINI_API_KEY"]) {
    try {
      const out = execSync(
        `docker exec ${containerName} openclaw config get ${key} 2>/dev/null`,
        { encoding: "utf-8", timeout: 5000 }
      ).trim();
      if (out && out !== "undefined" && out !== "null") return true;
    } catch {
      // continue
    }
  }
  return false;
}

// ─── Domain step ─────────────────────────────────────────────────────────────

async function domainStep(oc: ReturnType<typeof detectOpenClaw>, podUrl: string): Promise<void> {
  // Only auto-offer for Docker + managed pods + domain not already set
  if (oc.runtime !== "docker") return;

  const deployDir = findSynapDeployDir();
  if (!deployDir) return;

  const envPath = `${deployDir}/.env`;
  let envContent = "";
  try {
    envContent = fs.existsSync(envPath) ? fs.readFileSync(envPath, "utf-8") : "";
  } catch {
    return;
  }

  const alreadySet = /^OPENCLAW_DOMAIN=(?!disabled\.invalid).+/m.test(envContent);
  if (alreadySet) {
    const match = envContent.match(/^OPENCLAW_DOMAIN=(.+)$/m);
    log.heading("Public Dashboard");
    log.success(`Already exposed: ${chalk.cyan(`https://${match?.[1]?.trim()}`)}`);
    return;
  }

  // Detect pod type from the pod URL
  const isManaged = podUrl.includes(".synap.live");
  if (!isManaged) {
    // Self-hosted pods can still expose — but we don't auto-prompt because
    // they need to set up DNS themselves. Show a hint instead.
    log.heading("Public Dashboard");
    log.info("Self-hosted pod — expose the dashboard manually:");
    log.dim("  synap openclaw setup-domain");
    return;
  }

  log.heading("Public Dashboard");
  log.info("Your pod is managed — we can expose the OpenClaw dashboard at a public URL.");
  log.dim("Auth: your existing Synap session (no extra password)");
  log.blank();

  const { doExpose } = await prompts({
    type: "confirm",
    name: "doExpose",
    message: "Expose the dashboard now?",
    initial: true,
  });

  if (!doExpose) {
    log.dim("Later: synap openclaw setup-domain");
    return;
  }

  await openclawSetupDomain();
}

// ─── Summary ─────────────────────────────────────────────────────────────────

function printSummary(oc: ReturnType<typeof detectOpenClaw>): void {
  log.blank();
  console.log(chalk.green("═══════════════════════════════════════════"));
  console.log(chalk.green.bold("  Synap + OpenClaw Ready"));
  console.log(chalk.green("═══════════════════════════════════════════"));
  log.blank();

  // Read the public URL if exposed
  const deployDir = findSynapDeployDir();
  let publicUrl: string | null = null;
  if (deployDir) {
    try {
      const envContent = fs.readFileSync(`${deployDir}/.env`, "utf-8");
      const match = envContent.match(/^OPENCLAW_DOMAIN=(.+)$/m);
      const domain = match?.[1]?.trim();
      if (domain && domain !== "disabled.invalid") {
        publicUrl = `https://${domain}`;
      }
    } catch {
      // ignore
    }
  }

  const localConfig = getLocalPodConfig();
  log.info(`Pod:       ${localConfig?.podUrl ?? "unknown"}`);
  if (publicUrl) {
    log.info(`Dashboard: ${chalk.cyan(publicUrl)}`);
  } else {
    log.info(`Gateway:   ${chalk.cyan(`localhost:${oc.gatewayPort ?? 18789}`)}`);
  }
  log.blank();

  // ── Connections ──────────────────────────────────────────────────────────
  log.heading("Connections");
  log.info("Already wired:");
  log.dim("  ✓ Synap pod ↔ OpenClaw (Hub API key, workspace, agent user)");
  log.dim("  ✓ synap skill installed");
  log.blank();
  log.info("Needs your input (optional):");
  log.dim("  ○ Channels (Telegram, Discord, WhatsApp, Slack, Signal...)");
  log.dim("    → synap openclaw open channels");
  log.dim("  ○ Extra skills from ClawHub");
  log.dim("    → synap openclaw open skills");
  log.blank();
  log.info("Connect an AI client:");
  log.dim("  Claude Desktop   synap openclaw connect --client claude");
  log.dim("  Cursor           synap openclaw connect --client cursor");
  log.dim("  Windsurf         synap openclaw connect --client windsurf");
  log.blank();

  log.info("Useful commands:");
  log.dim("  synap openclaw              — status overview");
  log.dim("  synap openclaw connections  — AI providers, skills, channels, MCP clients");
  log.dim("  synap openclaw dashboard    — open the web UI");
  log.dim("  synap openclaw open <tab>   — open dashboard at channels/skills/config/...");
  log.dim("  synap openclaw token        — print the gateway token");
  log.dim("  synap openclaw configure    — change AI provider");
  log.dim("  synap openclaw doctor       — diagnostics");
  log.dim("  synap status                — full health check");
  log.blank();
  log.info("Try it — connect a client and ask your agent:");
  log.dim('  "remember that Marc prefers email"');
  log.dim('  "what do I know about Marc?"');
  log.blank();
}
