/**
 * CLI Authentication Module
 *
 * Browser-based poll approval flow (see login() below):
 * 1. POST ${CP}/auth/cli-request → { requestId, pollSecret }
 * 2. Open browser to ${LANDING_URL}/cli?request=<requestId>
 * 3. User signs in via Better Auth + picks a pod → browser POSTs the approval
 * 4. CLI polls GET ${CP}/auth/cli-request/<requestId> with the pollSecret until
 *    the credential payload (session token + pod) comes back
 * 5. CLI stores it in ~/.synap/credentials.json
 *
 * (waitForPodCallback below still uses a localhost server — that's the separate
 * managed-pod provisioning path, not login.)
 */

import http from "node:http";
import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const CP_URL =
  process.env.SYNAP_CP_URL || "https://api.synap.live";
const LANDING_URL =
  process.env.SYNAP_LANDING_URL || "https://synap.live";

const CREDENTIALS_DIR = path.join(os.homedir(), ".synap");
const CREDENTIALS_FILE = path.join(CREDENTIALS_DIR, "credentials.json");

export interface StoredCredentials {
  token: string;
  expiresAt: string;
  userId: string;
  email: string;
  /** ID of the pod the user chose during the web auth flow (optional). */
  podId?: string;
  /** URL of the pod the user chose during the web auth flow (optional). */
  podUrl?: string;
}

// ─── Credential Storage ────────────────────────────────────────────────────

function ensureCredentialsDir(): void {
  if (!fs.existsSync(CREDENTIALS_DIR)) {
    fs.mkdirSync(CREDENTIALS_DIR, { recursive: true, mode: 0o700 });
  }
}

function writeCredentials(creds: StoredCredentials): void {
  ensureCredentialsDir();
  fs.writeFileSync(CREDENTIALS_FILE, JSON.stringify(creds, null, 2), {
    mode: 0o600,
  });
}

export function getStoredToken(): StoredCredentials | null {
  try {
    if (!fs.existsSync(CREDENTIALS_FILE)) return null;
    const raw = fs.readFileSync(CREDENTIALS_FILE, "utf-8");
    return JSON.parse(raw) as StoredCredentials;
  } catch {
    return null;
  }
}

/** True if local expiry timestamp has passed (does NOT call the server). */
export function isTokenLocallyExpired(creds: StoredCredentials): boolean {
  return new Date(creds.expiresAt) < new Date();
}

export function logout(): void {
  try {
    if (fs.existsSync(CREDENTIALS_FILE)) {
      fs.unlinkSync(CREDENTIALS_FILE);
    }
  } catch {
    // ignore
  }
}

// ─── Session Validation ────────────────────────────────────────────────────

export async function isLoggedIn(): Promise<{
  valid: boolean;
  email?: string;
  userId?: string;
}> {
  const creds = getStoredToken();
  if (!creds) return { valid: false };

  try {
    const res = await fetch(`${CP_URL}/auth/me`, {
      headers: { Authorization: `Bearer ${creds.token}` },
      signal: AbortSignal.timeout(5000),
    });

    if (!res.ok) {
      // Server explicitly rejects token — clean up
      logout();
      return { valid: false };
    }

    const data = (await res.json()) as {
      user: { id: string; email: string };
    };

    // Extend local expiry by 7 days from now — keeps the token alive as long
    // as the server is still accepting it (avoids false "expired" deletions)
    writeCredentials({
      ...creds,
      email: data.user.email,
      userId: data.user.id,
      expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
    });

    return { valid: true, email: data.user.email, userId: data.user.id };
  } catch {
    // Network error — keep token, report as invalid for this call only
    return { valid: false };
  }
}

// ─── Token-based Login (headless / server) ─────────────────────────────────

/**
 * Store a manually provided API token (Better Auth session token).
 * Validates against the CP before saving.
 *
 * Usage: synap login --token <token>
 * Get a token from: https://synap.live/account/tokens
 */
