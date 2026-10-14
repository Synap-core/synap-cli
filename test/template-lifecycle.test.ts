import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  dataChangeRefusalMessage,
  parseDataChanges,
  decideConsent,
  dataChangesFromRefusal,
  consentNeedsPerson,
  parseAcceptList,
  parseLifecycle,
  lifecycleNotice,
  parseRetireResponse,
  formatRetirePlan,
  parseOverlays,
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
  it("carries the pod's count error and operator command", () => {
    const [d] = parseDataChanges({
      dataChanges: [{ opKey: "a", affected: null, error: "dry run failed", destructive: true, operatorCommand: "pnpm x" }],
    })!;
    expect(d).toMatchObject({ affected: null, error: "dry run failed", destructive: true, operatorCommand: "pnpm x" });
  });
  it("an uncounted change says so instead of inventing 0", () => {
    expect(parseDataChanges({ dataChanges: [{ opKey: "a" }] })![0]!.affected).toBeNull();
  });
});

describe("decideConsent", () => {
  const pending = [W12, { ...W12, opKey: "w13" }];
  it("nothing agreed → every change missing", () => {
    expect(decideConsent(pending, {})).toEqual({ accepted: [], missing: pending, refusedOperatorSteps: [] });
  });
  it("a destructive change is never agreed here, not even by --yes", () => {
    const op = { ...W12, opKey: "w14", destructive: true };
    expect(decideConsent([...pending, op], { yes: true }).accepted).toEqual(["w12", "w13"]);
    const named = decideConsent([op], { acceptList: ["w14"] });
    expect(named).toEqual({ accepted: [], missing: [], refusedOperatorSteps: ["w14"] });
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
    const n = lifecycleNotice("radar", { lifecycle: "retired", replacedBy: "ecosystem", retiredReason: null, warning: null })!;
    expect(n.label).toContain("replaced by ecosystem");
    expect(n.action).toBe("synap templates retire radar");
  });
  it("the pod's own warning wins over the CLI's fallback wording", () => {
    const n = lifecycleNotice("radar", { lifecycle: "unlisted", replacedBy: null, retiredReason: null, warning: "Pod says so." })!;
    expect(n.label).toBe("Pod says so.");
  });
  it("an unattached workspace (lifecycle null) carries no lifecycle", () => {
    expect(parseLifecycle({ lifecycle: null })).toBeUndefined();
  });
  it("unknown never claims the template is gone", () => {
    const n = lifecycleNotice("radar", { lifecycle: "unknown", replacedBy: null, retiredReason: null, warning: null })!;
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
      ws({ lifecycle: { lifecycle: "retired", replacedBy: "ecosystem", retiredReason: null, warning: null } }),
      check,
      []
    );
    expect(r.group).toBe("attention");
    expect(r.action).toBe("synap templates retire radar");
  });
  it("an unlisted template needs attention", () => {
    const r = classifyTemplateRow(
      ws({ drifted: false, lifecycle: { lifecycle: "unlisted", replacedBy: null, retiredReason: null, warning: null } }),
      { ...check, updateAvailable: false },
      []
    );
    expect(r.group).toBe("attention");
    expect(r.lifecycleNotice!.label).toMatch(/no longer in the catalog/i);
  });
  it("unknown is a note only — the row is not moved", () => {
    const r = classifyTemplateRow(
      ws({ lifecycle: { lifecycle: "unknown", replacedBy: null, retiredReason: null, warning: null } }),
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
        {
          id: "w1",
          name: "Radar",
          packageSlug: "radar",
          lifecycle: "retired",
          replacedBy: "ecosystem",
          retiredReason: "Folded.",
          lifecycleWarning: 'The "radar" template was retired. Folded.',
        },
        { id: "w2", name: "Old pod row", packageSlug: "crm" },
      ],
    });
    const { fetchWorkspaceAttachmentsStrict } = await import("../src/lib/installed.js");
    const rows = await fetchWorkspaceAttachmentsStrict({ podUrl: "https://p", apiKey: "k" } as never);
    expect(rows[0]!.lifecycle).toEqual({
      lifecycle: "retired",
      replacedBy: "ecosystem",
      retiredReason: "Folded.",
      warning: 'The "radar" template was retired. Folded.',
    });
    expect(rows[1]!.lifecycle).toBeUndefined();
  });

  it("maps overlays from the wire; an older pod row has none", async () => {
    hubGet.mockResolvedValue({
      workspaces: [
        {
          id: "w1",
          name: "CRM",
          packageSlug: "crm",
          lifecycle: "current",
          overlays: [
            {
              slug: "business-developer",
              lifecycle: "retired",
              replacedBy: "crm",
              retiredReason: null,
              lifecycleWarning: "nothing to move",
              replacementHere: true,
            },
          ],
        },
        { id: "w2", name: "Old pod row", packageSlug: "crm" },
      ],
    });
    const { fetchWorkspaceAttachmentsStrict } = await import("../src/lib/installed.js");
    const rows = await fetchWorkspaceAttachmentsStrict({ podUrl: "https://p", apiKey: "k" } as never);
    expect(rows[0]!.overlays).toEqual([
      {
        slug: "business-developer",
        info: { lifecycle: "retired", replacedBy: "crm", retiredReason: null, warning: "nothing to move" },
        replacementHere: true,
      },
    ]);
    expect(rows[1]!.overlays).toBeUndefined();
  });
});

