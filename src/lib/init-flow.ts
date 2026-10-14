/**
 * `synap init` decisions that don't need a terminal: which flow a machine
 * gets, and how the first key for a pod is offered. Pure, so they can be
 * tested without spawning the CLI.
 */

/** A pod Synap hosts (`*.synap.live`): never on this machine, never has a .env. */
export function isManagedPod(podUrl: string): boolean {
  try {
    const host = new URL(podUrl).hostname;
    return host === "synap.live" || host.endsWith(".synap.live");
  } catch {
    return false;
  }
}

/**
 * Server flow (OpenClaw beside the pod, compose stack) only when a pod runs on
 * THIS machine. Linux + docker alone is a workstation too (a devbox over SSH).
 */
export function chooseInitFlow(input: {
  /** linux + a working docker daemon */
  linuxDocker: boolean;
  /** `--agents` names agents on this machine: always the desktop flow */
  agentsRequested: boolean;
  podUrl?: string;
  /** A pod found running on this machine (not an env var), or null. */
  localPodUrl: string | null;
}): "server" | "desktop" {
  if (!input.linuxDocker || input.agentsRequested) return "desktop";
  if (input.podUrl && isManagedPod(input.podUrl)) return "desktop";
  return input.localPodUrl ? "server" : "desktop";
}

export type KeyChoice = "device" | "paste";

/**
 * How to get the first key for a pod, in order. Connecting this computer first
 * (the pod's device flow: a code approved on any device, on self-hosted and
 * managed pods alike); pasting a key is the advanced way. The PROVISIONING_TOKEN
 * is never offered: it is bootstrap-only on the pod (D9) and stops minting keys
 * once the pod has an owner. A pod that cannot run the device flow (too old) is
 * not offered it again; after a denied or expired code it is offered as a retry.
 */
export function keyChoices(input: { managed: boolean; deviceTried: boolean; deviceAvailable: boolean }): Array<{
  title: string;
  description: string;
  value: KeyChoice;
}> {
  const choices: Array<{ title: string; description: string; value: KeyChoice }> = [];
  if (input.deviceAvailable) {
    choices.push({
      title: input.deviceTried ? "Connect this computer again (new code)" : "Connect this computer (recommended)",
      description: "Gives you a link and a code. Approve it from any device.",
      value: "device",
    });
  }
  choices.push({
    title: "Advanced: paste an API key",
    description: "From your pod: Settings → API keys",
    value: "paste",
  });
  return choices;
}
