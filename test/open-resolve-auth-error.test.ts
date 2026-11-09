/**
 * `synap open <id>` with a key the pod refuses must point at `synap doctor`
 * (and show the HTTP status), not blame the desktop app. A real network failure
 * keeps the "app installed / pod reachable" text.
 *
 * Drives the REAL resolveAndOpen and the REAL hub-client (only the config and
 * global fetch are faked). Not covered: the real terminal output.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/lib/hub-client.js", async (orig) => ({
  ...(await orig<typeof import("../src/lib/hub-client.js")>()),
  resolveHubConfig: async () => ({ podUrl: "https://pod.test", apiKey: "k-not-printed", workspaceId: undefined }),
}));

import { resolveAndOpen } from "../src/commands/open.js";

let out: string;
beforeEach(() => {
  out = "";
  const grab = (...a: unknown[]) => {
    out += a.join(" ") + "\n";
  };
  vi.spyOn(console, "error").mockImplementation(grab);
  vi.spyOn(console, "log").mockImplementation(grab);
  vi.spyOn(process, "exit").mockImplementation((() => {
    throw new Error("EXIT");
  }) as never);
});
afterEach(() => vi.restoreAllMocks());

describe("synap open: resolve failures", () => {
  it.each([401, 403])("HTTP %i points at synap doctor, shows the status, does not blame the app", async (status) => {
    vi.stubGlobal("fetch", async () => new Response(JSON.stringify({ error: "Unauthorized" }), { status }));
    await expect(resolveAndOpen("abc12345")).rejects.toThrow("EXIT");
    expect(out).toContain("synap doctor");
    expect(out).toContain("synap whoami");
    expect(out).toContain(String(status));
    expect(out).not.toContain("desktop app is installed");
    expect(out).not.toContain("k-not-printed");
  });

  it("a request that never reaches the pod does not claim the key is wrong", async () => {
    vi.stubGlobal("fetch", async () => {
      throw Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNREFUSED" } });
    });
    await expect(resolveAndOpen("abc12345")).rejects.toThrow("EXIT");
    expect(out).not.toContain("synap whoami");
    expect(out).toMatch(/reach|ECONNREFUSED|connect/i);
  });
});
