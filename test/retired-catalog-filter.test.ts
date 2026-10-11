/**
 * A template the CP retired is never offered or suggested by the CLI — even
 * when the bundled `@synap-core/workspace-templates` copy still carries it
 * (the founder's pod suggested "Agent Fleet looks like → agent-fleet" after
 * agent-fleet was retired, because the 0.12.0 bundle still had it).
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchRetiredWorkspaceSlugs } from "../src/lib/cp-packages.js";
import { dropRetiredWorkspaces, suggestTemplateFor } from "../src/commands/market.js";

const entry = (slug: string, type = "workspace") =>
  ({ slug, name: slug, type, category: type, source: "bundled" }) as never;

afterEach(() => vi.unstubAllGlobals());

describe("fetchRetiredWorkspaceSlugs", () => {
  const stub = (status: number, body: unknown) =>
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(body), { status })));

  it("collects only the rows the CP marks retired", async () => {
    stub(200, {
      packages: [
        { slug: "agent-fleet", retired: { at: "2026-09-28", replacedBy: null, reason: "x" } },
        { slug: "crm", retired: null },
      ],
    });
    expect([...((await fetchRetiredWorkspaceSlugs()) ?? [])]).toEqual(["agent-fleet"]);
  });

  it("an older CP that refuses includeRetired (400) retires nothing", async () => {
    stub(400, { code: "UNKNOWN_QUERY_PARAM" });
    expect((await fetchRetiredWorkspaceSlugs())?.size).toBe(0);
  });

  it("any other failure is unknown (null), never an empty set", async () => {
    stub(503, {});
    expect(await fetchRetiredWorkspaceSlugs()).toBeNull();
  });
});

describe("dropRetiredWorkspaces", () => {
  const entries = [entry("agent-fleet"), entry("crm"), entry("agent-fleet", "capability")];

  it("drops a retired workspace template, so it is never suggested", () => {
    const kept = dropRetiredWorkspaces(entries, new Set(["agent-fleet"]));
    expect(kept.map((e: { slug: string; type: string }) => `${e.type}:${e.slug}`)).toEqual([
      "workspace:crm",
      "capability:agent-fleet",
    ]);
    const ws = { workspaceId: "w", workspaceName: "Agent Fleet", domain: "agent-fleet" } as never;
    expect(suggestTemplateFor(ws, entries)?.slug).toBe("agent-fleet");
    expect(suggestTemplateFor(ws, kept)).toBeNull();
  });

  it("unknown retirements keep every entry", () => {
    expect(dropRetiredWorkspaces(entries, null)).toHaveLength(3);
  });
});
