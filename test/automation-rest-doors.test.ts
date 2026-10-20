/**
 * `synap automation enable|disable|describe|delete` go through the Hub REST
 * automations door, never a Bearer hub-tRPC MUTATION the pod fences (S7,
 * 2026-10-20).
 *
 * The pod's `/api/hub/trpc` door now refuses a scoped key (the default agent
 * key, "read & propose") on every mutation the governed-write gate does not
 * bound — `activateAutomation` among them. The REST doors
 * (`POST /automations/:id/activate|pause`, `GET /automations/:id`) are the
 * documented ones. `deleteAutomation` has no REST door; it is a GATED mutation
 * (bounded by the gate, so a scoped key still passes) and stays on tRPC.
 *
 * Driven through the REAL commands against a stubbed pod (mocked fetch), on a
 * temp HOME (test/setup/temp-home.ts).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const POD = "https://pod.example.test";
const AUTO = "33333333-3333-4333-8333-333333333333";
const WS = "44444444-4444-4444-8444-444444444444";

let calls: Array<{ method: string; url: string; body?: any }>;
let out: string[];

function podStub(reply: (method: string, url: URL) => unknown) {
  return vi.fn(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    calls.push({
      method,
      url,
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
    });
    const body = reply(method, new URL(url));
    return body === undefined
      ? new Response("not found", { status: 404 })
      : new Response(JSON.stringify(body), { status: 200 });
  });
}

beforeEach(() => {
  calls = [];
  out = [];
  vi.stubEnv("SYNAP_POD_URL", POD);
  vi.stubEnv("SYNAP_HUB_API_KEY", "sk_test_scoped");
  vi.stubEnv("SYNAP_USER_ID", "user-1");
  vi.stubEnv("SYNAP_WORKSPACE_ID", WS);
  vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => {
    out.push(a.map(String).join(" "));
  });
  vi.spyOn(console, "error").mockImplementation((...a: unknown[]) => {
    out.push(a.map(String).join(" "));
  });
  vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
    throw new Error(`process.exit(${code})`);
  }) as never);
  vi.resetModules();
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const hubTrpcMutations = () =>
  calls.filter((c) => c.method === "POST" && c.url.includes("/api/hub/trpc/"));

describe("automation commands use the Hub REST door (S7)", () => {
  it("enable → POST /automations/:id/activate with the acting user + workspace", async () => {
    vi.stubGlobal(
      "fetch",
      podStub((m, u) =>
        m === "POST" && u.pathname === `/api/hub/automations/${AUTO}/activate`
          ? { status: "activated" }
          : undefined
      )
    );
    const { automationEnable } = await import("../src/commands/automation.js");
    await automationEnable(AUTO, {});
    expect(calls).toHaveLength(1);
    expect(calls[0].body).toEqual({ userId: "user-1", workspaceId: WS });
    expect(hubTrpcMutations()).toEqual([]);
    expect(out.join("\n")).toMatch(/is now active/);
  });

  it("enable by an agent key that only proposes says so — never 'now active'", async () => {
    vi.stubGlobal(
      "fetch",
      podStub((m, u) =>
        u.pathname.endsWith("/activate")
          ? { status: "proposed", proposalId: "prop-1", message: "Proposed" }
          : undefined
      )
    );
    const { automationEnable } = await import("../src/commands/automation.js");
    await automationEnable(AUTO, { workspace: WS });
    const text = out.join("\n");
    expect(text).toMatch(/proposed/i);
    expect(text).toContain("prop-1");
    expect(text).not.toMatch(/is now active/);
  });

  it("enable with no workspace fails before calling the pod (the door needs one)", async () => {
    vi.stubEnv("SYNAP_WORKSPACE_ID", "");
    vi.stubGlobal(
      "fetch",
      podStub(() => ({ status: "activated" }))
    );
    const { automationEnable } = await import("../src/commands/automation.js");
    await expect(automationEnable(AUTO, {})).rejects.toThrow(/process\.exit\(1\)/);
    expect(calls.filter((c) => c.url.includes("/automations/"))).toEqual([]);
    expect(out.join("\n")).toMatch(/--workspace/);
  });

  it("disable → POST /automations/:id/pause", async () => {
    vi.stubGlobal(
      "fetch",
      podStub((m, u) =>
        m === "POST" && u.pathname === `/api/hub/automations/${AUTO}/pause`
          ? { status: "paused" }
          : undefined
      )
    );
    const { automationDisable } = await import("../src/commands/automation.js");
    await automationDisable(AUTO, { workspace: WS });
    expect(calls).toHaveLength(1);
    expect(calls[0].body).toEqual({ userId: "user-1", workspaceId: WS });
    expect(hubTrpcMutations()).toEqual([]);
    expect(out.join("\n")).toMatch(/paused/);
  });

  it("describe → GET /automations/:id (no hub tRPC)", async () => {
    vi.stubGlobal(
      "fetch",
      podStub((m, u) =>
        m === "GET" && u.pathname === `/api/hub/automations/${AUTO}`
          ? { id: AUTO, name: "Nightly digest", status: "active" }
          : undefined
      )
    );
    const { automationDescribe } = await import("../src/commands/automation.js");
    await automationDescribe(AUTO, { json: true });
    expect(calls).toHaveLength(1);
    expect(new URL(calls[0].url).searchParams.get("userId")).toBe("user-1");
    // An id is unambiguous: no ambient workspace narrows the read.
    expect(new URL(calls[0].url).searchParams.get("workspaceId")).toBeNull();
    expect(calls.some((c) => c.url.includes("/trpc/"))).toBe(false);
    expect(out.join("\n")).toContain("Nightly digest");
  });

  it("delete keeps the GATED tRPC mutation (no REST door) and nothing else", async () => {
    vi.stubGlobal(
      "fetch",
      podStub((m, u) =>
        m === "POST" &&
        u.pathname === "/api/hub/trpc/automations.deleteAutomation"
          ? { result: { data: { json: { success: true } } } }
          : undefined
      )
    );
    const { automationDelete } = await import("../src/commands/automation.js");
    await automationDelete(AUTO, { force: true });
    expect(calls.map((c) => `${c.method} ${new URL(c.url).pathname}`)).toEqual([
      "POST /api/hub/trpc/automations.deleteAutomation",
    ]);
  });
});
