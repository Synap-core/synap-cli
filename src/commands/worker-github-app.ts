/**
 * The worker's GitHub identity: a GitHub App installation, never a person.
 *
 * An unattended run has Bash, so whatever `gh` and `git push` authenticate as
 * is what a prompt injection can use. The founder's login is an org admin (it
 * can `gh pr merge --admin` past the ruleset); the "Synap Agent" App has no
 * administration, members or bypass permission (see docs/synap-agent-app.md).
 *
 * The App's id and private key live in an owner-only env file
 * (default ~/.config/synap-agent-app.env):
 *
 *   GITHUB_APP_ID=123456
 *   GITHUB_APP_PRIVATE_KEY_FILE=/home/me/.config/synap-agent-app.pem   (0600)
 *   GITHUB_APP_INSTALLATION_ID=7890123      # optional: the org's installation
 *
 * Each launch mints an installation token (valid 1 h, cached until 5 min
 * before it ends) and puts it in the run's GH_TOKEN. Neither the key nor a
 * token is ever logged or written to state.
 */

import { createSign } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export interface GithubAppConfig {
  appId: string;
  privateKey: string;
  installationId?: string;
}

export function defaultGithubAppFile(): string {
  return path.join(os.homedir(), ".config", "synap-agent-app.env");
}

/** `KEY=value` lines, `#` comments, optional quotes. */
export function parseEnvFile(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split("\n")) {
    const m = /^\s*(?:export\s+)?([A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line);
    if (!m || line.trimStart().startsWith("#")) continue;
    out[m[1]] = m[2].replace(/^(["'])(.*)\1$/, "$2");
  }
  return out;
}

/**
 * `undefined`: no env file (the caller warns, loudly). Throws when the file is
 * there but unusable, so a half-set-up App never silently falls back to a
 * person's login.
 */
export function loadGithubAppConfig(file: string = defaultGithubAppFile()): GithubAppConfig | undefined {
  let text: string;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw new Error(`GitHub App file ${file} could not be read: ${(err as Error).message}`);
  }
  const env = parseEnvFile(text);
  const appId = env.GITHUB_APP_ID;
  const keyFile = env.GITHUB_APP_PRIVATE_KEY_FILE;
  if (!appId || !keyFile) throw new Error(`GitHub App file ${file} needs GITHUB_APP_ID and GITHUB_APP_PRIVATE_KEY_FILE`);
  const keyPath = keyFile.startsWith("~/") ? path.join(os.homedir(), keyFile.slice(2)) : keyFile;
  let privateKey: string;
  try {
    privateKey = fs.readFileSync(keyPath, "utf8");
  } catch (err) {
    throw new Error(`GitHub App private key ${keyPath} could not be read: ${(err as Error).message}`);
  }
  return { appId, privateKey, installationId: env.GITHUB_APP_INSTALLATION_ID || undefined };
}

/** The files a person must keep owner-only: any that others can read. */
export function githubAppFilesTooOpen(file: string = defaultGithubAppFile()): string[] {
  const open: string[] = [];
  const check = (f: string) => {
    try {
      if ((fs.statSync(f).mode & 0o077) !== 0) open.push(f);
    } catch {
      /* missing: loadGithubAppConfig reports it */
    }
  };
  check(file);
  try {
    const keyFile = parseEnvFile(fs.readFileSync(file, "utf8")).GITHUB_APP_PRIVATE_KEY_FILE;
    if (keyFile) check(keyFile.startsWith("~/") ? path.join(os.homedir(), keyFile.slice(2)) : keyFile);
  } catch {
    /* unreadable: loadGithubAppConfig reports it */
  }
  return open;
}

const b64url = (b: Buffer | string) => Buffer.from(b).toString("base64url");

/** The App JWT (RS256): 10 minutes at most, issued 60 s in the past for clock skew. */
export function signAppJwt(appId: string, privateKey: string, nowMs: number): string {
  const iat = Math.floor(nowMs / 1000) - 60;
  const head = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const body = b64url(JSON.stringify({ iat, exp: iat + 9 * 60, iss: appId }));
  const sig = createSign("RSA-SHA256").update(`${head}.${body}`).sign(privateKey);
  return `${head}.${body}.${b64url(sig)}`;
}

const API = "https://api.github.com";
const REFRESH_BEFORE_MS = 5 * 60_000;

export interface InstallationTokenSource {
  /** A token valid now; mints a new one when the cached one is near its end. Throws on failure. */
  get(): Promise<string>;
}

export function createInstallationTokenSource(
  config: GithubAppConfig,
  o: { fetchImpl?: typeof fetch; now?: () => number } = {}
): InstallationTokenSource {
  const doFetch = o.fetchImpl ?? fetch;
  const now = o.now ?? Date.now;
  let cached: { token: string; expiresAt: number } | undefined;
  let installationId = config.installationId;

  const call = async (method: string, url: string): Promise<unknown> => {
    const res = await doFetch(`${API}${url}`, {
      method,
      headers: {
        Authorization: `Bearer ${signAppJwt(config.appId, config.privateKey, now())}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "synap-worker",
      },
    });
    if (!res.ok) throw new Error(`GitHub ${method} ${url} answered ${res.status}`);
    return res.json();
  };

  return {
    async get() {
      if (cached && cached.expiresAt - now() > REFRESH_BEFORE_MS) return cached.token;
      if (!installationId) {
        const list = (await call("GET", "/app/installations")) as Array<{ id: number }>;
        if (!Array.isArray(list) || list.length !== 1) {
          throw new Error(
            `the App has ${Array.isArray(list) ? list.length : "an unreadable number of"} installations — set GITHUB_APP_INSTALLATION_ID`
          );
        }
        installationId = String(list[0].id);
      }
      const r = (await call("POST", `/app/installations/${installationId}/access_tokens`)) as {
        token?: string;
        expires_at?: string;
      };
      if (!r.token || !r.expires_at) throw new Error("GitHub answered no installation token");
      cached = { token: r.token, expiresAt: Date.parse(r.expires_at) };
      return r.token;
    },
  };
}

/**
 * The environment that makes `gh` AND `git push` (https) act as the token: the
 * credential-helper list is reset first, so a helper holding a person's login
 * is never asked.
 */
export function githubTokenEnv(token: string): NodeJS.ProcessEnv {
  return {
    GH_TOKEN: token,
    GITHUB_TOKEN: token,
    GIT_TERMINAL_PROMPT: "0",
    GIT_CONFIG_COUNT: "2",
    GIT_CONFIG_KEY_0: "credential.helper",
    GIT_CONFIG_VALUE_0: "",
    GIT_CONFIG_KEY_1: "credential.helper",
    GIT_CONFIG_VALUE_1: "!gh auth git-credential",
  };
}
