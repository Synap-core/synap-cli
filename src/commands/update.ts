/**
 * synap update
 *
 * Update the synap skill and check for CLI updates.
 */

import ora from "ora";
import { log, banner } from "../utils/logger.js";
import { detectOpenClaw } from "../lib/openclaw.js";
import { installSynapSkill } from "../lib/pod.js";

export async function update(): Promise<void> {
  banner();
  log.heading("Update");

  // Update skill
  const oc = detectOpenClaw();
  if (oc.found) {
    const spinner = ora("Updating synap skill...").start();
    try {
      installSynapSkill();
      spinner.succeed("Synap skill updated");
    } catch (err) {
      spinner.fail(err instanceof Error ? err.message : "Update failed");
    }
  } else {
    log.dim("OpenClaw not detected — skipping skill update");
  }

  // Check CLI version
  log.blank();
  log.info("To update the CLI itself:");
  log.dim("  npm update -g @synap/cli");

  log.blank();
}
