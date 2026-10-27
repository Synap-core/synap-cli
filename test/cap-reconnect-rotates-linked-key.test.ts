/**
 * `synap cap connect "<name>" --reconnect` on an installed, vault-keyed
 * capability must replace the key the capability's TOOLS read — never write a
 * second secret nothing points at.
 *
 * Dogfooded 2026-10-27 on unipile-linkedin: the pod's installed card carries
 * `installParams: []` (its template is not in the default catalog), so the CLI
 * fell back to `POST /vault/secrets`, wrote an orphan "… credential" secret,
 * printed success, and every run kept using the old (401) key.
 *
 * The pod is modelled at its contract: a secrets table, one tool whose
 * `credentialRef` is `vault://<id>`, and the doors the CLI may call. The
 * assertions read what a RUN would read — the value behind the tool's ref —
 * and count the secrets, so a write that lands anywhere else fails here.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const prompt = vi.hoisted(() => vi.fn());
vi.mock("prompts", () => ({ default: prompt }));

const pod = vi.hoisted(() => ({
  secrets: new Map<string, { name: string; value: string; capabilityId: string | null }>(),
  tool: { credentialRef: "" },
  card: {} as Record<string, unknown>,
  calls: [] as string[],
  nextId: 1,
}));

vi.mock("../src/lib/hub-client.js", async (importOriginal) => {
  const real = await importOriginal<typeof import("../src/lib/hub-client.js")>();
  const notFound = (path: string, method: string) =>
    new real.HubError({
      message: "Credential not found for this capability.",
      status: 404,
      rawBody: "",
      path,
      method,
    });
  return {
    ...real,
    resolveHubConfig: vi.fn(async () => ({ podUrl: "https://pod.test", apiKey: "k", workspaceId: "ws-1" })),
    renderHubError: vi.fn(),
    hubGet: vi.fn(async (path: string) => {
      pod.calls.push(`GET ${path}`);
      if (path === "/capabilities/catalog") return { capabilities: [pod.card] };
      throw new Error(`unexpected GET ${path}`);
    }),
    hubPost: vi.fn(async (path: string, body: Record<string, unknown>) => {
      pod.calls.push(`POST ${path}`);
      if (path === "/vault/secrets") {
        // The pod's plain vault door: a new, unlinked secret.
        const id = `s${pod.nextId++}`;
        pod.secrets.set(id, { name: String(body.name), value: String(body.value), capabilityId: null });
        return { id };
      }
      if (path === "/capabilities/apply") {
        // The applier: keyed by secret name, updated in place, linked to the tool.
        const params = body.params as Record<string, string>;
        const name = "Acme API key";
        let id = [...pod.secrets].find(([, s]) => s.name === name)?.[0];
        if (!id) id = `s${pod.nextId++}`;
        pod.secrets.set(id, { name, value: params.apiKey, capabilityId: "cap-1" });
        pod.tool.credentialRef = `vault://${id}`;
        return { created: { tools: [] } };
      }
      throw new Error(`unexpected POST ${path}`);
    }),
    hubPatch: vi.fn(async (path: string, body: Record<string, unknown>) => {
      pod.calls.push(`PATCH ${path}`);
      // PATCH /capabilities/:capabilityId/credentials/:id — rotates in place.
      const m = /^\/capabilities\/([^/]+)\/credentials\/([^/]+)$/.exec(path);
      if (!m) throw new Error(`unexpected PATCH ${path}`);
      const secret = pod.secrets.get(m[2]);
      if (!secret || secret.capabilityId !== m[1]) throw notFound(path, "PATCH");
      secret.value = String(body.value);
      return { id: m[2] };
    }),
  };
});

const { capabilityConnect } = await import("../src/commands/capability.js");

/** What a run reads: the value behind the tool's `vault://<id>`. */
function valueTheToolUses(): string | undefined {
  const id = pod.tool.credentialRef.replace(/^vault:\/\//, "");
  return pod.secrets.get(id)?.value;
}

class Exit extends Error {
  constructor(readonly code: number | undefined) {
    super(`process.exit(${code})`);
  }
}

beforeEach(() => {
  pod.secrets.clear();
  pod.calls.length = 0;
  pod.nextId = 2;
  prompt.mockReset();
  vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
    throw new Exit(code);
  }) as never);
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

/** An installed, vault-keyed capability whose card lists no install params. */
function installedWithKey(state: "connected" | "missing"): void {
  pod.secrets.set("s1", { name: "Acme API key", value: "old-key", capabilityId: "cap-1" });
  if (state === "missing") pod.secrets.delete("s1");
  pod.tool.credentialRef = "vault://s1";
  pod.card = {
    id: "cap-1",
    key: "cap-1",
    name: "Acme",
    source: "installed",
    status: state === "connected" ? "ready" : "needs_connection",
    connection: { required: true, kind: "vault", state, account: "s1" },
    verbs: [],
    installParams: [],
    nextAction: { kind: "none", hint: "" },
  };
}

describe("cap connect --reconnect on an installed vault-keyed capability", () => {
  it("replaces the key the tool reads, in place: one secret, the new value behind the tool's ref", async () => {
    installedWithKey("connected");
    prompt.mockResolvedValue({ value: "new-key" });

    await capabilityConnect("Acme", { reconnect: true });

    expect(pod.secrets.size).toBe(1);
    expect(pod.tool.credentialRef).toBe("vault://s1");
    expect(valueTheToolUses()).toBe("new-key");
    expect(pod.calls).not.toContain("POST /vault/secrets");
  });

  it("exits non-zero and writes nothing when there is no live key to replace and no params to re-apply", async () => {
    installedWithKey("missing");
    prompt.mockResolvedValue({ value: "new-key" });

    await expect(capabilityConnect("Acme", { reconnect: true })).rejects.toThrow(new Exit(1));

    expect(pod.secrets.size).toBe(0);
    expect(pod.calls.filter((c) => !c.startsWith("GET "))).toEqual([]);
  });

  it("a cancelled prompt keeps the current key and exits non-zero", async () => {
    installedWithKey("connected");
    prompt.mockResolvedValue({ value: undefined });

    await expect(capabilityConnect("Acme", { reconnect: true })).rejects.toThrow(new Exit(1));

    expect(valueTheToolUses()).toBe("old-key");
    expect(pod.secrets.size).toBe(1);
  });

  it("with no live key but install params on the card, re-applies the template so the tool is linked", async () => {
    installedWithKey("missing");
    pod.card.installParams = [{ name: "apiKey", label: "API key", required: true, secret: true }];
    prompt.mockResolvedValue({ value: "new-key" });

    await capabilityConnect("Acme", { reconnect: true });

    expect(pod.calls).toContain("POST /capabilities/apply");
    expect(pod.secrets.size).toBe(1);
    expect(valueTheToolUses()).toBe("new-key");
  });
});
