/**
 * synap connect
 *
 * Quick connection: link existing OpenClaw to existing Synap pod.
 */

import prompts from "prompts";
import ora from "ora";
import { log, banner } from "../utils/logger.js";
import { detectOpenClaw, readOpenClawConfig, writeOpenClawConfig, setConfigValue } from "../lib/openclaw.js";
import { checkPodHealth, setupAgent } from "../lib/pod.js";

interface ConnectOptions {
  podUrl?: string;
  apiKey?: string;
}

export async function connect(opts: ConnectOptions): Promise<void> {
  banner();
  log.heading("Connect to Synap Pod");

  // Get pod URL
  let podUrl = opts.podUrl;
  if (!podUrl) {
    const { url } = await prompts({
      type: "text",
      name: "url",
      message: "Synap pod URL:",
      initial: "http://localhost:4000",
    });
    podUrl = url;
  }

  if (!podUrl) return;

  // Health check
  const spinner = ora("Checking pod health...").start();
  const status = await checkPodHealth(podUrl);

  if (!status.healthy) {
    spinner.fail(`Pod not reachable at ${podUrl}`);
    return;
  }
  spinner.succeed(`Pod healthy at ${podUrl}`);

  // Get or generate API key
  let apiKey = opts.apiKey;
  if (!apiKey) {
    const { method } = await prompts({
      type: "select",
      name: "method",
      message: "Authentication:",
      choices: [
        { title: "Paste existing API key", value: "paste" },
        { title: "Generate new key (needs PROVISIONING_TOKEN)", value: "generate" },
      ],
    });

    if (method === "paste") {
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
        message: "PROVISIONING_TOKEN:",
      });

      if (token) {
        const genSpinner = ora("Creating agent credentials...").start();
        try {
          const result = await setupAgent(podUrl, token);
          apiKey = result.hubApiKey;
          genSpinner.succeed("Credentials created");

          // Save to OpenClaw config
          const oc = detectOpenClaw();
          if (oc.found) {
            const config = readOpenClawConfig() ?? {};
            setConfigValue(config, "synap.podUrl", podUrl);
            setConfigValue(config, "synap.workspaceId", result.workspaceId);
            setConfigValue(config, "synap.agentUserId", result.agentUserId);
            writeOpenClawConfig(config);
          }
        } catch (err) {
          genSpinner.fail(err instanceof Error ? err.message : "Failed");
          return;
        }
      }
    }
  }

  if (!apiKey) return;

  log.blank();
  log.success("Connected to Synap pod");
  log.blank();
  log.info("Set these environment variables:");
  log.dim(`  export SYNAP_HUB_API_KEY="${apiKey}"`);
  log.dim(`  export SYNAP_POD_URL="${podUrl}"`);
  log.blank();
  log.info("Install the skill:");
  log.dim("  openclaw skills install synap");
}
