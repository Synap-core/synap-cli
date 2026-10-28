/**
 * After a failed Hub command the CLI used to print only a Discord invite: a
 * customer with a billing or account problem had no way to open a ticket. Every
 * Synap surface now points at ONE support door, `https://synap.live/support`,
 * with `from=cli` naming the surface.
 *
 * Behavioural: drive `renderHubError` (the one place every failed Hub command
 * flows through) and read what actually reaches stderr. The URL is asserted as
 * a literal, not via the exported constant, so a wrong constant fails here.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

let errLines: string[];

beforeEach(() => {
  // The footer is once-per-process (module state): a fresh module per test.
  vi.resetModules();
  errLines = [];
  vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
    errLines.push(args.map(String).join(" "));
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

async function failOnce(): Promise<string> {
  const { HubError, renderHubError } = await import("../src/lib/hub-client.js");
  renderHubError(
    new HubError({
      message: "Hub GET /entities failed (HTTP 500): boom",
      status: 500,
      rawBody: "{}",
      path: "/entities",
      method: "GET",
    })
  );
  return errLines.join("\n");
}

describe("failed command help footer", () => {
  it("names the support door with from=cli (open a ticket), and keeps Discord", async () => {
    const out = await failOnce();
    expect(out).toContain("Open a ticket: https://synap.live/support?from=cli");
    expect(out).toContain("https://discord.gg/xhRdQ7hG5h");
  });

  it("prints the footer once per process, not once per failure", async () => {
    const { HubError, renderHubError } = await import("../src/lib/hub-client.js");
    const err = new HubError({
      message: "x",
      status: 500,
      rawBody: "{}",
      path: "/p",
      method: "GET",
    });
    renderHubError(err);
    renderHubError(err);
    const hits = errLines.filter((l) => l.includes("https://synap.live/support?from=cli"));
    expect(hits).toHaveLength(1);
  });
});
