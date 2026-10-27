/**
 * `synap cap connect --reconnect` with no name must offer the installed
 * capabilities connected by an API key (vault://), not only the Nango OAuth
 * services, and picking one must replace the key its tools read.
 *
 * Dogfooded 2026-10-28: the founder ran `synap cap connect --reconnect` to
 * replace the Unipile key and the picker listed only Canva and Google (the
 * Nango providers). "Unipile — Messaging & LinkedIn" was reachable by name only.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const prompt = vi.hoisted(() => vi.fn());
vi.mock("prompts", () => ({ default: prompt }));

const pod = vi.hoisted(() => ({
  secrets: new Map<string, { value: string; capabilityId: string }>(),
  catalog: [] as Record<string, unknown>[],
  catalogFails: false,
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
      if (path === "/connectors/providers")
        return {
          nangoStatus: "ok",
          providers: [
            { id: "canva", provider: "canva", displayName: "Canva", connected: true },
            { id: "google", provider: "google", displayName: "Google", connected: true },
          ],
        };
      if (path === "/capabilities/catalog") {
        if (pod.catalogFails) throw new real.HubError({ message: "boom", status: 500, rawBody: "", path, method: "GET" });
        return { capabilities: pod.catalog };
      }
      throw new Error(`unexpected GET ${path}`);
    }),
    hubPost: vi.fn(async (path: string) => {
      pod.calls.push(`POST ${path}`);
      throw new Error(`unexpected POST ${path}`);
    }),
    hubPatch: vi.fn(async (path: string, body: Record<string, unknown>) => {
      pod.calls.push(`PATCH ${path}`);
      const m = /^\/capabilities\/([^/]+)\/credentials\/([^/]+)$/.exec(path);
      const secret = m && pod.secrets.get(m[2]);
      if (!m || !secret || secret.capabilityId !== m[1]) throw new Error(`unexpected PATCH ${path}`);
      secret.value = String(body.value);
      return { id: m[2] };
    }),
  };
});

const { capabilityConnect } = await import("../src/commands/capability.js");

const UNIPILE = "Unipile — Messaging & LinkedIn";

class Exit extends Error {
  constructor(readonly code: number | undefined) {
    super(`process.exit(${code})`);
  }
}

beforeEach(() => {
  pod.secrets.clear();
  pod.secrets.set("s1", { value: "old-key", capabilityId: "cap-u" });
  pod.catalogFails = false;
  pod.calls.length = 0;
  pod.catalog = [
    {
      id: "cap-u",
      key: "unipile-linkedin",
      name: UNIPILE,
      source: "installed",
      status: "ready",
      connection: { required: true, kind: "vault", state: "connected", account: "s1" },
      verbs: [],
      installParams: [],
      nextAction: { kind: "none", hint: "" },
    },
    {
      id: null,
      key: "acme",
      name: "Acme (not installed)",
      source: "available",
      status: "available",
      connection: { required: true, kind: "vault", state: "missing" },
      verbs: [],
      nextAction: { kind: "add", hint: "" },
    },
  ];
  prompt.mockReset();
  vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
    throw new Exit(code);
  }) as never);
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

type Choice = { title: string; value: string; disabled?: boolean };
const choicesOfFirstPrompt = (): Choice[] => (prompt.mock.calls[0][0] as { choices: Choice[] }).choices;

describe("cap connect with no name", () => {
  it("--reconnect offers the installed API-key capability beside the OAuth services, selectable", async () => {
    prompt.mockResolvedValueOnce({ id: undefined });

    await capabilityConnect(undefined, { reconnect: true });

    const titles = choicesOfFirstPrompt().map((c) => c.title);
    const unipile = choicesOfFirstPrompt().find((c) => c.title.startsWith(UNIPILE));
    expect(titles.some((t) => t.startsWith("Canva"))).toBe(true);
    expect(unipile).toBeDefined();
    expect(unipile?.disabled).toBe(false);
    // Only installed capabilities: one not installed is `synap cap add`, not connect.
    expect(titles.some((t) => t.startsWith("Acme"))).toBe(false);
  });

  it("picking it replaces the key its tools read, in place, through the named door", async () => {
    const first = vi.fn();
    prompt.mockImplementationOnce(async (q: { choices: Choice[] }) => {
      first(q);
      return { id: q.choices.find((c) => c.title.startsWith(UNIPILE))?.value };
    });
    prompt.mockResolvedValue({ value: "new-key" });

    await capabilityConnect(undefined, { reconnect: true });

    expect(pod.secrets.get("s1")?.value).toBe("new-key");
    expect(pod.secrets.size).toBe(1);
    expect(pod.calls).toContain("PATCH /capabilities/cap-u/credentials/s1");
    expect(pod.calls).not.toContain("POST /vault/secrets");
  });

  it("without --reconnect, a connected keyed capability counts as connected (no dead end, no prompt)", async () => {
    await capabilityConnect(undefined, {});

    expect(prompt).not.toHaveBeenCalled();
  });

  it("a failed catalog read still offers the OAuth services and does not read as 'nothing keyed'", async () => {
    pod.catalogFails = true;
    prompt.mockResolvedValueOnce({ id: undefined });

    await capabilityConnect(undefined, { reconnect: true });

    const titles = choicesOfFirstPrompt().map((c) => c.title);
    expect(titles.some((t) => t.startsWith("Canva"))).toBe(true);
    expect(titles.some((t) => t.startsWith(UNIPILE))).toBe(false);
  });
});
