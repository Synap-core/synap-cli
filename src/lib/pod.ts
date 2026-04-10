/**
 * Synap pod connection and management utilities.
 */

import { execSync } from "child_process";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const CP_URL = process.env.SYNAP_CP_URL ?? "https://api.synap.live";

// ─── Local CLI config (persists pod connection even without OpenClaw) ─────────
const CONFIG_DIR = path.join(os.homedir(), ".synap");
const CONFIG_FILE = path.join(CONFIG_DIR, "pod-config.json");

export interface LocalPodConfig {
  podUrl: string;
  podId?: string;          // CP pod ID — used to query openclaw/status
  workspaceId: string;
  agentUserId: string;
  hubApiKey: string;
  savedAt: string;
}

export function saveLocalPodConfig(config: LocalPodConfig): void {
  if (!fs.existsSync(CONFIG_DIR)) {
    fs.mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 });
  }
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2), { mode: 0o600 });
}

export function getLocalPodConfig(): LocalPodConfig | null {
  try {
    if (!fs.existsSync(CONFIG_FILE)) return null;
    return JSON.parse(fs.readFileSync(CONFIG_FILE, "utf-8")) as LocalPodConfig;
  } catch {
    return null;
  }
}

export interface PodStatus {
  url: string;
  healthy: boolean;
  version?: string;
  entityCount?: number;
  workspaceId?: string;
}

/**
 * Check if a Synap pod is healthy.
 */
export async function checkPodHealth(podUrl: string): Promise<PodStatus> {
  const status: PodStatus = { url: podUrl, healthy: false };

  try {
    const res = await fetch(`${podUrl}/health`, {
      signal: AbortSignal.timeout(5000),
    });
    if (res.ok) {
      status.healthy = true;
      const data = (await res.json()) as Record<string, unknown>;
      status.version = data.version as string | undefined;
    }
  } catch {
    // pod unreachable
  }

  return status;
}

/**
 * Create an agent user and API key on the pod.
 * Uses the PROVISIONING_TOKEN for auth.
 */
export async function setupAgent(
  podUrl: string,
  provisioningToken: string,
  agentType = "openclaw"
): Promise<{
  hubApiKey: string;
  agentUserId: string;
  workspaceId: string;
}> {
  const res = await fetch(`${podUrl}/api/hub/setup/agent`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${provisioningToken}`,
    },
    body: JSON.stringify({ agentType }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Setup failed (HTTP ${res.status}): ${body}`);
  }

  return (await res.json()) as {
    hubApiKey: string;
    agentUserId: string;
    workspaceId: string;
  };
}

/**
 * Install Docker and start a self-hosted Synap pod.
 */
export function startSelfHostedPod(): void {
  execSync(
    'curl -fsSL https://raw.githubusercontent.com/Synap-core/backend/main/install.sh | bash',
    { stdio: "inherit" }
  );
}

/**
 * Install the synap skill into OpenClaw.
 */
/**
 * Provision the CP-authenticated user on their pod.
 * Calls the CP to get a handshake JWT, then calls /api/handshake on the pod.
 * This ensures the user exists in the pod's users table before setup/agent runs.
 * Safe to call multiple times — idempotent (Kratos upserts by email).
 */
export async function provisionUserOnPod(
  podUrl: string,
  cpToken: string
): Promise<void> {
  // Step 1: Get handshake JWT from CP
  const jwtRes = await fetch(`${CP_URL}/pods/handshake-jwt`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${cpToken}`,
    },
    body: JSON.stringify({ podUrl }),
    signal: AbortSignal.timeout(10000),
  });

  if (!jwtRes.ok) {
    const body = await jwtRes.text().catch(() => "");
    throw new Error(`Could not get handshake JWT (HTTP ${jwtRes.status}): ${body.slice(0, 200)}`);
  }

  const { token } = (await jwtRes.json()) as { token: string };

  // Step 2: Call /api/handshake on the pod
  const handshakeRes = await fetch(`${podUrl}/api/handshake`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ token }),
    signal: AbortSignal.timeout(15000),
  });

  // 200 = created/logged in, 409 = already exists (both are fine)
  if (!handshakeRes.ok && handshakeRes.status !== 409) {
    const body = await handshakeRes.text().catch(() => "");
    throw new Error(`Pod handshake failed (HTTP ${handshakeRes.status}): ${body.slice(0, 200)}`);
  }
}

/**
 * Generate an API key via the Control Plane (for authenticated users).
 * The CP relays the request to the pod using its own authority.
 */
export async function setupAgentViaCp(
  podUrl: string,
  cpToken: string,
  agentType = "openclaw"
): Promise<{
  hubApiKey: string;
  agentUserId: string;
  workspaceId: string;
}> {
  // Call the CP which will relay to the pod
  // The CP knows the pod's PROVISIONING_TOKEN (it provisioned the pod)
  const res = await fetch(`${CP_URL}/pods/setup-agent`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${cpToken}`,
    },
    body: JSON.stringify({ podUrl, agentType }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`CP relay failed (HTTP ${res.status}): ${body}`);
  }

  return (await res.json()) as {
    hubApiKey: string;
    agentUserId: string;
    workspaceId: string;
  };
}

