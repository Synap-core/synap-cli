import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { generateKeyPairSync } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { createInstallationTokenSource } from "./worker-github-app.js";
import { findOnPath, startTokenBroker, writeGithubHelpers } from "./worker-github-broker.js";

const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048, privateKeyEncoding: { type: "pkcs8", format: "pem" }, publicKeyEncoding: { type: "spki", format: "pem" } });

const T0 = Date.parse("2026-10-28T12:00:00Z");
let t = T0;
let minted = 0;
const fakeFetch = (async (url: string) => {
  if (url.endsWith("/app/installations")) return { ok: true, status: 200, json: async () => [{ id: 9 }] };
  minted++;
  return { ok: true, status: 200, json: async () => ({ token: `ghs_${minted}`, expires_at: new Date(t + 3600_000).toISOString() }) };
}) as unknown as typeof fetch;

const run = (bin: string, args: string[], env: Record<string, string>, input?: string) =>
  new Promise<{ code: number; stdout: string; stderr: string }>((resolve) => {
    const c = execFile(bin, args, { env }, (err, stdout, stderr) =>
      resolve({ code: err ? ((err as { code?: number }).code ?? 1) : 0, stdout, stderr })
    );
    // A helper may exit without reading its stdin (the git helper on `store`):
    // the write then fails with EPIPE, which is the child's choice, not a test failure.
    c.stdin?.on("error", () => {});
    c.stdin?.end(input ?? "");
  });

const closers: Array<() => void> = [];
afterEach(() => closers.splice(0).forEach((c) => c()));

const setup = async (source = createInstallationTokenSource({ appId: "1", privateKey }, { fetchImpl: fakeFetch, now: () => t })) => {
  t = T0;
  minted = 0;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bk-"));
  const realGh = path.join(dir, "real-gh");
  fs.writeFileSync(realGh, '#!/bin/sh\necho "gh-as:$GH_TOKEN args:$*"\n', { mode: 0o755 });
  const binDir = path.join(dir, "bin");
  const { gitHelper } = writeGithubHelpers(binDir, { realGh });
  const broker = startTokenBroker(source);
  closers.push(() => broker.close());
  await broker.ready;
  const env = { SYNAP_GH_SOCK: broker.sock, PATH: `${binDir}:/usr/bin:/bin` };
  return { binDir, gitHelper, env, broker };
};

describe("the GitHub helpers a run uses", () => {
  it("gh runs with a token that is still valid after the first hour (the clock is stubbed)", async () => {
    const { binDir, env } = await setup();
    const first = await run(path.join(binDir, "gh"), ["pr", "list"], env);
    expect(first.stdout.trim()).toBe("gh-as:ghs_1 args:pr list");
    t = T0 + 30 * 60_000;
    expect((await run(path.join(binDir, "gh"), [], env)).stdout).toContain("ghs_1"); // reused, not re-minted
    t = T0 + 61 * 60_000; // past the first token's end
    const later = await run(path.join(binDir, "gh"), ["pr", "list"], env);
    expect(later.stdout.trim()).toBe("gh-as:ghs_2 args:pr list");
  });

  it("the git credential helper answers `get` with a fresh token and nothing for other operations", async () => {
    const { gitHelper, env } = await setup();
    const get = await run(gitHelper, ["get"], env, "protocol=https\nhost=github.com\n\n");
    expect(get.stdout).toBe("username=x-access-token\npassword=ghs_1\n");
    t = T0 + 61 * 60_000;
    expect((await run(gitHelper, ["get"], env, "host=github.com\n\n")).stdout).toContain("password=ghs_2");
    expect((await run(gitHelper, ["store"], env, "x\n")).stdout).toBe("");
  });

  it("a broker that cannot mint makes gh fail without calling the real gh (no fall back to another login)", async () => {
    const { binDir, env } = await setup({
      get: async () => {
        throw new Error("GitHub answered 401");
      },
    });
    const r = await run(path.join(binDir, "gh"), ["pr", "list"], env);
    expect(r.code).not.toBe(0);
    expect(r.stdout).not.toContain("gh-as");
    expect(r.stderr).toContain("401");
  });

  it("the key is never handed over: neither helper nor answer carries it", async () => {
    const { binDir, env } = await setup();
    const out = (await run(path.join(binDir, "gh"), [], env)).stdout;
    expect(out).not.toContain("PRIVATE KEY");
    for (const f of fs.readdirSync(binDir)) expect(fs.readFileSync(path.join(binDir, f), "utf8")).not.toContain("PRIVATE KEY");
  });
});

describe("findOnPath", () => {
  it("skips the helpers' own folder, so the wrapper never calls itself", () => {
    const a = fs.mkdtempSync(path.join(os.tmpdir(), "fp-"));
    const b = fs.mkdtempSync(path.join(os.tmpdir(), "fp-"));
    for (const d of [a, b]) fs.writeFileSync(path.join(d, "gh"), "#!/bin/sh\n", { mode: 0o755 });
    expect(findOnPath("gh", `${a}:${b}`, a)).toBe(path.join(b, "gh"));
    expect(findOnPath("nope", `${a}:${b}`, a)).toBeUndefined();
  });
});
