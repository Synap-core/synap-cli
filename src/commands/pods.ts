/**
 * synap pods — manage multiple pod profiles and switch between them
 *
 *   synap pods list              list all configured pods
 *   synap pods add [name]        connect a new pod and save as a named profile
 *   synap pods use <name>        switch active pod and propagate to all surfaces
 *   synap pods remove <name>     remove a pod profile
 */

import prompts from "prompts";
import ora from "ora";
import chalk from "chalk";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { log } from "../utils/logger.js";
import {
  checkPodHealth,
  addPodProfile,
  setActivePod,
  setSurfacePod,
  removePodProfile,
  listPodProfiles,
  podNotFoundMessage,
  SURFACE_NAMES,
  type SurfaceName,
} from "../lib/pod.js";
// Origin comparison — the SAME helper the lens uses to decide whether a stored
// pod matches the one being addressed. One normalizer, not two.
import { samePodOrigin } from "../lib/project-ref.js";
import {
  TARGETS,
  writeMcpServerEntry,
  writeClaudeCodeEnv,
} from "../lib/targets.js";
import { renderNextSteps, FLOW } from "../lib/next-steps.js";


// ─── list ─────────────────────────────────────────────────────────────────────

export async function podsList(): Promise<void> {
  const profiles = listPodProfiles();

  if (profiles.length === 0) {
    log.info("No pods configured. Run: synap pods add");
    return;
  }

  log.heading("Configured pods");

  const checks = await Promise.all(
    profiles.map(async (p) => {
      const health = await checkPodHealth(p.config.podUrl).catch(() => ({ healthy: false, moved: false }));
      return { ...p, healthy: health.healthy, moved: Boolean(health.moved) };
    })
  );

  for (const p of checks) {
    const active = p.active ? chalk.green(" ● active") : chalk.dim(" ○");
    const health = p.healthy
      ? chalk.green("healthy")
      : p.moved
        ? chalk.yellow("moved — run: synap doctor --fix")
        : chalk.red("unreachable");
    const label = p.config.label ? chalk.dim(` (${p.config.label})`) : "";
    console.log(`  ${chalk.bold(p.name.padEnd(14))}${active}  ${health}  ${chalk.dim(p.config.podUrl)}${label}`);
  }

  // ── EFFECTIVE ≠ ACTIVE ────────────────────────────────────────────────────
  // `● active` above is the CONFIGURED profile (`~/.synap/config.json`). It is
  // NOT necessarily the pod commands actually talk to: `resolveHubConfig`'s
  // precedence ladder puts the ambient `SYNAP_POD_URL` / `SYNAP_HUB_API_KEY`
  // ABOVE the active profile, so an inherited env var silently redirects every
  // command while this list still shows the profile as active.
  //
  // That divergence produced a real, expensive confusion: `pods list` said
  // `perso`, every write went to the TEAM pod, and the symptom surfaced far
  // downstream as `403 Access denied to workspace` on a workspace that plainly
  // exists — because it exists on the OTHER pod. Same shape as `gh`, whose docs
  // note `GH_TOKEN` "takes precedence over previously stored credentials".
  //
  // Reporting configured state as though it were effective state is the defect;
  // naming it costs three lines.
  const envPod = process.env.SYNAP_POD_URL?.trim();
  const activeProfile = checks.find((p) => p.active);
  if (envPod && activeProfile && !samePodOrigin(envPod, activeProfile.config.podUrl)) {
    log.blank();
    log.warn(
      `SYNAP_POD_URL overrides the active profile — commands are talking to ${envPod}, not ${activeProfile.config.podUrl}.`
    );
    log.dim("  The env var wins over `● active`. Unset it, or run `synap whoami` to see the pod actually in use.");
  }

  log.blank();
  log.dim("synap pods use <name>        — switch active pod");
  log.dim("synap pods add [name]        — connect another pod");
  log.dim("synap pods update <name> <url> — change a pod's URL (e.g. after a domain move)");
}

// ─── first login ──────────────────────────────────────────────────────────────

/**
 * `synap login` with no pod saved. Signing in to the Synap account finds the
 * person's pods; adding one by URL stays as the manual way.
 */
