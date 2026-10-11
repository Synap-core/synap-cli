import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  parseDataChanges,
  decideConsent,
  dataChangesFromRefusal,
  parseAcceptList,
  parseLifecycle,
  lifecycleNotice,
  parseRetireResponse,
  formatRetirePlan,
} from "../src/lib/template-lifecycle.js";
import { HubError } from "../src/lib/hub-client.js";
import { classifyTemplateRow } from "../src/commands/market.js";
import { resolveRetireTarget } from "../src/commands/templates-retire.js";
import type { WorkspaceAttachment } from "../src/lib/installed.js";

const W12 = { opKey: "w12", description: "Deals move their stage", affected: 12, destructive: false };

describe("parseDataChanges — absent and empty are different facts", () => {
  it("undefined when the pod sent no field (older pod)", () => {
    expect(parseDataChanges({ ok: true })).toBeUndefined();
    expect(parseDataChanges(null)).toBeUndefined();
  });
  it("[] when the pod checked and nothing is owed", () => {
    expect(parseDataChanges({ dataChanges: [] })).toEqual([]);
  });
  it("drops entries with no opKey (they cannot be agreed to)", () => {
    expect(parseDataChanges({ dataChanges: [{ description: "x" }, W12] })).toEqual([W12]);
  });
  it("an uncounted change says so instead of inventing 0", () => {
    expect(parseDataChanges({ dataChanges: [{ opKey: "a" }] })![0]!.affected).toBeNull();
  });
});

describe("decideConsent", () => {
  const pending = [W12, { ...W12, opKey: "w13" }];
  it("nothing agreed → every change missing", () => {
    expect(decideConsent(pending, {})).toEqual({ accepted: [], missing: pending });
  });
  it("only named opKeys count; an unlisted name is never sent", () => {
    const d = decideConsent(pending, { acceptList: ["w13", "ghost"] });
    expect(d.accepted).toEqual(["w13"]);
    expect(d.missing.map((m) => m.opKey)).toEqual(["w12"]);
  });
  it("--yes agrees to every listed change", () => {
    expect(decideConsent(pending, { yes: true }).accepted).toEqual(["w12", "w13"]);
  });
  it("parseAcceptList splits commas and spaces", () => {
    expect(parseAcceptList("a, b c")).toEqual(["a", "b", "c"]);
    expect(parseAcceptList(undefined)).toEqual([]);
  });
});

describe("dataChangesFromRefusal", () => {
  const err = (status: number, code?: string) =>
    new HubError({ message: "x", status, code, body: { code, dataChanges: [W12] }, rawBody: "", path: "/p", method: "POST" });
  it("reads the list from a 409 consent refusal", () => {
    expect(dataChangesFromRefusal(err(409, "DATA_CHANGES_NEED_CONSENT"))).toEqual([W12]);
  });
  it("ignores any other 409 and any other status", () => {
    expect(dataChangesFromRefusal(err(409, "WORKSPACE_IDENTITY_CONFLICT"))).toBeNull();
    expect(dataChangesFromRefusal(err(500, "DATA_CHANGES_NEED_CONSENT"))).toBeNull();
    expect(dataChangesFromRefusal(new Error("x"))).toBeNull();
  });
});

describe("lifecycle", () => {
  it("an older pod (no field) is undefined, an unknown value is 'unknown' — never 'current'", () => {
    expect(parseLifecycle({})).toBeUndefined();
    expect(parseLifecycle({ lifecycle: "sunset" })!.lifecycle).toBe("unknown");
  });
  it("retired with a replacement offers the retire command", () => {
    const n = lifecycleNotice("radar", { lifecycle: "retired", replacedBy: "ecosystem", retiredReason: null })!;
    expect(n.label).toContain("replaced by ecosystem");
    expect(n.action).toBe("synap templates retire radar");
  });
  it("unknown never claims the template is gone", () => {
    const n = lifecycleNotice("radar", { lifecycle: "unknown", replacedBy: null, retiredReason: null })!;
    expect(n.label).toMatch(/not fully synced/);
    expect(n.label).not.toMatch(/no longer|retired/);
  });
});

const ws = (over: Partial<WorkspaceAttachment>): WorkspaceAttachment => ({
  workspaceId: "w1",
  workspaceName: "Radar",
  domain: null,
  packageSlug: "radar",
  packageVersion: "v1",
  drifted: true,
  latestVersion: "v2",
  ...over,
});
const check = { slug: "radar", installedVersion: "v1", latestVersion: "v2", updateAvailable: true, noVersionInfo: false };

