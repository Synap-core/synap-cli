import { createVerify, generateKeyPairSync } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  createInstallationTokenSource,
  githubAppFilesTooOpen,
  githubRunEnv,
  loadGithubAppConfig,
  parseEnvFile,
  signAppJwt,
} from "./worker-github-app.js";

const { privateKey, publicKey } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
  publicKeyEncoding: { type: "spki", format: "pem" },
});

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "gh-app-"));

describe("signAppJwt", () => {
  it("is a RS256 JWT for the app id that its public key verifies, valid under 10 minutes", () => {
    const now = Date.parse("2026-10-28T12:00:00Z");
    const [h, b, s] = signAppJwt("123", privateKey, now).split(".");
    expect(JSON.parse(Buffer.from(h, "base64url").toString())).toEqual({ alg: "RS256", typ: "JWT" });
    const body = JSON.parse(Buffer.from(b, "base64url").toString());
    expect(body.iss).toBe("123");
    expect(body.exp - body.iat).toBeLessThanOrEqual(600);
    expect(createVerify("RSA-SHA256").update(`${h}.${b}`).verify(publicKey, Buffer.from(s, "base64url"))).toBe(true);
  });
});

describe("loadGithubAppConfig", () => {
  it("no file is undefined (the caller warns), never a throw", () => {
    expect(loadGithubAppConfig(path.join(tmp(), "none.env"))).toBeUndefined();
  });
  it("reads the id, the key by path and the installation id", () => {
    const d = tmp();
    fs.writeFileSync(path.join(d, "k.pem"), privateKey, { mode: 0o600 });
    fs.writeFileSync(
      path.join(d, "a.env"),
      `# the Synap Agent App\nGITHUB_APP_ID=42\nGITHUB_APP_PRIVATE_KEY_FILE="${path.join(d, "k.pem")}"\nGITHUB_APP_INSTALLATION_ID=7\n`,
      { mode: 0o600 }
    );
    const cfg = loadGithubAppConfig(path.join(d, "a.env"));
    expect(cfg).toMatchObject({ appId: "42", installationId: "7" });
    expect(cfg?.privateKey).toContain("BEGIN PRIVATE KEY");
    expect(githubAppFilesTooOpen(path.join(d, "a.env"))).toEqual([]);
  });
  it("a file that is there but unusable THROWS — never a silent fall back to a person's login", () => {
    const d = tmp();
    fs.writeFileSync(path.join(d, "a.env"), "GITHUB_APP_ID=42\n");
    expect(() => loadGithubAppConfig(path.join(d, "a.env"))).toThrow(/GITHUB_APP_PRIVATE_KEY_FILE/);
    fs.writeFileSync(path.join(d, "b.env"), `GITHUB_APP_ID=42\nGITHUB_APP_PRIVATE_KEY_FILE=${path.join(d, "missing.pem")}\n`);
    expect(() => loadGithubAppConfig(path.join(d, "b.env"))).toThrow(/could not be read/);
  });
  it("names a key or env file that others can read", () => {
    const d = tmp();
    fs.writeFileSync(path.join(d, "k.pem"), privateKey, { mode: 0o644 });
    fs.writeFileSync(path.join(d, "a.env"), `GITHUB_APP_ID=1\nGITHUB_APP_PRIVATE_KEY_FILE=${path.join(d, "k.pem")}\n`, { mode: 0o600 });
    expect(githubAppFilesTooOpen(path.join(d, "a.env"))).toEqual([path.join(d, "k.pem")]);
  });
  it("parseEnvFile ignores comments and strips quotes", () => {
    expect(parseEnvFile("# A=1\nB='x y'\nexport C=3")).toEqual({ B: "x y", C: "3" });
  });
});

describe("createInstallationTokenSource", () => {
  const T0 = Date.parse("2026-10-28T12:00:00Z");
  const fakeFetch = (log: string[], opts: { installations?: unknown[]; status?: number } = {}) =>
    (async (url: string, init: { method: string; headers: Record<string, string> }) => {
      log.push(`${init.method} ${url.replace("https://api.github.com", "")}`);
      expect(init.headers.Authorization).toMatch(/^Bearer [\w-]+\.[\w-]+\.[\w-]+$/);
      const ok = (opts.status ?? 200) < 400;
      if (url.endsWith("/app/installations")) return { ok, status: opts.status ?? 200, json: async () => opts.installations ?? [{ id: 9 }] };
      return {
        ok,
        status: opts.status ?? 200,
        json: async () => ({ token: `ghs_${log.length}`, expires_at: new Date(T0 + 3600_000).toISOString() }),
      };
    }) as unknown as typeof fetch;

  it("finds the single installation, mints a token, and reuses it until 5 min before it ends", async () => {
    const log: string[] = [];
    let t = T0;
    const src = createInstallationTokenSource({ appId: "1", privateKey }, { fetchImpl: fakeFetch(log), now: () => t });
    const a = await src.get();
    expect(log).toEqual(["GET /app/installations", "POST /app/installations/9/access_tokens"]);
    t = T0 + 50 * 60_000;
    expect(await src.get()).toBe(a);
    expect(log).toHaveLength(2);
    t = T0 + 56 * 60_000;
    expect(await src.get()).not.toBe(a);
    expect(log).toHaveLength(3);
  });
  it("two installations and no id is an error, not a guess", async () => {
    const src = createInstallationTokenSource(
      { appId: "1", privateKey },
      { fetchImpl: fakeFetch([], { installations: [{ id: 1 }, { id: 2 }] }), now: () => T0 }
    );
    await expect(src.get()).rejects.toThrow(/GITHUB_APP_INSTALLATION_ID/);
  });
  it("a refused call throws (the worker then does not launch)", async () => {
    const src = createInstallationTokenSource({ appId: "1", privateKey, installationId: "9" }, { fetchImpl: fakeFetch([], { status: 401 }), now: () => T0 });
    await expect(src.get()).rejects.toThrow(/401/);
  });
});

describe("githubRunEnv", () => {
  const g = { token: "ghs_x", sock: "/s", binDir: "/b", gitHelper: "/b/git-credential-synap", ghConfigDir: "/c" };
  it("puts the helpers first on PATH, gh on an empty config dir, and resets the credential helpers first", () => {
    const e = githubRunEnv(g, "/usr/bin:/bin");
    expect(e.PATH).toBe("/b:/usr/bin:/bin");
    expect(e.GH_CONFIG_DIR).toBe("/c");
    expect(e.SYNAP_GH_SOCK).toBe("/s");
    expect(e.GH_TOKEN).toBe("ghs_x");
    expect([e.GIT_CONFIG_KEY_0, e.GIT_CONFIG_VALUE_0]).toEqual(["credential.helper", ""]);
    expect(e.GIT_CONFIG_VALUE_1).toBe("!/b/git-credential-synap");
  });
});