export async function podsFirstLogin(): Promise<void> {
  log.info("No pod saved yet.");
  const { how } = await prompts({
    type: "select",
    name: "how",
    message: "Connect your pod:",
    choices: [
      { title: "Sign in to Synap (recommended)", description: "Finds your pods for you", value: "signin" },
      { title: "Add a pod by URL instead", description: "Self-hosted, or not on your account", value: "url" },
    ],
  });
  if (!how) return;

  if (how === "signin") {
    const { signInAndSavePod } = await import("./init.js");
    const podUrl = await signInAndSavePod();
    if (podUrl) {
      log.success(`Pod saved: ${podUrl}`);
      return;
    }
    const { byUrl } = await prompts({
      type: "confirm",
      name: "byUrl",
      message: "Add a pod by URL instead?",
      initial: true,
    });
    if (!byUrl) return;
  }
  await podsAdd();
}

// ─── add ──────────────────────────────────────────────────────────────────────

export async function podsAdd(name?: string, podUrlArg?: string): Promise<void> {
  // Resolve profile name
  let profileName = name;
  if (!profileName) {
    const existing = listPodProfiles().map((p) => p.name);
    const { inputName } = await prompts({
      type: "text",
      name: "inputName",
      message: "Profile name for this pod:",
      initial: existing.includes("personal") ? "team" : existing.includes("default") ? "personal" : "default",
      validate: (v: string) => v.trim().length > 0 || "Name is required",
    });
    if (!inputName) return;
    profileName = (inputName as string).trim().toLowerCase().replace(/\s+/g, "-");
  }

  // Pod URL — pre-filled if passed as positional arg
  const { url } = await prompts({
    type: "text",
    name: "url",
    message: "Pod URL:",
    initial: podUrlArg ?? "https://",
    validate: (v: string) => v.startsWith("http") || "Must be a valid URL",
  });
  if (!url) return;

  const spinner = ora("Checking pod health...").start();
  const health = await checkPodHealth(url as string);
  if (!health.healthy) {
    spinner.fail(`Pod not reachable at ${url}`);
    return;
  }
  spinner.succeed(`Pod healthy at ${url}`);

  // Optional label
  const { label } = await prompts({
    type: "text",
    name: "label",
    message: "Label (optional, e.g. 'Personal' or 'Team'):",
  });

  // API key
  const { method } = await prompts({
    type: "select",
    name: "method",
    message: "Authentication:",
    choices: [
      { title: "Connect this computer (recommended)", description: "A link and a code to approve from any device", value: "device" },
      { title: "Paste existing API key", value: "paste" },
    ],
  });
  if (!method) return;

  let apiKey: string | undefined;
  const podUrl = url as string;

  if (method === "device") {
    // The pod's device flow: this computer's own key, saved under this profile,
    // and each approved agent's key written into its config.
    const { connectThisComputer } = await import("../lib/device-connect.js");
    const saved = await connectThisComputer(podUrl, { name: profileName });
    if (!saved) return;
    if (label) addPodProfile(profileName, { ...saved, label: label as string });
    log.blank();
    log.success(`Pod '${profileName}' saved.`);
    log.dim(`Run: synap pods use ${profileName}  — to make it active`);
    return;
  } else if (method === "paste") {
    const { key } = await prompts({ type: "password", name: "key", message: "Hub Protocol API key:" });
    apiKey = key as string | undefined;
  }

  if (!apiKey) return;

  addPodProfile(profileName, {
    podUrl,
    workspaceId: "",
    agentUserId: "",
    hubApiKey: apiKey,
    label: (label as string | undefined) || undefined,
    savedAt: new Date().toISOString(),
  });

  log.blank();
  log.success(`Pod '${profileName}' saved.`);
  log.dim(`Run: synap pods use ${profileName}  — to make it active`);
}

// ─── use ──────────────────────────────────────────────────────────────────────

export type { SurfaceName };

const SURFACE_LABELS: Record<string, string> = {
  raycast: "Raycast",
  "claude-code": "Claude Code",
  "claude-desktop": "Claude Desktop",
  cursor: "Cursor",
  opencode: "opencode",
  goose: "Goose",
};

/**
 * The surfaces `applySurfaceConfig` can actually write. SURFACE_NAMES is much
 * wider (it is the SSOT for every connect/agent identity), and `pods use
 * --surface <one of the others>` used to print success and do nothing.
 *
 * Typing applySurfaceConfig to this narrow union makes its switch exhaustive, so
 * adding a surface here without a writer is a COMPILE error, not a silent no-op.
 */
