import { describe, expect, it, vi, afterEach } from "vitest";
import { checkPodHealth } from "./pod.js";
import { classifyFetchError, proxyInUse, reachChecklist, unreachableMessage } from "./pod-reach.js";

const POD = "https://pod.example.com";

/** What undici throws when the proxy answers CONNECT with 403. */
function proxy403(): Error {
  const err = new TypeError("fetch failed");
  (err as { cause?: unknown }).cause = Object.assign(new Error("Proxy response (403) !== 200 when HTTP Tunneling"), {
    code: "UND_ERR_PRX_TUNNEL",
  });
  return err;
}

function refused(): Error {
  const err = new TypeError("fetch failed");
  (err as { cause?: unknown }).cause = Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:443"), { code: "ECONNREFUSED" });
  return err;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("classifyFetchError", () => {
  it("a proxy 403 on CONNECT is a proxy failure naming the status and the env proxy used", () => {
    const f = classifyFetchError(proxy403(), POD, { HTTPS_PROXY: "http://user:secret@egress.corp:3128" });
    expect(f.kind).toBe("proxy");
    expect(f.detail).toContain("403");
    expect(f.proxy).toEqual({ env: "HTTPS_PROXY", url: "http://egress.corp:3128" });
    expect(JSON.stringify(f)).not.toContain("secret");
  });

  it("ECONNREFUSED is a network failure that names the code", () => {
    const f = classifyFetchError(refused(), POD, {});
    expect(f.kind).toBe("network");
    expect(f.detail).toContain("ECONNREFUSED");
    expect(f.proxy).toBeUndefined();
  });

  it("NO_PROXY bypass means no proxy is reported", () => {
    expect(proxyInUse(POD, { HTTPS_PROXY: "http://egress:3128", NO_PROXY: ".example.com" })).toBeUndefined();
  });
});

describe("checkPodHealth carries the cause", () => {
  it("proxy 403: not healthy, failure.kind proxy", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(proxy403()));
    const h = await checkPodHealth(POD);
    expect(h.healthy).toBe(false);
    expect(h.failure?.kind).toBe("proxy");
  });

  it("pod answering 503: failure.kind pod", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("down", { status: 503 })));
    const h = await checkPodHealth(POD);
    expect(h.failure).toMatchObject({ kind: "pod", detail: "/health answered HTTP 503" });
  });
});

describe("init message and checklist branch on the cause", () => {
  it("proxy failure: headline has the status; checklist is not the pod-container list", () => {
    const f = classifyFetchError(proxy403(), POD, { HTTPS_PROXY: "http://egress.corp:3128" });
    expect(unreachableMessage(POD, f)).toContain("403");
    const list = reachChecklist(f).join("\n");
    expect(list).toContain("HTTPS_PROXY");
    expect(list).toContain("NO_PROXY");
    expect(list).not.toContain("container running");
  });

  it("pod failure keeps the pod-side checklist", () => {
    const list = reachChecklist({ kind: "pod", detail: "/health answered HTTP 503" }).join("\n");
    expect(list).toContain("container running");
  });
});
