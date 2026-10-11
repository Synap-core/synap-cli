import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from "vitest";

/**
 * `synap templates update` and DATA CHANGES (template-lifecycle contract C).
 *
 * The pod's preview lists conversion ops a template update would run on the
 * person's data. The CLI must:
 *   - never send `acceptDataChanges` the person did not agree to;
 *   - never apply when a listed change is not agreed (`update all` is NOT consent);
 *   - send exactly the agreed opKeys when they are;
 *   - turn a 409 DATA_CHANGES_NEED_CONSENT into a held-back result, not a failure
 *     folded into "updated";
 *   - on an older pod (no `dataChanges` field), apply exactly as before;
 *   - never re-apply a RETIRED template.
 *
 * Driven through the real `marketUpdate` with only the network mocked, so the
 * seam from preview → consent → apply body is what is tested.
 */

const hubPost = vi.fn();
const attachments = vi.fn();

vi.mock("../src/lib/hub-client.js", async (orig) => {
  const actual = (await orig()) as Record<string, unknown>;
  return {
    ...actual,
    hubPost: (...a: unknown[]) => hubPost(...a),
    resolveHubConfig: async () => ({ podUrl: "https://pod.test", apiKey: "k" }),
    renderHubError: () => {},
  };
});

const SLUG = "zz-lifecycle-test";

vi.mock("../src/lib/installed.js", async (orig) => {
  const actual = (await orig()) as Record<string, unknown>;
  return {
    ...actual,
    fetchInstalledSlugs: async () => new Set([SLUG]),
    fetchInstalledInventoryStrict: async () => ({
      degraded: false,
      rows: [
        {
          kind: "workspace",
          id: "w1",
          name: "ZZ",
          packageSlug: SLUG,
          templateKey: null,
          installedVersion: "v1",
          latestVersion: "v2",
          drift: true,
          installedAt: null,
          workspaceId: "w1",
          workspaceName: "ZZ",
          provisioningStatus: null,
          failedStep: null,
        },
      ],
    }),
    fetchWorkspaceAttachmentsStrict: (...a: unknown[]) => attachments(...a),
  };
});

vi.mock("../src/lib/cp-packages.js", async (orig) => {
  const actual = (await orig()) as Record<string, unknown>;
  return {
    ...actual,
    fetchPublicBrowseRows: async () => [
      { slug: SLUG, displayName: "ZZ", category: "workspace", version: "v2" },
    ],
    fetchPackageDefinition: async () => ({ name: "ZZ", profiles: [] }),
  };
});

vi.mock("../src/lib/auth.js", async (orig) => {
  const actual = (await orig()) as Record<string, unknown>;
  return { ...actual, getStoredToken: () => null };
});

const W12 = { opKey: "w12-deal-stage", description: "Deals move their stage to the commercial stage", affected: 12, destructive: false };
const W13 = { opKey: "w13-lead-stage", description: "Leads move their stage to the lead stage", affected: 3, destructive: true };

// The command module is heavy (the template bundle); load it once, outside any test's budget.
beforeAll(async () => {
  await import("../src/commands/market.js");
}, 60_000);

let logs: string[] = [];
const applyCalls = () => hubPost.mock.calls.filter((c) => c[0] === "/packages/apply");

beforeEach(() => {
  hubPost.mockReset();
  attachments.mockReset();
  attachments.mockResolvedValue([
    { workspaceId: "w1", workspaceName: "ZZ", domain: null, packageSlug: SLUG, packageVersion: "v1", drifted: true },
  ]);
  logs = [];
  vi.spyOn(console, "log").mockImplementation((m?: unknown) => {
    logs.push(String(m));
  });
  vi.spyOn(console, "error").mockImplementation(() => {});
  process.exitCode = undefined;
});
afterEach(() => {
  vi.restoreAllMocks();
  process.exitCode = undefined;
});

function previewReturns(body: Record<string, unknown>) {
  hubPost.mockImplementation(async (path: string) => {
    if (path === "/packages/preflight") return body;
    if (path === "/packages/apply") return { workspace: { id: "w1", outcome: "updated" } };
    throw new Error(`unexpected ${path}`);
  });
}

function lastJson(): Record<string, any> {
  return JSON.parse(logs[logs.length - 1]!);
}