const SUPPORTED_USE_SURFACES = ["claude-desktop", "cursor", "claude-code", "raycast"] as const;
type SupportedUseSurface = (typeof SUPPORTED_USE_SURFACES)[number];

function isSupportedUseSurface(s: SurfaceName): s is SupportedUseSurface {
  return (SUPPORTED_USE_SURFACES as readonly string[]).includes(s);
}

/**
 * Raycast's support dir — its presence is our "is Raycast installed" gate.
 * Mirrors `raycastSupportDir()` in lib/targets.ts, which is private to that file.
 */
function raycastSupportDir(): string {
  return path.join(os.homedir(), "Library", "Application Support", "com.raycast.macos");
}

export async function podsUse(name: string, opts: { surface?: SurfaceName; json?: boolean } = {}): Promise<void> {
  const profiles = listPodProfiles();
  const profile = profiles.find((p) => p.name === name);
  if (!profile) {
    log.error(podNotFoundMessage(name));
    return;
  }
  const podConfig = profile.config;

  if (opts.surface) {
    if (!isSupportedUseSurface(opts.surface)) {
      log.error(`'${opts.surface}' is not a surface \`pods use\` can configure.`);
      log.dim(`Supported: ${SUPPORTED_USE_SURFACES.join(", ")}`);
      log.dim(
        `Other surfaces (${SURFACE_NAMES.filter((s) => !isSupportedUseSurface(s)).join(", ")}) are configured via: synap connect --target=<surface>`
      );
      return;
    }
    // Per-surface switch — only update that surface's config
    try {
      setSurfacePod(opts.surface, name);
    } catch (err) {
      log.error(err instanceof Error ? err.message : String(err));
      return;
    }
    log.info(`${SURFACE_LABELS[opts.surface]} → pod '${name}' (${podConfig.podUrl})`);
    await applySurfaceConfig(opts.surface, podConfig);
    log.blank();
    log.dim("Other surfaces are unchanged. Run without --surface to switch all.");
    return;
  }

  // Global switch — update activePod + propagate to all surfaces
  setActivePod(name);
  log.info(`Switching all surfaces to pod '${name}' (${podConfig.podUrl})`);
  log.blank();

  const updated: string[] = [];

  // Claude Desktop
  const desktopPath = TARGETS["claude-desktop"].mcpConfigPath?.();
  if (desktopPath && fs.existsSync(desktopPath)) {
    writeMcpServerEntry(desktopPath, "synap", {
      command: "npx",
      args: ["-y", "mcp-remote", `${podConfig.podUrl.replace(/\/$/, "")}/mcp`, "--header", `Authorization: Bearer ${podConfig.hubApiKey}`],
    });
    updated.push("Claude Desktop");
  }

  // Cursor
  const cursorPath = TARGETS["cursor"].mcpConfigPath?.();
  if (cursorPath && fs.existsSync(cursorPath)) {
    writeMcpServerEntry(cursorPath, "synap", {
      url: `${podConfig.podUrl}/mcp`,
      headers: { Authorization: `Bearer ${podConfig.hubApiKey}` },
    });
    updated.push("Cursor");
  }

  // Claude Code
  const claudeSettings = path.join(os.homedir(), ".claude", "settings.json");
  if (fs.existsSync(claudeSettings)) {
    // Pod-wide: a workspace is a lens, not a container — don't weld the profile's
    // workspace into the MCP URL (matches the Desktop/Cursor entries above and
    // the `synap connect` default). Pins are set only via `synap connect --pin-*`.
    await writeClaudeCodeEnv({ podUrl: podConfig.podUrl, apiKey: podConfig.hubApiKey, agentUserId: podConfig.agentUserId });
    updated.push("Claude Code");
  }

  // Raycast reads ~/.synap/config.json directly — the activePod update above is
  // sufficient. Still gate on Raycast being installed: claiming we updated it on
  // a machine that has never run Raycast is a lie (same existsSync gate as above).
  if (fs.existsSync(raycastSupportDir())) {
    updated.push("Raycast");
  }

  const steps = FLOW.afterPodUse(name);

  if (opts.json) {
    console.log(JSON.stringify({ pod: name, podUrl: podConfig.podUrl, surfaces: updated, nextSteps: steps }, null, 2));
    return;
  }

  if (updated.length === 0) {
    log.warn("Active pod switched, but no agent surface is configured on this machine.");
    log.dim("Connect one with: synap connect --target=<surface>");
    renderNextSteps(steps);
    return;
  }

  log.success(`Updated: ${updated.join(", ")}`);
  log.dim("Restart any open agents to apply the new pod.");
  log.blank();
  log.dim("Tip: synap pods use <name> --surface <surface>  — switch only one surface");
  renderNextSteps(steps);
}