describe("classifyTemplateRow — lifecycle outranks drift", () => {
  it("a retired template points at retire, not update", () => {
    const r = classifyTemplateRow(
      ws({ lifecycle: { lifecycle: "retired", replacedBy: "ecosystem", retiredReason: null } }),
      check,
      []
    );
    expect(r.group).toBe("attention");
    expect(r.action).toBe("synap templates retire radar");
  });
  it("an unlisted template needs attention", () => {
    const r = classifyTemplateRow(
      ws({ drifted: false, lifecycle: { lifecycle: "unlisted", replacedBy: null, retiredReason: null } }),
      { ...check, updateAvailable: false },
      []
    );
    expect(r.group).toBe("attention");
    expect(r.lifecycleNotice!.label).toMatch(/no longer in the catalog/i);
  });
  it("unknown is a note only — the row is not moved", () => {
    const r = classifyTemplateRow(
      ws({ lifecycle: { lifecycle: "unknown", replacedBy: null, retiredReason: null } }),
      check,
      []
    );
    expect(r.action).toBe("synap templates update radar");
    expect(r.lifecycleNotice).not.toBeNull();
  });
  it("an older pod (no lifecycle) behaves as before", () => {
    const r = classifyTemplateRow(ws({}), check, []);
    expect(r.action).toBe("synap templates update radar");
    expect(r.lifecycleNotice).toBeNull();
  });
});

describe("retire-into response", () => {
  const plan = {
    source: { workspaceId: "w1", name: "Radar", slug: "radar" },
    target: { slug: "ecosystem", workspaceId: null, willInstall: true },
    moves: [{ profileSlug: "company", count: 14 }],
    stays: [{ profileSlug: "radar_signal", count: 3, reason: "ecosystem has no radar_signal kind" }],
    willArchive: false,
  };
  it("parses a dry-run plan and prints moves, stays and their reasons", () => {
    const o = parseRetireResponse({ plan })!;
    expect(o.kind).toBe("plan");
    const lines = formatRetirePlan((o as { plan: any }).plan).join("\n");
    expect(lines).toContain("It will be installed first");
    expect(lines).toContain("14 company");
    expect(lines).toContain("3 radar_signal: ecosystem has no radar_signal kind");
    expect(lines).toContain("The old space stays");
  });
  it("an agent run comes back as a proposal", () => {
    const o = parseRetireResponse({ status: "proposed", proposalId: "p1", plan })!;
    expect(o).toMatchObject({ kind: "proposed", proposalId: "p1" });
  });
  it("an unreadable body is null — never 'nothing to move'", () => {
    expect(parseRetireResponse({ ok: true })).toBeNull();
    expect(parseRetireResponse("x")).toBeNull();
  });
  it("an empty move list says so explicitly", () => {
    const o = parseRetireResponse({ plan: { ...plan, moves: [], stays: [] } })!;
    expect(formatRetirePlan((o as { plan: any }).plan)).toContain("Moves: nothing to move.");
  });
});

describe("resolveRetireTarget", () => {
  const all = [ws({}), ws({ workspaceId: "w2", workspaceName: "Ecosystem", packageSlug: "ecosystem" })];
  it("resolves by template slug first", () => {
    expect(resolveRetireTarget("radar", all)).toMatchObject({ kind: "found", ws: { workspaceId: "w1" } });
  });
  it("falls back to workspace id / name", () => {
    expect(resolveRetireTarget("w2", all)).toMatchObject({ kind: "found" });
    expect(resolveRetireTarget("nope", all)).toEqual({ kind: "none" });
  });
});

// The SEAM: a raw Hub `/workspaces` row carrying lifecycle reaches the attachment.
const hubGet = vi.fn();
vi.mock("../src/lib/hub-client.js", async (orig) => {
  const actual = (await orig()) as Record<string, unknown>;
  return { ...actual, hubGet: (...a: unknown[]) => hubGet(...a) };
});
beforeEach(() => hubGet.mockReset());

describe("fetchWorkspaceAttachmentsStrict carries lifecycle from the wire", () => {
  it("maps lifecycle / replacedBy / retiredReason", async () => {
    hubGet.mockResolvedValue({
      workspaces: [
        { id: "w1", name: "Radar", packageSlug: "radar", lifecycle: "retired", replacedBy: "ecosystem", retiredReason: "Folded." },
        { id: "w2", name: "Old pod row", packageSlug: "crm" },
      ],
    });
    const { fetchWorkspaceAttachmentsStrict } = await import("../src/lib/installed.js");
    const rows = await fetchWorkspaceAttachmentsStrict({ podUrl: "https://p", apiKey: "k" } as never);
    expect(rows[0]!.lifecycle).toEqual({ lifecycle: "retired", replacedBy: "ecosystem", retiredReason: "Folded." });
    expect(rows[1]!.lifecycle).toBeUndefined();
  });
});
