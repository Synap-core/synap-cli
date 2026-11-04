/**
 * A limited key refused at the door is said as one, never as a missing
 * workspace (finding de33a075, 1 Nov 2026).
 *
 * After `synap login --reconnect` swapped the person's full-access key for the
 * computer's key, `synap market update` read GET /workspaces, the pod's door
 * fence answered 403 `{ code: "GRANT_DOOR_UNSUPPORTED" }`, and the CLI hinted
 * "That workspace is not accessible on this pod": the hint matched
 * `/workspace/i` over `message`, which starts "Hub GET /workspaces failed".
 *
 * Driven through the REAL `hubGet` (a stubbed fetch is the pod) and the REAL
 * `renderHubError`; what is asserted is what the person reads on stderr.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  GRANT_DOOR_UNSUPPORTED_CODE,
  grantDenialOf,
  hubGet,
  hubPost,
  HubError,
  renderHubError,
  type HubConfig,
} from "../src/lib/hub-client.js";

const POD = "https://pod.limited-key.example.test";
const WS = "808939d1-86b3-4c52-a153-ae06ece2c54e";
const cfg: HubConfig = {
  podUrl: POD,
  apiKey: "computer-key",
  userId: "cli",
  workspaceId: WS,
};

/** The pod's own wording (synap-backend access/grant-door-fence.ts). */
const DOOR_REFUSAL = {
  error:
    "This door does not support scoped keys yet: its reads are not bounded by a grant. Use a door listed in the API keys guide, or a key with the full-access '*' grant.",
  code: "GRANT_DOOR_UNSUPPORTED",
};

function podAnswers(status: number, body: unknown): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(
      async () =>
        new Response(JSON.stringify(body), {
          status,
          headers: { "content-type": "application/json" },
        })
    )
  );
}

async function refusalOf(path: string): Promise<HubError> {
  try {
    await hubGet(path, {}, cfg);
  } catch (e) {
    if (e instanceof HubError) return e;
    throw e;
  }
  throw new Error(`expected GET ${path} to fail`);
}

