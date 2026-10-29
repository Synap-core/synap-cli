#!/usr/bin/env node
/**
 * Creates the "Synap Agent" GitHub App (the identity the devbox worker runs
 * `gh` and `git push` as) through GitHub's App MANIFEST flow, and writes its
 * credentials owner-only. A person runs this once, on the machine the worker
 * runs on (the key never leaves it, and is never printed):
 *
 *   node scripts/synap-agent-app-create.mjs [--org Synap-core] [--out ~/.config]
 *
 * 1. It serves one page on http://localhost:3123 and prints that URL.
 * 2. Open it, click "Create the Synap Agent App": GitHub shows the App with its
 *    permissions; confirm. (Contents write, Pull requests write, Checks read,
 *    Metadata read. No administration, no members, no ruleset bypass.)
 * 3. GitHub redirects back here with a one-time code; the script exchanges it
 *    for the App id and private key and writes
 *      <out>/synap-agent-app.pem   (0600)
 *      <out>/synap-agent-app.env   (0600: GITHUB_APP_ID, GITHUB_APP_PRIVATE_KEY_FILE)
 * 4. INSTALL the App (a separate click, GitHub offers no manifest for it):
 *    https://github.com/organizations/<org>/settings/apps/synap-agent/installations
 *    → Install → the repos the worker may push to (not "all" unless you mean it).
 *    Never add the App to a ruleset's bypass list.
 *
 * The worker reads synap-agent-app.env by itself (`synap worker --github-app`).
 */
import { createServer } from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const arg = (name, dflt) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : dflt;
};
const org = arg("org", "Synap-core");
const out = arg("out", path.join(os.homedir(), ".config")).replace(/^~(?=\/)/, os.homedir());
const PORT = 3123;
const redirect = `http://localhost:${PORT}/created`;

export const manifest = {
  name: "Synap Agent",
  url: "https://synap.live",
  redirect_url: redirect,
  public: false,
  default_events: [],
  default_permissions: { contents: "write", pull_requests: "write", checks: "read", metadata: "read" },
};

const state = Math.random().toString(36).slice(2);
const esc = (s) => s.replace(/&/g, "&amp;").replace(/"/g, "&quot;");
const page = `<!doctype html><meta charset=utf-8><title>Synap Agent App</title>
<form action="https://github.com/organizations/${org}/settings/apps/new?state=${state}" method="post">
<input type="hidden" name="manifest" value="${esc(JSON.stringify(manifest))}">
<button style="font:16px sans-serif;padding:12px 20px">Create the Synap Agent App in ${org}</button></form>`;

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  if (url.pathname === "/") {
    res.setHeader("content-type", "text/html").end(page);
    return;
  }
  if (url.pathname !== "/created") {
    res.statusCode = 404;
    res.end();
    return;
  }
  try {
    if (url.searchParams.get("state") !== state) throw new Error("state mismatch");
    const r = await fetch(`https://api.github.com/app-manifests/${url.searchParams.get("code")}/conversions`, {
      method: "POST",
      headers: { Accept: "application/vnd.github+json", "User-Agent": "synap-agent-app-create" },
    });
    if (!r.ok) throw new Error(`GitHub answered ${r.status}`);
    const app = await r.json();
    fs.mkdirSync(out, { recursive: true, mode: 0o700 });
    const pem = path.join(out, "synap-agent-app.pem");
    fs.writeFileSync(pem, app.pem, { mode: 0o600 });
    fs.writeFileSync(path.join(out, "synap-agent-app.env"), `GITHUB_APP_ID=${app.id}\nGITHUB_APP_PRIVATE_KEY_FILE=${pem}\n`, { mode: 0o600 });
    console.log(`App "${app.slug}" (id ${app.id}) created. Credentials written to ${out} (owner-only). Now install it: ${app.html_url}/installations`);
    res.setHeader("content-type", "text/html").end(`<p>Created. Back to the terminal: install the App on the repos, then you can close this tab.</p><p><a href="${esc(app.html_url)}/installations">Install it</a></p>`);
  } catch (err) {
    console.error(`failed: ${err.message}`);
    res.statusCode = 500;
    res.end("failed, see the terminal");
  } finally {
    setTimeout(() => server.close(), 500);
  }
});
server.listen(PORT, "127.0.0.1", () => console.log(`Open http://localhost:${PORT} and click the button.`));
