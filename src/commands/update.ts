/**
 * synap update
 *
 * Update the synap skill and remind the user how to update the CLI itself.
 *
 *   synap update              — update skill
 */

import ora from "ora";
import { log, banner } from "../utils/logger.js";
import { detectOpenClaw } from "../lib/openclaw.js";
import { installSynapSkill } from "../lib/pod.js";

// ─── Main ────────────────────────────────────────────────────────────────────

export async function update(): Promise<void> {
  banner();
  log.heading("Update");

  // ── 1. Skill update (OpenClaw) ────────────────────────────────────────────
  const oc = detectOpenClaw();
  if (oc.found) {
    const spinner = ora("Updating synap skill...").start();
    try {
      installSynapSkill();
      spinner.succeed("Synap skill updated");
    } catch (err) {
      spinner.fail(err instanceof Error ? err.message : "Skill update failed");
    }
  } else {
    log.dim("OpenClaw not detected — skipping skill update");
  }

  // ── 2. CLI update reminder ────────────────────────────────────────────────
  log.blank();
  log.info("To update the CLI itself:");
  log.dim("  npm update -g @synap-core/cli");
  log.blank();
}
