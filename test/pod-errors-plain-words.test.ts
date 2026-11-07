/**
 * A pod's refusal reaches the person as one plain line and one next step,
 * from ONE code-to-text map (src/lib/pod-errors.ts). "Reconnect" is advised
 * only on a 401; the pod's raw JSON is never printed (plan f61a20a5, W1).
 *
 * On 4 Nov `synap connect grok` failed with HTTP 400 SURFACE_AGENT_TYPE_REQUIRED
 * and the CLI printed the pod's JSON ("surface agent types", "human-owned
 * hub-protocol.write key") followed by "re-authenticate with `synap login
 * --reconnect`", which only mints another computer key and cannot help.
 *
 * Driven through the REAL `provisionAgentKey` (a stubbed fetch is the pod).
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { provisionAgentKey } from "../src/lib/targets.js";
import { explainPodError } from "../src/lib/pod-errors.js";
import { hubGet, HubError, renderHubError, type HubConfig } from "../src/lib/hub-client.js";

const POD = "https://pod.antoinesrvt.synap.live";

function podAnswers(status: number, body: unknown): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } }))
  );
}

async function mintFails(agentType: string): Promise<string> {
  try {
    await provisionAgentKey(POD, "computer-key", agentType, { idempotent: true });
  } catch (e) {
    return (e as Error).message;
  }
  throw new Error("expected the mint to fail");
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/** The pod's own bodies (synap-backend routers/hub-protocol/rest/setup.ts, access/grant-door-fence.ts). */
const SURFACE_REFUSAL = {
  error:
    "Agent keys may only provision surface agent types. Named agents (non-surface agentType) require a human-owned hub-protocol.write key.",
  code: "SURFACE_AGENT_TYPE_REQUIRED",
  allowedSurfaceTypes: ["claude-code", "cursor"],
};
const DOOR_REFUSAL = {
  error:
    "This door does not support scoped keys yet: its reads are not bounded by a grant. Use a door listed in the API keys guide, or a key with the full-access '*' grant.",
  code: "GRANT_DOOR_UNSUPPORTED",
};
const AI_KEY_REFUSAL = {
  error: "An AI's key cannot connect another AI. Connect it with this computer's key (`synap init`) or from your own session.",
  code: "AGENT_KEY_CANNOT_REGISTER_AGENTS",
};

