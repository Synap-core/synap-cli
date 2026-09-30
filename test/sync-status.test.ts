import { describe, it, expect } from "vitest";
import { resolveHubConfig, hubGet } from "../src/lib/hub-client.js";
import { capabilitySyncStatus } from "../src/commands/sync-status.js";
import { vi } from "vitest";

vi.mock("../src/lib/hub-client.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/lib/hub-client.js")>();
  return {
    ...actual,
    resolveHubConfig: vi.fn(),
    hubGet: vi.fn(),
  };
});

const mockResolveHubConfig = vi.mocked(resolveHubConfig);
const mockHubGet = vi.mocked(hubGet);

describe("capabilitySyncStatus — request wiring", () => {
  it("forwards a provider filter and the resolved workspace as query params", async () => {
    mockResolveHubConfig.mockResolvedValue({
      podUrl: "https://pod.example",
      apiKey: "k",
      workspaceId: "ws-1",
    } as any);
    mockHubGet.mockResolvedValue({ statuses: [] });

    await capabilitySyncStatus("google", {});

    expect(mockHubGet).toHaveBeenCalledWith(
      "/connectors/sync-status",
      { provider: "google", workspaceId: "ws-1" },
      expect.anything()
    );
  });

  it("omits provider from the query when none is given", async () => {
    mockResolveHubConfig.mockResolvedValue({
      podUrl: "https://pod.example",
      apiKey: "k",
      workspaceId: undefined,
    } as any);
    mockHubGet.mockResolvedValue({ statuses: [] });

    await capabilitySyncStatus(undefined, {});

    const [, query] = mockHubGet.mock.calls.at(-1)!;
    expect(query).not.toHaveProperty("provider");
    expect(query).not.toHaveProperty("workspaceId");
  });

  it("--workspace overrides the resolved config workspace", async () => {
    mockResolveHubConfig.mockResolvedValue({
      podUrl: "https://pod.example",
      apiKey: "k",
      workspaceId: "ws-config",
    } as any);
    mockHubGet.mockResolvedValue({ statuses: [] });

    await capabilitySyncStatus(undefined, { workspace: "ws-flag" });

    const [, query] = mockHubGet.mock.calls.at(-1)!;
    expect(query).toMatchObject({ workspaceId: "ws-flag" });
  });

  // EMPTY ≠ FAILED: a genuinely empty `statuses` array from a successful
  // response must render as "nothing configured", never throw or exit non-zero.
  it("an empty statuses array from a successful call does not error", async () => {
    mockResolveHubConfig.mockResolvedValue({
      podUrl: "https://pod.example",
      apiKey: "k",
    } as any);
    mockHubGet.mockResolvedValue({ statuses: [] });

    await expect(capabilitySyncStatus(undefined, {})).resolves.toBeUndefined();
  });

  // NEGATIVE-CONTROL target: a failed call (hubGet throws, exactly what the
  // real door does on a 500 — see connectors.sync-status.test.ts) must exit
  // non-zero, never render as if nothing were configured.
  it("a hubGet failure exits non-zero rather than rendering an empty list", async () => {
    mockResolveHubConfig.mockResolvedValue({
      podUrl: "https://pod.example",
      apiKey: "k",
    } as any);
    mockHubGet.mockRejectedValue(new Error("pod unreachable"));
    const exitSpy = vi.spyOn(process, "exit").mockImplementation((() => {
      throw new Error("__exit__");
    }) as never);

    await expect(capabilitySyncStatus(undefined, {})).rejects.toThrow("__exit__");
    expect(exitSpy).toHaveBeenCalledWith(1);
    exitSpy.mockRestore();
  });
});