function printed(err: unknown): string {
  const lines: string[] = [];
  vi.spyOn(console, "error").mockImplementation((m) => void lines.push(String(m)));
  vi.spyOn(console, "log").mockImplementation((m) => void lines.push(String(m)));
  renderHubError(err);
  return lines.join("\n");
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("a limited key refused at the door", () => {
  it("reads the pod's structured code, and keeps its words apart from the path", async () => {
    podAnswers(403, DOOR_REFUSAL);
    const err = await refusalOf("/workspaces");
    expect(err.code).toBe(GRANT_DOOR_UNSUPPORTED_CODE);
    expect(err.detail).toBe(DOOR_REFUSAL.error);
    // The path is in `message` (other call sites read its `(HTTP 403)` token).
    expect(err.message).toContain("GET /workspaces");
    expect(err.message).toContain("(HTTP 403)");
  });

  it("says the key is limited, names the door, and never blames the workspace", async () => {
    podAnswers(403, DOOR_REFUSAL);
    const out = printed(await refusalOf("/workspaces"));
    expect(out).toContain("This key is limited");
    expect(out).toContain("signed in as yourself, which the CLI cannot do yet. (GET /workspaces)");
    expect(out).not.toContain("not accessible on this pod");
    expect(out).not.toContain(`Sent workspace ${WS}`);
    expect(out).not.toContain("Workspace not found");
  });

  it("the owner-wide refusal carries the same code, and the same hint", async () => {
    podAnswers(403, {
      error:
        "This door acts on everything you own (it cannot be limited to a space, project or kind), so it needs a key with unrestricted full access ('*' with no space, project or object limit).",
      code: "GRANT_DOOR_UNSUPPORTED",
    });
    const out = printed(await refusalOf("/calendar/feed"));
    expect(out).toContain("This key is limited");
    expect(out).not.toContain("not accessible on this pod");
  });
});

describe("a limited key whose grant leaves the action out", () => {
  // The pod's code (GRANT_DENIED, synap-backend grant-denial-code.ts), and an
  // older pod's words (utils/grant-write-check.ts) with no code.
  async function postRefusal(body: unknown): Promise<HubError> {
    podAnswers(403, body);
    try {
      await hubPost("/packages/apply", {}, cfg);
    } catch (e) {
      if (e instanceof HubError) return e;
      throw e;
    }
    throw new Error("expected POST /packages/apply to fail");
  }

  it("is read from the pod's words, and names the refused action", async () => {
    const err = await postRefusal({ error: `This key's grant does not allow "workspace.update".` });
    expect(err.code).toBeUndefined();
    expect(grantDenialOf(err)).toEqual({ action: "workspace.update" });
  });

  it("reads the pod's GRANT_DENIED code and action first, whatever the words", async () => {
    const err = await postRefusal({
      error: "Refused.",
      code: "GRANT_DENIED",
      reasonCode: "GRANT_DENIED",
      action: "workspace.update",
    });
    expect(err.code).toBe("GRANT_DENIED");
    expect(grantDenialOf(err)).toEqual({ action: "workspace.update" });
  });

  it("reads reasonCode when the door kept its own code", async () => {
    const err = await postRefusal({
      error: "Refused.",
      code: "ROUTE_CODE",
      reasonCode: "GRANT_DENIED",
      action: "channel.read",
    });
    expect(grantDenialOf(err)).toEqual({ action: "channel.read" });
  });

  it("a 403 with neither the code nor the older words is not a grant denial", async () => {
    expect(grantDenialOf(await postRefusal({ error: "Refused.", code: "OTHER" }))).toBeNull();
  });

  it("says the key may not do it, never that the workspace is missing", async () => {
    const out = printed(
      await postRefusal({ error: `This key's grant does not allow "workspace.update".` })
    );
    expect(out).toContain(`This key may not do "workspace.update"`);
    expect(out).toContain("Nothing is wrong with your workspace");
    expect(out).toContain("Do it yourself with full access");
    expect(out).not.toContain("not accessible on this pod");
    expect(out).not.toContain(`Sent workspace ${WS}`);
  });

  it("the words that name a workspace id are still a grant denial", async () => {
    const out = printed(
      await postRefusal({
        error: `This key's grant does not allow "entity.task.update" in workspace ${WS}.`,
      })
    );
    expect(out).toContain(`This key may not do "entity.task.update"`);
    expect(out).not.toContain("not accessible on this pod");
  });

  it("a command that knows the person's door names it", async () => {
    const err = await postRefusal({ error: `This key's grant does not allow "workspace.update".` });
    const lines: string[] = [];
    vi.spyOn(console, "error").mockImplementation((m) => void lines.push(String(m)));
    renderHubError(err, { personDoor: "Apply it yourself from pod admin → Marketplace → Updates." });
    const out = lines.join("\n");
    expect(out).toContain("Apply it yourself from pod admin → Marketplace → Updates.");
    expect(out).not.toContain("Do it yourself with full access");
  });
});

describe("the workspace hint", () => {
  it("still shows when the pod's own words name a workspace", async () => {
    podAnswers(403, { error: "You are not a member of this workspace" });
    const out = printed(await refusalOf("/entities"));
    expect(out).toContain(`Sent workspace ${WS} to ${POD}`);
    expect(out).toContain("not accessible on this pod");
    expect(out).not.toContain("This key is limited");
  });

  it("is not triggered by the URL path: a /workspaces route refused for scopes gets the credentials hint", async () => {
    podAnswers(403, { error: "Insufficient scope: hub-protocol.read required" });
    const out = printed(await refusalOf("/workspaces"));
    expect(out).not.toContain("not accessible on this pod");
    expect(out).not.toContain("Workspace not found");
    expect(out).toContain("rejected this key's credentials or its scopes");
  });
});