describe("dataChangeRefusalMessage — the pod's other data-change refusals, in words", () => {
  const err = (status: number, code: string, extra: Record<string, unknown> = {}) =>
    new HubError({ message: "x", status, code, body: { code, ...extra }, rawBody: "", path: "/p", method: "POST" });

  it("names the pod-admin rule for 403 DATA_CHANGES_NEED_POD_ADMIN", () => {
    expect(dataChangeRefusalMessage(err(403, "DATA_CHANGES_NEED_POD_ADMIN"))).toMatch(/pod owner or admin/);
  });

  it("says the template was not applied for 409 DATA_CHANGES_FAILED, with the pod's reason", () => {
    const msg = dataChangeRefusalMessage(err(409, "DATA_CHANGES_FAILED", { error: "op crm.x hit a lock." }));
    expect(msg).toMatch(/template was not applied/);
    expect(msg).toMatch(/op crm\.x hit a lock\./);
  });

  it("leaves every other error to the generic path (a consent refusal is not a failure)", () => {
    expect(dataChangeRefusalMessage(err(409, "DATA_CHANGES_NEED_CONSENT"))).toBeNull();
    expect(dataChangeRefusalMessage(err(403, "FORBIDDEN"))).toBeNull();
    expect(dataChangeRefusalMessage(new Error("boom"))).toBeNull();
  });
});

describe("overlays — a pack composed onto a space shows under it", () => {
  const BD_WARNING =
    'The "business-developer" overlay on this space was retired. It is replaced by "crm", which this space already has. Its fields stay; there is nothing to move.';
  const overlayRow = (over: Record<string, unknown>) => ({
    slug: "business-developer",
    installedVersion: "h-1",
    latestVersion: null,
    drifted: false,
    lifecycle: "retired",
    replacedBy: "crm",
    retiredReason: null,
    lifecycleWarning: BD_WARNING,
    replacementHere: true,
    ...over,
  });
  const current = { lifecycle: { lifecycle: "current" as const, replacedBy: null, retiredReason: null, warning: null } };
  const noDrift = { ...check, updateAvailable: false };

  it("parseOverlays: absent field (older pod) and empty list are different facts", () => {
    expect(parseOverlays({})).toBeUndefined();
    expect(parseOverlays({ overlays: [] })).toEqual([]);
    expect(parseOverlays({ overlays: [{ lifecycle: "retired" }, overlayRow({})] })!.map((o) => o.slug)).toEqual([
      "business-developer",
    ]);
  });

  it("an overlay with no lifecycle reads as unknown, never current", () => {
    expect(parseOverlays({ overlays: [{ slug: "x" }] })![0]!.info.lifecycle).toBe("unknown");
  });

  it("shows the pod's own sentence under the space; replacement already here is not attention", () => {
    const overlays = parseOverlays({ overlays: [overlayRow({})] })!;
    const r = classifyTemplateRow(ws({ drifted: false, ...current, overlays }), noDrift, []);
    expect(r.overlayNotices).toEqual([{ slug: "business-developer", label: BD_WARNING, lifecycle: "retired" }]);
    expect(r.group).toBe("ok");
    expect(r.action).toBeNull();
  });

  it("a retired overlay whose replacement is NOT on the space needs attention, with no retire action", () => {
    const overlays = parseOverlays({
      overlays: [overlayRow({ slug: "grants", replacedBy: "finance", replacementHere: false, lifecycleWarning: null })],
    })!;
    const r = classifyTemplateRow(ws({ drifted: false, ...current, overlays }), noDrift, []);
    expect(r.group).toBe("attention");
    // An overlay is not a space: `synap templates retire grants` would move nothing.
    expect(r.action).toBeNull();
    // Same wording as a space's fallback when the pod sent no sentence.
    expect(r.overlayNotices[0]!.label).toBe("Retired: grants is replaced by finance");
  });

  it("a current overlay is listed with no notice", () => {
    const overlays = parseOverlays({
      overlays: [overlayRow({ lifecycle: "current", replacedBy: null, lifecycleWarning: null, replacementHere: false })],
    })!;
    const r = classifyTemplateRow(ws({ drifted: false, ...current, overlays }), noDrift, []);
    expect(r.overlayNotices).toEqual([{ slug: "business-developer", label: null, lifecycle: "current" }]);
    expect(r.group).toBe("ok");
  });

  it("an older pod (no overlays field) renders exactly as before", () => {
    const before = classifyTemplateRow(ws({}), check, []);
    expect(before.overlayNotices).toEqual([]);
    expect(before.group).toBe("attention");
    expect(before.action).toBe("synap templates update radar");
  });
});

describe("consentNeedsPerson — an agent's refusal is not 'you have not agreed'", () => {
  const refusal = (body: Record<string, unknown>) =>
    new HubError({ message: "x", status: 409, code: "DATA_CHANGES_NEED_CONSENT", body: { code: "DATA_CHANGES_NEED_CONSENT", dataChanges: [W12], ...body }, rawBody: "", path: "/p", method: "POST" });
  it("follows the pod's needsPerson flag", () => {
    expect(consentNeedsPerson(refusal({ needsPerson: true, missing: [] }))).toBe(true);
    expect(consentNeedsPerson(refusal({ needsPerson: false, missing: ["w12"] }))).toBe(false);
  });
  it("older pod: everything agreed (missing []) yet refused can only be an agent", () => {
    // dogfood 2026-10-14: `--accept-data-changes h0.devplane-story.planned`
    // from an agent session was told to re-run the same command.
    expect(consentNeedsPerson(refusal({ missing: [] }))).toBe(true);
    expect(consentNeedsPerson(refusal({ missing: ["w12"] }))).toBe(false);
  });
  it("false for any other error", () => {
    expect(consentNeedsPerson(new Error("x"))).toBe(false);
  });
});