/** Apply a pod config to a single surface's external config file. */
async function applySurfaceConfig(surface: SupportedUseSurface, podConfig: import("../lib/pod.js").LocalPodConfig): Promise<void> {
  switch (surface) {
    case "claude-desktop": {
      const p = TARGETS["claude-desktop"].mcpConfigPath?.();
      if (p && fs.existsSync(p)) {
        writeMcpServerEntry(p, "synap", {
          command: "npx",
          args: ["-y", "mcp-remote", `${podConfig.podUrl.replace(/\/$/, "")}/mcp`, "--header", `Authorization: Bearer ${podConfig.hubApiKey}`],
        });
        log.success("Claude Desktop MCP config updated.");
        log.dim("Quit + relaunch Claude Desktop to apply.");
      } else {
        log.dim("Claude Desktop config not found — run `synap connect --target=claude-desktop` first.");
      }
      break;
    }
    case "cursor": {
      const p = TARGETS["cursor"].mcpConfigPath?.();
      if (p && fs.existsSync(p)) {
        writeMcpServerEntry(p, "synap", {
          url: `${podConfig.podUrl}/mcp`,
          headers: { Authorization: `Bearer ${podConfig.hubApiKey}` },
        });
        log.success("Cursor MCP config updated.");
      } else {
        log.dim("Cursor config not found — run `synap connect --target=cursor` first.");
      }
      break;
    }
    case "claude-code": {
      const p = path.join(os.homedir(), ".claude", "settings.json");
      if (fs.existsSync(p)) {
        // Pod-wide: don't weld the profile's workspace into the MCP URL (see note
        // in `podsUse` above and the `synap connect` default).
        await writeClaudeCodeEnv({ podUrl: podConfig.podUrl, apiKey: podConfig.hubApiKey, agentUserId: podConfig.agentUserId });
        log.success("Claude Code env updated (~/.claude/settings.json).");
      } else {
        log.dim("Claude Code settings not found — run `synap connect --target=claude-code` first.");
      }
      break;
    }
    case "raycast":
      // Raycast reads ~/.synap/config.json directly — surfaces entry is enough.
      log.success("Raycast surface preference saved.");
      break;
    default: {
      // Exhaustiveness guard: widening SUPPORTED_USE_SURFACES without adding a
      // writer above fails to compile here, instead of silently doing nothing.
      const _exhaustive: never = surface;
      return _exhaustive;
    }
  }
}

// ─── switch (interactive) ─────────────────────────────────────────────────────

export async function podsSwitch(name?: string): Promise<void> {
  const profiles = listPodProfiles();

  if (profiles.length === 0) {
    log.info("No pods configured. Run: synap pods add");
    return;
  }

  let targetName = name;

  if (!targetName) {
    if (profiles.length === 1) {
      log.info(`Only one pod configured: ${chalk.bold(profiles[0].name)}`);
      targetName = profiles[0].name;
    } else {
      const active = profiles.find((p) => p.active);
      const { picked } = await prompts({
        type: "select",
        name: "picked",
        message: "Switch to which pod?",
        choices: profiles.map((p) => ({
          title: `${chalk.bold(p.name)}${p.active ? chalk.green("  ← active") : ""}  ${chalk.dim(p.config.podUrl)}`,
          value: p.name,
        })),
        initial: active ? profiles.indexOf(active) : 0,
      });
      if (!picked) return;
      targetName = picked as string;
    }
  }

  await podsUse(targetName);
}

// ─── remove ───────────────────────────────────────────────────────────────────

