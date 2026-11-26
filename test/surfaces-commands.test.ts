/**
 * The Surface commands reach the pod's ONE find door and ONE attach door.
 *
 * - `synap surfaces <kind> <id>` reads GET /surfaces and prints a store the
 *   pod could not read as an `unavailable` line, never as "none yet": an
 *   empty list and a failed read are different facts.
 * - `--for <kind>:<id>` on `view create` / `doc create` sends the new view or
 *   document to POST /surfaces/attach; a proposed create (no id yet) sends
 *   nothing to attach; a malformed `--for` is refused before anything is sent.
 * - `synap open <kind> <id> --surface <sid>` carries `?surface=<sid>` on the
 *   deep link it opens.
 * - `synap artifact create --html` is an alias of `doc create --type html`: it
 *   reaches POST /documents with type html, never POST /cells/define.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

const hubGet = vi.fn(async (): Promise<unknown> => ({ rows: [], unavailable: [] }));
const defaultPost = async (path: string): Promise<Record<string, unknown>> => {
  if (path === "/surfaces/attach") {
    return { status: "attached", linkId: "link-1", openUrl: "/open/entity/ent-1?surface=view-1" };
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

  it("an empty answer with every store read says none yet", async () => {
    const { surfacesList } = await import("../src/commands/surfaces.js");
    await surfacesList("entity", "ent-1", {});
    expect(out.join("\n")).toContain("None yet");
  });
});

describe("--for <kind>:<id> attaches what was made", () => {
  it("view create --for posts the new view to /surfaces/attach", async () => {
    const { viewCreate } = await import("../src/commands/view.js");
    await viewCreate({ type: "kanban", name: "Board", for: "entity:ent-1", json: true });
    const attach = postsTo("/surfaces/attach");
    expect(attach).toHaveLength(1);
    expect((attach[0] as unknown as [string, unknown])[1]).toEqual({
      anchor: { kind: "entity", id: "ent-1" },
      surface: { type: "view", id: "view-1" },
    });
  });

  it("doc create --for posts the new document to /surfaces/attach", async () => {
    const { docCreate } = await import("../src/commands/doc.js");
    await docCreate({ title: "Brief", content: "# Brief", for: "project:proj-1", json: true });
    const attach = postsTo("/surfaces/attach");
    expect(attach).toHaveLength(1);
    expect((attach[0] as unknown as [string, unknown])[1]).toEqual({
      anchor: { kind: "project", id: "proj-1" },
      surface: { type: "document", id: "doc-1" },
    });
  });

  it("a proposed document has nothing to attach yet", async () => {
    hubPost.mockResolvedValueOnce({ status: "proposed", proposalId: "prop-1" });
    const { docCreate } = await import("../src/commands/doc.js");
    await docCreate({ title: "Brief", content: "x", for: "entity:ent-1" });
    expect(postsTo("/surfaces/attach")).toHaveLength(0);
  });

  it("a failed attach is reported after the create, with a failing exit", async () => {
    hubPost.mockImplementation(async (path: string) => {
      if (path === "/surfaces/attach") throw new Error("anchor not found");
      return { status: "created", id: "doc-1" };
    });
    const { docCreate } = await import("../src/commands/doc.js");
    await docCreate({ title: "Brief", content: "x", for: "entity:ent-404" });
    expect(out.join("\n")).toContain("Document created: Brief");
    expect(err.join("\n")).toContain("anchor not found");
    expect(process.exitCode).toBe(1);
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
    await openCommand("entity", "ent-1", { surface: "view-1" });
    const urls = execFileSync.mock.calls.map((c) => (c[1] as string[]).at(-1));
    expect(urls[0]).toBe("synap://open/entity/ent-1?surface=view-1");
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
