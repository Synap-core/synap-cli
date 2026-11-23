/**
 * `synap cap add` from a key that may not add capabilities (an agent's or a
 * computer's) asks the person instead of failing, and never asks for a
 * credential it cannot use (founder dogfood 2026-11-16, finding 1773922e:
 * the key was typed, then the pod answered 403 "This key's grant does not
 * allow tool.create").
 *
 * The pod is modelled at its contract: `/auth/status` says what the key may
 * do, `/capabilities/apply` is the direct write, `/installations/request`
 * with computer "pod" files the person's approval.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const prompt = vi.hoisted(() => vi.fn());
vi.mock("prompts", () => ({ default: prompt }));

const REVIEW = "https://pod.test/open/prop-1";
const reviewOverride = vi.hoisted(() => ({ url: null as string | null }));

const pod = vi.hoisted(() => ({
  /** `/auth/status` `access`; undefined = an older pod that does not say. */
  access: undefined as unknown,
  /** The direct write refuses with the grant denial. */
  refuseApply: false,
  /** An older pod reads "pod" as an unknown computer. */
  podTargetUnknown: false,
  calls: [] as Array<{ method: string; path: string; body?: Record<string, unknown> }>,
}));

vi.mock("../src/lib/hub-client.js", async (importOriginal) => {
  const real = await importOriginal<typeof import("../src/lib/hub-client.js")>();
  const card = {
    id: null,
    key: "cal-com-scheduling",
    name: "Cal.com Scheduling",
    description: "Book meetings and read your calendar",
    source: "available",
    status: "available",
    verbs: [],
    installParams: [{ name: "apiKey", label: "Cal.com API key", required: true, secret: true }],
    nextAction: { kind: "add", hint: "Add it." },
  };
  return {
    ...real,
    resolveHubConfig: vi.fn(async () => ({ podUrl: "https://pod.test", apiKey: "k", workspaceId: "ws-1" })),
    renderHubError: vi.fn(),
    hubGet: vi.fn(async (path: string) => {
      pod.calls.push({ method: "GET", path });
      if (path === "/auth/status") return { userId: "agent-1", ...(pod.access === undefined ? {} : { access: pod.access }) };
      if (path === "/capabilities/catalog") return { capabilities: [card] };
      throw new Error(`unexpected GET ${path}`);
    }),
    hubPost: vi.fn(async (path: string, body: Record<string, unknown>) => {
      pod.calls.push({ method: "POST", path, body });
      if (path === "/capabilities/apply") {
        if (pod.refuseApply) {
          throw new real.HubError({
            message: 'Hub POST /capabilities/apply failed (HTTP 403): This key\'s grant does not allow "tool.create"',
            detail: 'This key\'s grant does not allow "tool.create"',
            status: 403,
            rawBody: "",
            path,
            method: "POST",
          });
        }
        return { created: { tools: [] } };
      }
      if (path === "/installations/request") {
        if (pod.podTargetUnknown) {
          throw new real.HubError({
            message: "Hub POST /installations/request failed (HTTP 404): Computer not found",
            detail: "Computer not found",
            status: 404,
            rawBody: "",
            path,
            method: "POST",
          });
        }
        return { status: "proposed", proposalId: "prop-1", reviewUrl: reviewOverride.url ?? REVIEW, message: "Proposed." };
      }
      throw new Error(`unexpected POST ${path}`);
    }),
  };
});

const opened = vi.hoisted(() => [] as string[]);
vi.mock("../src/lib/safe-open.js", async (importOriginal) => {
  const real = await importOriginal<typeof import("../src/lib/safe-open.js")>();
  return {
    ...real,
    openPodPage: (url: string, podUrl: string) => real.openPodPage(url, podUrl, (u) => void opened.push(u)),
  };
});

const { capabilityAdd } = await import("../src/commands/capability.js");

class Exit extends Error {
  constructor(readonly code: number | undefined) {
    super(`process.exit(${code})`);
  }
}

let out: string[] = [];

beforeEach(() => {
  pod.access = undefined;
  pod.refuseApply = false;
  pod.podTargetUnknown = false;
  pod.calls.length = 0;
  opened.length = 0;
  prompt.mockReset();
  out = [];
  vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
    throw new Exit(code);
  }) as never);
  const keep = (...a: unknown[]) => void out.push(a.map(String).join(" "));
  vi.spyOn(console, "log").mockImplementation(keep);
  vi.spyOn(console, "error").mockImplementation(keep);
});

const posts = () => pod.calls.filter((c) => c.method === "POST").map((c) => c.path);
const printed = () => out.join("\n");

const LIMITED = {
  isFullAccess: false,
  summary: "limited",
  scopes: [{ permissions: ["entity.*", "proposal.create"], workspaceIds: null, projectIds: null, entityIds: null }],
  clientId: null,
};

