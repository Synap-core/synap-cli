/**
 * The Surface commands reach the pod's ONE find door and ONE attach door.
 *
 * - `synap surfaces <kind> <id>` reads GET /surfaces and prints a store the
 *   pod could not read as an `unavailable` line, never as "none yet": an
 *   empty list and a failed read are different facts.
 *   An answer off that contract is a failed read (exit 1), never "none yet".
 * - `--for <kind>:<id>` on `view create` / `doc create` is ONE governed act,
 *   POST /surfaces {anchor, body, title, spec}: never a create followed by an
 *   attach (a body left unattached when the second call fails); a malformed
 *   `--for` is refused before anything is sent.
 * - `synap open <kind> <id> --surface <sid>` carries `?surface=<sid>` on the
 *   deep link it opens; a `--surface` that is not a uuid is refused.
 * - `synap artifact create --html` is an alias of `doc create --type html`: it
 *   reaches POST /documents with type html, never POST /cells/define.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

const hubGet = vi.fn(async (): Promise<unknown> => ({ rows: [], unavailable: [] }));
const SURFACE = "2c08acb0-0000-4000-8000-0000000000f5";
const defaultPost = async (path: string): Promise<Record<string, unknown>> => {
  if (path === "/surfaces") {
    return { status: "created", surface: { type: "view", id: "view-1" }, openUrl: "/open/entity/ent-1?surface=view-1" };
  }
  if (path === "/views") return { id: "view-1", name: "Board", type: "kanban" };
  return { status: "created", id: "doc-1" };
};
const hubPost = vi.fn(defaultPost);

vi.mock("../src/lib/hub-client.js", () => {
  class HubError extends Error {}
  class HubNetworkError extends Error {}
  return {
    hubGet,
    hubPost,
    hubPatch: vi.fn(),
    renderHubError: vi.fn(),
    HubError,
    HubNetworkError,
    resolveHubConfig: vi.fn(async () => ({
      podUrl: "https://pod.example.test",
      apiKey: "key",
      workspaceId: "ws-1",
    })),
    resolveUserId: vi.fn(async () => "user-1"),
  };
});

const execFileSync = vi.fn();
vi.mock("child_process", async (importOriginal) => ({
  ...(await importOriginal<typeof import("child_process")>()),
  execFileSync,
}));

let out: string[];
let err: string[];
let dir: string;
beforeEach(() => {
  hubGet.mockClear();
  hubPost.mockClear();
  hubPost.mockImplementation(defaultPost);
  execFileSync.mockClear();
  out = [];
  err = [];
  vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => void out.push(a.map(String).join(" ")));
  vi.spyOn(console, "error").mockImplementation((...a: unknown[]) => void err.push(a.map(String).join(" ")));
  dir = mkdtempSync(join(tmpdir(), "surfaces-cmd-"));
  process.exitCode = undefined;
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  vi.restoreAllMocks();
  process.exitCode = undefined;
});

const postsTo = (path: string) =>
  hubPost.mock.calls.filter((c) => (c as unknown as [string])[0] === path);

describe("synap surfaces <kind> <id>", () => {
  it("reads GET /surfaces with the anchor", async () => {
    const { surfacesList } = await import("../src/commands/surfaces.js");
    await surfacesList("entity", "ent-1", { workspace: "ws-9", json: true });
    const [path, params] = hubGet.mock.calls[0] as unknown as [string, Record<string, string>];
    expect(path).toBe("/surfaces");
    expect(params).toEqual({ kind: "entity", id: "ent-1", workspaceId: "ws-9" });
  });

  it("prints each row with its open link made absolute", async () => {
    hubGet.mockResolvedValueOnce({
      rows: [
        {
          id: "view-1", body: "view", relation: "attached", title: "Deal board",
          viewType: "kanban", anchor: { kind: "entity", id: "ent-1" },
          openUrl: "/open/view-1", readOnly: false, source: "links",
        },
      ],
      unavailable: [],
    });
    const { surfacesList } = await import("../src/commands/surfaces.js");
    await surfacesList("entity", "ent-1", {});
    const text = out.join("\n");
    expect(text).toContain("Deal board");
    expect(text).toContain("https://pod.example.test/open/view-1");
  });

  it("a store that could not be read is a line of its own, never 'none yet'", async () => {
    hubGet.mockResolvedValueOnce({
      rows: [],
      unavailable: [{ source: "renderers", error: "timeout" }],
    });
    const { surfacesList } = await import("../src/commands/surfaces.js");
    await surfacesList("entity", "ent-1", {});
    const all = [...out, ...err].join("\n");
    expect(all).toContain("unavailable: renderers could not be read (timeout)");
    expect(all).not.toContain("None yet");
  });

  it("an answer off the contract is a failed read with a failing exit, never 'none yet'", async () => {
    vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
      throw new Error(`exit ${code}`);
    }) as never);
    const { surfacesList } = await import("../src/commands/surfaces.js");
    for (const answer of [{ items: [] }, { rows: [] }, null, "<html>"]) {
      hubGet.mockResolvedValueOnce(answer);
      out = [];
      err = [];
      await expect(surfacesList("entity", "ent-1", {})).rejects.toThrow("exit 1");
      const all = [...out, ...err].join("\n");
      expect(all).toContain("not a surface list");
      expect(all).not.toContain("None yet");
    }
  });

  it("an empty answer with every store read says none yet", async () => {
    const { surfacesList } = await import("../src/commands/surfaces.js");
    await surfacesList("entity", "ent-1", {});
    expect(out.join("\n")).toContain("None yet");
  });
});

describe("--for <kind>:<id> makes it for that object in one act", () => {
  const bodyOf = (path: string) => (postsTo(path)[0] as unknown as [string, Record<string, unknown>])[1];

  it("view create --for is one POST /surfaces with the view type, never a create then an attach", async () => {
    const { viewCreate } = await import("../src/commands/view.js");
    await viewCreate({ type: "kanban", name: "Board", for: "entity:ent-1" });
    expect(postsTo("/surfaces")).toHaveLength(1);
    expect(bodyOf("/surfaces")).toEqual({
      anchor: { kind: "entity", id: "ent-1" },
      body: "view",
      title: "Board",
      spec: { viewType: "kanban" },
    });
    expect(postsTo("/views")).toHaveLength(0);
    expect(postsTo("/surfaces/attach")).toHaveLength(0);
    expect(out.join("\n")).toContain("https://pod.example.test/open/entity/ent-1?surface=view-1");
  });

  it("a bento or whiteboard is its own body; --workspace pins where it is stored", async () => {
    const { viewCreate } = await import("../src/commands/view.js");
    await viewCreate({ type: "bento", name: "Cockpit", workspace: "ws-9", for: "project:proj-1", json: true });
    expect(bodyOf("/surfaces")).toEqual({
      anchor: { kind: "project", id: "proj-1" },
      body: "bento",
      title: "Cockpit",
      spec: { workspaceId: "ws-9" },
    });
  });

  it("doc create --for is one POST /surfaces carrying the content; a page is an html body", async () => {
    const { docCreate } = await import("../src/commands/doc.js");
    await docCreate({ title: "Brief", content: "# Brief", for: "project:proj-1", json: true });
    expect(bodyOf("/surfaces")).toEqual({
      anchor: { kind: "project", id: "proj-1" },
      body: "document",
      title: "Brief",
      spec: { content: "# Brief" },
    });
    hubPost.mockClear();
    await docCreate({ title: "Report", content: "<p>hi</p>", type: "html", for: "entity:ent-1", json: true });
    expect(bodyOf("/surfaces")).toMatchObject({ body: "html", spec: { content: "<p>hi</p>" } });
    expect(postsTo("/documents")).toHaveLength(0);
    expect(postsTo("/surfaces/attach")).toHaveLength(0);
  });

  it("a proposed create is one proposal, said as such, not a failure", async () => {
    hubPost.mockResolvedValueOnce({ status: "proposed", proposalId: "prop-1" });
    const { docCreate } = await import("../src/commands/doc.js");
    await docCreate({ title: "Brief", content: "x", for: "entity:ent-1" });
    expect(postsTo("/surfaces")).toHaveLength(1);
    expect([...out, ...err].join("\n")).toContain("proposed (under review)");
    expect(process.exitCode).toBeUndefined();
  });

  it("a refused create fails with the pod's words and nothing else is sent", async () => {
    vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
      throw new Error(`exit ${code}`);
    }) as never);
    hubPost.mockImplementation(async () => {
      throw new Error("anchor not found");
    });
    const { docCreate } = await import("../src/commands/doc.js");
    await expect(docCreate({ title: "Brief", content: "x", for: "entity:ent-404" })).rejects.toThrow("exit 1");
    expect(err.join("\n")).toContain("anchor not found");
    expect(hubPost).toHaveBeenCalledTimes(1);
  });

  it("a malformed --for is refused before anything is sent", async () => {
    vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
      throw new Error(`exit ${code}`);
    }) as never);
    const { viewCreate } = await import("../src/commands/view.js");
    await expect(viewCreate({ type: "kanban", for: "ent-1" })).rejects.toThrow("exit 1");
    expect(hubPost).not.toHaveBeenCalled();
  });
});

describe("synap open --surface", () => {
  it("the deep link carries the surface", async () => {
    const { openCommand } = await import("../src/commands/open.js");
    await openCommand("entity", "ent-1", { surface: SURFACE });
    const urls = execFileSync.mock.calls.map((c) => (c[1] as string[]).at(-1));
    expect(urls[0]).toBe(`synap://open/entity/ent-1?surface=${SURFACE}`);
  });

  it("a --surface that is not a surface id is refused before anything opens", async () => {
    vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
      throw new Error(`exit ${code}`);
    }) as never);
    const { openCommand } = await import("../src/commands/open.js");
    for (const bad of ["view-1", "", "../x", `${SURFACE}&x=1`]) {
      await expect(openCommand("entity", "ent-1", { surface: bad })).rejects.toThrow("exit 1");
    }
    expect(execFileSync).not.toHaveBeenCalled();
  });

  it("--surface without a kind and id is refused", async () => {
    vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
      throw new Error(`exit ${code}`);
    }) as never);
    const { openCommand } = await import("../src/commands/open.js");
    await expect(openCommand("ent-1", undefined, { surface: "view-1" })).rejects.toThrow("exit 1");
    expect(execFileSync).not.toHaveBeenCalled();
  });
});

describe("synap artifact create --html (retired alias)", () => {
  it("makes an html document, not a cell", async () => {
    const file = join(dir, "report.html");
    writeFileSync(file, "<!doctype html><p>hi</p>");
    const { artifactCreate } = await import("../src/commands/artifact.js");
    await artifactCreate({ html: file, json: true });
    expect(postsTo("/cells/define")).toHaveLength(0);
    const docs = postsTo("/documents");
    expect(docs).toHaveLength(1);
    expect((docs[0] as unknown as [string, Record<string, unknown>])[1]).toMatchObject({
      type: "html",
      title: "report",
      content: "<!doctype html><p>hi</p>",
    });
    expect(err.join("\n")).toContain("retired");
  });
});
