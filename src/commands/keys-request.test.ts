import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { HubError, HubNetworkError } from "../lib/hub-client.js";
import {
  runKeysRequest,
  parseDuration,
  EXIT_APPROVED,
  EXIT_DENIED,
  EXIT_TIMED_OUT,
  type KeysRequestDeps,
} from "./keys-request.js";

const SECRET = "sk_test_never_on_stdout_0123456789";
const filed = (n: number) => ({
  request_code: `code-${n}-aaaaaaaaaaaaaaaa`,
  request_id: `req-${n}`,
  review_url: `https://pod-admin.example/keys/requests/req-${n}`,
  expires_in: 900,
  interval: 5,
});
const approved = {
  apiKey: SECRET,
  keyId: "k1",
  keyPrefix: "sk_test",
  name: "devbox",
  scopes: ["hub-protocol.write"],
  expiresAt: null,
};
const tokenError = (status: number, error: string) =>
  new HubError({
    message: `HTTP ${status}`,
    status,
    body: { error },
    rawBody: JSON.stringify({ error }),
    path: "/keys/requests/token",
    method: "POST",
  });

type Step = unknown | Error;

/** A pod that answers each call from a script, on a clock the sleeps advance. */
function stub(script: Record<string, Step[]>) {
  let t = 0;
  const logs: string[] = [];
  const printed: string[] = [];
  const calls: Array<{ path: string; body: unknown }> = [];
  const deps: KeysRequestDeps = {
    podUrl: "https://pod.example",
    post: async (p, body) => {
      calls.push({ path: p, body });
      const step = script[p]!.shift();
      if (step instanceof Error) throw step;
      return step;
    },
    sleep: async (ms) => {
      t += ms;
    },
    now: () => t,
    log: (l) => logs.push(l),
    printKey: (k) => printed.push(k),
  };
  return { deps, logs, printed, calls };
}

const tmp = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), "keys-req-")), "key.env");

describe("synap keys request", () => {
  it("approved: writes a 0600 file and never prints the key", async () => {
    const out = tmp();
    const s = stub({
      "/keys/requests": [filed(1)],
      "/keys/requests/token": [tokenError(400, "authorization_pending"), approved],
    });
    const code = await runKeysRequest({ template: "dev-loop-poster", out }, s.deps);
    expect(code).toBe(EXIT_APPROVED);
    expect(fs.readFileSync(out, "utf8")).toBe(
      `SYNAP_POD_URL=https://pod.example\nSYNAP_HUB_API_KEY=${SECRET}\n`
    );
    expect(fs.statSync(out).mode & 0o777).toBe(0o600);
    expect(s.printed).toEqual([]);
    expect(s.logs.join("\n")).not.toContain(SECRET);
    expect(s.logs.join("\n")).toContain("https://pod-admin.example/keys/requests/req-1");
  });

  it("--print is the only way the key reaches stdout", async () => {
    const s = stub({ "/keys/requests": [filed(1)], "/keys/requests/token": [approved] });
    expect(await runKeysRequest({ template: "t", print: true }, s.deps)).toBe(EXIT_APPROVED);
    expect(s.printed).toEqual([SECRET]);
    expect(s.logs.join("\n")).not.toContain(SECRET);
  });

  it("expired: files a new request and carries on", async () => {
    const out = tmp();
    const s = stub({
      "/keys/requests": [filed(1), filed(2)],
      "/keys/requests/token": [tokenError(400, "expired_token"), approved],
    });
    expect(await runKeysRequest({ template: "t", out }, s.deps)).toBe(EXIT_APPROVED);
    expect(s.calls.filter((c) => c.path === "/keys/requests")).toHaveLength(2);
    expect((s.calls.at(-1)!.body as { request_code: string }).request_code).toBe(filed(2).request_code);
  });

  it("denied: exit 1, nothing written", async () => {
    const out = tmp();
    const s = stub({
      "/keys/requests": [filed(1)],
      "/keys/requests/token": [tokenError(400, "access_denied")],
    });
    expect(await runKeysRequest({ template: "t", out }, s.deps)).toBe(EXIT_DENIED);
    expect(fs.existsSync(out)).toBe(false);
  });

  it("5xx and network errors are retried, filing and collecting", async () => {
    const out = tmp();
    const s = stub({
      "/keys/requests": [tokenError(502, "bad gateway"), filed(1)],
      "/keys/requests/token": [
        tokenError(503, "restarting"),
        new HubNetworkError({
          message: "down",
          code: "ECONNREFUSED",
          podUrl: "https://pod.example",
          path: "/keys/requests/token",
          method: "POST",
          hint: "",
        }),
        approved,
      ],
    });
    expect(await runKeysRequest({ template: "t", out }, s.deps)).toBe(EXIT_APPROVED);
    expect(fs.existsSync(out)).toBe(true);
  });

  it("never answered within --wait: exit 2", async () => {
    const s = stub({
      "/keys/requests": [filed(1)],
      "/keys/requests/token": Array.from({ length: 50 }, () => tokenError(400, "authorization_pending")),
    });
    expect(await runKeysRequest({ template: "t", print: true, wait: "1m" }, s.deps)).toBe(EXIT_TIMED_OUT);
  });

  it("refuses to overwrite --out without --force, before filing a request", async () => {
    const out = tmp();
    fs.writeFileSync(out, "keep");
    const s = stub({ "/keys/requests": [], "/keys/requests/token": [] });
    expect(await runKeysRequest({ template: "t", out }, s.deps)).toBe(EXIT_DENIED);
    expect(s.calls).toEqual([]);
    expect(fs.readFileSync(out, "utf8")).toBe("keep");
  });

  it("needs --out or --print", async () => {
    const s = stub({ "/keys/requests": [], "/keys/requests/token": [] });
    expect(await runKeysRequest({ template: "t" }, s.deps)).toBe(EXIT_DENIED);
    expect(s.calls).toEqual([]);
  });

  it("--no-wait files once, prints the link, collects nothing", async () => {
    const s = stub({ "/keys/requests": [filed(1)], "/keys/requests/token": [] });
    expect(await runKeysRequest({ template: "t", print: true, noWait: true }, s.deps)).toBe(EXIT_APPROVED);
    expect(s.calls.map((c) => c.path)).toEqual(["/keys/requests"]);
    expect(s.logs.join("\n")).toContain("req-1");
  });

  it("parseDuration", () => {
    expect(parseDuration("24h")).toBe(86_400_000);
    expect(parseDuration("90s")).toBe(90_000);
    expect(parseDuration("soon")).toBeNull();
  });
});
