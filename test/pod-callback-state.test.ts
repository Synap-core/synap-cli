/**
 * F12 — the `synap init` "create a pod" loopback callback only takes the
 * provision page's answer.
 *
 * The defect: `/callback?podUrl=…` resolved with ANY podUrl from ANY caller
 * that reached 127.0.0.1:<port> during the 5-minute wait, and init then ran
 * its device flow against that URL and wrote it into every agent config.
 * Now the callback URL carries a random `state` (the landing page keeps the
 * callback's query, synap-landing app/account/pod/provision/page.tsx), and a
 * hit without it is refused while the wait goes on.
 *
 * Driven through the real `waitForPodCallback` server over HTTP.
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import { waitForPodCallback } from "../src/lib/auth.js";

afterEach(() => vi.restoreAllMocks());

/** Start the wait and return the callback URL the CLI sent to the provision page. */
async function startWait() {
  const printed: string[] = [];
  vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => { printed.push(a.join(" ")); });
  const pending = waitForPodCallback(10_000);
  let provision: string | undefined;
  for (let i = 0; i < 100 && !provision; i++) {
    provision = printed.map((l) => l.trim()).find((l) => l.includes("cli_callback="));
    if (!provision) await new Promise((r) => setTimeout(r, 20));
  }
  if (!provision) throw new Error("provision URL never printed");
  const callback = new URL(new URL(provision).searchParams.get("cli_callback")!);
  return { pending, callback };
}

const settled = (p: Promise<unknown>) =>
  Promise.race([p.then(() => true), new Promise((r) => setTimeout(() => r(false), 100))]);

function hit(callback: URL, params: Record<string, string>, keepState = true): Promise<Response> {
  const u = new URL(callback.toString());
  u.hostname = "127.0.0.1"; // the server binds the IPv4 loopback; `localhost` may resolve to ::1 first
  if (!keepState) u.searchParams.delete("state");
  for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
  return fetch(u);
}

describe("pod provisioning callback", () => {
  it("refuses a callback without the CLI's state, keeps waiting, then takes the real one", async () => {
    const { pending, callback } = await startWait();
    expect(callback.searchParams.get("state")).toMatch(/^[A-Za-z0-9_-]{32}$/);

    const forged = await hit(callback, { podUrl: "https://evil.example" }, false);
    expect(forged.status).toBe(403);
    const wrong = await hit(callback, { podUrl: "https://evil.example", state: "x".repeat(32) }, false);
    expect(wrong.status).toBe(403);
    expect(await settled(pending)).toBe(false); // still waiting

    const ok = await hit(callback, { podUrl: "https://pod.new.synap.live/", workspaceId: "ws-1" });
    expect(ok.status).toBe(200);
    await expect(pending).resolves.toEqual({ podUrl: "https://pod.new.synap.live", workspaceId: "ws-1" });
  });

  it("refuses a non-https or credentialed pod URL even with the right state", async () => {
    const { pending, callback } = await startWait();
    for (const podUrl of ["http://pod.x.synap.live", "javascript:alert(1)", "https://u:p@pod.x.synap.live", ""]) {
      expect((await hit(callback, { podUrl })).status).toBe(400);
    }
    expect(await settled(pending)).toBe(false);
    await hit(callback, { podUrl: "https://pod.x.synap.live" });
    await expect(pending).resolves.toMatchObject({ podUrl: "https://pod.x.synap.live" });
  });
});