/**
 * Enable OpenClaw as a free addon on a SELF-HOSTED pod.
 * Uses the PROVISIONING_TOKEN directly against the pod.
 */
export async function enableOpenClawAddon(
  podUrl: string,
  provisioningToken: string
): Promise<{ hubApiKey: string; agentUserId: string; workspaceId: string }> {
  return await setupAgent(podUrl, provisioningToken, "openclaw");
}

/**
 * Enable OpenClaw as an addon on a MANAGED pod via the Control Plane.
 * Calls POST /openclaw/provision on the CP (requires CP session token).
 * Returns the podId so the caller can poll status if needed.
 */
export async function enableOpenClawAddonManaged(
  cpToken: string,
  podUrl: string
): Promise<{ podId: string }> {
  // Find the pod ID from the CP
  const podsRes = await fetch(`${CP_URL}/pods`, {
    headers: { Authorization: `Bearer ${cpToken}` },
    signal: AbortSignal.timeout(10000),
  });
  if (!podsRes.ok) throw new Error(`Could not fetch pods (HTTP ${podsRes.status})`);

  const { pods } = (await podsRes.json()) as { pods: Array<{ id: string; subdomain: string; customDomain: string | null }> };
  const appDomain = "synap.live";
  const pod = pods.find((p) => {
    const url = p.customDomain ? `https://${p.customDomain}` : `https://${p.subdomain}.${appDomain}`;
    return url === podUrl || podUrl.includes(p.subdomain);
  });

  if (!pod) throw new Error("Pod not found on your account");

  const provRes = await fetch(`${CP_URL}/openclaw/provision`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${cpToken}`,
    },
    body: JSON.stringify({ podId: pod.id }),
    signal: AbortSignal.timeout(15000),
  });

  if (!provRes.ok) {
    const body = await provRes.text().catch(() => "");
    throw new Error(`OpenClaw provision failed (HTTP ${provRes.status}): ${body.slice(0, 200)}`);
  }

  return { podId: pod.id };
}

/**
 * Check server resources (RAM, disk).
 */
export function checkServerResources(): {
  ramTotal: number;
  ramFree: number;
  diskFree: string;
} {
  let ramTotal = 0;
  let ramFree = 0;
  let diskFree = "unknown";

  try {
    const mem = execSync("free -m 2>/dev/null || sysctl -n hw.memsize 2>/dev/null", {
      encoding: "utf-8",
      timeout: 3000,
    });
    const lines = mem.trim().split("\n");
    if (lines.length > 1) {
      const parts = lines[1].split(/\s+/);
      ramTotal = parseInt(parts[1], 10) || 0;
      ramFree = parseInt(parts[6] || parts[3], 10) || 0;
    } else {
      const bytes = parseInt(lines[0], 10);
      if (bytes > 0) {
        ramTotal = Math.round(bytes / 1024 / 1024);
        ramFree = Math.round(ramTotal * 0.5);
      }
    }
  } catch { /* can't detect */ }

  try {
    const df = execSync("df -h / 2>/dev/null | tail -1", {
      encoding: "utf-8",
      timeout: 3000,
    });
    diskFree = df.trim().split(/\s+/)[3] || "unknown";
  } catch { /* can't detect */ }

  return { ramTotal, ramFree, diskFree };
}

/**
 * Start OpenClaw as a Docker addon on the local server.
 * Writes env vars to the pod's .env file and runs docker compose --profile openclaw.
 * Only works when the CLI is running ON the pod server.
 */
/**
 * Find the Synap deploy directory — where the .env and docker-compose files live.
 * Searches standard locations plus parent dirs of cwd (handles ~/pkm_stacks/synap-backend etc.).
 */
export function findSynapDeployDir(): string | null {
  const home = os.homedir();
  const candidates = [
    // Standard install locations
    "/srv/synap",
    "/opt/synap",
    // Common dev/self-hosted layouts
    path.join(home, "pkm_stacks", "synap-backend", "deploy"),
    path.join(home, "pkm_stacks", "synap-backend"),
    path.join(home, "synap-backend", "deploy"),
    path.join(home, "synap-backend"),
    path.join(home, "synap", "deploy"),
    path.join(home, "synap"),
  ];

  // Also walk up from cwd — handles running from inside the repo
  let dir = process.cwd();
  for (let i = 0; i < 5; i++) {
    candidates.push(dir);
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }

  const hasSynapCompose = (d: string) => {
    try {
      const standalone = path.join(d, "docker-compose.standalone.yml");
      const regular = path.join(d, "docker-compose.yml");
      if (fs.existsSync(standalone)) {
        const content = fs.readFileSync(standalone, "utf-8");
        return /ghcr\.io\/synap-core\/backend|synap-backend/i.test(content);
      }
      if (fs.existsSync(regular)) {
        const content = fs.readFileSync(regular, "utf-8");
        return /ghcr\.io\/synap-core\/backend|synap-backend/i.test(content);
      }
      return false;
    } catch {
      return false;
    }
  };

  // Deduplicate while preserving priority order
  const seen = new Set<string>();
  for (const candidate of candidates) {
    if (seen.has(candidate)) continue;
    seen.add(candidate);
    if (hasSynapCompose(candidate)) return candidate;
  }

  return null;
}

export function startOpenClawOnServer(
  hubApiKey: string,
  agentUserId: string,
  workspaceId: string,
  podUrl: string
): void {
  const deployDir = findSynapDeployDir();

  if (!deployDir) {
    throw new Error(
      "Could not find Synap deploy directory (looked in /srv/synap, /opt/synap, and parent dirs).\n" +
        "Run manually from your synap-backend dir: docker compose --profile openclaw up -d openclaw"
    );
  }

  // Update .env with OpenClaw vars (create or append)
  const envFile = path.join(deployDir, ".env");
  const envVars: Record<string, string> = {
    OPENCLAW_HUB_API_KEY: hubApiKey,
    SYNAP_AGENT_USER_ID: agentUserId,
    SYNAP_WORKSPACE_ID: workspaceId,
    SYNAP_POD_URL: podUrl,
  };

  let envContent = "";
  try {
    envContent = fs.existsSync(envFile) ? fs.readFileSync(envFile, "utf-8") : "";
  } catch {
    /* start fresh */
  }

  // Update or append each var
  for (const [key, value] of Object.entries(envVars)) {
    const regex = new RegExp(`^${key}=.*`, "m");
    const line = `${key}=${value}`;
    if (regex.test(envContent)) {
      envContent = envContent.replace(regex, line);
    } else {
      envContent =
        envContent.endsWith("\n") || envContent === ""
          ? envContent + line + "\n"
          : envContent + "\n" + line + "\n";
    }
  }
  fs.writeFileSync(envFile, envContent, { mode: 0o600 });

  // Start OpenClaw container
  const composeFile = fs.existsSync(
    path.join(deployDir, "docker-compose.standalone.yml")
  )
    ? "docker-compose.standalone.yml"
    : "docker-compose.yml";

  execSync(
    `docker compose -f ${composeFile} --profile openclaw up -d openclaw`,
    { stdio: "inherit", cwd: deployDir, timeout: 60000 }
  );

  // Poll health (up to 30s)
  let healthy = false;
  for (let i = 0; i < 6; i++) {
    try {
      const result = execSync("curl -sf http://localhost:18789/health", {
        encoding: "utf-8",
        timeout: 5000,
      });
      if (result.includes("ok") || result.includes("healthy")) {
        healthy = true;
        break;
      }
    } catch {
      /* not ready yet */
    }
    if (i < 5) execSync("sleep 5");
  }

  if (!healthy) {
    throw new Error(
      "OpenClaw started but health check didn't pass in 30s.\n" +
        "Check logs: docker compose logs openclaw"
    );
  }
}

/**
 * Install the synap skill into OpenClaw.
 */
export function installSynapSkill(): void {
  try {
    execSync(
      "openclaw skills install https://raw.githubusercontent.com/Synap-core/backend/main/skills/synap/SKILL.md",
      { stdio: "inherit", timeout: 30000 }
    );
  } catch {
    // openclaw CLI might not be in PATH — provide manual command
    throw new Error(
      "Could not install skill automatically. Run manually:\n" +
        "  openclaw skills install https://raw.githubusercontent.com/Synap-core/backend/main/skills/synap/SKILL.md"
    );
  }
}