export async function podsRemove(name: string): Promise<void> {
  const profiles = listPodProfiles();
  const profile = profiles.find((p) => p.name === name);

  if (!profile) {
    log.error(podNotFoundMessage(name));
    return;
  }

  if (profile.active) {
    log.warn(`'${name}' is the active pod.`);
    const remaining = profiles.filter((p) => p.name !== name);
    if (remaining.length > 0) {
      log.dim(`Will switch to '${remaining[0].name}' after removal.`);
    }
  }

  const { confirm } = await prompts({
    type: "confirm",
    name: "confirm",
    message: `Remove pod profile '${name}' (${profile.config.podUrl})?`,
    initial: false,
  });
  if (!confirm) return;

  removePodProfile(name);
  log.success(`Removed '${name}'.`);

  const after = listPodProfiles();
  if (after.length > 0 && profile.active) {
    log.dim(`Active pod is now '${after[0].name}'.`);
  }
}

// ─── reconnect ────────────────────────────────────────────────────────────────

/**
 * Re-run the browser auth flow against an already-saved pod URL.
 * Lets users refresh a broken/expired API key without re-entering the pod URL.
 */
export async function podsReconnect(name?: string): Promise<void> {
  const profiles = listPodProfiles();

  if (profiles.length === 0) {
    log.info("No pods configured. Run: synap pods add");
    return;
  }

  let targetName = name;

  if (!targetName) {
    if (profiles.length === 1) {
      targetName = profiles[0].name;
    } else {
      const active = profiles.find((p) => p.active);
      const { picked } = await prompts({
        type: "select",
        name: "picked",
        message: "Which pod do you want to reconnect?",
        choices: profiles.map((p) => ({
          title: `${chalk.bold(p.name)}${p.active ? chalk.green("  ← active") : ""}  ${chalk.dim(p.config.podUrl)}`,
          value: p.name,
        })),
        initial: active ? profiles.indexOf(active) : 0,
      });
      if (!picked) return;
      targetName = picked as string;
    }
  }

  const profile = profiles.find((p) => p.name === targetName);
  if (!profile) {
    log.error(podNotFoundMessage(targetName));
    return;
  }

  const podUrl = profile.config.podUrl;
  log.info(`Reconnecting to ${chalk.cyan(podUrl)}`);

  const spinner = ora("Checking pod health...").start();
  const health = await checkPodHealth(podUrl);
  if (!health.healthy) {
    spinner.fail(`Pod not reachable at ${podUrl}. Check that it is running.`);
    return;
  }
  spinner.succeed("Pod is reachable");

  // The pod's device flow. A reconnect from the same computer is offered the
  // existing computer on the approval page (its agents, history and rules kept);
  // the approved agents' configs are rewritten with their new keys.
  const { connectThisComputer } = await import("../lib/device-connect.js");
  const saved = await connectThisComputer(podUrl, { name: targetName });
  if (!saved) {
    log.error("Reconnect cancelled. The saved profile is unchanged.");
    return;
  }
  log.success(`Pod '${targetName}' credentials refreshed.`);
}

// ─── update (change URL in place) ─────────────────────────────────────────────

/**
 * Verify whether an existing Hub API key is still accepted by a pod at `podUrl`.
 *
 * Keys are NOT domain-linked — the pod validates a key by its stored hash,
 * independent of the hostname it's reached on — so after a domain move the SAME
 * key should still authenticate. This proves it (via the canonical `/users/me`
 * identity call, the same one `resolveUserId` uses) rather than assuming:
 *   "valid"        — 2xx: key works, no recreate needed
 *   "rejected"     — 401/403: key genuinely refused → must recreate
 *   "inconclusive" — network error / 5xx / other: can't tell, so don't destroy it
 */
async function verifyKeyAgainstPod(
  podUrl: string,
  apiKey: string
): Promise<"valid" | "rejected" | "inconclusive"> {
  try {
    const res = await fetch(`${podUrl.replace(/\/$/, "")}/api/hub/users/me`, {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(10000),
    });
    if (res.ok) return "valid";
    if (res.status === 401 || res.status === 403) return "rejected";
    return "inconclusive";
  } catch {
    return "inconclusive";
  }
}

/**
 * synap pods update <name> [newUrl] — change a saved pod's URL in place.
 *
 * The safe path for a domain move (e.g. pod.team.thearchitech.xyz →
 * pod.thearch.synap.live): checks the pod is reachable at the new URL, verifies
 * whether the existing key still authenticates there, and ONLY offers to recreate
 * the key if the pod genuinely rejects it (keys survive a domain change, so a
 * re-auth is usually unnecessary). Nothing is written until both checks pass, so
 * a typo or a not-yet-live domain leaves the working profile untouched.
 */
