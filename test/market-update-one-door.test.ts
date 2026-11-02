import { describe, it, expect, beforeEach, vi } from "vitest";

/**
 * `market update` applies EVERY installed kind through the pod's ONE update
 * door, `POST /package-updates/{slug}/apply`, whoever holds the key (founder,
 * 2 Nov 2026: "normally the CLI for me should be able to do everything").
 * The pod applies the rule: a person's update lands, an agent key's is filed
 * for the person's approval, what only the person can do names its review
 * page. The CLI no longer routes by kind: the per-kind doors are gone
 * (`/packages/apply` for a space, the pod-wide `/configs/reconcile` an agent
 * may not run, nothing for a capability).
 *
 * INCIDENT this still guards (2026-10-12): a SKILL sent to `/packages/apply`,
 * the workspace door, minted an empty "New Workspace". No update ever reaches
 * `/packages/apply` now.
 *
 * Driven through the real `marketUpdate` with only the network seams mocked:
 * the pod's verdicts, the CP fetches and the hub transport.
 */

vi.mock("../src/lib/auth.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getCpUrl: () => "https://cp.test",
  getStoredToken: () => null,
  isTokenLocallyExpired: () => false,
}));

const row = (kind: string, slug: string) => ({
  kind,
  id: `${kind}-${slug}`,
  name: slug,
  packageSlug: slug,
  templateKey: null,
  installedVersion: "1.0.0",
  latestVersion: "1.1.0",
  drift: true,
  installedAt: null,
  workspaceId: kind === "workspace" ? "ws-1" : null,
  workspaceName: null,
  provisioningStatus: null,
  failedStep: null,
});
const inventory: { rows: unknown[] } = { rows: [] };
vi.mock("../src/lib/package-updates.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  fetchPackageStandings: async () => (await import("./helpers/standings-from-inventory.js")).standingsFromMockedInventory(),
}));
vi.mock("../src/lib/installed.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  fetchInstalledInventoryStrict: async () => ({ rows: inventory.rows, driftComputed: true, degraded: false }),
  fetchWorkspaceAttachmentsStrict: async () => [],
}));
vi.mock("../src/lib/cp-packages.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  fetchPackageDefinition: async () => ({ workspaceName: "Content OS" }),
}));

const POD = "https://pod.antoinesrvt.synap.live";
const ADMIN = "https://pod-admin.antoinesrvt.synap.live";
const hubPost = vi.fn(async (_path: string, _body?: unknown): Promise<unknown> => ({}));
/** What the one update door answers (the preview door answers `{}`). */
function doorAnswers(answer: () => Promise<unknown>): void {
  hubPost.mockImplementation(async (path: string) => (path === "/packages/preflight" ? {} : answer()));
}
vi.mock("../src/lib/hub-client.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  resolveHubConfig: async () => ({ podUrl: POD, apiKey: "k", workspaceId: undefined }),
  hubPost: (...args: unknown[]) => hubPost(...(args as [string, unknown])),
}));

const { marketUpdate, packageReviewLink } = await import("../src/commands/market.js");
const { HubError } = await import("../src/lib/hub-client.js");
const { log } = await import("../src/utils/logger.js");

let said: string[] = [];
beforeEach(() => {
  hubPost.mockClear();
  doorAnswers(async () => ({ status: "applied", receipt: null }));
  said = [];
  vi.unstubAllGlobals();
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      const u = String(url);
      const json = (body: unknown) => ({ ok: true, status: 200, json: async () => body }) as unknown as Response;
      if (u.includes("/api/packages/available")) return json({ packages: [] });
      if (/\/api\/packages\?/.test(u))
        return json({
          packages: [{ id: "c", slug: "content-os", displayName: "Content OS", category: "workspace", version: "1.1.0" }],
        });
      throw new Error(`unexpected fetch: ${u}`);
    }),
  );
  vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
    throw new Error(`process.exit(${code})`);
  }) as never);
  vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => void said.push(a.map(String).join(" ")));
  for (const level of ["success", "info", "warn", "error", "hint", "dim", "heading", "blank"] as const) {
    vi.spyOn(log, level).mockImplementation(((...a: unknown[]) => void said.push(a.map(String).join(" "))) as never);
  }
});

const applies = () => hubPost.mock.calls.filter((c) => c[0] !== "/packages/preflight");
const lastJson = () => JSON.parse(said.at(-1)!);
const refusal = (status: number, body: Record<string, unknown>) =>
  new HubError({
    message: `Hub POST failed (HTTP ${status}): ${String(body.error)}`,
    status,
    detail: String(body.error),
    body,
    rawBody: JSON.stringify(body),
    path: "/package-updates/x/apply",
    method: "POST",
  });

