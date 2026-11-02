/**
 * `synap market update --yes` with a computer / agent key (founder, 2 Nov 2026,
 * CLI 1.13.1-next.20261102.ec3d166). The pod refuses a pod-wide config
 * reconcile to ANY agent credential (403 "An agent credential cannot trigger a
 * pod-wide config reconcile"), so:
 *  - a skill / view / automation update is the person's act in pod admin, like
 *    a capability: the reconcile door is never called, the row is not a failure;
 *  - those updates are not offered as next-step commands;
 *  - the summary counts them as "to apply in pod admin", never "failed";
 *  - the slug column fits a long slug and keeps two spaces.
 *
 * Driven through the real `marketUpdate`; the pod is stubbed at the hub transport.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

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
  fetchPackageDefinition: async () => ({ skill: { slug: "x", body: "# x" } }),
}));

const key: { status: Record<string, unknown> } = { status: {} };
const hubPost = vi.fn(async (_path: string): Promise<unknown> => ({}));
const hubGet = vi.fn(async (path: string): Promise<unknown> => {
  if (path === "/auth/status") return key.status;
  return {};
});
vi.mock("../src/lib/hub-client.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  resolveHubConfig: async () => ({ podUrl: "https://pod.antoinesrvt.synap.live", apiKey: "k", workspaceId: undefined }),
  hubPost: (...args: unknown[]) => hubPost(...(args as [string])),
  hubGet: (...args: unknown[]) => hubGet(...(args as [string])),
}));

const { marketUpdate, summarizeApplyResults } = await import("../src/commands/market.js");
const { HubError } = await import("../src/lib/hub-client.js");
const { log } = await import("../src/utils/logger.js");

const agentKey = { userId: "u1", userEmail: "agent-computer-ab12@synap.agent", keyType: "user_pat" };
const personKey = { userId: "u2", userEmail: "me@example.com", keyType: "user_pat" };
const LONG = "designing-with-real-components"; // 30 characters

let said: string[] = [];
beforeEach(() => {
  hubPost.mockClear();
  hubGet.mockClear();
  said = [];
  vi.unstubAllGlobals();
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      const u = String(url);
      const json = (body: unknown) => ({ ok: true, status: 200, json: async () => body }) as unknown as Response;
      if (u.includes("/api/packages/available")) return json({ packages: [] });
      if (/\/api\/packages\?/.test(u)) return json({ packages: [] });
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

const paths = () => hubPost.mock.calls.map((c) => c[0]);
const plain = () => said.join("\n").replace(/\x1b\[[0-9;]*m/g, "");

describe("market update with an agent key", () => {
  it("a skill update never calls the reconcile door: it is pod admin's, and not a failure", async () => {
    key.status = agentKey;
    inventory.rows = [row("skill", "facecam-edit")];
    await marketUpdate(undefined, { yes: true, json: true });
    expect(paths()).not.toContain("/configs/reconcile");
    const json = JSON.parse(said.at(-1)!);
    expect(json.applied).toEqual([expect.objectContaining({ slug: "facecam-edit", status: "apply-in-pod-admin" })]);
    expect(json.summary.failed).toBe(0);
    expect(json.summary.toApplyInPodAdmin).toBe(1);
  });

  it("says where the person applies it, in the same words as the summary", async () => {
    key.status = agentKey;
    inventory.rows = [row("skill", "facecam-edit")];
    await marketUpdate(undefined, { yes: true });
    const out = plain();
    expect(out).toContain("facecam-edit is a skill — to apply in pod admin");
    expect(out).toContain("https://pod-admin.antoinesrvt.synap.live/marketplace/updates");
    expect(out).toContain("1 to apply in pod admin");
    expect(out).not.toMatch(/update failed|failed/);
  });

  it("is left out of the next steps (the check run)", async () => {
    key.status = agentKey;
    inventory.rows = [row("skill", "facecam-edit"), row("workspace", "content-os")];
    await marketUpdate(undefined, { json: true });
    const json = JSON.parse(said.at(-1)!);
    const commands = JSON.stringify(json.nextSteps);
    // ...and named where the person applies it (2 Nov live run: the hint
    // named the capabilities only, so the skill vanished from the advice).
    expect(json.appliedInPodAdmin?.slugs).toContain("facecam-edit");
    expect(commands).toContain("content-os");
    expect(commands).not.toContain("facecam-edit");
  });

  it("control: a person's key keeps the reconcile path", async () => {
    key.status = personKey;
    inventory.rows = [row("skill", "facecam-edit")];
    hubPost.mockImplementationOnce(async () => ({
      updated: [{ kind: "skill", packageSlug: "facecam-edit", name: "facecam-edit", reason: "advanced" }],
    }));
    await marketUpdate(undefined, { yes: true, json: true });
    expect(paths()).toEqual(["/configs/reconcile"]);
    const json = JSON.parse(said.at(-1)!);
    expect(json.applied[0].status).toBe("updated");
  });

  it("a key the CLI cannot classify that the pod refuses is the same row, not a failure", async () => {
    key.status = {}; // no signal: unknown
    inventory.rows = [row("skill", "facecam-edit")];
    hubPost.mockImplementationOnce(async () => {
      throw new HubError({
        message: "An agent credential cannot trigger a pod-wide config reconcile. (HTTP 403)",
        status: 403,
        rawBody: JSON.stringify({ error: "An agent credential cannot trigger a pod-wide config reconcile." }),
        path: "/configs/reconcile",
        method: "POST",
      });
    });
    await marketUpdate(undefined, { yes: true, json: true });
    const json = JSON.parse(said.at(-1)!);
    expect(json.applied[0].status).toBe("apply-in-pod-admin");
    expect(json.summary.failed).toBe(0);
  });
});

describe("the summary", () => {
  it("counts what is the person's apart from failures", () => {
    const s = summarizeApplyResults([
      { slug: "a", status: "apply-in-pod-admin" },
      { slug: "b", status: "apply-in-pod-admin" },
      { slug: "c", status: "apply-in-pod-admin" },
      { slug: "d", status: "proposed" },
      { slug: "e", status: "failed" },
    ]);
    expect(s.toApplyInPodAdmin).toBe(3);
    expect(s.failed).toBe(1);
    expect(s.line).toContain("3 to apply in pod admin");
    expect(s.line).toContain("1 failed");
  });

  it("with nothing failed it is not a warning", () => {
    const s = summarizeApplyResults([{ slug: "a", status: "apply-in-pod-admin" }]);
    expect(s.line).toContain("→");
    expect(s.line).not.toContain("⚠");
  });
});

describe("the installed list's slug column", () => {
  it("keeps two spaces after a 30-character slug", async () => {
    key.status = personKey;
    inventory.rows = [row("workspace", LONG), row("workspace", "crm")];
    await marketUpdate(undefined, {});
    const line = plain().split("\n").find((l) => l.includes(LONG))!;
    expect(LONG).toHaveLength(30);
    expect(line).toMatch(new RegExp(`${LONG}  \\S`));
    const crm = plain().split("\n").find((l) => /\bcrm\b/.test(l) && !l.includes(LONG))!;
    // every label starts in the same column
    expect(crm.search(/\S/, crm.indexOf("crm") + 3)).toBe(line.search(/\S/, line.indexOf(LONG) + 30));
  });
});
