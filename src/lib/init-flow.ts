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

export type KeyChoice = "signin" | "paste" | "provisioning";

/**
 * How to get the first key for a pod, in order. Sign-in first (it mints the key
 * for any pod linked to the account); the rest are advanced. A synap.live pod
 * has no .env, so no PROVISIONING_TOKEN. Once sign-in has been tried and gave
 * no access, it is not offered again.
 */
export function keyChoices(input: { managed: boolean; signInTried: boolean }): Array<{
  title: string;
  description: string;
  value: KeyChoice;
}> {
  const choices: Array<{ title: string; description: string; value: KeyChoice }> = [];
  if (!input.signInTried) {
    choices.push({
      title: "Sign in to Synap (recommended)",
      description: "Gives you a link and a code. Works from any device.",
      value: "signin",
    });
  }
  choices.push({
    title: "Advanced: paste an API key",
    description: "From your pod: Settings → API keys",
    value: "paste",
  });
  if (!input.managed) {
    choices.push({
      title: "Advanced: use the PROVISIONING_TOKEN",
      description: "Self-host admin, from the pod's .env file",
      value: "provisioning",
    });
  }
  return choices;
}
