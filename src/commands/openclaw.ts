/**
 * synap openclaw
 *
 * Everything you need to access, configure, and connect OpenClaw
 * after installation. Subcommands:
 *
 *   synap openclaw            — overview: gateway status, AI key, next steps
 *   synap openclaw connect    — show MCP client configs for Claude Desktop, Cursor, etc.
 *   synap openclaw configure  — set AI provider key interactively
 *   synap openclaw logs       — tail container logs
 *   synap openclaw restart    — restart the container
 */

import chalk from "chalk";
import ora from "ora";
import { execSync } from "child_process";
import prompts from "prompts";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { log, banner } from "../utils/logger.js";
import { detectOpenClaw } from "../lib/openclaw.js";
import { findSynapDeployDir, getLocalPodConfig } from "../lib/pod.js";
import { getStoredToken } from "../lib/auth.js";

// ─── Overview ────────────────────────────────────────────────────────────────

export async function openclawOverview(): Promise<void> {
  banner();

  const oc = detectOpenClaw();

  if (!oc.found) {
    log.warn("OpenClaw is not running.");
    log.blank();
    log.dim("Start it: docker compose --profile openclaw up -d openclaw");
    log.dim("Or run:   synap init");
    return;
  }

  // ── Gateway status ──────────────────────────────────────────────────────
  log.heading("Gateway");
  const gatewayPort = oc.gatewayPort ?? 18789;

  if (oc.gatewayRunning) {
    log.success(`Running on port ${gatewayPort}`);
    log.info(`MCP endpoint: ${chalk.cyan(`http://localhost:${gatewayPort}/mcp`)}`);
  } else {
    log.warn(`Port ${gatewayPort} not responding — OpenClaw may still be starting`);
    log.dim("Give it a minute, then: synap openclaw");
  }

  if (oc.runtime === "docker") {
    log.dim(`Container: ${oc.containerName ?? "openclaw"}`);
  }
  if (oc.version) log.dim(`Version: ${oc.version}`);

  // ── AI provider ─────────────────────────────────────────────────────────
  log.heading("AI Provider");
  const aiConfig = readOpenClawAiConfig(oc);
  const hasAnyKey = !!(aiConfig.anthropicKey || aiConfig.openaiKey || aiConfig.geminiKey);
  const apiKeyStatus = { configured: hasAnyKey };
  if (hasAnyKey) {
    if (aiConfig.anthropicKey) log.success(`Anthropic: ${maskKey(aiConfig.anthropicKey)}`);
    if (aiConfig.openaiKey) log.success(`OpenAI:    ${maskKey(aiConfig.openaiKey)}`);
    if (aiConfig.geminiKey) log.success(`Google:    ${maskKey(aiConfig.geminiKey)}`);
    if (aiConfig.primaryModel) log.dim(`Model:     ${aiConfig.primaryModel}`);
  } else {
    log.warn("No AI API key configured — OpenClaw cannot process requests");
    log.blank();
    if (oc.runtime === "docker") {
      log.dim("Set your key:  synap openclaw configure");
    } else {
      log.dim("Set your key:  openclaw configure  (or: synap openclaw configure)");
    }
    log.blank();
    log.dim("Supported: Anthropic (Claude), OpenAI, Google, or Synap IS");
  }

  // ── Skill ───────────────────────────────────────────────────────────────
  log.heading("Synap Skill");
  const skillInstalled = checkSkillInstalled(oc);
  if (skillInstalled) {
    log.success("synap skill installed");
  } else {
    log.warn("Synap skill not installed");
    const containerName = oc.containerName ?? "openclaw";
    log.dim(
      oc.runtime === "docker"
        ? `Install: docker exec ${containerName} openclaw skills install synap`
        : "Install: openclaw skills install synap"
    );
  }

  // ── Dashboard ────────────────────────────────────────────────────────────
  log.heading("Dashboard");
  const publicUrl = getOpenClawPublicUrl();
  if (publicUrl) {
    log.success(`Public: ${chalk.cyan(publicUrl)}`);
    log.dim(`Local:  http://localhost:${oc.gatewayPort ?? 18789}`);
    log.dim("Open:   synap openclaw dashboard");
  } else if (oc.runtime === "docker") {
    log.info(`Local: ${chalk.cyan(`http://localhost:${oc.gatewayPort ?? 18789}`)}`);
    log.dim("Expose via domain:  synap openclaw setup-domain");
    log.dim("SSH tunnel (remote): synap openclaw dashboard");
  } else {
    log.info(`Web UI: ${chalk.cyan(`http://localhost:${oc.gatewayPort ?? 18789}`)}`);
    log.dim("Open: openclaw dashboard  — or: synap openclaw dashboard");
  }

  // ── How to connect ───────────────────────────────────────────────────────
  log.heading("AI Client (MCP)");
  log.info("Connect Claude Desktop, Cursor, or Windsurf:");
  log.blank();
  log.dim("  Claude Desktop    synap openclaw connect --client claude");
  log.dim("  Cursor            synap openclaw connect --client cursor");
  log.dim("  Windsurf          synap openclaw connect --client windsurf");
  log.blank();

  // ── Next steps ───────────────────────────────────────────────────────────
  log.heading("Next Steps");
  if (!apiKeyStatus.configured) {
    log.info("1. Set your AI key:    synap openclaw configure");
    log.info("2. Connect a client:   synap openclaw connect");
  } else if (!skillInstalled) {
    const containerName = oc.containerName ?? "openclaw";
    log.info(
      oc.runtime === "docker"
        ? `1. Install skill: docker exec ${containerName} openclaw skills install synap`
        : "1. Install skill: openclaw skills install synap"
    );
    log.info("2. Connect a client:  synap openclaw connect");
  } else if (!oc.gatewayRunning) {
    log.info("1. Wait for gateway (it may still be starting)");
    log.info("2. Connect a client:  synap openclaw connect");
  } else {
    log.success("Everything looks good.");
    log.info("Connect an AI client:  synap openclaw connect");
  }

  log.blank();
}

// ─── Connect: show MCP client configs ────────────────────────────────────────

export async function openclawConnect(opts: { client?: string }): Promise<void> {
  const oc = detectOpenClaw();
  const gatewayPort = oc.gatewayPort ?? 18789;
  const isDocker = oc.runtime === "docker";

  // OpenClaw MCP is stdio-based — clients run `openclaw mcp serve` as a local process
  // which connects to the gateway over WebSocket. The gateway token authenticates
  // the connection — we fetch it from the container so the config is ready to paste.
  const token = readGatewayToken(oc) ?? undefined;

  if (!token) {
    log.warn("Could not read gateway token from OpenClaw.");
    log.dim("The MCP configs below will require you to add --token manually.");
    log.dim("Run: synap openclaw token");
    log.blank();
  }

  const client = opts.client?.toLowerCase();

  if (!client || client === "claude") {
    printMcpConfig("Claude Desktop", gatewayPort, isDocker, "claude", token);
  }
  if (!client || client === "cursor") {
    printMcpConfig("Cursor", gatewayPort, isDocker, "cursor", token);
  }
  if (!client || client === "windsurf") {
    printMcpConfig("Windsurf", gatewayPort, isDocker, "windsurf", token);
  }
  if (client && !["claude", "cursor", "windsurf"].includes(client)) {
    log.warn(`Unknown client "${client}". Showing generic config.`);
    printMcpConfig("MCP Client", gatewayPort, isDocker, "generic", token);
  }

  if (isDocker) {
    log.blank();
    log.info("Remote server? Tunnel the gateway port first:");
    log.dim(`  ssh -N -L ${gatewayPort}:localhost:${gatewayPort} user@your-server`);
    log.dim("  Then use the configs above (they point to localhost)");
    log.blank();
    log.dim("openclaw must be installed locally on the client machine:");
    log.dim("  npm i -g openclaw");
  }
}

function printMcpConfig(
  label: string,
  gatewayPort: number,
  isRemote: boolean,
  client: "claude" | "cursor" | "windsurf" | "generic",
  token?: string
): void {
  log.heading(label);

  // MCP config: stdio command that connects to the local (or tunneled) gateway
  const args: string[] = ["mcp", "serve"];
  if (isRemote) {
    args.push("--url", `ws://localhost:${gatewayPort}`);
  }
  if (token) {
    args.push("--token", token);
  }

  const config = JSON.stringify(
    { mcpServers: { openclaw: { command: "openclaw", args } } },
    null,
    2
  );

  const paths: Record<string, string> = {
    claude:
      "macOS: ~/Library/Application Support/Claude/claude_desktop_config.json",
    cursor: "~/.cursor/mcp.json",
    windsurf: "~/.windsurf/mcp.json",
    generic: "<your MCP client config file>",
  };

  log.dim(`Config file: ${paths[client]}`);
  log.blank();
  console.log(chalk.cyan(config));
  log.blank();

  if (client === "claude") {
    log.dim("After saving: quit and reopen Claude Desktop");
    log.dim('Ask: "What tools do you have?" — OpenClaw tools should appear');
  }
  if (client === "cursor") {
    log.dim("After saving: Cmd+Shift+P → MCP: Restart Servers");
  }
  log.blank();
}

// ─── Dashboard ───────────────────────────────────────────────────────────────

export function openclawDashboard(): void {
  const oc = detectOpenClaw();
  const port = oc.gatewayPort ?? 18789;
  const localUrl = `http://localhost:${port}`;

  // Check if a public domain is configured via Caddy
  const publicUrl = getOpenClawPublicUrl();

  if (publicUrl) {
    log.info(`Dashboard: ${chalk.cyan(publicUrl)}`);
    log.blank();
    try {
      const open = process.platform === "darwin" ? "open" : "xdg-open";
      execSync(`${open} ${publicUrl}`, { stdio: "ignore" });
    } catch {
      log.dim("Open the URL above in your browser.");
    }
    return;
  }

  if (oc.runtime === "docker") {
    const isRemoteServer = !process.env.DISPLAY && process.platform === "linux";

    if (isRemoteServer) {
      log.info(`Dashboard: ${chalk.cyan(localUrl)}`);
      log.blank();
      log.info("You're on a remote server — tunnel the port to your laptop:");
      log.blank();
      console.log(chalk.cyan(`  ssh -N -L ${port}:localhost:${port} user@$(hostname -I | awk '{print $1}')`));
      log.blank();
      log.dim(`Then open ${chalk.cyan(localUrl)} in your browser.`);
      log.blank();
      log.info("Or expose it permanently via your domain:");
      log.dim("  synap openclaw setup-domain");
    } else {
      log.info(`Opening ${chalk.cyan(localUrl)} ...`);
      try {
        const open = process.platform === "darwin" ? "open" : "xdg-open";
        execSync(`${open} ${localUrl}`, { stdio: "ignore" });
      } catch {
        log.dim(`Open manually: ${localUrl}`);
      }
    }
  } else {
    log.info("Opening dashboard...");
    try {
      execSync("openclaw dashboard", { stdio: "inherit", timeout: 5000 });
    } catch {
      try {
        const open = process.platform === "darwin" ? "open" : "xdg-open";
        execSync(`${open} ${localUrl}`, { stdio: "ignore" });
      } catch {
        log.info(`Dashboard: ${chalk.cyan(localUrl)}`);
      }
    }
  }
}

export async function openclawSetupDomain(): Promise<void> {
  banner();
  log.heading("Expose OpenClaw Dashboard");
  log.blank();

  const deployDir = findSynapDeployDir();
  if (!deployDir) {
    log.error("Couldn't find the Synap deploy directory.");
    log.dim("Run this command on the server where your pod is deployed.");
    return;
  }

  const envDomain = readEnvVar(deployDir, "DOMAIN");
  if (!envDomain) {
    log.error("DOMAIN is not set in .env — can't determine pod domain.");
    return;
  }

  // Detect pod type: managed (*.synap.live) vs self-hosted (custom domain)
  const isManaged = envDomain.endsWith(".synap.live") || envDomain === "synap.live";
  const localConfig = getLocalPodConfig();
  const creds = getStoredToken();

  log.info(`Pod domain: ${chalk.cyan(envDomain)}`);
  log.dim(`Type: ${isManaged ? "managed (synap.live)" : "self-hosted"}`);
  log.blank();

  let publicDomain: string;
  let authMode: "cp-oauth" | "basic";
  let basicAuthPassword: string | undefined;

  if (isManaged) {
    // ── Managed pod flow: CP creates DNS + CP OAuth ───────────────────────
    if (!creds) {
      log.error("Not logged in to Synap.");
      log.dim("Run: synap login  (or: synap login --token <token>)");
      return;
    }
    if (!localConfig?.podId) {
      log.error("Pod ID not found in local config.");
      log.dim("Run: synap init  (to set up the pod connection)");
      return;
    }

    const { confirm } = await prompts({
      type: "confirm",
      name: "confirm",
      message: `Create DNS record openclaw.${envDomain}? (CP will provision it)`,
      initial: true,
    });
    if (!confirm) return;

    const spinner = ora("Asking Control Plane to create DNS record...").start();
    try {
      const result = await requestDashboardDomainFromCp(
        creds.token,
        localConfig.podId
      );
      if (
        result.domain.trim().toLowerCase() === envDomain.trim().toLowerCase()
      ) {
        throw new Error(
          `Refusing unsafe dashboard domain "${result.domain}": use a dedicated subdomain (e.g. openclaw.${envDomain}).`
        );
      }
      publicDomain = result.domain;
      authMode = result.authMode;
      spinner.succeed(`Domain created: ${chalk.cyan(publicDomain)}`);
    } catch (err) {
      spinner.fail(err instanceof Error ? err.message : String(err));
      log.dim("If this is a custom-domain or self-hosted pod, run again — it will fall back to manual mode.");
      return;
    }
  } else {
    // ── Self-hosted flow: user sets DNS, we use basic auth ────────────────
    log.info("Self-hosted pod — you'll need to add a DNS record yourself.");
    log.blank();

    const { subdomain } = await prompts({
      type: "text",
      name: "subdomain",
      message: "Public subdomain for OpenClaw:",
      initial: `openclaw.${envDomain}`,
    });
    if (!subdomain) return;
    if (subdomain.trim().toLowerCase() === envDomain.trim().toLowerCase()) {
      log.error(
        "OPENCLAW_DOMAIN cannot match DOMAIN. This causes redirect loops."
      );
      log.dim(`Use a dedicated host, for example: openclaw.${envDomain}`);
      return;
    }
    publicDomain = subdomain;
    authMode = "basic";

    log.blank();
    log.info("Add this DNS A record:");
    log.dim(`  Type:   A`);
    log.dim(`  Name:   ${publicDomain}`);
    log.dim(`  Value:  <this server's public IP>`);
    log.blank();

    const { dnsReady } = await prompts({
      type: "confirm",
      name: "dnsReady",
      message: "DNS record added?",
      initial: true,
    });
    if (!dnsReady) {
      log.dim("Run this command again once DNS is set up.");
      return;
    }

    // Generate a strong random password for basic auth
    basicAuthPassword = generatePassword(32);
  }

  // ── Write the Caddy auth snippet ──────────────────────────────────────────
  const snippetPath = path.join(deployDir, "openclaw_auth.snippet");

  if (authMode === "cp-oauth") {
    fs.writeFileSync(snippetPath, generateCpOAuthSnippet(), { mode: 0o644 });
    log.success("Wrote CP OAuth auth snippet");
  } else {
    const hash = await bcryptHashViaCaddy(basicAuthPassword!);
    fs.writeFileSync(snippetPath, generateBasicAuthSnippet("openclaw", hash), { mode: 0o644 });
    log.success("Wrote basic auth snippet");
  }

  // ── Update .env ───────────────────────────────────────────────────────────
  const envFile = path.join(deployDir, ".env");
  writeEnvVar(envFile, "OPENCLAW_DOMAIN", publicDomain);
  log.success(`Set OPENCLAW_DOMAIN=${publicDomain} in .env`);

  // ── Restart Caddy ────────────────────────────────────────────────────────
  log.blank();
  log.info("Restarting Caddy to apply changes...");
  try {
    execSync("docker compose restart caddy", {
      cwd: deployDir,
      stdio: "pipe",
      timeout: 30000,
    });
    log.success("Caddy restarted");
  } catch {
    log.warn("Caddy restart failed — run manually:");
    log.dim(`  cd ${deployDir} && docker compose restart caddy`);
  }

  // ── Summary ──────────────────────────────────────────────────────────────
  log.blank();
  console.log(chalk.green("═══════════════════════════════════════════"));
  console.log(chalk.green.bold("  OpenClaw Dashboard Ready"));
  console.log(chalk.green("═══════════════════════════════════════════"));
  log.blank();
  log.info(`URL: ${chalk.cyan(`https://${publicDomain}`)}`);
  log.blank();

  if (authMode === "cp-oauth") {
    log.info("Auth: Synap session (you're already logged in to synap.live)");
    log.dim("Open the URL — if you're not signed in, you'll be redirected to login.");
  } else {
    log.info("Auth: basic auth");
    log.dim(`  Username: openclaw`);
    log.dim(`  Password: ${chalk.cyan(basicAuthPassword)}`);
    log.blank();
    log.warn("Save this password — it won't be shown again.");
  }
  log.blank();
  log.dim("TLS: Caddy will provision a Let's Encrypt certificate on first visit.");
  log.dim("This takes ~30s the first time.");
  log.blank();
}

// ─── Configure: set AI provider key ──────────────────────────────────────────

export interface ConfigureOpts {
  interactive?: boolean;
  provider?: "anthropic" | "openai" | "google";
  key?: string;
  model?: string;
  show?: boolean;
}

export async function openclawConfigure(opts: ConfigureOpts = {}): Promise<void> {
  const oc = detectOpenClaw();
  if (!oc.found) {
    log.error("OpenClaw is not running.");
    return;
  }

  // Verify openclaw binary is actually callable inside the container before
  // we start writing config. Protects against "container up but openclaw not ready".
  if (oc.runtime === "docker" && !verifyOpenclawCliReady(oc.containerName ?? "openclaw")) {
    log.error("OpenClaw container is running, but the openclaw CLI isn't responding.");
    log.dim("It may still be initializing. Wait 30s and try again, or run: synap openclaw doctor");
    return;
  }

  // ── Show current config ─────────────────────────────────────────────────
  if (opts.show) {
    log.heading("OpenClaw AI Config");
    const current = readOpenClawAiConfig(oc);
    if (current.anthropicKey) log.success(`Anthropic: ${maskKey(current.anthropicKey)}`);
    if (current.openaiKey) log.success(`OpenAI:    ${maskKey(current.openaiKey)}`);
    if (current.geminiKey) log.success(`Google:    ${maskKey(current.geminiKey)}`);
    if (current.primaryModel) log.info(`Model:     ${current.primaryModel}`);
    if (!current.anthropicKey && !current.openaiKey && !current.geminiKey) {
      log.warn("No AI provider key configured");
    }
    return;
  }

  // ── Interactive (delegate to OpenClaw's own wizard) ──────────────────────
  if (opts.interactive) {
    handoffToOpenClawWizard(oc);
    return;
  }

  banner();
  log.heading("Configure AI Provider");

  // ── Scripted path (--provider + --key) ───────────────────────────────────
  let provider = opts.provider;
  let apiKey = opts.key;
  let model = opts.model;

  if (!provider) {
    const pick = await prompts({
      type: "select",
      name: "provider",
      message: "Which AI provider?",
      choices: [
        { title: "Anthropic (Claude)", description: "recommended", value: "anthropic" },
        { title: "OpenAI (GPT-4o)", value: "openai" },
        { title: "Google (Gemini)", value: "google" },
        { title: "Run OpenClaw's own wizard", description: "interactive", value: "wizard" },
      ],
    });
    if (!pick.provider) return;
    // Inline handoff — don't recurse, we already have `oc` in scope
    if (pick.provider === "wizard") {
      handoffToOpenClawWizard(oc);
      return;
    }
    provider = pick.provider;
  }

  const envKey =
    provider === "anthropic"
      ? "ANTHROPIC_API_KEY"
      : provider === "openai"
      ? "OPENAI_API_KEY"
      : "GEMINI_API_KEY";

  const modelDefault =
    provider === "anthropic"
      ? "anthropic/claude-sonnet-4-6"
      : provider === "openai"
      ? "openai/gpt-4o"
      : "google/gemini-2.0-flash";

  if (!apiKey) {
    const res = await prompts({ type: "password", name: "apiKey", message: `${envKey}:` });
    if (!res.apiKey) return;
    apiKey = res.apiKey as string;
  }

  if (!model) {
    const res = await prompts({
      type: "text",
      name: "model",
      message: "Model:",
      initial: modelDefault,
    });
    if (!res.model) return;
    model = res.model as string;
  }

  // Final narrowing — both are guaranteed strings by this point
  const finalKey: string = apiKey;
  const finalModel: string = model;

  // ── Write via OpenClaw's own config system ──────────────────────────────
  const containerName = oc.containerName ?? "openclaw";

  // Step 1: API key — MUST succeed
  const keySpinner = ora(`Setting env.${envKey}...`).start();
  const keyResult = runOpenClawConfigSet(containerName, `env.${envKey}`, finalKey);
  if (!keyResult.ok) {
    keySpinner.fail(`Failed to set env.${envKey}`);
    log.dim(keyResult.stderr || keyResult.error || "(no output)");
    log.dim("Diagnose: synap openclaw doctor");
    return;
  }
  keySpinner.succeed(`Set env.${envKey}`);

  // Step 2: Model — non-fatal (schema path may differ across OpenClaw versions)
  const modelSpinner = ora(`Setting default model to ${finalModel}...`).start();
  const modelPaths = [
    "agents.defaults.model.primary",
    "models.default",
    "agent.model",
  ];
  let modelSet = false;
  let modelError = "";
  for (const modelPath of modelPaths) {
    const r = runOpenClawConfigSet(containerName, modelPath, finalModel);
    if (r.ok) {
      modelSpinner.succeed(`Set ${modelPath} = ${finalModel}`);
      modelSet = true;
      break;
    }
    modelError = r.stderr || r.error || modelError;
  }
  if (!modelSet) {
    modelSpinner.warn(`Couldn't set model automatically — set it manually`);
    log.dim(`Tried: ${modelPaths.join(", ")}`);
    if (modelError) log.dim(`Last error: ${modelError.split("\n")[0]}`);
    log.dim(`Run: docker exec -it ${containerName} openclaw configure`);
  }

  // ── Restart to apply ─────────────────────────────────────────────────────
  log.info("Restarting OpenClaw to apply...");
  try {
    execSync(`docker restart ${containerName}`, { stdio: "pipe", timeout: 30000 });
    log.success("Restarted — give it ~30s to come back up");
    log.dim("Check: synap openclaw");
  } catch {
    log.warn("Restart failed — run manually: docker restart openclaw");
  }
  log.blank();
}

// ─── Connections: unified view of what's connected ─────────────────────────

export function openclawConnections(): void {
  banner();
  const oc = detectOpenClaw();
  if (!oc.found) {
    log.error("OpenClaw is not running.");
    return;
  }

  const publicUrl = getOpenClawPublicUrl();
  const gatewayPort = oc.gatewayPort ?? 18789;
  const localUrl = `http://localhost:${gatewayPort}`;
  const dashboardUrl = publicUrl ?? localUrl;

  // ── AI Providers ─────────────────────────────────────────────────────────
  log.heading("AI Providers");
  const ai = readOpenClawAiConfig(oc);
  const synapProvider = readSynapProviderConfig(oc);
  const hasAny = ai.anthropicKey || ai.openaiKey || ai.geminiKey || synapProvider;
  if (!hasAny) {
    log.warn("No provider configured");
    log.dim("Run: synap openclaw configure");
  } else {
    if (ai.anthropicKey) log.success(`Anthropic       ${maskKey(ai.anthropicKey)}`);
    if (ai.openaiKey) log.success(`OpenAI          ${maskKey(ai.openaiKey)}`);
    if (ai.geminiKey) log.success(`Google Gemini   ${maskKey(ai.geminiKey)}`);
    if (synapProvider?.baseUrl) {
      log.success(`Synap IS        ${synapProvider.baseUrl}`);
      log.dim("                Models: synap/auto, synap/balanced, synap/advanced");
    }
    if (ai.primaryModel) log.dim(`Primary model:  ${ai.primaryModel}`);
  }

  // ── Skills ───────────────────────────────────────────────────────────────
  log.heading("Skills");
  const skills = readOpenClawSkills(oc);
  if (skills.length > 0) {
    for (const skill of skills) {
      if (skill.toLowerCase().includes("synap")) {
        log.success(`${skill}  ${chalk.dim("(Synap knowledge graph + relay)")}`);
      } else {
        log.info(skill);
      }
    }
  } else {
    log.dim("None detected");
  }
  log.dim(`Browse more: ${dashboardUrl}/#skills`);

  // ── Channels ─────────────────────────────────────────────────────────────
  log.heading("Channels");
  const channels = readOpenClawChannels(oc);
  const channelTypes = [
    "telegram",
    "discord",
    "whatsapp",
    "slack",
    "signal",
    "imessage",
    "matrix",
  ];
  for (const type of channelTypes) {
    const connected = channels.some((c) => c.toLowerCase().includes(type));
    const label = type.charAt(0).toUpperCase() + type.slice(1);
    if (connected) {
      log.success(`${label.padEnd(12)}connected`);
    } else {
      log.dim(`○ ${label.padEnd(12)}not connected`);
    }
  }
  log.blank();
  log.dim(`Connect channels: ${dashboardUrl}/#channels`);
  log.dim("Or: synap openclaw open channels");

  // ── MCP Clients ──────────────────────────────────────────────────────────
  log.heading("MCP Clients");
  log.info("Connect Claude Desktop, Cursor, Windsurf to OpenClaw:");
  log.dim("  synap openclaw connect --client claude");
  log.dim("  synap openclaw connect --client cursor");
  log.dim("  synap openclaw connect --client windsurf");

  // ── Dashboard ────────────────────────────────────────────────────────────
  log.heading("Dashboard");
  log.info(chalk.cyan(dashboardUrl));
  if (!publicUrl) {
    log.dim("Not publicly exposed — run: synap openclaw setup-domain");
  }

  log.blank();
}

// ─── Open: deep-link to dashboard sections ───────────────────────────────────

const DASHBOARD_SECTIONS = ["channels", "skills", "config", "chat", "sessions", "logs"] as const;
type DashboardSection = (typeof DASHBOARD_SECTIONS)[number];

export function openclawOpen(section?: string): void {
  const oc = detectOpenClaw();
  if (!oc.found) {
    log.error("OpenClaw is not running.");
    return;
  }

  const publicUrl = getOpenClawPublicUrl();
  const gatewayPort = oc.gatewayPort ?? 18789;
  const baseUrl = publicUrl ?? `http://localhost:${gatewayPort}`;

  let url = baseUrl;
  if (section) {
    const s = section.toLowerCase();
    if (DASHBOARD_SECTIONS.includes(s as DashboardSection)) {
      url = `${baseUrl}/#${s}`;
    } else {
      log.warn(`Unknown section "${section}". Known sections:`);
      log.dim(`  ${DASHBOARD_SECTIONS.join(", ")}`);
      log.info(`Opening main dashboard instead: ${chalk.cyan(baseUrl)}`);
      url = baseUrl;
    }
  }

  log.info(`Opening ${chalk.cyan(url)}`);
  try {
    const open = process.platform === "darwin" ? "open" : "xdg-open";
    execSync(`${open} ${JSON.stringify(url)}`, { stdio: "ignore" });
  } catch {
    log.dim("Could not open browser automatically — open the URL above manually.");
  }
}

// ─── Configure helpers ───────────────────────────────────────────────────────

function verifyOpenclawCliReady(containerName: string): boolean {
  try {
    execSync(`docker exec ${containerName} openclaw --version`, {
      stdio: "pipe",
      timeout: 8000,
    });
    return true;
  } catch {
    return false;
  }
}

function handoffToOpenClawWizard(oc: ReturnType<typeof detectOpenClaw>): void {
  if (oc.runtime !== "docker") {
    log.error("Interactive wizard only works for Docker runtime.");
    log.dim("For local install, run: openclaw configure");
    return;
  }
  const containerName = oc.containerName ?? "openclaw";
  log.heading("Handing off to OpenClaw");
  log.dim(`Running: docker exec -it ${containerName} openclaw configure`);
  log.blank();
  try {
    // stdio: inherit passes our TTY through to docker exec.
    // If we're not on a TTY (e.g. piped input), docker exec -it will fail — catch it.
    execSync(`docker exec -it ${containerName} openclaw configure`, { stdio: "inherit" });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.error(`openclaw configure failed: ${msg}`);
    log.dim(`Run directly: docker exec -it ${containerName} openclaw configure`);
  }
}

interface ConfigSetResult {
  ok: boolean;
  stderr?: string;
  error?: string;
}

function runOpenClawConfigSet(
  containerName: string,
  key: string,
  value: string
): ConfigSetResult {
  try {
    // Use shell quoting via JSON.stringify — handles quotes + special chars safely.
    // stdio: pipe so we can capture stderr on failure.
    execSync(
      `docker exec ${containerName} openclaw config set ${key} ${JSON.stringify(value)}`,
      { stdio: "pipe", timeout: 15000, encoding: "utf-8" }
    );
    return { ok: true };
  } catch (err: unknown) {
    const e = err as { stderr?: Buffer | string; message?: string };
    const stderr = typeof e.stderr === "string" ? e.stderr : e.stderr?.toString("utf-8");
    return {
      ok: false,
      stderr: stderr?.trim(),
      error: e.message,
    };
  }
}

// ─── Logs: tail container output ─────────────────────────────────────────────

export function openclawLogs(opts: { lines?: number; follow?: boolean }): void {
  const oc = detectOpenClaw();

  if (oc.runtime !== "docker") {
    log.warn("Log tailing only available for Docker runtime.");
    log.dim("OpenClaw logs: check your process manager or journald");
    return;
  }

  const containerName = oc.containerName ?? "openclaw";
  const lines = opts.lines ?? 50;
  const flag = opts.follow ? "-f" : `--tail ${lines}`;

  try {
    log.dim(`docker logs ${containerName} ${flag}`);
    log.blank();
    execSync(`docker logs ${containerName} ${flag}`, { stdio: "inherit", timeout: opts.follow ? 0 : 30000 });
  } catch {
    log.error(`Could not get logs for container "${containerName}"`);
    log.dim(`Try: docker logs ${containerName} --tail 50`);
  }
}

// ─── Token: print the gateway token ──────────────────────────────────────────

export function openclawToken(opts: { copy?: boolean; for?: string }): void {
  const oc = detectOpenClaw();
  if (!oc.found) {
    log.error("OpenClaw is not running.");
    return;
  }

  const token = readGatewayToken(oc);
  if (!token) {
    log.error("Could not read gateway token from OpenClaw.");
    log.dim("Try: synap openclaw doctor");
    return;
  }

  if (opts.for) {
    // Print a pre-filled MCP client config with the token embedded
    const client = opts.for.toLowerCase();
    const gatewayPort = oc.gatewayPort ?? 18789;
    const config = {
      mcpServers: {
        openclaw: {
          command: "openclaw",
          args: [
            "mcp",
            "serve",
            "--url",
            `ws://localhost:${gatewayPort}`,
            "--token",
            token,
          ],
        },
      },
    };
    const paths: Record<string, string> = {
      claude: "~/Library/Application Support/Claude/claude_desktop_config.json",
      cursor: "~/.cursor/mcp.json",
      windsurf: "~/.windsurf/mcp.json",
    };
    log.heading(client.charAt(0).toUpperCase() + client.slice(1));
    if (paths[client]) log.dim(`Config file: ${paths[client]}`);
    log.blank();
    console.log(chalk.cyan(JSON.stringify(config, null, 2)));
    log.blank();
    return;
  }

  if (opts.copy) {
    try {
      const pbcopy =
        process.platform === "darwin"
          ? "pbcopy"
          : process.platform === "linux"
          ? "xclip -selection clipboard"
          : null;
      if (pbcopy) {
        execSync(`echo -n ${JSON.stringify(token)} | ${pbcopy}`, { stdio: "pipe" });
        log.success("Token copied to clipboard");
        return;
      }
    } catch {
      // fall through to print
    }
  }

  // Plain print
  console.log(token);
}

function readGatewayToken(oc: ReturnType<typeof detectOpenClaw>): string | null {
  if (!oc.found) return null;
  if (oc.runtime === "docker") {
    const containerName = oc.containerName ?? "openclaw";
    // Try OpenClaw's own config first — works even if token file path changes
    try {
      const raw = execSync(
        `docker exec ${containerName} openclaw config get gateway.token 2>/dev/null`,
        { encoding: "utf-8", timeout: 5000 }
      ).trim();
      if (raw && raw !== "undefined" && raw !== "null") {
        return raw.replace(/^["']|["']$/g, "");
      }
    } catch {
      // fall through
    }
    // Fallback: read the token file directly
    try {
      const raw = execSync(
        `docker exec ${containerName} cat /root/.openclaw/gateway.token 2>/dev/null`,
        { encoding: "utf-8", timeout: 5000 }
      ).trim();
      return raw || null;
    } catch {
      return null;
    }
  }
  // Local install — read from host filesystem
  try {
    const tokenPath = `${process.env.HOME}/.openclaw/gateway.token`;
    if (fs.existsSync(tokenPath)) {
      return fs.readFileSync(tokenPath, "utf-8").trim();
    }
  } catch {
    // ignore
  }
  return null;
}

// ─── Doctor: run OpenClaw's own diagnostic ───────────────────────────────────

export function openclawDoctor(opts: { fix?: boolean }): void {
  const oc = detectOpenClaw();
  if (!oc.found) {
    log.error("OpenClaw is not running.");
    return;
  }

  const fixFlag = opts.fix ? " --fix" : "";

  if (oc.runtime === "docker") {
    const containerName = oc.containerName ?? "openclaw";
    log.dim(`Running: docker exec ${containerName} openclaw doctor${fixFlag}`);
    log.blank();
    try {
      execSync(`docker exec ${containerName} openclaw doctor${fixFlag}`, {
        stdio: "inherit",
        timeout: 60000,
      });
    } catch {
      log.warn("openclaw doctor reported issues or failed");
    }
  } else {
    try {
      execSync(`openclaw doctor${fixFlag}`, { stdio: "inherit", timeout: 60000 });
    } catch {
      log.warn("openclaw doctor reported issues or failed");
    }
  }
}

// ─── Restart ─────────────────────────────────────────────────────────────────

export async function openclawRestart(): Promise<void> {
  const oc = detectOpenClaw();

  if (oc.runtime !== "docker") {
    log.warn("Restart only available for Docker runtime.");
    return;
  }

  const containerName = oc.containerName ?? "openclaw";

  const { confirm } = await prompts({
    type: "confirm",
    name: "confirm",
    message: `Restart ${containerName}?`,
    initial: true,
  });

  if (!confirm) return;

  try {
    execSync(`docker restart ${containerName}`, { stdio: "pipe", timeout: 30000 });
    log.success(`${containerName} restarted — give it ~30s to come back up`);
    log.dim("Check: synap openclaw");
  } catch {
    log.error("Restart failed");
    log.dim(`Try: docker restart ${containerName}`);
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function getOpenClawPublicUrl(): string | null {
  const deployDir = findSynapDeployDir();
  if (!deployDir) return null;
  try {
    const content = fs.readFileSync(`${deployDir}/.env`, "utf-8");
    const match = content.match(/^OPENCLAW_DOMAIN=(.+)$/m);
    const domain = match?.[1]?.trim();
    if (!domain || domain === "disabled.invalid" || domain === "") return null;
    return `https://${domain}`;
  } catch {
    return null;
  }
}

function checkSkillInstalled(oc: ReturnType<typeof detectOpenClaw>): boolean {
  if (!oc.found) return false;
  if (oc.runtime === "docker") {
    try {
      const containerName = oc.containerName ?? "openclaw";
      const out = execSync(
        `docker exec ${containerName} openclaw skills list 2>/dev/null`,
        { encoding: "utf-8", timeout: 10000 }
      );
      return /synap/i.test(out);
    } catch {
      return false;
    }
  }
  // Local install — check skills directory
  return false;
}

function writeEnvVar(envFile: string, key: string, value: string): void {
  let content = "";
  try {
    content = fs.existsSync(envFile) ? fs.readFileSync(envFile, "utf-8") : "";
  } catch {
    // start fresh
  }
  const regex = new RegExp(`^${key}=.*`, "m");
  const line = `${key}=${value}`;
  content = regex.test(content)
    ? content.replace(regex, line)
    : content.endsWith("\n") || content === ""
    ? content + line + "\n"
    : content + "\n" + line + "\n";
  fs.writeFileSync(envFile, content, { mode: 0o600 });
}

// ─── Domain setup helpers ────────────────────────────────────────────────────

function readEnvVar(deployDir: string, key: string): string | null {
  try {
    const content = fs.readFileSync(path.join(deployDir, ".env"), "utf-8");
    const match = content.match(new RegExp(`^${key}=(.+)$`, "m"));
    return match?.[1]?.trim() ?? null;
  } catch {
    return null;
  }
}

function generatePassword(length: number): string {
  // URL-safe random password
  return crypto
    .randomBytes(length)
    .toString("base64url")
    .slice(0, length);
}

async function bcryptHashViaCaddy(plaintext: string): Promise<string> {
  // Caddy ships `caddy hash-password` which outputs a bcrypt hash.
  // Run it via the running caddy container so we don't need a bcrypt dep in Node.
  try {
    const hash = execSync(
      `docker exec -i caddy caddy hash-password --plaintext ${JSON.stringify(plaintext)}`,
      { encoding: "utf-8", timeout: 10000 }
    ).trim();
    return hash;
  } catch (err) {
    // Fallback: try without container (if caddy is in PATH)
    try {
      return execSync(
        `caddy hash-password --plaintext ${JSON.stringify(plaintext)}`,
        { encoding: "utf-8", timeout: 10000 }
      ).trim();
    } catch {
      throw new Error(
        `Could not hash password via caddy: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }
}

function generateCpOAuthSnippet(): string {
  return `# OpenClaw dashboard auth — CP OAuth (generated by synap openclaw setup-domain)
#
# Validates the Better Auth session cookie against the Synap Control Plane.
# Because the CP cookie is set with Domain=.synap.live (crossSubDomainCookies),
# the browser sends it automatically to this subdomain.
#
# 200 → authenticated, pass through to openclaw
# 401 → redirect to synap.live login

forward_auth https://api.synap.live {
    uri /api/auth/me
    copy_headers X-Authenticated-User

    @unauthorized status 401
    handle_response @unauthorized {
        redir https://synap.live/login?redirect=https://{host}{uri} temporary
    }
}
`;
}

function generateBasicAuthSnippet(username: string, bcryptHash: string): string {
  return `# OpenClaw dashboard auth — basic auth (generated by synap openclaw setup-domain)
#
# Single credential protects the dashboard. The password hash below was
# generated with \`caddy hash-password\`. To rotate, run:
#   synap openclaw setup-domain

basicauth {
    ${username} ${bcryptHash}
}
`;
}

function readOpenClawAiConfig(oc: ReturnType<typeof detectOpenClaw>): {
  anthropicKey?: string;
  openaiKey?: string;
  geminiKey?: string;
  primaryModel?: string;
} {
  if (!oc.found || oc.runtime !== "docker") return {};
  const containerName = oc.containerName ?? "openclaw";

  const read = (key: string): string | undefined => {
    try {
      const out = execSync(
        `docker exec ${containerName} openclaw config get ${key} 2>/dev/null`,
        { encoding: "utf-8", timeout: 5000 }
      ).trim();
      if (!out || out === "undefined" || out === "null") return undefined;
      return out.replace(/^["']|["']$/g, "");
    } catch {
      return undefined;
    }
  };

  return {
    anthropicKey: read("env.ANTHROPIC_API_KEY"),
    openaiKey: read("env.OPENAI_API_KEY"),
    geminiKey: read("env.GEMINI_API_KEY"),
    primaryModel: read("agents.defaults.model.primary"),
  };
}

function maskKey(key: string): string {
  if (key.length <= 8) return "•".repeat(key.length);
  return `${key.slice(0, 4)}...${key.slice(-4)}`;
}

function readSynapProviderConfig(
  oc: ReturnType<typeof detectOpenClaw>
): { baseUrl?: string } | null {
  if (!oc.found || oc.runtime !== "docker") return null;
  const containerName = oc.containerName ?? "openclaw";
  try {
    const out = execSync(
      `docker exec ${containerName} openclaw config get models.providers.synap.baseUrl 2>/dev/null`,
      { encoding: "utf-8", timeout: 5000 }
    ).trim();
    if (!out || out === "undefined" || out === "null") return null;
    return { baseUrl: out.replace(/^["']|["']$/g, "") };
  } catch {
    return null;
  }
}

function readOpenClawSkills(oc: ReturnType<typeof detectOpenClaw>): string[] {
  if (!oc.found) return [];
  if (oc.runtime === "docker") {
    const containerName = oc.containerName ?? "openclaw";
    try {
      const out = execSync(
        `docker exec ${containerName} openclaw skills list 2>/dev/null`,
        { encoding: "utf-8", timeout: 10000 }
      );
      // OpenClaw's `skills list` output format varies; extract slug-like tokens.
      const names = new Set<string>();
      for (const line of out.split("\n")) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith("#") || /^(name|slug|version|installed)/i.test(trimmed)) {
          continue;
        }
        // Pick the first slug-looking token on the line
        const match = trimmed.match(/^([a-z0-9][\w-]+)\b/i);
        if (match && match[1].length >= 3) {
          names.add(match[1]);
        }
      }
      return Array.from(names);
    } catch {
      return [];
    }
  }
  return [];
}

function readOpenClawChannels(oc: ReturnType<typeof detectOpenClaw>): string[] {
  if (!oc.found) return [];
  if (oc.runtime === "docker") {
    const containerName = oc.containerName ?? "openclaw";
    try {
      const out = execSync(
        `docker exec ${containerName} openclaw channels list 2>/dev/null`,
        { encoding: "utf-8", timeout: 10000 }
      );
      const names = new Set<string>();
      for (const line of out.split("\n")) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        // Extract any line that mentions a known channel type
        for (const type of ["telegram", "discord", "whatsapp", "slack", "signal", "imessage", "matrix"]) {
          if (new RegExp(`\\b${type}\\b`, "i").test(trimmed)) {
            names.add(type);
          }
        }
      }
      return Array.from(names);
    } catch {
      return [];
    }
  }
  return [];
}

async function requestDashboardDomainFromCp(
  cpToken: string,
  podId: string
): Promise<{ domain: string; authMode: "cp-oauth" | "basic" }> {
  const cpUrl = process.env.SYNAP_CP_URL ?? "https://api.synap.live";
  const res = await fetch(`${cpUrl}/openclaw/expose-dashboard`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${cpToken}`,
    },
    body: JSON.stringify({ podId }),
    signal: AbortSignal.timeout(20000),
  });

  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { error?: string } | null;
    throw new Error(
      `CP request failed (HTTP ${res.status}): ${body?.error ?? "unknown error"}`
    );
  }

  const data = (await res.json()) as {
    domain: string;
    authMode: "cp-oauth" | "basic";
  };
  return { domain: data.domain, authMode: data.authMode };
}
