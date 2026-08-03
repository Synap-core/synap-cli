import { describe, it, expect } from "vitest";
import {
  suggestTemplateFor,
  resolveWorkspaceQuery,
  classifyTemplateRow,
} from "../src/commands/market.js";
import type { WorkspaceAttachment } from "../src/lib/installed.js";

const ws = (over: Partial<WorkspaceAttachment>): WorkspaceAttachment => ({
  workspaceId: "w1",
  workspaceName: "W",
  domain: null,
  packageSlug: null,
  packageVersion: null,
  ...over,
});

// Minimal catalog entries — only fields suggestTemplateFor reads.
const entries = [
  { slug: "crm", name: "CRM", category: "workspace", domain: "crm", tags: [], isPrivate: false, source: "remote" },
  { slug: "personal", name: "Personal", category: "workspace", domain: "personal", tags: [], isPrivate: false, source: "remote" },
  { slug: "apollo", name: "Apollo", category: "capability", domain: "sales", tags: [], isPrivate: false, source: "remote" },
] as never[];

describe("suggestTemplateFor", () => {
  it("STRONG match on a specific domain", () => {
    const s = suggestTemplateFor(ws({ domain: "crm", workspaceName: "Anything" }), entries);
    expect(s).toEqual({ slug: "crm", name: "CRM", confidence: "strong" });
  });

  it("does NOT suggest from the generic 'personal' domain (the false-positive bug)", () => {
    expect(suggestTemplateFor(ws({ domain: "personal", workspaceName: "Pod Admin" }), entries)).toBeNull();
  });

  it("WEAK match when the name contains a template slug", () => {
    const s = suggestTemplateFor(ws({ domain: "personal", workspaceName: "The arch CRM" }), entries);
    expect(s).toEqual({ slug: "crm", name: "CRM", confidence: "weak" });
  });

  it("never suggests a capability-kind entry (only workspace templates)", () => {
    // 'apollo' is a capability; a name containing it must NOT be suggested.
    expect(suggestTemplateFor(ws({ workspaceName: "apollo lists" }), entries)).toBeNull();
  });

  it("null when nothing fits", () => {
    expect(suggestTemplateFor(ws({ workspaceName: "New Workspace", domain: "personal" }), entries)).toBeNull();
  });
});

describe("resolveWorkspaceQuery", () => {
  const all = [
    ws({ workspaceId: "id-1", workspaceName: "The arch CRM" }),
    ws({ workspaceId: "id-2", workspaceName: "Operations" }),
    ws({ workspaceId: "id-3", workspaceName: "The Arch — Stellar Grants" }),
  ];
  it("resolves by exact id", () => {
    const r = resolveWorkspaceQuery("id-2", all);
    expect(r.kind).toBe("found");
  });
  it("resolves by exact (case-insensitive) name", () => {
    const r = resolveWorkspaceQuery("operations", all);
    expect(r).toMatchObject({ kind: "found", ws: { workspaceId: "id-2" } });
  });
  it("resolves a UNIQUE substring", () => {
    const r = resolveWorkspaceQuery("stellar", all);
    expect(r).toMatchObject({ kind: "found", ws: { workspaceId: "id-3" } });
  });
  it("is ambiguous when >1 name matches", () => {
    const r = resolveWorkspaceQuery("the arch", all);
    expect(r.kind).toBe("ambiguous");
  });
  it("none when nothing matches", () => {
    expect(resolveWorkspaceQuery("zzz", all).kind).toBe("none");
  });
});

describe("classifyTemplateRow — action-ranked grouping", () => {
  it("attached + drifted → attention with an update action", () => {
    const r = classifyTemplateRow(
      ws({ packageSlug: "operations", packageVersion: "h-a" }),
      { slug: "operations", installedVersion: "h-a", latestVersion: "h-b", updateAvailable: true, noVersionInfo: false },
      entries
    );
    expect(r.group).toBe("attention");
    expect(r.action).toContain("templates update operations");
  });
  it("unattached WITH suggestion → attention", () => {
    const r = classifyTemplateRow(ws({ workspaceName: "The arch CRM", domain: "personal" }), undefined, entries);
    expect(r.group).toBe("attention");
    expect(r.suggestion?.slug).toBe("crm");
  });
  it("unattached with NO suggestion → unlinked (not attention)", () => {
    const r = classifyTemplateRow(ws({ workspaceName: "Pod Admin", domain: "personal" }), undefined, entries);
    expect(r.group).toBe("unlinked");
    expect(r.action).toBeNull();
  });
  it("attached + current → ok", () => {
    const r = classifyTemplateRow(
      ws({ packageSlug: "crm", packageVersion: "h-x" }),
      { slug: "crm", installedVersion: "h-x", latestVersion: "h-x", updateAvailable: false, noVersionInfo: false },
      entries
    );
    expect(r.group).toBe("ok");
  });
});