export async function podsUpdate(
  name: string,
  newUrlArg?: string,
  opts: { url?: string; yes?: boolean } = {}
): Promise<void> {
  const profiles = listPodProfiles();
  const profile = profiles.find((p) => p.name === name);
  if (!profile) {
    log.error(podNotFoundMessage(name));
    return;
  }
  const currentUrl = profile.config.podUrl;

  // Resolve the new URL: positional arg > --url > prompt (default = current).
  let newUrl = (newUrlArg ?? opts.url)?.trim();
  if (!newUrl && !opts.yes) {
    const { url } = await prompts({
      type: "text",
      name: "url",
      message: `New URL for pod '${name}':`,
      initial: currentUrl,
      validate: (v: string) => v.startsWith("http") || "Must be a valid URL (https://…)",
    });
    if (!url) return;
    newUrl = (url as string).trim();
  }
  if (!newUrl) {
    log.error("No new URL provided. Usage: synap pods update <name> <url>");
    return;
  }
  newUrl = newUrl.replace(/\/$/, "");

  if (newUrl === currentUrl.replace(/\/$/, "")) {
    log.info(`URL unchanged (${newUrl}). Re-verifying reachability + key…`);
  } else {
    log.info(`${chalk.dim(currentUrl)} → ${chalk.cyan(newUrl)}`);
  }

  // 1) Reachability — never point a profile at a dead URL.
  const spinner = ora("Checking pod health at new URL…").start();
  const health = await checkPodHealth(newUrl);
  if (!health.healthy) {
    spinner.fail(`Pod not reachable at ${newUrl} — profile left unchanged.`);
    log.dim(`Verify the domain is live first: curl -sI ${newUrl}/health`);
    return;
  }
  spinner.succeed(`Pod healthy at ${newUrl}${health.version ? `  (v${health.version})` : ""}`);

  // 2) Does the EXISTING key still authenticate against the (possibly new) host?
  let config = profile.config;
  const keySpinner = ora("Verifying existing API key…").start();
  const verdict = await verifyKeyAgainstPod(newUrl, config.hubApiKey);

  if (verdict === "valid") {
    keySpinner.succeed("Existing key still valid — no recreate needed.");
  } else if (verdict === "inconclusive") {
    keySpinner.warn("Could not verify the key (unexpected pod response). Keeping the existing key.");
    log.dim(`If pod calls start failing, run: synap pods reconnect ${name}`);
  } else {
    // rejected — the key is genuinely refused; a recreate is required.
    keySpinner.fail("Pod rejected the existing key — it must be recreated.");
    if (opts.yes) {
      log.warn("Non-interactive (--yes): profile left unchanged so nothing breaks.");
      log.dim(`Recreate the key with: synap pods reconnect ${name}`);
      return;
    }
    const { recreate } = await prompts({
      type: "confirm",
      name: "recreate",
      message: "Connect this computer to the pod again now?",
      initial: true,
    });
    if (!recreate) {
      log.warn(`URL not updated (old profile kept). Re-run when ready, or: synap pods reconnect ${name}`);
      return;
    }
    // The pod's device flow — the same door as `synap pods reconnect`. It saves
    // the computer's new key under this profile (at the new URL) itself.
    const { connectThisComputer } = await import("../lib/device-connect.js");
    const saved = await connectThisComputer(newUrl, { name });
    if (!saved) {
      log.warn("URL not updated (old profile kept). Re-run when ready.");
      return;
    }
    config = saved;
    log.success("New key issued.");
  }

  // 3) Persist in place — preserve everything except the URL (and the
  //    credential, when it was recreated).
  addPodProfile(name, {
    ...config,
    podUrl: newUrl,
    savedAt: new Date().toISOString(),
  });
  log.success(`Pod '${name}' updated → ${newUrl}`);

  // 4) Propagate to surfaces when this pod is active, so MCP configs (Claude
  //    Code/Desktop/Cursor) pick up the new URL. When it's not active, switching
  //    it would be a surprise — just tell the user how to propagate.
  if (profile.active) {
    log.blank();
    await podsUse(name);
  } else {
    log.dim(`'${name}' is not the active pod. Run 'synap pods use ${name}' to propagate the new URL to agent surfaces.`);
  }
}
