/**
 * Interactive `synap connect`: the approval prompt leads with "Follow the pod
 * default", pre-selected, and choosing it writes NOTHING — a new agent's trust
 * is the pod's rule ("reversible writes act", founder 2026-09-28). A preset is
 * only ever an explicit choice. Driven through the real `ensureAgentGovernance`
 * against a stubbed pod.
 */

import { describe, it, expect, vi, beforeEach, afterAll } from "vitest";

const asked: Array<{ choices: Array<{ value: string }>; initial: number }> = [];
let answer = "pod-default";
vi.mock("prompts", () => ({
  default: vi.fn(async (q: { choices: Array<{ value: string }>; initial: number }) => {
    asked.push(q);
    return { mode: answer };
  }),
}));

const POD = "https://pod.example.synap.live";
let calls: Array<{ method: string; url: string }>;

function pod() {
  return vi.fn(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    calls.push({ method, url });
    const json = (b: unknown) => new Response(JSON.stringify(b), { status: 200 });
    if (url.endsWith("/api/hub/users/me")) return json({ id: "human-1" });
    if (url.includes("/governance") && method === "GET")
      return json({ posture: null, configured: false });
    if (url.includes("/governance")) return json({ ok: true });
    return new Response("not found", { status: 404 });
  });
}

beforeEach(() => {
  calls = [];
  asked.length = 0;
  vi.spyOn(console, "log").mockImplementation(() => undefined);
  vi.stubGlobal("fetch", pod());
});

afterAll(() => vi.unstubAllGlobals());

const governanceWrites = () =>
  calls.filter((c) => c.url.includes("/governance") && c.method === "PATCH");

describe("connect approval prompt", () => {
  it("leads with the pod default, pre-selected", async () => {
    const { ensureAgentGovernance } = await import("../src/lib/targets.js");
    answer = "pod-default";
    await ensureAgentGovernance({ podUrl: POD, apiKey: "k" }, "agent-1", undefined, {
      onlyIfUnset: true,
    });
    expect(asked).toHaveLength(1);
    expect(asked[0].choices[asked[0].initial].value).toBe("pod-default");
  });

  it("choosing the pod default writes nothing", async () => {
    const { ensureAgentGovernance } = await import("../src/lib/targets.js");
    answer = "pod-default";
    await ensureAgentGovernance({ podUrl: POD, apiKey: "k" }, "agent-1", undefined, {
      onlyIfUnset: true,
    });
    // Non-vacuity: the read ran, so the prompt was reached against the pod.
    expect(calls.some((c) => c.url.includes("/governance") && c.method === "GET")).toBe(true);
    expect(governanceWrites()).toEqual([]);
  });

  it("a failed read falls back strict and says so — never 'predates'", async () => {
    const { ensureAgentGovernance } = await import("../src/lib/targets.js");
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        const method = init?.method ?? "GET";
        calls.push({ method, url });
        if (url.endsWith("/api/hub/users/me"))
          return new Response(JSON.stringify({ id: "human-1" }), { status: 200 });
        if (url.includes("/governance") && method === "GET")
          return new Response("boom", { status: 500 });
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      })
    );
    const logged: string[] = [];
    vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => {
      logged.push(a.map(String).join(" "));
    });
    await ensureAgentGovernance({ podUrl: POD, apiKey: "k" }, "agent-1", "creates");
    expect(governanceWrites()).toHaveLength(1);
    const text = logged.join("\n");
    expect(text).toMatch(/could not read/);
    expect(text).not.toMatch(/predates/);
  });

  it("an explicit preset still writes", async () => {
    const { ensureAgentGovernance } = await import("../src/lib/targets.js");
    answer = "safe";
    await ensureAgentGovernance({ podUrl: POD, apiKey: "k" }, "agent-1", undefined, {
      onlyIfUnset: true,
    });
    expect(governanceWrites()).toHaveLength(1);
  });
});

describe("a pod that serves its write-mode list", () => {
  const CHOICES = [
    { mode: "pod-default", label: "Normal", line: "Creates and edits apply directly with Undo.", recommended: true, posture: null },
    { mode: "create-with-undo", label: "Creates only", line: "Creates apply directly with Undo.", recommended: false, posture: "create-with-undo" },
    { mode: "ask-first", label: "Ask first", line: "Every change asks you first.", recommended: false, posture: "ask-first" },
  ];
  const patches: unknown[] = [];
  beforeEach(() => {
    patches.length = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        const method = init?.method ?? "GET";
        calls.push({ method, url });
        const json = (b: unknown) => new Response(JSON.stringify(b), { status: 200 });
        if (url.endsWith("/api/hub/users/me")) return json({ id: "human-1" });
        if (url.includes("/governance") && method === "GET")
          return json({ posture: null, configured: false, writeModeChoices: CHOICES });
        if (url.includes("/governance")) {
          patches.push(JSON.parse(String(init?.body)));
          return json({ ok: true });
        }
        return new Response("not found", { status: 404 });
      })
    );
  });

  it("asks with the pod's rows, its recommended one pre-selected", async () => {
    const { ensureAgentGovernance } = await import("../src/lib/targets.js");
    answer = "pod-default";
    await ensureAgentGovernance({ podUrl: POD, apiKey: "k" }, "agent-1", undefined, {
      onlyIfUnset: true,
    });
    expect(asked).toHaveLength(1);
    expect(asked[0].choices.map((c) => c.value)).toEqual([
      "pod-default",
      "create-with-undo",
      "ask-first",
    ]);
    expect(asked[0].choices[asked[0].initial].value).toBe("pod-default");
    // Normal for an unconfigured agent writes nothing.
    expect(governanceWrites()).toEqual([]);
  });

  it("writes the posture the pod named for the chosen row", async () => {
    const { ensureAgentGovernance } = await import("../src/lib/targets.js");
    answer = "create-with-undo";
    await ensureAgentGovernance({ podUrl: POD, apiKey: "k" }, "agent-1", undefined, {
      onlyIfUnset: true,
    });
    expect(patches).toEqual([{ posture: "create-with-undo" }]);
  });
});
