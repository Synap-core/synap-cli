/**
 * synap update
 *
 * Tells the user how to update the CLI itself. (It used to also update an
 * agent's skill; Synap installs no agent now, so the hint is all that is left.)
 */

import { log, banner } from "../utils/logger.js";

export async function update(): Promise<void> {
  banner();
  log.heading("Update");
  log.info("To update the CLI itself:");
  log.dim("  npm update -g @synap-core/cli");
  log.dim("  npx @synap-core/cli@latest   (no global install)");
  log.blank();
}