describe("cap add on a key that may not add capabilities", () => {
  it("asks the person for approval BEFORE any credential prompt, and never writes directly", async () => {
    pod.access = LIMITED;
    await capabilityAdd("Cal.com Scheduling", {});

    expect(prompt).not.toHaveBeenCalled();
    expect(posts()).toEqual(["/installations/request"]);
    expect(pod.calls.find((c) => c.path === "/installations/request")?.body).toEqual({
      capabilityKey: "cal-com-scheduling",
      action: "install",
      computer: "pod",
    });
    expect(printed()).toContain(REVIEW);
    expect(printed()).toContain("Cal.com API key");
  });

  it("an older pod that does not say what the key may do: tries, and the refusal ends in the same ask", async () => {
    pod.refuseApply = true;
    prompt.mockResolvedValueOnce({ value: "cal_live_secret" });
    await capabilityAdd("Cal.com Scheduling", {});

    expect(posts()).toEqual(["/capabilities/apply", "/installations/request"]);
    const ask = pod.calls.find((c) => c.path === "/installations/request");
    expect(JSON.stringify(ask?.body)).not.toContain("cal_live_secret");
    expect(printed()).toContain(REVIEW);
    expect(printed()).toContain("was not kept");
  });

  it("a pod that cannot take the request yet says so and exits 1", async () => {
    pod.access = LIMITED;
    pod.podTargetUnknown = true;
    await expect(capabilityAdd("Cal.com Scheduling", {})).rejects.toMatchObject({ code: 1 });
    expect(printed()).toContain("cannot take the request from the CLI yet");
  });
});

describe("cap add on a full-access key", () => {
  it("asks for the credential and applies directly, as before", async () => {
    pod.access = { isFullAccess: true, summary: "full access", scopes: [], clientId: null };
    prompt.mockResolvedValueOnce({ value: "cal_live_secret" });
    await capabilityAdd("Cal.com Scheduling", {});

    expect(prompt).toHaveBeenCalledTimes(1);
    expect(posts()).toEqual(["/capabilities/apply"]);
  });
});

describe("cap add by a near name", () => {
  it("not in a terminal: refuses and names the command for what was meant", async () => {
    pod.access = LIMITED;
    await expect(capabilityAdd("cal.com", {})).rejects.toMatchObject({ code: 1 });
    expect(printed()).toContain('No capability named "cal.com"');
    expect(printed()).toContain('synap cap add "Cal.com Scheduling"');
    expect(posts()).toEqual([]);
  });

  it("in a terminal: asks \"Did you mean…?\" and goes on with the confirmed one", async () => {
    pod.access = LIMITED;
    const tty = { stdin: process.stdin.isTTY, stdout: process.stdout.isTTY };
    Object.defineProperty(process.stdin, "isTTY", { value: true, configurable: true });
    Object.defineProperty(process.stdout, "isTTY", { value: true, configurable: true });
    try {
      prompt.mockResolvedValueOnce({ ok: true });
      await capabilityAdd("cal.com", {});
    } finally {
      Object.defineProperty(process.stdin, "isTTY", { value: tty.stdin, configurable: true });
      Object.defineProperty(process.stdout, "isTTY", { value: tty.stdout, configurable: true });
    }
    expect(prompt).toHaveBeenCalledTimes(1);
    expect(prompt.mock.calls[0]![0]).toMatchObject({ type: "confirm" });
    expect(posts()).toEqual(["/installations/request"]);
  });
});

describe("cap add on a limited key opens the approval page", () => {
  const asTerminal = async (run: () => Promise<void>, tty = true) => {
    const was = process.stdout.isTTY;
    Object.defineProperty(process.stdout, "isTTY", { value: tty, configurable: true });
    try {
      await run();
    } finally {
      Object.defineProperty(process.stdout, "isTTY", { value: was, configurable: true });
    }
  };

  it("in a terminal: opens the pod's review page, and still prints it", async () => {
    pod.access = LIMITED;
    await asTerminal(() => capabilityAdd("Cal.com Scheduling", {}));
    expect(opened).toEqual([REVIEW]);
    expect(printed()).toContain(REVIEW);
  });

  it("not in a terminal (a script, CI): prints the link and opens nothing", async () => {
    pod.access = LIMITED;
    await asTerminal(() => capabilityAdd("Cal.com Scheduling", {}), false);
    expect(opened).toEqual([]);
    expect(printed()).toContain(REVIEW);
  });

  it("a review link off this pod is printed, never opened", async () => {
    pod.access = LIMITED;
    reviewOverride.url = "https://evil.example/open/prop-1";
    try {
      await asTerminal(() => capabilityAdd("Cal.com Scheduling", {}));
    } finally {
      reviewOverride.url = null;
    }
    expect(opened).toEqual([]);
  });
});