describe("a failed agent-key mint", () => {
  it("400 SURFACE_AGENT_TYPE_REQUIRED for a known client: not listed yet, a generic key; no release promise, no account route, no reconnect, no JSON", async () => {
    podAnswers(400, SURFACE_REFUSAL);
    const msg = await mintFails("grok");
    expect(msg).toContain("Your pod does not list Grok yet.");
    expect(msg).toContain("synap mcp url --client generic");
    // A client that connects only with a key has no Synap-account route, and
    // the CLI cannot know which pod release adds a client.
    expect(msg).not.toContain("mcp.synap.live");
    expect(msg).not.toMatch(/Synap account/i);
    expect(msg).not.toMatch(/release/i);
    expect(msg).not.toMatch(/reconnect/i);
    expect(msg).not.toContain("{");
    expect(msg).not.toContain("surface agent types");
    expect(msg).not.toContain("hub-protocol.write");
  });

  it("the same code for a custom agent name, asked without asPerson: the command that asks for your approval", async () => {
    podAnswers(400, SURFACE_REFUSAL);
    const msg = await mintFails("researcher");
    expect(msg).toContain('custom agent "researcher"');
    expect(msg).toContain("synap agents add --name researcher --type researcher");
    expect(msg).toContain("/agents)");
    expect(msg).not.toMatch(/cannot sign in as you/i);
    expect(msg).not.toMatch(/reconnect/i);
  });

  it("asked as the person and still refused: an older pod, said plainly, with pod admin as the way", () => {
    const { line, next } = explainPodError({
      status: 400,
      body: JSON.stringify(SURFACE_REFUSAL),
      client: "hermes",
      knownClient: false,
      asPerson: true,
      podUrl: POD,
    });
    expect(line).toBe('Your pod does not accept a request for the custom agent "hermes" from this computer yet: it needs a newer pod.');
    expect(next).toContain("/agents)");
    expect(`${line} ${next}`).not.toMatch(/cannot sign in as you|reconnect/i);
  });

  it("403 GRANT_DOOR_UNSUPPORTED says it needs you signed in as yourself; no reconnect", async () => {
    podAnswers(403, DOOR_REFUSAL);
    const msg = await mintFails("cursor");
    expect(msg).toContain("This key is limited (this computer's or an AI's key), and this action needs you signed in as yourself");
    // Names the app: the desktop app, or pod admin (with its address).
    expect(msg).toContain("Synap desktop app");
    expect(msg).toContain("pod admin (https://pod-admin.antoinesrvt.synap.live)");
    expect(msg).not.toMatch(/reconnect/i);
    expect(msg).not.toContain("{");
  });

  it("403 AGENT_KEY_CANNOT_REGISTER_AGENTS says to run it outside the AI; no reconnect", async () => {
    podAnswers(403, AI_KEY_REFUSAL);
    const msg = await mintFails("cursor");
    expect(msg).toContain("an AI cannot connect another AI");
    expect(msg).toContain("your own terminal");
    expect(msg).not.toMatch(/reconnect/i);
  });

  it("an unknown code shows the pod's words, not its JSON, and no reconnect", async () => {
    podAnswers(409, { error: "Something conflicted", code: "SOMETHING_ELSE" });
    const msg = await mintFails("cursor");
    expect(msg).toContain("The pod refused (HTTP 409): Something conflicted");
    expect(msg).not.toContain("{");
    expect(msg).not.toMatch(/reconnect/i);
  });

  it("a 5xx shows nothing of its body: the pod is not answering, try again", async () => {
    podAnswers(502, { error: "upstream connect error at 10.0.3.7:4000", code: "SOMETHING_ELSE" });
    const msg = await mintFails("cursor");
    expect(msg).toContain("The pod is not answering right now (HTTP 502).");
    expect(msg).toContain("Try again in a minute, or check pod admin (https://pod-admin.antoinesrvt.synap.live).");
    expect(msg).not.toContain("upstream");
    expect(msg).not.toContain("10.0.3.7");
  });

  it("only a 401 advises a reconnect", async () => {
    podAnswers(401, { error: "Invalid API key" });
    const msg = await mintFails("cursor");
    expect(msg).toContain("synap login --reconnect");
  });
});

describe("the one map", () => {
  it("never advises a reconnect for any status but 401", () => {
    for (const status of [400, 403, 404, 409, 429, 500, 503]) {
      for (const code of [undefined, "SURFACE_AGENT_TYPE_REQUIRED", "GRANT_DOOR_UNSUPPORTED", "AGENT_KEY_CANNOT_REGISTER_AGENTS"]) {
        const t = explainPodError({ status, code, client: "cursor", knownClient: true });
        expect(`${t.line} ${t.next}`).not.toMatch(/reconnect/i);
      }
    }
  });

  it("reads an older pod's words when it sent no code", () => {
    const t = explainPodError({ status: 403, body: JSON.stringify({ error: DOOR_REFUSAL.error }) });
    expect(t.line).toContain("needs you signed in as yourself");
  });

  it("the hub's limited-key hint takes its words from the map, and offers no key the CLI cannot get", async () => {
    podAnswers(403, DOOR_REFUSAL);
    const cfg: HubConfig = { podUrl: POD, apiKey: "computer-key", userId: "cli" };
    let err: unknown;
    try {
      await hubGet("/capabilities/catalog", {}, cfg);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(HubError);
    const lines: string[] = [];
    vi.spyOn(console, "error").mockImplementation((m) => void lines.push(String(m)));
    vi.spyOn(console, "log").mockImplementation((m) => void lines.push(String(m)));
    renderHubError(err);
    const out = lines.join("\n");
    expect(out).toContain("needs you signed in as yourself");
    expect(out).toContain("GET /capabilities/catalog");
    expect(out).not.toContain("SYNAP_HUB_API_KEY");
  });
});
