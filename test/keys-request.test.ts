/**
 * `synap keys create|templates|list|revoke` (keys plan §3.6, Decision 4): the
 * CLI FILES a key request, its person approves it on pod-admin, and the CLI
 * collects the key once. It never mints, and it never prints the key unless
 * asked (`--show-key`).
 *
 * Driven through the real commands against a fake pod on loopback that
 * answers the W2 routes as synap-backend `routers/hub-protocol/rest/keys.ts`
 * does (RFC 8628 400s until the decision), with the real fetch and the real
 * shared poll loop; the clock is shrunk with `timeScale` (5 s → 100 ms).
 */

import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from "vitest";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";

import { keysCreate, keysList, keysRevoke, keysTemplates } from "../src/commands/keys.js";

const SCALE = 0.02;
const COMPUTER_KEY = "synap_computerkey0000";
const SECRET = "synap_requestedsecret4242";

const KEY = {
  apiKey: SECRET,
  keyId: "11111111-1111-4111-8111-111111111111",
  keyPrefix: "synap_re",
  name: "CI poster",
  scopes: ["hub-protocol.read", "hub-protocol.write"],
  expiresAt: "2027-01-25T00:00:00.000Z",
};
const pending = { status: 400, body: { error: "authorization_pending", error_description: "Waiting." } };

let script: Array<{ status: number; body: unknown }> = [];
let requests: Array<{ method: string; url: string; auth?: string; body: unknown }> = [];
let server: http.Server;
let podUrl: string;

