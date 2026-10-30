/**
 * `synap cap enable "<name>"` turns ON the capability's access to its service
 * (each tool row in the card's `toolsOff`), not only its verbs.
 *
 * Founder dogfood 2026-10-30 (Hetzner Cloud): `market install`'s one-shot
 * `POST /tools/:id/approve` timed out, `cap enable` approved the six verbs and
 * printed "Enabled", and every run was refused "installed but not enabled"
 * because the pod's run gate also reads the TOOL row's `approved`.
 *
 * The pod is modelled at its contract: one tool row with an `approved` flag
 * behind `POST /tools/:id/approve`, and the catalog card whose `toolsOff`
 * lists it while it is off. Assertions read the row a RUN would read.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const prompt = vi.hoisted(() => vi.fn());
vi.mock("prompts", () => ({ default: prompt }));

const TOOL = "d26aa29b-45f0-494b-9ebf-388da2bb9528";
const PAGE = "https://pod-admin.pod.test/open/capability/cap-1";

const pod = vi.hoisted(() => ({
  tool: { approved: false },
  /** The pod refuses the approve, as it does for an agent key. */
  refuseApprove: false,
  calls: [] as string[],
}));

vi.mock("../src/lib/hub-client.js", async (importOriginal) => {
  const real = await importOriginal<typeof import("../src/lib/hub-client.js")>();
  return {
    ...real,
    resolveHubConfig: vi.fn(async () => ({ podUrl: "https://pod.test", apiKey: "k", workspaceId: "ws-1" })),
    renderHubError: vi.fn(),
    hubGet: vi.fn(async (path: string) => {
      pod.calls.push(`GET ${path}`);
      if (path !== "/capabilities/catalog") throw new Error(`unexpected GET ${path}`);
      return {
        capabilities: [
          {
            id: "cap-1",
            key: "hetzner-cloud",
            name: "Hetzner Cloud",
            source: "installed",
            status: "ready",
            verbs: [
              { verbId: "hcloud_create_server", skillId: "s-1", label: "hcloud_create_server", type: "write", enabled: true },
              { verbId: "hcloud_list_servers", skillId: "s-2", label: "hcloud_list_servers", type: "read", enabled: true },
            ],
            ...(pod.tool.approved ? {} : { toolsOff: [{ id: TOOL, name: "hetzner_cloud" }] }),
            nextAction: pod.tool.approved
              ? { kind: "run", hint: "Run one of its actions.", url: PAGE }
              : { kind: "enable", hint: "Its access to the service is off.", url: PAGE },
          },
        ],
      };
    }),
    hubPost: vi.fn(async (path: string, body: Record<string, unknown>) => {
      pod.calls.push(`POST ${path}`);
      if (path === `/tools/${TOOL}/approve`) {
        if (pod.refuseApprove) {
          throw new real.HubError({
            message: "Approving a tool is a person's step: an agent key cannot approve.",
            status: 403,
            rawBody: "",
            path,
            method: "POST",
          });
        }
        pod.tool.approved = body.approved === true;
        return { id: TOOL, approved: pod.tool.approved };
      }
      throw new Error(`unexpected POST ${path}`);
    }),
  };
});

const { capabilityEnable } = await import("../src/commands/capability.js");

let out: string[] = [];

beforeEach(() => {
  pod.tool.approved = false;
  pod.refuseApprove = false;
  pod.calls.length = 0;
  out = [];
  prompt.mockReset();
  // The person keeps the verbs as they are (both already on).
  prompt.mockResolvedValue({ verbs: ["hcloud_create_server", "hcloud_list_servers"] });
  vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
    throw new Error(`process.exit(${code})`);
  }) as never);
  const capture = (...args: unknown[]) => void out.push(args.map(String).join(" "));
  vi.spyOn(console, "log").mockImplementation(capture);
  vi.spyOn(console, "error").mockImplementation(capture);
  vi.spyOn(console, "warn").mockImplementation(capture);
});

describe("cap enable — a capability whose access to the service is off", () => {
  it("turns the access on, though every verb was already on (wrong rule: verbs only)", async () => {
    await capabilityEnable("Hetzner Cloud", {});
    expect(pod.calls).toContain(`POST /tools/${TOOL}/approve`);
    expect(pod.tool.approved).toBe(true);
    expect(out.join("\n")).toMatch(/Turned on its access to hetzner_cloud/);
  });

  it("refused by the pod (an agent key): says it is still off and where a person fixes it, never success", async () => {
    pod.refuseApprove = true;
    await capabilityEnable("Hetzner Cloud", {});
    const text = out.join("\n");
    expect(pod.tool.approved).toBe(false);
    expect(text).toMatch(/access to "hetzner_cloud" is still off/);
    expect(text).toContain(PAGE);
    expect(text).not.toMatch(/Turned on its access/);
    expect(text).not.toMatch(/Nothing (else )?changed/);
  });

  it("access already on: no approve call, the old answer", async () => {
    pod.tool.approved = true;
    await capabilityEnable("Hetzner Cloud", {});
    expect(pod.calls.some((c) => c.includes("/approve"))).toBe(false);
    expect(out.join("\n")).toMatch(/Nothing changed — Hetzner Cloud is already set up that way/);
  });
});
