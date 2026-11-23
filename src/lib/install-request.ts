/**
 * Adding a capability from a key that may not add it itself: the CLI asks the
 * person, who approves on the pod and enters any credential there.
 *
 * Founder dogfood 2026-11-16 (finding 1773922e): `synap cap add "Cal.com
 * Scheduling"` asked for the API key, then the pod refused the write with
 * 403 "This key's grant does not allow tool.create" and sent the person to do
 * it by hand. Now the CLI reads the key's grant first (`/auth/status`
 * `access`) and, when it cannot write tools, files the pod's install request
 * (`POST /installations/request`, computer "pod": the same rule as MCP
 * `synap_request_installation`). The pod files ONE `capability.install`
 * proposal; its review page takes the credential (`proposals.repair`, vault
 * first), so the key never travels through the CLI or sits in the proposal.
 */

import chalk from "chalk";
import ora from "ora";
import { covers } from "@synap-core/types/grants";
import { hubPost, HubError, renderHubError, type HubConfig } from "./hub-client.js";
import type { KeyAccess } from "./credential-class.js";
import { log } from "../utils/logger.js";
import { openPodPage } from "./safe-open.js";

/** The first write a direct `/capabilities/apply` makes, and the one its refusal names. */
export const DIRECT_INSTALL_PERMISSION = "tool.create";

/**
 * May this key install a capability itself? `unknown` when the pod did not say
 * (older pod, no grant read): the caller tries, and a refusal still ends in
 * the same ask.
 */
export function directInstallAllowed(
  access: KeyAccess | null | undefined
): "yes" | "no" | "unknown" {
  if (!access) return "unknown";
  if (access.isFullAccess) return "yes";
  const granted = access.scopes.some((s) =>
    s.permissions.some((p) => {
      try {
        return covers(p, DIRECT_INSTALL_PERMISSION);
        // empty-ok: a malformed pattern grants nothing (as `permissionsMatch` in @synap-core/types/grants); the pod stays the judge
      } catch {
        return false;
      }
    })
  );
  return granted ? "yes" : "no";
}

export interface InstallableCard {
  key: string;
  name: string;
  installParams?: Array<{ name: string; label?: string; required?: boolean }>;
}

/** What the pod answers to `POST /installations/request` with computer "pod". */
type PodInstallAnswer =
  | { status: "proposed"; proposalId?: string; reviewUrl?: string; message?: string }
  | { status: "installed" }
  | { status: "already_on_pod" };

/** An older pod reads "pod" as a computer id it does not know. */
export function podTargetUnsupported(err: unknown): boolean {
  return (
    err instanceof HubError &&
    (err.status === 400 ||
      (err.status === 404 && /computer not found/i.test(err.detail ?? err.message)))
  );
}

/**
 * Ask the person to approve adding `card` to the pod. True when the ask was
 * filed (or nothing was needed); false after printing why it could not be.
 */
export async function askPodToInstall(cfg: HubConfig, card: InstallableCard): Promise<boolean> {
  const spinner = ora({ text: `Asking to add ${chalk.bold(card.name)}…`, color: "cyan" }).start();
  let answer: PodInstallAnswer;
  try {
    answer = (await hubPost(
      "/installations/request",
      { capabilityKey: card.key, action: "install", computer: "pod" },
      cfg
    )) as PodInstallAnswer;
    spinner.stop();
  } catch (err) {
    spinner.stop();
    if (podTargetUnsupported(err)) {
      log.error(`This key may not add ${card.name}, and this pod cannot take the request from the CLI yet.`);
      log.hint("Add it in the Synap desktop app or pod admin, or update the pod and run this again.");
      return false;
    }
    log.error(`Could not ask to add ${card.name}.`);
    renderHubError(err);
    return false;
  }

  if (answer.status === "already_on_pod") {
    log.success(`${card.name} is already on this pod.`);
    return true;
  }
  if (answer.status === "installed") {
    log.success(`Added ${chalk.bold(card.name)}.`);
    return true;
  }

  log.success(`Asked to add ${chalk.bold(card.name)}. Nothing is installed until you approve it.`);
  if (answer.reviewUrl) {
    console.log(`    Approve it here: ${chalk.cyan(answer.reviewUrl)}`);
    // A person at a terminal gets the page opened for them (founder, 2026-11-18:
    // "it should automatically open a link to pod admin to validate"). Only a
    // page on this pod or its pod-admin origin is opened (`openPodPage`); a
    // script or CI run (no terminal) only gets the printed link.
    if (process.stdout.isTTY) openPodPage(answer.reviewUrl, cfg.podUrl);
  } else if (answer.proposalId) console.log(`    Approve it with: synap open proposal ${answer.proposalId}`);
  const owed = (card.installParams ?? []).filter((p) => p.required);
  if (owed.length > 0) {
    const labels = owed.map((p) => p.label ?? p.name).join(", ");
    log.dim(`The approval page asks for: ${labels}.`);
  }
  if (answer.proposalId) log.dim(`Wait for the answer here:  synap proposals await ${answer.proposalId}`);
  return true;
}
