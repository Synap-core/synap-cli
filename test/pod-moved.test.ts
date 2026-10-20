import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  PodMovedError,
  askControlPlaneWherePodIs,
  podFetch,
} from "../src/lib/pod-moved.js";
import { hubGet, hubPost } from "../src/lib/hub-client.js";
import { addPodProfile, checkPodHealth } from "../src/lib/pod.js";
import { diagnosePodMove } from "../src/commands/doctor.js";

/**
 * A pod that moved ({name}.synap.live → {name}.pod.synap.live): the CLI never
 * follows a redirect to another host for a pod call, and learns the new
 * address only from the Control Plane — `POST /pods/handshake {targetUrl}` →
 * `410 {code: "POD_MOVED", podId, podUrl, consoleUrl}` (CP `routes/pods.ts`).
 *
 * The last block reads the CP SOURCE, like other parity tests here, so a
 * renamed field fails this file. NOT covered: a real CP answer (needs the
 * wave-6 CP deployed) and the `pods update` prompts `doctor --fix` runs.
 */

const OLD = "https://acme.synap.live";
const NEW = "https://acme.pod.synap.live";
const CP = "https://api.synap.live";

type Call = { url: string; init: RequestInit };
function stubFetch(answer: (url: string, init: RequestInit) => Response): Call[] {
  const calls: Call[] = [];
  vi.stubGlobal("fetch", async (input: string | URL, init: RequestInit = {}) => {
    const url = String(input);
    calls.push({ url, init });
    return answer(url, init);
  });
  return calls;
}
const redirect = (status: number, location: string) =>
  new Response(null, { status, headers: { location } });
const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("podFetch", () => {
  it("refuses a redirect to another host, without calling it", async () => {
    const calls = stubFetch(() => redirect(308, `${NEW}/api/hub/users/me`));
    const err = await podFetch(`${OLD}/api/hub/users/me`, { headers: { Authorization: "Bearer k" } }).catch(
      (e: unknown) => e
    );
    expect(err).toBeInstanceOf(PodMovedError);
    expect((err as PodMovedError).podUrl).toBe(OLD);
    expect((err as PodMovedError).message).toBe(
      `The pod at ${OLD} has a new address. Run: synap doctor --fix`
    );
    expect(calls.map((c) => c.url)).toEqual([`${OLD}/api/hub/users/me`]);
    expect(calls[0].init.redirect).toBe("manual");
  });

  it("follows a redirect on the same host, and an http → https upgrade", async () => {
    const calls = stubFetch((url) =>
      url === "http://pod.example.com/health"
        ? redirect(301, "https://pod.example.com/health")
        : url === "https://pod.example.com/health"
          ? redirect(307, "/health/")
          : json(200, { ok: true })
    );
    const res = await podFetch("http://pod.example.com/health");
    expect(res.status).toBe(200);
    expect(calls.map((c) => c.url)).toEqual([
      "http://pod.example.com/health",
      "https://pod.example.com/health",
      "https://pod.example.com/health/",
    ]);
  });

  it("treats an https → http downgrade as another host", async () => {
    stubFetch(() => redirect(302, "http://pod.example.com/x"));
    await expect(podFetch("https://pod.example.com/x")).rejects.toBeInstanceOf(PodMovedError);
  });

  it("hands back a redirect without a Location as it came", async () => {
    stubFetch(() => new Response(null, { status: 302 }));
    expect((await podFetch(`${OLD}/x`)).status).toBe(302);
  });
});

describe("pod calls never follow a moved pod", () => {
  it("hubGet: PodMovedError, the key never sent to the other host", async () => {
    const calls = stubFetch(() => redirect(308, `${NEW}/api/hub/users/me`));
    await expect(hubGet("/users/me", {}, { podUrl: OLD, apiKey: "k", userId: "u" })).rejects.toBeInstanceOf(
      PodMovedError
    );
    expect(calls).toHaveLength(1);
  });

  it("hubPost: the same, not reported as a network failure", async () => {
    stubFetch(() => redirect(308, `${NEW}/api/hub/capture`));
    await expect(hubPost("/capture", {}, { podUrl: OLD, apiKey: "k", userId: "u" })).rejects.toBeInstanceOf(
      PodMovedError
    );
  });

  it("checkPodHealth: not healthy, and marked moved", async () => {
    stubFetch(() => redirect(308, `${NEW}/health`));
    const health = await checkPodHealth(OLD);
    expect(health.healthy).toBe(false);
    expect(health.moved).toBe(true);
  });
});