export async function loginWithToken(token: string): Promise<StoredCredentials | null> {
  const res = await fetch(`${CP_URL}/auth/me`, {
    headers: { Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(8000),
  });

  if (!res.ok) return null;

  const data = (await res.json()) as { user: { id: string; email: string } };
  const creds: StoredCredentials = {
    token,
    email: data.user.email,
    userId: data.user.id,
    expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
  };
  writeCredentials(creds);
  return creds;
}

// ─── Browser Login Flow ────────────────────────────────────────────────────

function openBrowser(url: string): void {
  try {
    switch (process.platform) {
      case "darwin":
        execSync(`open "${url}"`);
        break;
      case "linux":
        execSync(`xdg-open "${url}"`);
        break;
      case "win32":
        execSync(`start "" "${url}"`);
        break;
      default:
        // Can't open browser — caller handles fallback
        throw new Error("Unsupported platform");
    }
  } catch {
    throw new Error("Could not open browser");
  }
}

/**
 * Browser login via the CP poll-based approval flow.
 *
 * 1. POST /auth/cli-request → { requestId, pollSecret }.
 * 2. Open the browser at `${LANDING_URL}/cli?request=<id>` — the user signs in
 *    and picks a pod, which POSTs the approval to the CP.
 * 3. Poll GET /auth/cli-request/<id> with the pollSecret until the CP returns
 *    the credential payload (session token + chosen pod).
 *
 * No localhost server, no https→http redirect: the three fragile hops of the
 * old flow are gone. Returns null on timeout/denied/failure (callers surface
 * their own message), preserving the previous contract.
 *
 * The BROWSER host is a CLI concern, owned by `LANDING_URL` (default
 * synap.live, env-overridable) — NOT the CP's `approveUrl`. The CP builds that
 * from its own FRONTEND_URL, which is the ADMIN dashboard (dashboard.synap.live),
 * the wrong place to send a user. We take only the `requestId` from the CP and
 * build the landing URL ourselves, exactly as the old flow owned LANDING_URL.
 */
export async function login(): Promise<StoredCredentials | null> {
  const { pollForApproval } = await import("./approval-poll.js");

  // 1. Create the login request on the CP (unauthenticated).
  let created: { requestId: string; pollSecret: string };
  try {
    const res = await fetch(`${CP_URL}/auth/cli-request`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) return null;
    created = (await res.json()) as typeof created;
  } catch {
    return null;
  }

  const { requestId, pollSecret } = created;
  if (!requestId || !pollSecret) return null;

  // 2. Open the browser to the approve screen on the LANDING host (never the
  //    CP's dashboard-derived approveUrl — dashboard is admin-only).
  const approveUrl = `${LANDING_URL}/cli?request=${encodeURIComponent(requestId)}`;
  try {
    openBrowser(approveUrl);
  } catch {
    console.log(`\n  Open this URL in your browser:\n`);
    console.log(`  ${approveUrl}\n`);
  }

  // 3. Poll for approval — the payload IS the StoredCredentials.
  try {
    const creds = await pollForApproval<StoredCredentials>({
      url: `${CP_URL}/auth/cli-request/${requestId}`,
      headers: { Authorization: `Bearer ${pollSecret}` },
      isApproved: (d) => (d as { status?: string }).status === "approved",
      isRejected: (d) => {
        const s = (d as { status?: string }).status;
        return s === "denied" || s === "expired";
      },
      onApproved: (d) => {
        const p = d as {
          token: string;
          email: string;
          userId: string;
          expiresAt?: string;
          podId?: string;
          podUrl?: string;
        };
        return {
          token: p.token,
          email: p.email,
          userId: p.userId,
          expiresAt:
            p.expiresAt ||
            new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
          ...(p.podId ? { podId: p.podId } : {}),
          ...(p.podUrl ? { podUrl: p.podUrl } : {}),
        };
      },
    });
    writeCredentials(creds);
    return creds;
  } catch {
    // Timed out or denied — callers print their own guidance.
    return null;
  }
}

// ─── Pod Provisioning Callback ────────────────────────────────────────────────
//
// Used by `synap init` Path C (managed pod) to resume after a user creates a
// pod on synap.live. The CLI opens:
//   https://synap.live/account/pod/provision?cli_callback=http://localhost:PORT/callback
// The landing page redirects back to:
//   http://localhost:PORT/callback?podUrl=https://...&workspaceId=...

export interface PodCallbackResult {
  podUrl: string;
  workspaceId?: string;
}

export async function waitForPodCallback(
  timeoutMs = 300_000 // 5-minute window
): Promise<PodCallbackResult | null> {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const url = new URL(req.url ?? "/", `http://localhost`);

      if (url.pathname === "/callback") {
        const podUrl = url.searchParams.get("podUrl");
        const workspaceId = url.searchParams.get("workspaceId") ?? undefined;

        res.writeHead(200, { "Content-Type": "text/html" });
        res.end(`<!DOCTYPE html>
<html>
<head><title>Synap CLI</title></head>
<body style="font-family: system-ui, sans-serif; display: flex; align-items: center; justify-content: center; height: 100vh; margin: 0; background: #0a0a0a; color: #e5e5e5;">
  <div style="text-align: center;">
    <h1 style="font-size: 24px; margin-bottom: 8px;">Pod connected</h1>
    <p style="color: #888;">You can close this window and return to the terminal.</p>
  </div>
</body>
</html>`);

        cleanup();
        if (podUrl) {
          resolve({ podUrl, workspaceId });
        } else {
          resolve(null);
        }
      } else {
        res.writeHead(404);
        res.end();
      }
    });

    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      if (!addr || typeof addr === "string") {
        cleanup();
        resolve(null);
        return;
      }

      const port = addr.port;
      const callbackUrl = `http://localhost:${port}/callback`;
      const provisionUrl = `${LANDING_URL}/account/pod/provision?cli_callback=${encodeURIComponent(callbackUrl)}`;

      try {
        openBrowser(provisionUrl);
      } catch {
        console.log(`\n  Open this URL in your browser to provision your pod:\n`);
        console.log(`  ${provisionUrl}\n`);
      }
    });

    const timeout = setTimeout(() => {
      cleanup();
      resolve(null);
    }, timeoutMs);

    function cleanup() {
      clearTimeout(timeout);
      try {
        server.close();
      } catch {
        // ignore
      }
    }
  });
}