beforeAll(async () => {
  server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (d) => (raw += d));
    req.on("end", () => {
      const json = (status: number, body: unknown) => {
        res.writeHead(status, { "Content-Type": "application/json" });
        res.end(JSON.stringify(body));
      };
      requests.push({ method: req.method!, url: req.url!, auth: req.headers.authorization, body: raw ? JSON.parse(raw) : null });
      if (req.method === "GET" && req.url === "/api/hub/keys/templates") {
        return json(200, {
          templates: [
            {
              id: "dev-loop-poster",
              name: "Dev loop poster",
              description: "Posts what happened from CI",
              stored: false,
              uses: ["hub-api"],
              permissions: ["event.create"],
              workspaceIds: null,
              projectIds: null,
              entityIds: null,
              expiresInDays: 90,
            },
          ],
        });
      }
      if (req.method === "POST" && req.url === "/api/hub/keys/requests") {
        return json(200, {
          request_code: "rq_code_0123456789abcdef",
          request_id: "req-1",
          review_url: `${podUrl}/keys/requests/req-1`,
          expires_in: 600,
          interval: 5,
        });
      }
      if (req.method === "POST" && req.url === "/api/hub/keys/requests/token") {
        const next = script.length > 1 ? script.shift()! : script[0]!;
        return json(next.status, next.body);
      }
      if (req.method === "GET" && req.url === "/api/hub/keys/requested") {
        return json(200, {
          keys: [
            { ...KEY, apiKey: undefined, templateId: "dev-loop-poster", createdAt: "2026-10-27T00:00:00.000Z", lastUsedAt: null, revokedAt: null },
          ],
        });
      }
      if (req.method === "DELETE" && req.url === `/api/hub/keys/requested/${KEY.keyId}`) return json(200, { revoked: true });
      if (req.method === "DELETE" && req.url?.startsWith("/api/hub/keys/requested/")) return json(404, { error: "Not a key you requested." });
      return json(404, { error: "no" });
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  podUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  process.env.SYNAP_POD_URL = podUrl;
  process.env.SYNAP_HUB_API_KEY = COMPUTER_KEY;
});

afterAll(() => {
  server.close();
  process.exitCode = undefined;
});

let printed: string[] = [];
const opened: string[] = [];
const deps = { timeScale: SCALE, openUrl: (u: string) => void opened.push(u) };

beforeEach(() => {
  requests = [];
  printed = [];
  opened.length = 0;
  process.exitCode = undefined;
  fs.rmSync(path.join(os.homedir(), ".synap"), { recursive: true, force: true });
  const record = (...a: unknown[]) => void printed.push(a.map(String).join(" "));
  vi.spyOn(console, "log").mockImplementation(record);
  vi.spyOn(console, "error").mockImplementation(record);
  vi.spyOn(process.stdout, "write").mockImplementation(((s: unknown) => (record(s), true)) as typeof process.stdout.write);
  vi.spyOn(process.stderr, "write").mockImplementation(((s: unknown) => (record(s), true)) as typeof process.stderr.write);
});

const mode = (p: string) => fs.statSync(p).mode & 0o777;
const tokenPolls = () => requests.filter((r) => r.url === "/api/hub/keys/requests/token");

describe("synap keys create", () => {
  it("files a request with the computer's key, opens the review page, waits through pending and slow_down, then saves the key once (0600, never printed)", async () => {
    script = [pending, { status: 400, body: { error: "slow_down", error_description: "Slow.", interval: 6 } }, pending, { status: 200, body: KEY }];
    await keysCreate({ template: "dev-loop-poster", name: "CI poster", ttl: "30" }, deps);

    const filed = requests.find((r) => r.url === "/api/hub/keys/requests")!;
    expect(filed.method).toBe("POST");
    expect(filed.auth).toBe(`Bearer ${COMPUTER_KEY}`);
    expect(filed.body).toEqual({ template: "dev-loop-poster", name: "CI poster", expiresInDays: 30 });
    expect(tokenPolls().map((r) => r.body)).toEqual(Array(4).fill({ request_code: "rq_code_0123456789abcdef" }));
    expect(tokenPolls().every((r) => r.auth === `Bearer ${COMPUTER_KEY}`)).toBe(true);
    expect(opened).toEqual([`${podUrl}/keys/requests/req-1`]);
    expect(printed.join("\n")).toContain(`${podUrl}/keys/requests/req-1`);

    const saved = path.join(os.homedir(), ".synap", "keys", `${KEY.keyId}.env`);
    expect(fs.readFileSync(saved, "utf-8")).toBe(`SYNAP_API_KEY=${SECRET}\n`);
    expect(mode(saved)).toBe(0o600);
    expect(printed.join("\n")).not.toContain(SECRET);
    expect(process.exitCode).toBeUndefined();
  });

  it("--env-file writes the key into that file as --env-name, keeps its other lines, replaces an earlier one, 0600", async () => {
    script = [{ status: 200, body: KEY }];
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "synap-keys-env-"));
    const file = path.join(dir, ".env");
    fs.writeFileSync(file, "OTHER=1\n\nexport SYNAP_OBS_KEY=old\nLAST=2\n", { mode: 0o644 });
    await keysCreate({ template: "dev-loop-poster", envFile: file, envName: "SYNAP_OBS_KEY" }, deps);

    expect(fs.readFileSync(file, "utf-8")).toBe(`OTHER=1\n\nLAST=2\nSYNAP_OBS_KEY=${SECRET}\n`);
    expect(mode(file)).toBe(0o600);
    expect(printed.join("\n")).not.toContain(SECRET);
    expect(fs.existsSync(path.join(os.homedir(), ".synap", "keys"))).toBe(false);
  });

  it("--show-key prints the key once and saves no file", async () => {
    script = [{ status: 200, body: KEY }];
    await keysCreate({ template: "dev-loop-poster", showKey: true }, deps);
    expect(printed.filter((l) => l.includes(SECRET))).toHaveLength(1);
    expect(fs.existsSync(path.join(os.homedir(), ".synap", "keys"))).toBe(false);
  });

  it("--json says where the key was saved and carries no key", async () => {
    script = [{ status: 200, body: KEY }];
    await keysCreate({ template: "dev-loop-poster", json: true }, deps);
    const out = printed.find((l) => l.trim().startsWith("{"))!;
    const parsed = JSON.parse(out);
    expect(parsed).toMatchObject({ keyId: KEY.keyId, envName: "SYNAP_API_KEY" });
    expect(parsed.apiKey).toBeUndefined();
    expect(printed.join("\n")).not.toContain(SECRET);
  });

  it("--ttl never asks for a key that never expires; a bad --ttl files nothing", async () => {
    script = [{ status: 200, body: KEY }];
    await keysCreate({ template: "dev-loop-poster", ttl: "never" }, deps);
    expect(requests.find((r) => r.url === "/api/hub/keys/requests")!.body).toEqual({ template: "dev-loop-poster", expiresInDays: null });

    requests = [];
    process.exitCode = undefined;
    await keysCreate({ template: "dev-loop-poster", ttl: "soon" }, deps);
    expect(requests).toEqual([]);
    expect(process.exitCode).toBe(1);
  });

  it.each([
    ["access_denied", /denied/],
    ["expired_token", /expired/],
  ])("%s ends the wait: exit 1, no key saved", async (error, words) => {
    script = [pending, { status: 400, body: { error, error_description: "x" } }];
    await keysCreate({ template: "dev-loop-poster" }, deps);
    expect(process.exitCode).toBe(1);
    expect(printed.join("\n")).toMatch(words);
    expect(fs.existsSync(path.join(os.homedir(), ".synap", "keys"))).toBe(false);
  });
});

describe("synap keys templates | list | revoke", () => {
  it("templates lists the pod's templates", async () => {
    await keysTemplates();
    expect(requests.map((r) => `${r.method} ${r.url}`)).toEqual(["GET /api/hub/keys/templates"]);
    expect(printed.join("\n")).toContain("dev-loop-poster");
  });

  it("list shows only the keys this computer requested, by id", async () => {
    await keysList();
    expect(requests.map((r) => `${r.method} ${r.url}`)).toEqual(["GET /api/hub/keys/requested"]);
    expect(printed.join("\n")).toContain(KEY.keyId);
  });

  it("revoke deletes a key this computer requested", async () => {
    await keysRevoke(KEY.keyId);
    expect(requests.map((r) => `${r.method} ${r.url}`)).toEqual([`DELETE /api/hub/keys/requested/${KEY.keyId}`]);
    expect(process.exitCode).toBeUndefined();
  });

  it("revoke of any other key says it is not this computer's and exits 1", async () => {
    await keysRevoke("22222222-2222-4222-8222-222222222222");
    expect(process.exitCode).toBe(1);
    expect(printed.join("\n")).toMatch(/not one this computer requested/);
  });
});