describe("askControlPlaneWherePodIs", () => {
  it("reads the CP's 410 POD_MOVED", async () => {
    const calls = stubFetch(() =>
      json(410, {
        code: "POD_MOVED",
        error: "This Pod has a new address. Use the new one from now on.",
        recovery: { action: "use_new_pod_url" },
        podId: "pod-1",
        podUrl: NEW,
        consoleUrl: "https://admin.acme.pod.synap.live",
      })
    );
    const answer = await askControlPlaneWherePodIs({ podUrl: OLD, cpUrl: `${CP}/`, cpToken: "cp-token" });
    expect(answer).toEqual({
      kind: "moved",
      podUrl: NEW,
      consoleUrl: "https://admin.acme.pod.synap.live",
      podId: "pod-1",
    });
    expect(calls[0].url).toBe(`${CP}/pods/handshake`);
    expect(calls[0].init.method).toBe("POST");
    expect(JSON.parse(String(calls[0].init.body))).toEqual({ targetUrl: OLD });
    expect((calls[0].init.headers as Record<string, string>).Authorization).toBe("Bearer cp-token");
  });

  it("is signed-out without a CP sign-in, and never asks", async () => {
    const calls = stubFetch(() => json(200, {}));
    expect(await askControlPlaneWherePodIs({ podUrl: OLD, cpUrl: CP, cpToken: undefined })).toEqual({
      kind: "signed-out",
    });
    expect(calls).toHaveLength(0);
  });

  it("reads 401 as signed-out, other refusals as not moved", async () => {
    stubFetch(() => json(401, {}));
    expect((await askControlPlaneWherePodIs({ podUrl: OLD, cpUrl: CP, cpToken: "t" })).kind).toBe("signed-out");
    stubFetch(() => json(403, { code: "POD_NOT_REGISTERED" }));
    expect(await askControlPlaneWherePodIs({ podUrl: OLD, cpUrl: CP, cpToken: "t" })).toEqual({
      kind: "not-moved",
      code: "POD_NOT_REGISTERED",
    });
  });

  it("never takes a new address that is not https", async () => {
    stubFetch(() => json(410, { code: "POD_MOVED", podUrl: "http://acme.pod.synap.live" }));
    expect((await askControlPlaneWherePodIs({ podUrl: OLD, cpUrl: CP, cpToken: "t" })).kind).toBe("unknown");
  });

  it("an unreachable CP is unknown, not 'not moved'", async () => {
    vi.stubGlobal("fetch", async () => {
      throw new TypeError("fetch failed");
    });
    expect((await askControlPlaneWherePodIs({ podUrl: OLD, cpUrl: CP, cpToken: "t" })).kind).toBe("unknown");
  });
});

describe("synap doctor: a moved pod", () => {
  const signIn = () => {
    const dir = path.join(process.env.HOME!, ".synap");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, "credentials.json"),
      JSON.stringify({ token: "cp-token", expiresAt: "2999-01-01T00:00:00.000Z", userId: "u", email: "e" })
    );
  };

  it("names the new address from the CP and the saved profile it will fix", async () => {
    signIn();
    addPodProfile("acme", { podUrl: OLD, workspaceId: "w", agentUserId: "a", hubApiKey: "k", savedAt: "x" });
    const calls = stubFetch(() => json(410, { code: "POD_MOVED", podId: "p", podUrl: NEW }));
    const diagnosis = await diagnosePodMove(OLD, { moved: true }, "acme");
    expect(diagnosis?.check.ok).toBe(false);
    expect(diagnosis?.check.detail).toContain(NEW);
    expect(diagnosis?.check.fix).toMatch(/synap doctor --fix/);
    expect(diagnosis?.move).toEqual({ from: OLD, to: NEW, profileName: "acme" });
    expect(calls[0].url).toMatch(/\/pods\/handshake$/);
  });

  it("asks nobody about a self-hosted pod that is simply down", async () => {
    const calls = stubFetch(() => json(500, {}));
    expect(await diagnosePodMove("https://pod.example.com", { moved: false }, "x")).toBeNull();
    expect(calls).toHaveLength(0);
  });

  it("without a CP sign-in, says to sign in first", async () => {
    fs.rmSync(path.join(process.env.HOME!, ".synap", "credentials.json"), { force: true });
    stubFetch(() => json(200, {}));
    const diagnosis = await diagnosePodMove(OLD, { moved: true }, "acme");
    expect(diagnosis?.move).toBeUndefined();
    expect(diagnosis?.check.fix).toMatch(/synap login/);
  });
});

// The CP's handshake route, from the sibling checkout or CP_PODS_ROUTE (a copy
// taken from an unmerged CP branch).
const cpRoutePath =
  process.env.CP_PODS_ROUTE ??
  path.resolve(__dirname, "..", "..", "synap-control-plane-api", "src", "routes", "pods.ts");
const cpRoute = fs.existsSync(cpRoutePath) ? fs.readFileSync(cpRoutePath, "utf8") : "";
const cpHasMove = cpRoute.includes('podHandshakeProblem("POD_MOVED")');

describe("parity with the CP's handshake route", () => {
  it.skipIf(!cpHasMove)("410 POD_MOVED carries podUrl, and the request takes targetUrl", () => {
    const schema = cpRoute.slice(cpRoute.indexOf("const handshakeSchema"), cpRoute.indexOf('pods.post("/handshake"'));
    expect(schema).toMatch(/targetUrl: z\.string\(\)\.url\(\)/);
    const moved = cpRoute.slice(cpRoute.indexOf('podHandshakeProblem("POD_MOVED")') - 200);
    expect(moved).toMatch(/\.\.\.podHandshakeProblem\("POD_MOVED"\),\s*podId: [^,]+,\s*podUrl: [^,]+,\s*consoleUrl:/);
    expect(moved.slice(0, 600)).toMatch(/\},\s*410,?\s*\)/);
  });
});
