/**
 * synap finish
 *
 * Complete setup after OpenClaw has been provisioned.
 * Run this once OpenClaw is running (a few minutes after synap init).
 *
 * Steps:
 *  1. Verify pod connection (reads ~/.synap/pod-config.json)
 *  2. Check pod health
 *  3. Check OpenClaw is running
 *  4. Security audit
 *  5. Install synap skill
 *  6. Seed workspace entities
 *  7. Optionally configure IS as AI provider
 */

import chalk from "chalk";
import { log, banner } from "../utils/logger.js";
import { detectOpenClaw } from "../lib/openclaw.js";
import { checkPodHealth, getLocalPodConfig } from "../lib/pod.js";
import { securityStep, skillStep, seedStep, isStep } from "./init.js";

export async function finish(): Promise<void> {
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

  // ── Step 7: Configure IS ──────────────────────────────────────────────────
  await isStep(podUrl, hubApiKey, true);

  // ── Summary ────────────────────────────────────────────────────────────────
  log.blank();
  console.log(chalk.green("═══════════════════════════════════════════"));
  console.log(chalk.green.bold("  Synap + OpenClaw Ready"));
  console.log(chalk.green("═══════════════════════════════════════════"));
  log.blank();
  log.info(`Pod: ${podUrl}`);
  log.info("Skill: synap (knowledge graph + relay)");
  log.blank();
  log.info("Try it now:");
  log.dim('  Ask your agent: "remember that Marc prefers email"');
  log.dim('  Then later: "what do I know about Marc?"');
  log.blank();
  log.dim("  synap status         — health check");
  log.dim("  synap update         — update skill");
  log.dim("  synap security-audit — verify security");
  log.blank();
}