// ─── CP API Helpers ────────────────────────────────────────────────────────

export function getCpUrl(): string {
  return CP_URL;
}

export interface Pod {
  id: string;
  subdomain: string;
  customDomain: string | null;
  status: string;
  region: string;
  url: string;
}

export async function listPods(token: string): Promise<Pod[]> {
  const res = await fetch(`${CP_URL}/pods`, {
    headers: { Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(10000),
  });

  if (!res.ok) {
    throw new Error(`Failed to list pods (HTTP ${res.status})`);
  }

  const data = (await res.json()) as { pods: Pod[] };
  // Only show active/provisioning pods — not deleted/archived
  return (data.pods ?? []).filter(
    (p) => p.status === "active" || p.status === "provisioning" || p.status === "syncing_intelligence"
  );
}

/**
 * Get the remote OpenClaw provisioning status from the CP.
 * Returns null if not provisioned or on network error.
 */
export async function getOpenClawRemoteStatus(
  cpToken: string,
  podId: string
): Promise<{ status: "not_provisioned" | "provisioning" | "running" | "error"; url: string | null } | null> {
  try {
    const res = await fetch(`${getCpUrl()}/openclaw/status?podId=${encodeURIComponent(podId)}`, {
      headers: { Authorization: `Bearer ${cpToken}` },
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return null;
    return (await res.json()) as { status: "not_provisioned" | "provisioning" | "running" | "error"; url: string | null };
  } catch {
    return null;
  }
}
