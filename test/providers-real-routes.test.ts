/**
 * F13 — `synap providers` and the opencode/aider installers call the pod's
 * real provider routes, and never write a masked key into a tool's config.
 *
 * The defect: the CLI called `/api/hub/providers/models` and
 * `/api/hub/providers/credentials`, which no pod serves (the routes are
 * `/api/hub/ai-providers` and `/api/hub/ai-providers/credentials`,
 * synap-backend routers/hub-protocol/rest/ai-providers.ts), so every call
 * ended in HTTP 404. The pod also masks provider keys for agent keys
 * (`{ masked: true }`), which an installer must refuse rather than write.
 *
 * The fake pod below serves ONLY the backend's routes, with its shapes, and
 * 404s anything else.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fetchPodProviders, fetchPodCredentials, AI_PROVIDERS_PATH } from "../src/commands/providers.js";
import { installAider, installOpencode } from "../src/lib/targets.js";

const POD = "https://pod.providers.example.test";
const SECRET = "sk-or-v1-0123456789abcdef0123456789";
let masked = true;
let calls: string[] = [];

const rows = [
  { id: "u1", providerId: "openrouter", name: "OpenRouter", baseUrl: "https://openrouter.ai/api/v1", enabled: true, priority: 1, tags: [], models: [{ id: "deepseek/deepseek-chat", contextWindow: 64000 }], hasApiKey: true },
  { id: "u2", providerId: "off", name: "Disabled", baseUrl: "https://off.example/v1", enabled: false, priority: 9, tags: [], models: [], hasApiKey: false },
];

beforeEach(() => {
  calls = [];
  masked = true;
  vi.stubGlobal("fetch", async (input: string | URL) => {
    const u = new URL(String(input));
    calls.push(u.pathname);
    const json = (body: unknown, status = 200) =>
      new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
    if (u.origin === POD && u.pathname === "/api/hub/ai-providers") return json({ providers: rows });
    if (u.origin === POD && u.pathname === "/api/hub/ai-providers/credentials") {
      return json({
        providers: [{ providerId: "openrouter", apiKey: masked ? "sk-or-v1…6789" : SECRET, hasApiKey: true, source: "pod-wide" }],
        masked,
      });
    }
    return json({ error: "Not found" }, 404);
  });
  vi.spyOn(console, "log").mockImplementation(() => {});
});

afterEach(() => vi.unstubAllGlobals());

describe("pod provider routes", () => {
  it("lists enabled providers from /api/hub/ai-providers", async () => {
    const list = await fetchPodProviders(POD, "agent-key");
    expect(calls).toEqual([AI_PROVIDERS_PATH]);
    expect(list.map((p) => p.providerId)).toEqual(["openrouter"]);
    expect(list[0].models[0].id).toBe("deepseek/deepseek-chat");
  });

  it("joins credentials onto the listing and reports masking", async () => {
    masked = false;
    const creds = await fetchPodCredentials(POD, "internal-key");
    expect(creds.masked).toBe(false);
    expect(creds.providers[0]).toMatchObject({ providerId: "openrouter", baseUrl: "https://openrouter.ai/api/v1", apiKey: SECRET });
  });

  it("aider: a masked key is refused, nothing is written", async () => {
    const ok = await installAider({ podUrl: POD, apiKey: "agent-key" });
    expect(ok).toBe(false);
    expect(fs.existsSync(path.join(os.homedir(), ".aider.conf.yml"))).toBe(false);
  });

  it("opencode: a masked key is refused, nothing is written", async () => {
    const ok = await installOpencode({ podUrl: POD, apiKey: "agent-key" });
    expect(ok).toBe(false);
    expect(fs.existsSync(path.join(os.homedir(), ".config", "opencode", "opencode.json"))).toBe(false);
  });

  it("aider: a plaintext key (a pod service key) is written", async () => {
    masked = false;
    const ok = await installAider({ podUrl: POD, apiKey: "internal-key" });
    expect(ok).toBe(true);
    const conf = fs.readFileSync(path.join(os.homedir(), ".aider.conf.yml"), "utf8");
    expect(conf).toContain(`openai-api-key: ${SECRET}`);
    expect(conf).toContain("openai-api-base: https://openrouter.ai/api/v1");
    expect(calls.every((p) => p.startsWith(AI_PROVIDERS_PATH))).toBe(true);
    fs.rmSync(path.join(os.homedir(), ".aider.conf.yml"));
  });
});