describe("market update — one door for every kind", () => {
  it("every kind goes to /package-updates/{slug}/apply with the version the pod showed; never /packages/apply nor /configs/reconcile", async () => {
    inventory.rows = ["workspace", "capability", "skill", "view", "automation"].map((k) => row(k, `${k}-pkg`));
    await marketUpdate(undefined, { all: true, json: true });
    expect(applies().map((c) => c[0]).sort()).toEqual([
      "/package-updates/automation-pkg/apply",
      "/package-updates/capability-pkg/apply",
      "/package-updates/skill-pkg/apply",
      "/package-updates/view-pkg/apply",
      "/package-updates/workspace-pkg/apply",
    ]);
    for (const c of applies()) expect(c[1]).toEqual({ expectedVersion: "1.1.0", choices: {} });
    const paths = hubPost.mock.calls.map((c) => c[0]);
    expect(paths).not.toContain("/packages/apply");
    expect(paths).not.toContain("/configs/reconcile");
    expect(lastJson().summary.updated).toBe(5);
  });

  it("an agent key's update filed for approval is waiting, with its approval link — never failed", async () => {
    inventory.rows = [row("capability", "gmail")];
    doorAnswers(async () => ({ status: "proposed", proposalIds: ["p-1"] }));
    await marketUpdate(["gmail"], { json: true });
    const json = lastJson();
    expect(json.applied).toEqual([
      expect.objectContaining({ slug: "gmail", status: "proposed", proposalId: "p-1", reviewUrl: `${ADMIN}/proposal/p-1` }),
    ]);
    expect(json.summary.proposed).toBe(1);
    expect(json.summary.failed).toBe(0);
  });

  it("what only the person can do names that package's page on pod admin, not a failure", async () => {
    inventory.rows = [row("workspace", "brand-library")];
    doorAnswers(async () => {
      throw refusal(403, {
        error: 'This update of "brand-library" changes existing records (op-1), which only a person agrees to.',
        reasonCode: "NEEDS_PERSON",
        reviewUrl: "/open/update/brand-library",
      });
    });
    await marketUpdate(["brand-library"], {});
    const out = said.join("\n");
    expect(out).toContain("brand-library is a workspace — to apply in pod admin: This update of");
    expect(out).toContain(`${ADMIN}/marketplace/updates/brand-library`);
    expect(out).toContain("1 to apply in pod admin");
    expect(out).not.toMatch(/update failed/);
  });

  it("a field both sides changed (CHOICES_NEEDED) is the person's too", async () => {
    inventory.rows = [row("skill", "facecam-edit")];
    doorAnswers(async () => {
      throw refusal(400, { error: "Both the catalog and this pod changed s1:body.", reasonCode: "CHOICES_NEEDED" });
    });
    await marketUpdate(["facecam-edit"], { json: true });
    expect(lastJson().applied[0]).toMatchObject({
      status: "apply-in-pod-admin",
      reviewUrl: `${ADMIN}/marketplace/updates/facecam-edit`,
    });
  });

  it("an invalid catalog definition names the template and each field, as a failure", async () => {
    inventory.rows = [row("workspace", "content-os")];
    doorAnswers(async () => {
      throw refusal(400, {
        error: 'The catalog\'s definition of "content-os" does not fit this pod (playbooks.0.stages.0.goal: Too big).',
        reasonCode: "INVALID_CATALOG_DEFINITION",
        fieldErrors: { "playbooks.0.stages.0.goal": ["Too big"] },
      });
    });
    await marketUpdate(["content-os"], {});
    const out = said.join("\n");
    expect(out).toContain('content-os not updated — The catalog\'s definition of "content-os"');
    expect(out).toContain("playbooks.0.stages.0.goal: Too big");
    expect(out).toContain("1 failed");
  });

  it("an older pod that refuses an agent here keeps today's line: to apply in pod admin", async () => {
    inventory.rows = [row("capability", "gmail")];
    doorAnswers(async () => {
      throw refusal(403, {
        error: "An agent cannot apply a space or capability update here: it may change existing records, which only a person agrees to.",
      });
    });
    await marketUpdate(["gmail"], { json: true });
    const json = lastJson();
    expect(json.applied[0].status).toBe("apply-in-pod-admin");
    expect(json.summary.failed).toBe(0);
  });

  it("an answer the CLI cannot read is a FAILURE, never 'up to date'", async () => {
    inventory.rows = [row("skill", "creative-director")];
    doorAnswers(async () => "<html>bad gateway</html>");
    await marketUpdate(["creative-director"], { json: true });
    const json = lastJson();
    expect(json.applied).toEqual([expect.objectContaining({ slug: "creative-director", status: "failed" })]);
    expect(json.summary.updated + json.summary.unchanged).toBe(0);
  });

  it("the check run offers every update as a next step (the pod says at apply time what is the person's)", async () => {
    inventory.rows = [row("capability", "gmail"), row("skill", "facecam-edit")];
    await marketUpdate(undefined, { json: true });
    const commands = JSON.stringify(lastJson().nextSteps);
    expect(commands).toContain("gmail");
    expect(commands).toContain("facecam-edit");
    expect(applies()).toEqual([]);
  });
});

describe("packageReviewLink", () => {
  it("is pod admin's page for the package when the pod-admin origin derives from the pod's", () => {
    expect(packageReviewLink(POD, "brand-library", "/open/update/brand-library")).toBe(
      `${ADMIN}/marketplace/updates/brand-library`
    );
  });
  it("falls back to the pod's own link, then to nothing", () => {
    expect(packageReviewLink("not a url", "x", "/open/update/x")).toBe("not a url/open/update/x");
    expect(packageReviewLink("not a url", "x", undefined)).toBeUndefined();
  });
});