describe("templates update — data changes need agreement", () => {
  it("does NOT apply when a change is listed and nothing was agreed", async () => {
    previewReturns({ ok: true, dataChanges: [W12] });
    const { marketUpdate } = await import("../src/commands/market.js");
    await marketUpdate([SLUG], { json: true });
    expect(applyCalls()).toHaveLength(0);
    const out = lastJson();
    expect(out.applied[0].status).toBe("needs-consent");
    expect(out.applied[0].pendingDataChanges.map((d: any) => d.opKey)).toEqual([W12.opKey]);
    expect(out.dataChanges[SLUG][0].affected).toBe(12);
    expect(process.exitCode).toBe(1);
  });

  it("`update all` is not consent", async () => {
    previewReturns({ ok: true, dataChanges: [W12] });
    const { marketUpdate } = await import("../src/commands/market.js");
    await marketUpdate(undefined, { json: true, all: true });
    expect(applyCalls()).toHaveLength(0);
  });

  it("sends exactly the agreed opKeys with --accept-data-changes", async () => {
    previewReturns({ ok: true, dataChanges: [W12] });
    const { marketUpdate } = await import("../src/commands/market.js");
    await marketUpdate([SLUG], { json: true, acceptDataChanges: `${W12.opKey},not-pending` });
    expect(applyCalls()).toHaveLength(1);
    expect(applyCalls()[0]![1].acceptDataChanges).toEqual([W12.opKey]);
  });

  it("agreeing to one of two changes applies nothing", async () => {
    previewReturns({ ok: true, dataChanges: [W12, W13] });
    const { marketUpdate } = await import("../src/commands/market.js");
    await marketUpdate([SLUG], { json: true, acceptDataChanges: W12.opKey });
    expect(applyCalls()).toHaveLength(0);
    expect(lastJson().applied[0].pendingDataChanges.map((d: any) => d.opKey)).toEqual([W13.opKey]);
  });

  it("--yes agrees to every listed change", async () => {
    previewReturns({ ok: true, dataChanges: [W12, W13] });
    const { marketUpdate } = await import("../src/commands/market.js");
    await marketUpdate([SLUG], { json: true, yes: true });
    expect(applyCalls()[0]![1].acceptDataChanges).toEqual([W12.opKey, W13.opKey]);
  });

  it("an older pod (no dataChanges field) applies exactly as before — no consent field sent", async () => {
    previewReturns({ ok: true });
    const { marketUpdate } = await import("../src/commands/market.js");
    await marketUpdate([SLUG], { json: true });
    expect(applyCalls()).toHaveLength(1);
    expect("acceptDataChanges" in applyCalls()[0]![1]).toBe(false);
  });

  it("a 409 DATA_CHANGES_NEED_CONSENT is held back, not counted as updated", async () => {
    const { HubError } = await import("../src/lib/hub-client.js");
    hubPost.mockImplementation(async (path: string) => {
      if (path === "/packages/preflight") return { ok: true };
      throw new HubError({
        message: "conflict",
        status: 409,
        code: "DATA_CHANGES_NEED_CONSENT",
        body: { code: "DATA_CHANGES_NEED_CONSENT", dataChanges: [W12] },
        rawBody: "",
        path,
        method: "POST",
      });
    });
    const { marketUpdate } = await import("../src/commands/market.js");
    await marketUpdate([SLUG], { json: true });
    const out = lastJson();
    expect(out.applied[0].status).toBe("needs-consent");
    expect(out.summary.updated).toBe(0);
    expect(out.summary.needsConsent).toBe(1);
    expect(process.exitCode).toBe(1);
  });

  it("a failed preview is reported, never read as 'no data changes'", async () => {
    hubPost.mockImplementation(async (path: string) => {
      if (path === "/packages/preflight") throw new Error("boom");
      return { workspace: { id: "w1", outcome: "updated" } };
    });
    const { marketUpdate } = await import("../src/commands/market.js");
    await marketUpdate([SLUG], { json: true, dryRun: true });
    expect(lastJson().dataChanges[SLUG]).toEqual({ error: expect.stringContaining("preview failed") });
  });
});

describe("templates update — retired templates", () => {
  it("never re-applies a retired template and reports its replacement", async () => {
    attachments.mockResolvedValue([
      {
        workspaceId: "w1",
        workspaceName: "ZZ",
        domain: null,
        packageSlug: SLUG,
        packageVersion: "v1",
        drifted: true,
        lifecycle: { lifecycle: "retired", replacedBy: "ecosystem", retiredReason: "Folded into Ecosystem." },
      },
    ]);
    previewReturns({ ok: true });
    const { marketUpdate } = await import("../src/commands/market.js");
    await marketUpdate([SLUG], { json: true, yes: true });
    expect(hubPost).not.toHaveBeenCalled();
    expect(lastJson().templateLifecycle[SLUG]).toEqual({
      lifecycle: "retired",
      replacedBy: "ecosystem",
      retiredReason: "Folded into Ecosystem.",
    });
  });
});
