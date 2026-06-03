/**
 * Browser-based connect flow — the recommended provisioning path.
 *
 * 1. Start a local HTTP server on an ephemeral port.
 * 2. Build `{podUrl}/admin/connect?integration=cli&redirect_uri=http://127.0.0.1:<port>/callback`.
 * 3. Open the user's default browser at that URL.
 * 4. Admin UI authenticates the user (Kratos session), mints a scoped Hub
 *    Protocol API key via `trpc.apiKeys.connectIntegration`, and redirects
 *    to `http://127.0.0.1:<port>/callback?context={apiKey,podUrl,workspaceId}`.
 * 5. Local server receives the callback, extracts credentials, shuts down.
 *
 * This is the same flow Raycast uses (via a `raycast://` deeplink) — for CLI
 * we just swap the deeplink for a loopback HTTP URL. The admin UI's redirect
 * whitelist accepts both.
 *
 * Security notes:
 *   - Loopback only (127.0.0.1) — no external network can intercept.
 *   - One-shot: server only handles the first /callback, then exits.
 *   - 5-minute timeout.
 *   - No CSRF token: single-use, host-local, bound to the process.
 */

import http from "node:http";
import { URL } from "node:url";
import { spawn } from "node:child_process";
import type { AddressInfo } from "node:net";

export interface BrowserAuthResult {
  apiKey: string;
  podUrl: string;
  workspaceId?: string;
}

export interface BrowserAuthOptions {
  podUrl: string;
  integration: "cli" | "raycast" | "openclaw" | "custom";
  /** Milliseconds to wait for the callback. Default 5min. */
  timeoutMs?: number;
  /** Hook invoked with the admin-panel URL right before opening the browser. */
  onUrlReady?: (url: string) => void;
}

export async function runBrowserAuth(
  opts: BrowserAuthOptions
): Promise<BrowserAuthResult> {
  const podUrl = opts.podUrl.replace(/\/$/, "");
  const timeoutMs = opts.timeoutMs ?? 5 * 60_000;

  return new Promise<BrowserAuthResult>((resolve, reject) => {
    const server = http.createServer();
    let settled = false;
    const settle = (fn: () => void) => {
      if (settled) return;
      settled = true;
      fn();
      server.close();
      clearTimeout(timeout);
    };

    const timeout = setTimeout(() => {
      settle(() =>
        reject(
          new Error(
            "Timed out waiting for browser approval. Run again, or use --manual-key."
          )
        )
      );
    }, timeoutMs);

    server.on("request", (req, res) => {
      // Only accept GET /callback — reject anything else.
      const reqUrl = new URL(req.url ?? "/", `http://127.0.0.1`);
      if (reqUrl.pathname !== "/callback") {
        res.writeHead(404).end("Not found");
        return;
      }

      const raw = reqUrl.searchParams.get("context");
      if (!raw) {
        res.writeHead(400, { "Content-Type": "text/html; charset=utf-8" });
        res.end(errorHtml("No context received — try again."));
        settle(() => reject(new Error("Callback missing `context` parameter")));
        return;
      }

      try {
        const parsed = JSON.parse(raw) as {
          apiKey?: string;
          podUrl?: string;
          workspaceId?: string | null;
        };
        if (!parsed.apiKey || !parsed.podUrl) {
          throw new Error("Callback missing apiKey or podUrl");
        }
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        res.end(successHtml(opts.integration));
        settle(() =>
          resolve({
            apiKey: parsed.apiKey!,
            podUrl: parsed.podUrl!,
            workspaceId: parsed.workspaceId ?? undefined,
          })
        );
      } catch (err) {
        res.writeHead(400, { "Content-Type": "text/html; charset=utf-8" });
        res.end(errorHtml("Invalid callback payload."));
        settle(() =>
          reject(err instanceof Error ? err : new Error(String(err)))
        );
      }
    });

    server.on("error", (err) => {
      settle(() => reject(err));
    });

    server.listen(0, "127.0.0.1", () => {
      const port = (server.address() as AddressInfo).port;
      const redirectUri = `http://127.0.0.1:${port}/callback`;
      const adminUrl = new URL(`${podUrl}/admin/connect`);
      adminUrl.searchParams.set("integration", opts.integration);
      adminUrl.searchParams.set("redirect_uri", redirectUri);
      const fullUrl = adminUrl.toString();
      opts.onUrlReady?.(fullUrl);
      openBrowser(fullUrl).catch(() => {
        // Browser open failure is non-fatal — user can paste the URL themselves.
      });
    });
  });
}

/**
 * Cross-platform browser open. Returns when the launcher has been kicked off,
 * not when the user has actually seen the page.
 */
async function openBrowser(url: string): Promise<void> {
  const platform = process.platform;
  const [command, args] =
    platform === "darwin"
      ? (["open", [url]] as const)
      : platform === "win32"
        ? (["cmd", ["/c", "start", "", url]] as const)
        : (["xdg-open", [url]] as const);

  return new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: "ignore",
      detached: true,
    });
    child.once("error", reject);
    child.once("spawn", () => {
      child.unref();
      resolve();
    });
  });
}

// ─── Page HTML ──────────────────────────────────────────────────────────────
// Short, no external deps, CLI-tool vibe. Shown once per connect.

function successHtml(integration: string): string {
  const label = integration.charAt(0).toUpperCase() + integration.slice(1);
  return `<!doctype html>
<html lang="en">
  <head><meta charset="utf-8"><title>Synap connected</title>
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <style>
      :root { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif; }
      body { margin: 0; background: #0A0A0A; color: #FAFAFA; display: grid; place-items: center; min-height: 100vh; }
      .card { max-width: 420px; padding: 32px; text-align: center; }
      .check { width: 48px; height: 48px; margin: 0 auto 16px; border-radius: 9999px; background: rgba(16, 185, 129, 0.12); display: grid; place-items: center; color: #10B981; }
      h1 { font-size: 20px; margin: 0 0 8px; font-weight: 600; letter-spacing: -0.01em; }
      p { margin: 0; color: rgba(250, 250, 250, 0.6); font-size: 14px; line-height: 1.5; }
      code { background: rgba(250, 250, 250, 0.08); padding: 2px 6px; border-radius: 4px; font-size: 12px; }
    </style>
  </head>
  <body>
    <div class="card">
      <div class="check">
        <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"></polyline></svg>
      </div>
      <h1>${label} connected</h1>
      <p>You can close this tab and return to your terminal.</p>
    </div>
    <script>setTimeout(() => window.close(), 3000);</script>
  </body>
</html>`;
}

function errorHtml(reason: string): string {
  return `<!doctype html>
<html lang="en">
  <head><meta charset="utf-8"><title>Synap connect failed</title>
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <style>
      :root { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif; }
      body { margin: 0; background: #0A0A0A; color: #FAFAFA; display: grid; place-items: center; min-height: 100vh; }
      .card { max-width: 420px; padding: 32px; text-align: center; }
      .x { width: 48px; height: 48px; margin: 0 auto 16px; border-radius: 9999px; background: rgba(239, 68, 68, 0.12); display: grid; place-items: center; color: #EF4444; }
      h1 { font-size: 20px; margin: 0 0 8px; font-weight: 600; }
      p { margin: 0; color: rgba(250, 250, 250, 0.6); font-size: 14px; line-height: 1.5; }
    </style>
  </head>
  <body>
    <div class="card">
      <div class="x">
        <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>
      </div>
      <h1>Connect failed</h1>
      <p>${reason}</p>
    </div>
  </body>
</html>`;
}
